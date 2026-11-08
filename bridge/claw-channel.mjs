// Inbound ClawBot channel.
//
// Why this exists: `dsh-wechat-send` refuses to send until the state file holds a
// *binding* for a conversation, and a binding is only created when an inbound message
// is consumed by a long-poll loop. Without the DSH plugin running, nothing polls — so
// the user's WeChat message went nowhere and every send failed with "还没有绑定的微信对话".
//
// This module runs one ChannelMonitor per bound account, persists the cursor per
// account (so switching accounts resumes where each one left off), records the
// binding/contextToken in the same state.json the plugin and CLI read, and drops
// received files into <workspace>/媒体/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CORE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..', 'vendor', 'dsh-wechat-plugin', 'dist', 'core', 'lib', 'index.js',
);

import { sendWechat } from './claw-send.mjs';
import { handleClawMessage } from './claw-agent.mjs';

let core = null;
async function loadCore() {
  if (core) return core;
  core = await import('file://' + CORE.replace(/\\/g, '/'));
  return core;
}

export function stateFile() {
  return path.join(DSH_HOME, 'wechat', 'state.json');
}

let workspaceDir = process.env.CLAW_WORKSPACE || '';
export function setChannelWorkspace(dir) { if (dir) workspaceDir = dir; }
function currentWorkspace(dir) { return dir || workspaceDir; }

let runtimeCfg = {};
/** The server hands over its config once, at boot. */
export function setChannelConfig(cfg) { runtimeCfg = cfg || {}; }
function channelConfig() { return runtimeCfg; }

const runtime = {
  started: false,
  monitors: new Map(), // accountId -> { status, since, error, pauseUntil }
  inbox: [],           // newest first, capped
  lastError: null,
};

const INBOX_LIMIT = 60;

/**
 * Send whatever the plugin parked because the reply window was closed. Called when a
 * new inbound message reopens the window.
 */
export async function flushPending(c) {
  const store = new c.StateStore(stateFile());
  const state = await store.read();
  const queued = Array.isArray(state.pendingNotifications) ? state.pendingNotifications : [];
  if (!queued.length) return { flushed: 0, left: 0 };
  let flushed = 0;
  const keep = [];
  for (const item of queued) {
    const r = await sendWechat({ text: item.text, accountId: item.accountId ?? null });
    if (r.ok) flushed += 1;
    else keep.push(item);
  }
  await store.update((s) => { s.pendingNotifications = keep; });
  return { flushed, left: keep.length };
}

export function channelSnapshot() {
  const accounts = [...runtime.monitors.entries()].map(([id, m]) => {
    // The monitor knows when it is cooling down after a stale token; report it so the
    // UI can say "paused" instead of pretending everything is fine.
    let paused = false;
    let remainingPauseMs = 0;
    try {
      paused = Boolean(m.monitor?.paused);
      remainingPauseMs = Number(m.monitor?.remainingPauseMs ?? 0);
    } catch { /* older monitor */ }
    return {
      accountId: id,
      status: m.status,
      since: m.since,
      error: m.error ?? null,
      paused,
      remainingPauseMs,
      lastMessageAt: m.lastMessageAt ?? null,
      messages: m.messages ?? 0,
    };
  });
  return {
    ok: true,
    started: runtime.started,
    accounts,
    lastError: runtime.lastError,
    inbox: runtime.inbox.slice(0, INBOX_LIMIT),
  };
}

export function clearInbox() {
  runtime.inbox.length = 0;
  return { ok: true };
}

/** Where received attachments land: the channel's workspace, matching the plugin. */
function mediaDir(workspace) {
  return path.join(workspace || path.join(os.homedir(), 'CHAT'), '媒体');
}

async function saveAttachment(c, item, account, workspace) {
  try {
    const dl = await c.downloadItemMedia({ item });
    if (!dl) return null;
    const dir = mediaDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    const ext = dl.fileName && path.extname(dl.fileName) ? '' : '.bin';
    const name = dl.fileName || `wechat-${Date.now()}${ext}`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, dl.data);
    return { path: full, name, size: fs.statSync(full).size };
  } catch (e) {
    runtime.lastError = '附件下载失败：' + String(e?.message ?? e).slice(0, 120);
    return null;
  }
}

function pushInbox(entry) {
  runtime.inbox.unshift(entry);
  if (runtime.inbox.length > INBOX_LIMIT) runtime.inbox.length = INBOX_LIMIT;
}

/**
 * Start (or restart) the pump for every account in the state file.
 * Safe to call repeatedly: an account that is already running is left alone.
 */
