// Two-way WeChat ↔ Codex. This is the part the plugin does inside DSH: a message from
// the phone becomes a Codex turn, and the answer comes back to the phone. We talk the
// Codex app-server protocol directly, so no DSH involvement is needed.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { sendWechat } from './claw-send.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const THREADS_FILE = path.join(HERE, 'claw-threads.json');
const REPLY_CHUNK = 1100; // WeChat is not a log view; keep each bubble readable.

// ---------------------------------------------------------------- per-account state
function readThreads() {
  try { return JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8')); } catch { return {}; }
}
function writeThreads(map) {
  try { fs.writeFileSync(THREADS_FILE, JSON.stringify(map, null, 2), 'utf8'); } catch { /* ignore */ }
}
function threadFor(accountId) {
  return readThreads()[accountId] ?? null;
}
function setThread(accountId, threadId, title) {
  const map = readThreads();
  map[accountId] = { threadId, title: title ?? map[accountId]?.title ?? null, at: Date.now() };
  writeThreads(map);
}

// ---------------------------------------------------------------- internal RPC client
class CodexRpc {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.seq = 1;
    this.pending = new Map();
    this.notes = [];
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.url, { headers: { 'user-agent': 'codex-remote-claw' } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('app-server connect timeout')), 8000);
      this.ws.once('open', () => { clearTimeout(timer); resolve(); });
      this.ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id !== undefined && !msg.method && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
        else p.resolve(msg.result);
        return;
      }
      this.notes.push(msg);
      if (this.notes.length > 4000) this.notes.splice(0, 1000);
    });
    await this.send('initialize', {
      clientInfo: { name: 'codex-remote-claw', title: 'WeChat', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    try { this.ws.send(JSON.stringify({ method: 'initialized' })); } catch { /* noop */ }
  }

  send(method, params) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('not connected')); return; }
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ method, id, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' timeout')); }
      }, 120000);
    });
  }

  close() { try { this.ws?.close(); } catch { /* noop */ } }
}

let rpc = null;
async function client(url) {
  if (!rpc) rpc = new CodexRpc(url);
  await rpc.connect();
  return rpc;
}

// ---------------------------------------------------------------- helpers
function chunk(text, size = REPLY_CHUNK) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.4) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

function collectAnswer(threadId, sinceSeq) {
  // Newest agent message text from the notifications we saw during the turn.
  const items = new Map();
  for (const n of rpc.notes.slice(sinceSeq)) {
    if (n.params?.threadId && n.params.threadId !== threadId) continue;
    const item = n.params?.item;
    if (item?.type === 'agentMessage' && item.text) items.set(item.id ?? 'last', item.text);
    const d = n.params?.delta;
    if (n.method === 'item/agentMessage/delta' && typeof d === 'string') {
      const key = n.params.itemId ?? 'last';
      items.set(key, (items.get(key) ?? '') + d);
    }
  }
  const all = [...items.values()];
  return all.length ? all[all.length - 1] : '';
}

async function waitForTurn(c, threadId, turnId, timeoutMs = 10 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 700));
    const done = rpc.notes.slice(mark).find((n) => n.method === 'turn/completed' && n.params?.turn?.id === turnId);
    if (done) return done.params.turn;
  }
  return null;
}

let mark = 0;

// ---------------------------------------------------------------- commands
const HELP = [
  '可用指令：',
  '/new 开一个新会话',
  '/list 列出最近会话（/switch 序号 切换）',
  '/switch N 切到第 N 个会话',
  '/current 当前会话',
  '/cancel 停止当前回合',
  '/model 列出模型（/model 名字 切换）',
  '/help 这条帮助',
  '',
  '直接发消息就是给当前会话下任务，答完会回到这里。',
].join('\n');

