// QR login without installing anything into DSH: the plugin bundles @dsh-wechat/core,
// which is a plain iLink client ("no DSH imports"), and it writes the same
// <DSH_HOME>/wechat/state.json the plugin and its CLI read. So the bridge can bind the
// bot once, and then every other tool on the machine sees a logged-in channel.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { startChannel } from './claw-channel.mjs';
const qrcodeLib = require('qrcode');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CORE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..', 'vendor', 'dsh-wechat-plugin', 'dist', 'core', 'lib', 'index.js');

const MAX_ACCOUNTS = 3;

let core = null;
async function loadCore() {
  if (core) return core;
  core = await import(new URL('file://' + CORE.replace(/\\/g, '/')).href);
  return core;
}

export function loginStatePath() {
  return path.join(DSH_HOME, 'wechat', 'state.json');
}

/** One live login attempt, if any. */
const live = {
  running: false,
  phase: 'idle', // idle | qr | scanned | verify | confirmed | error | already-bound
  qrPng: null,
  qrUrl: null,
  message: '',
  startedAt: 0,
  account: null,
  needsCode: false,
  controller: null,
  generator: null,
  refresh: 0,
};

export function loginSnapshot() {
  return {
    ok: true,
    running: live.running,
    phase: live.phase,
    qrPng: live.qrPng,
    qrUrl: live.qrUrl,
    message: live.message,
    needsCode: live.needsCode,
    refresh: live.refresh,
    account: live.account,
    statePath: loginStatePath(),
  };
}

export function cancelLogin() {
  try { live.controller?.abort(); } catch { /* already gone */ }
  live.running = false;
  live.phase = 'idle';
  live.qrPng = null;
  live.needsCode = false;
  return { ok: true };
}

/** Feed a pairing verification code to a login waiting for one. */
export function submitLoginCode(code) {
  if (!live.running || !live.generator) return { ok: false, error: '没有正在等待验证码的登录' };
  if (!live.needsCode) return { ok: false, error: '当前登录不需要验证码' };
  live.needsCode = false;
  live.phase = 'scanned';
  live.message = '已提交验证码，等待手机确认…';
  try {
    // The generator's input channel is how the plugin answers this prompt.
    live.pendingCode = String(code ?? '');
    live.resume?.();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

async function renderQr(text) {
  try {
    return await qrcodeLib.toDataURL(text, { margin: 1, width: 260, errorCorrectionLevel: 'M' });
  } catch {
    return null;
  }
}

/**
 * Start a login. Returns immediately; poll loginSnapshot() for the QR and progress.
 */
export async function startLogin() {
  if (live.running) cancelLogin();
  // Three is the cap: more than that and "which bot am I talking to" stops being obvious,
  // and each one holds its own long poll open.
  const bound = hasBoundAccountCount();
  if (bound >= MAX_ACCOUNTS) {
    live.phase = 'error';
    live.message = '最多绑定 ' + MAX_ACCOUNTS + ' 个微信，先退出一个再扫';
    return loginSnapshot();
  }
  live.running = true;
  live.phase = 'starting';
  live.qrPng = null;
  live.qrUrl = null;
  live.message = '正在获取二维码…';
  live.startedAt = Date.now();
  live.refresh = 0;
  live.account = null;
  live.needsCode = false;
  live.controller = new AbortController();

  (async () => {
    try {
      const c = await loadCore();
      const store = new c.StateStore(loginStatePath());
      const state = await store.read();
      // Sending the tokens we already hold keeps the server from re-binding and
      // unbinding whatever the phone is already talking to.
      const existingTokens = Object.values(state.accounts ?? {}).map((a) => a.token).filter(Boolean);
      const gen = c.login(
        { existingTokens, timeoutMs: 5 * 60_000, reuseExisting: 'reuse' },
        live.controller.signal,
      );
      live.generator = gen;
      let next = await gen.next();
      while (!next.done) {
        const ev = next.value;
        if (ev.kind === 'qr') {
          live.phase = 'qr';
          live.qrUrl = ev.qrUrl;
          // Encode qrUrl (qr.qrcode_img_content), NOT ev.qrcode: the session handle
          // scanned as a QR is just a string, which is what WeChat showed.
          live.qrPng = await renderQr(ev.qrUrl || ev.qrcode);
          live.refresh = ev.refreshed ? live.refresh + 1 : live.refresh;
          live.message = '用微信扫一扫，扫完在手机上点确认';
          next = await gen.next();
          continue;
        }
        if (ev.kind === 'scanned') {
          live.phase = 'scanned';
          live.qrPng = null;
          live.message = '已扫码，等你在手机上确认';
          next = await gen.next();
          continue;
        }
        if (ev.kind === 'expired') {
          live.message = ev.willRetry ? '二维码过期，正在换一张…' : '二维码过期';
          next = await gen.next();
          continue;
        }
        if (ev.kind === 'redirected') {
          next = await gen.next();
          continue;
        }
        if (ev.kind === 'verifycode-required') {
          live.phase = 'verify';
          live.needsCode = true;
          live.message = '微信要求配对验证码，请在手机上查看并填入';
          // Park until submitLoginCode() supplies one.
          const code = await new Promise((resolve) => { live.resume = () => resolve(live.pendingCode ?? ''); });
          next = await gen.next(code);
          continue;
        }
        if (ev.kind === 'already-bound') {
          live.phase = 'already-bound';
          live.message = '这台机器已经绑定过这个微信，无需重新扫码';
          live.running = false;
          return;
        }
        if (ev.kind === 'confirmed') {
          live.phase = 'confirmed';
          live.account = ev.account ?? null;
          if (ev.account) {
            await store.update((s) => {
              s.accounts = s.accounts ?? {};
              s.accounts[ev.account.accountId] = ev.account;
            });
          }
          live.message = '绑定成功';
          live.running = false;
          // New account: start its pump now so the first inbound message creates a binding.
          void startChannel().catch(() => {});
          return;
        }
        next = await gen.next();
      }
      const result = next.value ?? {};
      if (result?.account) {
        await store.update((s) => {
          s.accounts = s.accounts ?? {};
          s.accounts[result.account.accountId] = result.account;
        });
        live.account = result.account;
        live.phase = 'confirmed';
        live.message = '绑定成功';
      } else if (result?.alreadyBound) {
        live.phase = 'already-bound';
        live.message = '已经绑定过了';
      } else {
        live.phase = 'error';
        live.message = result?.reason || '登录没有完成';
      }
    } catch (e) {
      live.phase = 'error';
      live.message = e?.name === 'AbortError' ? '已取消' : String(e?.message ?? e).slice(0, 200);
    } finally {
      live.running = false;
      live.qrPng = null;
      live.needsCode = false;
    }
  })();

  return loginSnapshot();
}

function hasBoundAccountCount() {
  try {
    const raw = JSON.parse(fs.readFileSync(loginStatePath(), 'utf8'));
    return Object.keys(raw.accounts ?? {}).length;
  } catch { return 0; }
}

/** Is a state file present with at least one bound account? */
export function hasBoundAccount() {
  try {
    const raw = JSON.parse(fs.readFileSync(loginStatePath(), 'utf8'));
    return Object.keys(raw.accounts ?? {}).length > 0;
  } catch {
    return false;
  }
}
