// Send through the bundled iLink client instead of shelling out to the CLI.
//
// The CLI refuses once the reply window closes ("还没有绑定的微信对话", then
// "prepare failed") and parks the message for later. The iLink gateway accepts a
// proactive message that carries *no* context token, so notifications can reach the
// phone without the user having to write first.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CORE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..', 'vendor', 'dsh-wechat-plugin', 'dist', 'core', 'lib', 'index.js',
);

let core = null;
async function loadCore() {
  if (core) return core;
  core = await import('file://' + CORE.replace(/\\/g, '/'));
  return core;
}

export function wechatStatePath() {
  return path.join(DSH_HOME, 'wechat', 'state.json');
}

const LABEL_FILE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'claw-labels.json');

export function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABEL_FILE, 'utf8')); } catch { return {}; }
}

export function writeLabel(accountId, name) {
  const labels = readLabels();
  const clean = String(name ?? '').trim().slice(0, 24);
  if (!accountId || !clean) return { ok: false, error: '名字不能为空' };
  labels[accountId] = clean;
  fs.writeFileSync(LABEL_FILE, JSON.stringify(labels, null, 2), 'utf8');
  return { ok: true, name: clean };
}

/** All bound accounts, newest activity first. */
export function listAccounts() {
  try {
    const st = JSON.parse(fs.readFileSync(wechatStatePath(), 'utf8'));
    const accounts = st.accounts ?? {};
    const bindings = st.bindings ?? {};
    const byAccount = new Map();
    for (const b of Object.values(bindings)) {
      const cur = byAccount.get(b.accountId);
      if (!cur || (b.lastUsedAt ?? 0) > (cur.lastUsedAt ?? 0)) byAccount.set(b.accountId, b);
    }
    const labels = readLabels();
    return Object.entries(accounts).map(([id, acc]) => {
      const b = byAccount.get(id) ?? null;
      return {
        accountId: id,
        name: labels[id] ?? null,
        userId: acc.userId ?? null,
        boundAt: acc.boundAt ?? null,
        conversationId: b?.conversationId ?? null,
        peerId: b?.peerId ?? null,
        lastUsedAt: b?.lastUsedAt ?? null,
        title: b?.title ?? null,
      };
    }).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  } catch {
    return [];
  }
}

/** Drop one account from the state file: accounts, bindings, tokens, cursor. */
export function removeAccount(accountId) {
  if (!accountId) return { ok: false, error: 'accountId required' };
  const file = wechatStatePath();
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, error: 'state unreadable' }; }
  if (!st.accounts?.[accountId]) return { ok: false, error: '没有这个账号' };
  delete st.accounts[accountId];
  delete st.syncBufs?.[accountId];
  delete st.contextTokens?.[accountId];
  for (const [conv, b] of Object.entries(st.bindings ?? {})) {
    if (b.accountId === accountId) delete st.bindings[conv];
  }
  for (const [conv, q] of Object.entries(st.quota ?? {})) {
    if (conv.startsWith(accountId + ':')) delete st.quota[conv];
  }
  fs.writeFileSync(file, JSON.stringify(st, null, 2), 'utf8');
  const labels = readLabels();
  if (labels[accountId]) { delete labels[accountId]; fs.writeFileSync(LABEL_FILE, JSON.stringify(labels, null, 2), 'utf8'); }
  return { ok: true };
}

/** Which account a send should go to: explicit pick, else the most recently active. */
function pickAccount(accountId) {
  try {
    const st = JSON.parse(fs.readFileSync(wechatStatePath(), 'utf8'));
    const accounts = st.accounts ?? {};
    const bindings = st.bindings ?? {};
    const rows = Object.entries(bindings)
      .filter(([, b]) => accounts[b.accountId])
      .sort((a, b) => (b[1].lastUsedAt ?? 0) - (a[1].lastUsedAt ?? 0));
    const chosen = accountId
      ? rows.find(([, b]) => b.accountId === accountId)
      : rows[0];
    if (!chosen) return null;
    const [, binding] = chosen;
    return { account: accounts[binding.accountId], binding };
  } catch {
    return null;
  }
}

/**
 * Send text and/or one file.
 * `proactive: true` (the default when nobody just wrote) means: no context token, which
 * is what makes an unprompted push acceptable to the gateway.
 */
export async function sendWechat({ text, file, accountId, contextToken = null }) {
  const picked = pickAccount(accountId);
  if (!picked) {
    return { ok: false, error: '还没有可用的微信会话：先在微信里给机器人发一条消息' };
  }
  const { account, binding } = picked;
  const c = await loadCore();
  const body = String(text ?? '').trim();
  try {
    if (file) {
      const uploaded = await c.uploadFile({ account, toUserId: binding.peerId, path: file });
      const r = await c.sendFile({ account, to: binding.peerId, uploaded, contextToken: contextToken ?? undefined });
      return { ok: true, message: '已通过微信发送：文件 ' + path.basename(file), id: r.serverMessageId ?? r.clientId };
    }
    const r = await c.sendText({
      account,
      to: binding.peerId,
      text: body,
      contextToken: contextToken ?? undefined,
    });
    return { ok: true, message: '已通过微信发送：消息', id: r.serverMessageId ?? r.clientId };
  } catch (e) {
    const message = String(e?.message ?? e).slice(0, 240);
    // The service refuses with "prepare failed" when the bot session has no fresh inbound
    // message to answer. Park it in the same queue the plugin uses; the channel flushes it
    // the moment the user writes again.
    if (/prepare failed|rate limited/i.test(message)) {
      try {
        const store = new c.StateStore(wechatStatePath());
        await store.update((s) => {
          s.pendingNotifications = Array.isArray(s.pendingNotifications) ? s.pendingNotifications : [];
          s.pendingNotifications.push({
            conversationId: binding.conversationId,
            text: body || ('文件：' + (file ? path.basename(file) : '')),
            id: 'codex-remote-' + Date.now().toString(36),
            queuedAt: Date.now(),
          });
        });
        return {
          ok: false,
          queued: true,
          error: '微信要等你先给它发一条消息才能推：已排队，你回一句话后自动补发',
        };
      } catch { /* fall through to the plain error */ }
    }
    return { ok: false, error: message };
  }
}

/** Files the channel dropped into the workspace: <workspace>/媒体/*, newest first. */
export function listInboundFiles(workspace, limit = 40) {
  const dir = path.join(workspace || '', '媒体');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) out.push({ path: path.join(dir, name), name, size: st.size, at: st.mtimeMs });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}