export async function startChannel(workspace) {
  workspace = currentWorkspace(workspace);
  const c = await loadCore();
  const store = new c.StateStore(stateFile());
  const state = await store.read();
  const accounts = state.accounts ?? {};

  runtime.started = true;
  if (!Object.keys(accounts).length) {
    runtime.lastError = null;
    return channelSnapshot();
  }

  for (const [accountId, account] of Object.entries(accounts)) {
    const existing = runtime.monitors.get(accountId);
    // Exactly one monitor per account: an old one must be aborted first or the gateway
    // ends up holding two long polls for the same bot (which is what produced duplicates).
    if (existing?.controller) {
      try { existing.controller.abort(); } catch { /* gone */ }
      existing.status = 'stopped';
    }

    const monitor = new c.ChannelMonitor({
      account,
      initialSyncBuf: state.syncBufs?.[accountId] ?? '',
      onSyncBuf: async (buf) => {
        if (!buf) return;
        await store.update((s) => {
          s.syncBufs = s.syncBufs ?? {};
          s.syncBufs[accountId] = buf;
        });
      },
      onMessage: async (msg) => {
        // Persist the binding and reply token the CLI needs, in the plugin's own shape.
        await store.update((s) => {
          s.bindings = s.bindings ?? {};
          const prev = s.bindings[msg.conversationId];
          s.bindings[msg.conversationId] = {
            conversationId: msg.conversationId,
            accountId: msg.accountId,
            peerId: msg.peerId,
            sessionId: prev?.sessionId ?? 'codex-remote',
            title: (msg.text || prev?.title || '来自微信').slice(0, 60),
            createdAt: prev?.createdAt ?? Date.now(),
            lastUsedAt: Date.now(),
          };
          if (msg.contextToken) {
            s.contextTokens = s.contextTokens ?? {};
            s.contextTokens[msg.accountId] = s.contextTokens[msg.accountId] ?? {};
            s.contextTokens[msg.accountId][msg.conversationId] = msg.contextToken;
          }
        });

        const files = [];
        for (const item of msg.media ?? []) {
          const saved = await saveAttachment(c, item, account, workspace);
          if (saved) files.push(saved);
        }
        pushInbox({
          accountId: msg.accountId,
          conversationId: msg.conversationId,
          peerId: msg.peerId,
          text: msg.text ?? '',
          files,
          at: msg.receivedAt ?? Date.now(),
        });
        const m = runtime.monitors.get(accountId);
        if (m) {
          m.status = 'running';
          m.error = null;
          m.lastMessageAt = Date.now();
          m.messages = (m.messages ?? 0) + 1;
        }
        // The user just wrote, so the reply window is open again.
        try { await flushPending(c); } catch (e) { runtime.lastError = '补发失败：' + String(e?.message ?? e).slice(0, 120); }
        // Then let the message drive a Codex turn and answer back in WeChat.
        try {
          await handleClawMessage(msg, channelConfig());
          const mon = runtime.monitors.get(accountId);
          if (mon) mon.lastTurnAt = Date.now();
        } catch (e) {
          runtime.lastError = '处理消息失败：' + String(e?.message ?? e).slice(0, 160);
        }
      },
      onError: (err) => {
        runtime.lastError = String(err?.message ?? err).slice(0, 200);
        const m = runtime.monitors.get(accountId);
        if (m) m.error = runtime.lastError;
      },
      onStop: (reason, detail) => {
        const m = runtime.monitors.get(accountId);
        if (m) { m.status = 'stopped'; m.error = detail ?? reason; }
        // A stale token needs a fresh login; anything else gets one retry later.
        if (reason !== 'aborted' && reason !== 'stale-token') {
          setTimeout(() => { void startChannel(workspace); }, 15_000);
        }
      },
    });

    const entry = { status: 'starting', since: Date.now(), error: null, monitor, controller: new AbortController() };
    runtime.monitors.set(accountId, entry);
    entry.monitor.run(entry.controller.signal)
      .then(() => { entry.status = 'stopped'; })
      .catch((e) => { entry.status = 'error'; entry.error = String(e?.message ?? e).slice(0, 160); });
    entry.status = 'running';
  }

  return channelSnapshot();
}

/** Restart one account's pump (used by the 重连 button). */
export async function restartAccount(accountId, workspace) {
  const entry = runtime.monitors.get(accountId);
  if (entry?.controller) {
    try { entry.controller.abort(); } catch { /* gone */ }
    entry.status = 'stopped';
    runtime.monitors.delete(accountId);
  }
  const snap = await startChannel(currentWorkspace(workspace));
  const now = snap.accounts.find((a) => a.accountId === accountId);
  return { ok: Boolean(now), account: now ?? null };
}

/** Stop one account's pump and forget it (used by 退出登录). */
export function stopAccount(accountId) {
  const entry = runtime.monitors.get(accountId);
  if (!entry) return { ok: true, stopped: false };
  try { entry.controller?.abort(); } catch { /* gone */ }
  entry.status = 'stopped';
  runtime.monitors.delete(accountId);
  runtime.inbox = runtime.inbox.filter((m) => m.accountId !== accountId);
  return { ok: true, stopped: true };
}

// A pump can stop on its own (network hiccup, token cooldown). Bring it back without
// waiting for the user to press 重连.
let healTimer = null;
export function startHealing(workspace) {
  if (healTimer) return { ok: true, already: true };
  healTimer = setInterval(() => {
    const stalled = [...runtime.monitors.entries()].filter(([, m]) => m.status === 'stopped' || m.status === 'error');
    if (stalled.length) {
      for (const [id] of stalled) runtime.monitors.delete(id);
      void startChannel(currentWorkspace(workspace)).catch(() => {});
    }
  }, 45_000);
  healTimer.unref?.();
  return { ok: true };
}

export function stopChannel() {
  for (const [, entry] of runtime.monitors) {
    try { entry.controller?.abort(); } catch { /* gone */ }
    entry.status = 'stopped';
  }
  runtime.started = false;
  return { ok: true };
}