async function handleCommand(c, accountId, text, contextToken, cfg) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  if (cmd === '/help') return HELP;

  if (cmd === '/current') {
    const t = threadFor(accountId);
    if (!t) return '当前还没有绑定会话，发一条消息就会新建一个。';
    return '当前会话：' + (t.title || t.threadId);
  }

  if (cmd === '/new') {
    const started = await c.send('thread/start', { cwd: cfg.defaultCwd });
    const thread = started?.thread ?? started;
    setThread(accountId, thread.id, '微信新会话');
    return '已新建会话：' + (thread.name || thread.id.slice(0, 8)) + '\n直接发消息即可。';
  }

  if (cmd === '/list') {
    const page = await c.send('thread/list', { limit: 10 });
    const rows = page?.data ?? page?.threads ?? [];
    if (!rows.length) return '还没有会话。';
    return rows.slice(0, 10).map((t, i) => (i + 1) + '. ' + (t.name || t.preview || t.id.slice(0, 8))).join('\n') + '\n\n用 /switch 序号 切换。';
  }

  if (cmd === '/switch') {
    const n = Number(arg);
    if (!n) return '用法：/switch 2';
    const page = await c.send('thread/list', { limit: 10 });
    const rows = page?.data ?? page?.threads ?? [];
    const pick = rows[n - 1];
    if (!pick) return '没有第 ' + n + ' 个会话。';
    setThread(accountId, pick.id, pick.name ?? pick.preview ?? null);
    return '已切到：' + (pick.name || pick.preview || pick.id.slice(0, 8));
  }

  if (cmd === '/cancel') {
    const t = threadFor(accountId);
    if (!t) return '没有在跑的会话。';
    try {
      await c.send('turn/interrupt', { threadId: t.threadId });
      return '已请求停止。';
    } catch (e) {
      return '停止失败：' + e.message;
    }
  }

  if (cmd === '/model') {
    if (arg) {
      const t = threadFor(accountId);
      if (!t) return '先建立会话再切模型。';
      await c.send('thread/settings/update', { threadId: t.threadId, model: arg });
      return '已切到模型 ' + arg + '（下一个回合生效）。';
    }
    const list = await c.send('model/list', {});
    const models = (list?.data ?? []).map((m) => m.id ?? m.model).filter(Boolean);
    return '模型：\n' + models.join('\n') + '\n\n用 /model 名字 切换。';
  }

  return '不认识的指令：' + cmd + '\n\n' + HELP;
}

// ---------------------------------------------------------------- the channel brain
/**
 * Handle one inbound WeChat message: command, or a Codex turn whose answer goes back.
 * @returns {Promise<{ok:boolean, reply?:string, error?:string}>}
 */
export async function handleClawMessage(msg, cfg) {
  const accountId = msg.accountId;
  const text = String(msg.text ?? '').trim();
  const files = (msg.media ?? []).length ? '（收到 ' + msg.media.length + ' 个附件）' : '';
  if (!text && !files) return { ok: false, error: '空消息' };

  let c;
  try {
    c = await client(cfg.upstreamUrl ?? `ws://${cfg.appServerHost}:${cfg.appServerPort}`);
  } catch (e) {
    await sendWechat({ accountId, text: '连不上 Codex：' + e.message, contextToken: msg.contextToken });
    return { ok: false, error: e.message };
  }

  const reply = async (body) => {
    for (const part of chunk(body)) {
      try { await sendWechat({ accountId, text: part, contextToken: msg.contextToken }); } catch { /* next part */ }
    }
  };

  if (text.startsWith('/')) {
    let out;
    try { out = await handleCommand(c, accountId, text, msg.contextToken, cfg); }
    catch (e) { out = '指令失败：' + e.message; }
    await reply(out);
    return { ok: true, reply: out };
  }

  // A normal task: continue this account's thread, or start one.
  let threadId = threadFor(accountId)?.threadId ?? null;
  if (!threadId) {
    const started = await c.send('thread/start', { cwd: cfg.defaultCwd });
    const thread = started?.thread ?? started;
    threadId = thread?.id;
    if (!threadId) {
      await reply('建会话失败：' + JSON.stringify(started).slice(0, 200));
      return { ok: false, error: 'thread/start failed' };
    }
    setThread(accountId, threadId, text.slice(0, 40));
  }

  mark = rpc.notes.length;
  let turnId;
  const startTurn = () => c.send('turn/start', {
    threadId,
    input: [{ type: 'text', text: text + (files ? '\n' + files : '') }],
    cwd: cfg.defaultCwd,
  });
  try {
    let res;
    try {
      res = await startTurn();
    } catch (e) {
      // The thread this account was bound to is gone (archived or deleted elsewhere).
      if (/not found|no such thread/i.test(String(e.message))) {
        const fresh = await c.send('thread/start', { cwd: cfg.defaultCwd });
        const thread = fresh?.thread ?? fresh;
        threadId = thread?.id;
        if (!threadId) throw e;
        setThread(accountId, threadId, text.slice(0, 40));
        res = await startTurn();
      } else {
        throw e;
      }
    }
    turnId = (res?.turn ?? res)?.id;
  } catch (e) {
    await reply('启动回合失败：' + e.message);
    return { ok: false, error: e.message };
  }

  const turn = await waitForTurn(c, threadId, turnId);
  const answer = collectAnswer(threadId, mark);
  const failed = turn && /fail|error|interrupt/i.test(String(turn.status));
  const body = answer || (failed ? '这一回合失败了，可以在网页端看细节。' : '（这一回合没有文字输出）');
  await reply(body);
  return { ok: true, reply: body, threadId, turnId };
}
