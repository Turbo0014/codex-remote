#!/usr/bin/env node
// Codex Remote bridge: serves the web UI and proxies WebSocket connections to a
// loopback-only `codex app-server`. Nothing about the Codex login or the app-server
// socket is exposed to the network directly.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer, WebSocket } from 'ws';
import { clawStatus, clawSend, clawInbound } from './clawbot.mjs';
import { startLogin, loginSnapshot, submitLoginCode, cancelLogin } from './claw-login.mjs';
import { startChannel, stopChannel, channelSnapshot, clearInbox, setChannelWorkspace, restartAccount, stopAccount, startHealing, setChannelConfig } from './claw-channel.mjs';
import { sendWechat, listAccounts, listInboundFiles, writeLabel, removeAccount } from './claw-send.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireLocal = createRequire(import.meta.url);
const WEB_DIR = path.resolve(HERE, '..', 'web');
const CONFIG_PATH = path.join(HERE, 'config.json');
const LOG_DIR = path.join(HERE, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'bridge.log');

// ---------------------------------------------------------------- config
const DEFAULTS = {
  host: '0.0.0.0',
  port: 8787,
  appServerPort: 8791,
  clashApi: 'http://127.0.0.1:9097',
  // Empty = discover at runtime (DSH_HOME runtimes, then PATH). Set it explicitly if you
  // keep python somewhere unusual.
  officePython: '',
  clashSecret: 'set-your-secret',
  appServerHost: '127.0.0.1',
  defaultCwd: process.env.CODEX_DEFAULT_CWD || '',
  cookieDays: 30,
  autoStartCodex: true,
  uploadDir: path.join(os.tmpdir(), 'codex-remote'),
};

function readConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
      console.error('[bridge] config.json is not valid JSON:', e.message);
      process.exit(2);
    }
  }
  const merged = { ...DEFAULTS, ...cfg };
  let dirty = false;
  if (!merged.passcode) { merged.passcode = crypto.randomBytes(9).toString('base64url'); dirty = true; }
  if (!merged.secret) { merged.secret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  if (!merged.codexExe) { merged.codexExe = findCodexExe(); dirty = true; }
  if (dirty) fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function saveConfig(next) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8'); } catch (e) { console.error('[bridge] cannot write config:', e.message); }
}

function findCodexExe() {
  const candidates = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const binDir = path.join(local, 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(binDir)) {
      for (const name of fs.readdirSync(binDir)) {
        const exe = path.join(binDir, name, 'codex.exe');
        if (fs.existsSync(exe)) candidates.push({ exe, mtime: fs.statSync(exe).mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.exe ?? 'codex';
}

const cfg = readConfig();

// ---------------------------------------------------------------- logging
fs.mkdirSync(LOG_DIR, { recursive: true });
function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 4 * 1024 * 1024) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    }
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch { /* logging must never throw */ }
}

// ---------------------------------------------------------------- auth
const COOKIE = 'codex_remote_session';

function sign(exp) {
  const h = crypto.createHmac('sha256', cfg.secret).update(String(exp)).digest('base64url');
  return `${exp}.${h}`;
}
function verifyCookie(value) {
  if (!value || typeof value !== 'string') return false;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = Number(value.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(exp);
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: "unauthenticated" }));
  return false;
}

function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (verifyCookie(cookies[COOKIE])) return true;
  const url = new URL(req.url, 'http://localhost');
  const t = url.searchParams.get('t');
  return Boolean(t && t === cfg.passcode);
}

const loginAttempts = new Map();
function allowAttempt(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) { loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 }); return true; }
  rec.count += 1;
  return rec.count <= 8;
}

function passcodeMatches(given) {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(cfg.passcode);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- app-server
const UPSTREAM = `ws://${cfg.appServerHost}:${cfg.appServerPort}`;
let appServer = null;
let restartTimer = null;
let restartDelay = 2000;
let shuttingDown = false;

function startAppServer() {
  if (!cfg.autoStartCodex) { log('[bridge] autoStartCodex=false; expecting an app-server on', UPSTREAM); return; }
  const args = ['app-server', '--listen', `ws://${cfg.appServerHost}:${cfg.appServerPort}`];
  log('[bridge] starting app-server:', cfg.codexExe, args.join(' '));
  appServer = spawn(cfg.codexExe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  appServer.stdout.setEncoding('utf8');
  appServer.stdout.on('data', (d) => log('[app-server:out]', d.trim()));
  appServer.stderr.setEncoding('utf8');
  appServer.stderr.on('data', (d) => log('[app-server:err]', d.trim()));

  appServer.on('error', (err) => log('[bridge] failed to spawn app-server:', err.message));
  appServer.on('exit', (code, signal) => {
    appServer = null;
    if (shuttingDown) return;
    log(`[bridge] app-server exited (code=${code} signal=${signal}); restarting in ${restartDelay}ms`);
    restartTimer = setTimeout(() => { startAppServer(); restartDelay = 5000; }, restartDelay);
  });
}

async function upstreamReady(timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${cfg.appServerHost}:${cfg.appServerPort}/readyz`, { signal: ctrl.signal });
    return res.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}

async function waitForUpstream(deadlineMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await upstreamReady()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.topojson': 'application/json; charset=utf-8',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.kml': 'application/vnd.google-earth.kml+xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const TEXT_EXT = new Set(['.txt', '.md', '.log', '.csv', '.json', '.js', '.mjs', '.ts', '.tsx', '.jsx',
  '.css', '.html', '.xml', '.yml', '.yaml', '.toml', '.ini', '.ps1', '.cmd', '.bat', '.sh', '.py',
  '.rs', '.go', '.java', '.c', '.h', '.cpp', '.sql', '.gitignore', '.env']);

// ---------------------------------------------------------------- hardening
// Serving a whole machine to the internet needs guard rails: clickjacking and
// MIME-sniffing headers, a CSP without inline script, and (most importantly) a
// readable-path scope so a stolen session cannot read C:\Windows or your SSH keys.
const GZIP_CACHE = new Map(); // etag -> gzip buffer (bounded)
const GZIP_MAX_ENTRIES = 40;


/**
 * Reject cross-site state changes. Browsers already refuse to send a Lax cookie on a
 * cross-site POST, but a proxy or a same-site subdomain could still reach us, and this
 * costs one header comparison.
 */
function sameOriginOk(req) {
  const bad = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (!bad.includes(req.method || 'GET')) return true;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const src = req.headers.origin || req.headers.referer || '';
  if (!src) return true; // curl / native client without Origin
  try {
    const u = new URL(src);
    return !host || u.host.toLowerCase() === host;
  } catch {
    return false;
  }
}
function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
}

// Paths a session may read. Anything outside is refused so a leaked cookie cannot
// exfiltrate system files. config.json -> "fileScope": "any" disables the check.
function allowedRoots() {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase()); };
  add(cfg.defaultCwd);
  add(process.env.USERPROFILE || os.homedir());
  add(os.tmpdir());
  try {
    const gsPath = path.join(os.homedir(), '.codex', '.codex-global-state.json');
    const gs = JSON.parse(fs.readFileSync(gsPath, 'utf8').replace(/^\uFEFF/, ''));
    for (const pr of Object.values(gs['local-projects'] ?? {})) {
      for (const r of pr?.rootPaths ?? []) add(r);
    }
  } catch { /* no registry yet */ }
  return [...roots];
}

function fileAllowed(target) {
  if (String(cfg.fileScope || 'home').toLowerCase() === 'any') return true;
  const p = path.resolve(target).replace(/[\\/]+$/, '').toLowerCase();
  const deny = [
    /^[a-z]:\\windows(\\|$)/,
    /\\system32(\\|$)/,
    /^[a-z]:\\program files/,
    /^[a-z]:\\programdata/,
    /\\\.ssh(\\|$)/,
    /\\\.gnupg(\\|$)/,
  ];
  if (deny.some((re) => re.test(p))) return false;
  return allowedRoots().some((root) => p === root || p.startsWith(root + '\\') || p.startsWith(root + '/'));
}

/** 403 in the JSON shape the client already understands. */
function denyPath(res, target) {
  log('[bridge] blocked out-of-scope path: ' + String(target).slice(0, 120));
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: '路径不在允许范围内（config.json 里可设 fileScope: "any"）' }));
}

/** gzip a static body, memoised by etag. */
function gzipStatic(etag, buf) {
  const hit = GZIP_CACHE.get(etag);
  if (hit) return hit;
  const gz = zlib.gzipSync(buf, { level: 6 });
  if (GZIP_CACHE.size >= GZIP_MAX_ENTRIES) GZIP_CACHE.delete(GZIP_CACHE.keys().next().value);
  GZIP_CACHE.set(etag, gz);
  return gz;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const target = path.resolve(WEB_DIR, rel);
  if (!target.startsWith(WEB_DIR + path.sep) && target !== path.join(WEB_DIR, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const isHtml = ext === '.html';
    // Code and markup must revalidate, otherwise an update stays invisible until the
    // browser cache expires. Fonts/images/attachments keep their 1-day cache.
    const revalidate = isHtml || ext === '.js' || ext === '.mjs' || ext === '.css';
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    if (revalidate && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag: etag, 'cache-control': 'no-cache' });
      res.end();
      return;
    }
    const type = MIME[ext] ?? 'application/octet-stream';
    const compressible = /^(text\/|application\/(javascript|json|xml))/.test(type) && st.size > 1024;
    const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const headers = {
      'content-type': type,
      'content-length': st.size,
      'cache-control': revalidate ? 'no-cache' : 'public, max-age=86400',
      vary: 'Accept-Encoding',
    };
    if (revalidate) headers.etag = etag;
    if (compressible && wantsGzip) {
      try {
        const gz = gzipStatic(etag, fs.readFileSync(target));
        headers['content-encoding'] = 'gzip';
        headers['content-length'] = gz.length;
        res.writeHead(200, headers);
        res.end(gz);
        return;
      } catch { /* fall back to the plain file */ }
    }
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  });
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- http server
const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  if (!sameOriginOk(req)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'cross-origin request rejected' }));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = req.socket.remoteAddress || 'unknown';

  try {
    if (url.pathname === '/healthz') {
      const ok = await upstreamReady();
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok, upstream: UPSTREAM, at: Date.now() }));
      return;
    }

    if (url.pathname === '/api/me' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authed: isAuthed(req), version: 1, defaultCwd: cfg.defaultCwd || '' }));
      return;
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      // Loopback is the machine's own owner (scripting, local checks): never throttled.
      const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLoopback && !allowAttempt(ip)) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'too many attempts, wait 5 minutes' }));
        return;
      }
      const body = await readBody(req);
      let passcode = '';
      try { passcode = JSON.parse(body).passcode ?? ''; } catch { /* ignore */ }
      if (!passcodeMatches(passcode)) {
        log(`[bridge] failed login from ${ip}`);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'wrong passcode' }));
        return;
      }
      const exp = Date.now() + cfg.cookieDays * 86400_000;
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      log(`[bridge] login ok from ${ip}`);
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `${COOKIE}=${encodeURIComponent(sign(exp))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.cookieDays * 86400}${secure}`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ---- projects: mirrored read-only from the desktop app's registry ----------
    if (url.pathname === '/api/session/reset' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
    const sid = sessionIdFor(req);
    const session = sid ? sessions.get(sid) : null;
    if (session) resetSession(session, 'client requested reset');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, found: Boolean(session) }));
    return;
  }


  // ---- WeChat web transfer window (QR login lives in that page, driven over CDP)



  if (url.pathname === '/api/threads/move' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 16 * 1024);
      const body = JSON.parse(raw || "{}");
      const threadId = String(body.threadId || "");
      if (!threadId) throw new Error("threadId required");
      const projectId = body.projectId === null || body.projectId === undefined ? null : String(body.projectId);
      const dbPath = path.join(process.env.USERPROFILE || os.homedir(), ".codex", "sqlite", "codex.db");
      // The desktop sidebar reads local_thread_catalog; the app-server knows the
      // assignment separately, so both have to be told (the client does the first).
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      try {
        const stmt = db.prepare("UPDATE local_thread_catalog SET project_id = ? WHERE thread_id = ?");
        const info = stmt.run(projectId && projectId !== "" ? projectId : null, threadId);
        out = { ok: true, updated: Number(info.changes || 0) };
      } finally {
        db.close();
      }
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(out));
    return;
  }
  // ---------------------------------------------------------------- ClawBot channel
  // ---- ClawBot accounts (one per WeChat binding) and inbound files
  if (url.pathname === '/api/claw/accounts' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const snapshot = channelSnapshot();
    const live = new Map((snapshot.accounts ?? []).map((a) => [a.accountId, a]));
    const accounts = listAccounts().map((a, i) => {
      const ch = live.get(a.accountId) ?? null;
      return {
        ...a,
        // Every account can run at once; this is the truth about each one right now.
        channel: ch ? ch.status : 'idle',
        paused: ch?.paused ?? false,
        pauseMs: ch?.remainingPauseMs ?? 0,
        lastMessageAt: ch?.lastMessageAt ?? null,
        messages: ch?.messages ?? 0,
        error: ch?.error ?? null,
        displayName: a.name || ('微信 ' + (i + 1) + ' (' + a.accountId.split('@')[0].slice(0, 4) + ')'),
      };
    });
    const active = cfg.clawAccount || accounts[0]?.accountId || null;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, accounts, active }));
    return;
  }

  // ---- per-account test / reconnect / logout
  if (url.pathname === '/api/claw/account/test' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const body = JSON.parse((await readBody(req, 8 * 1024)) || "{}");
      const id = String(body.accountId || "");
      const name = listAccounts().find((a) => a.accountId === id)?.name || id.split("@")[0];
      const r = await sendWechat({ accountId: id, text: "Codex 远程测试消息 · " + (name || "") });
      out = r;
    } catch (e) { out = { ok: false, error: e.message }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/claw/account/reconnect' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const body = JSON.parse((await readBody(req, 8 * 1024)) || "{}");
      const id = String(body.accountId || "");
      out = await restartAccount(id, cfg.defaultCwd);
    } catch (e) { out = { ok: false, error: e.message }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/claw/account/logout' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const body = JSON.parse((await readBody(req, 8 * 1024)) || "{}");
      const id = String(body.accountId || "");
      stopAccount(id);
      const removed = removeAccount(id);
      if (cfg.clawAccount === id) { delete cfg.clawAccount; saveConfig(cfg); }
      out = { ...removed, accounts: listAccounts() };
    } catch (e) { out = { ok: false, error: e.message }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname === '/api/claw/account/label' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const body = JSON.parse((await readBody(req, 8 * 1024)) || "{}");
      out = writeLabel(String(body.accountId || ""), String(body.name || ""));
    } catch (e) { out = { ok: false, error: e.message }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname === '/api/claw/account/active' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const body = JSON.parse((await readBody(req, 8 * 1024)) || "{}");
      const id = String(body.accountId || "");
      if (!listAccounts().some((a) => a.accountId === id)) throw new Error("没有这个账号");
      cfg.clawAccount = id;
      saveConfig(cfg);
      out = { ok: true, active: id };
    } catch (e) { out = { ok: false, error: e.message }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/claw/files' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const cwd = url.searchParams.get('cwd') || cfg.defaultCwd;
    const files = listInboundFiles(cwd);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, dir: cwd, files }));
    return;
  }
  // ---- ClawBot inbound channel (long poll; creates the binding the CLI needs)
  if (url.pathname === '/api/claw/channel' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(channelSnapshot()));
    return;
  }

  if (url.pathname === '/api/claw/channel/restart' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const snap = await startChannel(cfg.defaultCwd);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(snap));
    return;
  }

  if (url.pathname === '/api/claw/inbox/clear' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(clearInbox()));
    return;
  }
  // ---- ClawBot login (drives the bundled iLink client; no DSH restart needed)
  if (url.pathname === '/api/claw/login' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(loginSnapshot()));
    return;
  }

  if (url.pathname === '/api/claw/login/start' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const snap = await startLogin();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(snap));
    return;
  }

  if (url.pathname === '/api/claw/login/code' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false, error: 'bad request' };
    try {
      const body = JSON.parse((await readBody(req, 8 * 1024)) || "{}");
      out = submitLoginCode(String(body.code || ""));
    } catch (e) { out = { ok: false, error: e.message }; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/claw/login/cancel' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(cancelLogin()));
    return;
  }
  if (url.pathname === '/api/claw/status' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const st = clawStatus(cfg.clawCliPath || null);
    if (url.searchParams.get('cwd')) st.inbound = clawInbound(url.searchParams.get('cwd'));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(st));
    return;
  }

  if (url.pathname === '/api/claw/send' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let jobId = null;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 32 * 1024);
      const body = JSON.parse(raw || "{}");
      const text = String(body.text || '').slice(0, 2000);
      const file = body.file ? String(body.file) : null;
      // Explicit pick wins; otherwise the account chosen in the panel, otherwise the
      // most recently active one.
      const target = String(body.accountId || "").trim();
      const accountId = target || cfg.clawAccount || null;
      if (!text && !file) throw new Error("text or file required");
      if (file) {
        try { if (!fs.statSync(file).isFile()) throw new Error("not a file"); }
        catch { throw new Error("文件不存在：" + file); }
      }
      const job = { id: 'claw-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), state: 'running', text, file, startedAt: Date.now() };
      clawJobs.set(job.id, job);
      jobId = job.id;
      // Detached: an upload can take a while and the client polls the job.
      sendWechat({ text, file, accountId })
        .then((r) => {
          job.state = r.ok ? 'done' : 'error';
          job.message = r.message ?? r.error;
          job.code = r.code;
          job.accountId = accountId;
          job.endedAt = Date.now();
        })
        .catch((e) => { job.state = 'error'; job.message = e.message; job.endedAt = Date.now(); });
      out = { ok: true, jobId: job.id };
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/claw/job' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const id = url.searchParams.get('id');
    const job = clawJobs.get(String(id || ''));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(job ? { ok: true, job } : { ok: false, error: 'no such job' }));
    return;
  }

  if (url.pathname === '/api/claw/inbound' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const cwd = url.searchParams.get('cwd') || cfg.defaultCwd;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, files: clawInbound(cwd) }));
    return;
  }
  if (url.pathname === '/api/app/ensure' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 8 * 1024);
      const { app: key, waitMs } = JSON.parse(raw || "{}");
      out = await ensureApp(String(key || "").toLowerCase(), Math.min(180000, Number(waitMs) || 90000));
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/share' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 64 * 1024);
      const { path: target, prefer } = JSON.parse(raw || "{}");
      if (!target) throw new Error('path required');
      const resolved = path.resolve(target);
      if (!fileAllowed(resolved)) { denyPath(res, resolved); return; }
      const st = fs.statSync(resolved);
      if (!st.isFile()) throw new Error('not a file');
      const token = makeShareToken(resolved);
      const bases = shareBaseUrls();
      const base = (prefer && bases.find((b) => b.ip === prefer)?.url) || bases[0].url;
      out = { ok: true, url: base + 's/' + token, size: st.size, name: path.basename(resolved), bases };
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }




  if (url.pathname === '/api/inbox' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
    let files = [];
    try {
      files = [
        ...listWechatFiles(days, limit).map((f) => ({ ...f, source: 'wechat' })),
        ...listDownloads(Math.min(days, 7), limit),
      ];
    } catch (e) { log('[inbox] scan failed: ' + e.message); }
    files.sort((a, b) => b.mtime - a.mtime);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      files: files.slice(0, limit),
      scan: {
        at: lastWechatScan.at, roots: lastWechatScan.roots,
        accountDirs: lastWechatScan.accountDirs, dirs: lastWechatScan.dirs,
        files: lastWechatScan.files, downloadDirs: DOWNLOAD_DIRS,
      },
    }));
    return;
  }

  if (url.pathname === '/api/wechat-files' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
    let files = [];
    try { files = listWechatFiles(days, limit); } catch (e) { log('[bridge] wechat scan failed:', e.message); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, files, scan: { at: lastWechatScan.at, roots: lastWechatScan.roots, accountDirs: lastWechatScan.accountDirs, dirs: lastWechatScan.dirs, files: lastWechatScan.files } }));
    return;
  }

  if (url.pathname === '/api/threads/prune' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const out = pruneThreadCatalog();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname === '/api/fs/mkdir' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 16 * 1024);
      const { path: dir, name } = JSON.parse(raw || "{}");
      const clean = String(name || '').trim();
      if (!dir) throw new Error('缺少父目录');
      if (!clean) throw new Error('请输入文件夹名');
      if (clean.length > 100) throw new Error('名称太长');
      if (/[\\/:*?"<>|]/.test(clean)) throw new Error('名称不能包含 \\ / : * ? " < > |');
      if (clean === '.' || clean === '..') throw new Error('名称无效');
      const parent = path.resolve(dir);
      const pst = fs.statSync(parent);
      if (!pst.isDirectory()) throw new Error('父路径不是目录');
      const target = path.join(parent, clean);
      if (fs.existsSync(target)) throw new Error('同名文件夹已存在');
      fs.mkdirSync(target, { recursive: false });
      log('[fs] mkdir ' + target);
      out = { ok: true, path: target, name: clean };
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname === '/api/fs/dirs' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const raw = url.searchParams.get('path') || '';
    let out = { ok: false };
    try {
      const send = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      if (!raw.trim()) {
        const drives = [];
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
          const root = letter + ':\\';
          try { if (fs.existsSync(root)) drives.push({ name: root, path: root }); } catch { /* skip */ }
        }
        const home = process.env.USERPROFILE || os.homedir();
        const quick = [{ name: '主目录', path: home }, { name: '桌面', path: path.join(home, 'Desktop') }, { name: '文档', path: path.join(home, 'Documents') }, { name: '下载', path: path.join(home, 'Downloads') }, { name: '当前工作目录', path: cfg.defaultCwd || home }]
          .filter((q) => { try { return fs.existsSync(q.path); } catch { return false; } });
        send({ ok: true, path: '', parent: null, dirs: drives, quick, crumbs: [] });
        return;
      }
      const target = path.resolve(raw);
      const st = fs.statSync(target);
      if (!st.isDirectory()) throw new Error('不是目录');
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const dirs = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'node_modules' || e.name === '.git') continue;
        dirs.push({ name: e.name, path: path.join(target, e.name) });
        if (dirs.length >= 400) break;
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      const parent = path.dirname(target);
      const crumbs = [];
      let cur = target;
      for (;;) {
        crumbs.unshift({ name: cur === path.parse(cur).root ? cur : path.basename(cur), path: cur });
        const up = path.dirname(cur);
        if (up === cur) break;
        cur = up;
      }
      send({ ok: true, path: target, parent: parent === target ? null : parent, dirs, crumbs });
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (url.pathname === '/api/projects/mirror' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 32 * 1024);
      const body = JSON.parse(raw || '{}');
      if (body.action === 'remove') {
        if (!body.id) throw new Error('id required');
        out = unmirrorProject(String(body.id));
      } else {
        out = mirrorProject({ id: body.id, name: body.name, roots: body.roots });
      }
      log('[projects] mirror ' + JSON.stringify(out));
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname === '/api/projects' && req.method === 'GET') {
      if (!isAuthed(req)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error":"unauthenticated"}');
        return;
      }
      const gsPath = path.join(process.env.USERPROFILE || os.homedir(), '.codex', '.codex-global-state.json');
      const empty = {
        projects: [], assignments: {}, projectless: [], order: null, defaultCwd: cfg.defaultCwd || '',
      };
      try {
        const gs = JSON.parse(fs.readFileSync(gsPath, 'utf8').replace(/^\uFEFF/, ''));
        const local = gs['local-projects'] ?? {};
        const projects = Object.values(local)
          .filter((x) => x && x.id)
          .map((x) => ({
            id: x.id,
            name: x.name || (x.rootPaths?.[0] ? path.basename(x.rootPaths[0]) : x.id),
            roots: x.rootPaths ?? [],
            createdAt: x.createdAt ?? null,
            updatedAt: x.updatedAt ?? null,
          }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          projects,
          assignments: gs['thread-project-assignments'] ?? {},
          projectless: gs['projectless-thread-ids'] ?? [],
          order: gs['project-order'] ?? null,
          defaultCwd: cfg.defaultCwd || '',
        }));
      } catch (e) {
        log('[bridge] projects read failed:', e.message);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(empty));
      }
      return;
    }

    // ---- attachments: iPad/desktop file picker and drag-drop land here --------
    // Copy an attachment into the working directory so the agent can actually read it.
  if (url.pathname.startsWith('/s/') && req.method === 'GET') {
    const file = readShareToken(url.pathname.slice(3));
    if (!file) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('链接已过期或无效'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('文件不存在'); return; }
      const name = path.basename(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': st.size,
        'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
        'cache-control': 'private, max-age=300',
      });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  // ---------------------------------------------------------------- clash / network
  if (url.pathname === '/api/clash/autoswitch' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const out = {
      ok: true,
      enabled: autoswitch.enabled,
      intervalSec: autoswitch.intervalSec,
      busy: autoswitch.busy,
      last: autoswitch.last,
      lastSwitch: autoswitch.lastSwitch,
      switches: autoswitch.switches,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/clash/autoswitch' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw || "{}");
      if (typeof body.enabled === 'boolean') autoswitch.enabled = body.enabled;
      if (body.intervalSec !== undefined) {
        autoswitch.intervalSec = Math.min(Math.max(Number(body.intervalSec) || 180, 30), 3600);
      }
      saveAutoswitch();
      if (autoswitch.enabled) { startAutoswitchTimer(); autoSwitchTick().catch(() => {}); }
      else if (autoswitch.timer) { clearInterval(autoswitch.timer); autoswitch.timer = null; }
      out = { ok: true, enabled: autoswitch.enabled, intervalSec: autoswitch.intervalSec };
      log('[clash] autoswitch ' + (autoswitch.enabled ? 'on (' + autoswitch.intervalSec + 's)' : 'off'));
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname === '/api/clash/probe' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 64 * 1024);
      const { node, group: g } = JSON.parse(raw || "{}");
      if (!node) throw new Error('node required');
      const snap = await clashSnapshot();
      const groupName = g ?? snap.defaultGroup ?? snap.groups[0]?.name;
      const result = await probeNode(groupName, node);
      out = { ok: true, group: groupName, ...result };
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/clash/autopick' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw || "{}");
      const snap = await clashSnapshot();
      const groupName = body.group ?? snap.defaultGroup ?? snap.groups[0]?.name;
      // 0 (or omitted) means every node in the group
      const limit = body.limit === undefined ? 0 : Math.min(Math.max(Number(body.limit) || 0, 0), 200);
      const id = startAutopick(groupName, limit);
      out = { ok: true, id, group: groupName, limit };
      log('[clash] autopick start ' + id + ' group=' + groupName + ' limit=' + limit);
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/clash/autopick' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const id = url.searchParams.get('id') ?? '';
    const job = autopickJobs.get(id);
    const out = job ? { ok: true, job } : { ok: false, error: 'job not found' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname === '/api/clash' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const out = await clashSnapshot();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/clash/select' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 64 * 1024);
      const { group, node } = JSON.parse(raw || "{}");
      if (!group || !node) throw new Error('group and node are required');
      const r = await clashFetch(`/proxies/${encodeURIComponent(group)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: node }),
      });
      if (r.status >= 300) throw new Error(`clash returned ${r.status}`);
      out = { ok: true, group, node };
      log('[clash] switched ' + group + ' -> ' + node);
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/clash/test' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw || "{}");
      const snap = await clashSnapshot();
      const group = body.group ?? snap.groups[0]?.name ?? null;
      const node = body.node ?? snap.groups.find((g) => g.name === group)?.now ?? null;
      const delay = node ? await clashDelay(node) : { ok: false, error: "no node" };
      const codex = await codexProbe();
      out = { ok: true, group, node, delay, codex, at: Date.now() };
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname === '/api/attach/import' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let out = { ok: false };
    try {
      const raw = await readBody(req, 64 * 1024);
      const { path: src, cwd } = JSON.parse(raw || '{}');
      if (!src || !cwd) throw new Error('src and cwd are required');
      const st = fs.statSync(src);
      if (!st.isFile()) throw new Error('not a file');
      // refuse anything that is already inside cwd
      const rel0 = path.relative(cwd, src);
      if (rel0 && !rel0.startsWith('..') && !path.isAbsolute(rel0)) {
        out = { ok: true, path: src, relative: rel0.split(path.sep).join('/'), copied: false };
      } else {
        const dir = path.join(cwd, '.attachments');
        fs.mkdirSync(dir, { recursive: true });
        const base = path.basename(src).replace(/[\\/:*?"<>|]/g, '_');
        let dest = path.join(dir, base);
        let n = 1;
        while (fs.existsSync(dest)) {
          const ext = path.extname(base);
          dest = path.join(dir, `${path.basename(base, ext)}-${n++}${ext}`);
        }
        fs.copyFileSync(src, dest);
        out = { ok: true, path: dest, relative: path.relative(cwd, dest).split(path.sep).join('/'), copied: true };
      }
      log('[attach] imported ' + (out.copied ? 'copy' : 'in place') + ' -> ' + out.relative);
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/upload' && req.method === 'POST') {
      if (!isAuthed(req)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error":"unauthenticated"}');
        return;
      }
      const MAX = 512 * 1024 * 1024;
      const rawName = (() => {
        try { return decodeURIComponent(String(req.headers['x-filename'] || 'upload.bin')); }
        catch { return 'upload.bin'; }
      })();
      const safe = path.basename(rawName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-120) || 'upload.bin';
      fs.mkdirSync(cfg.uploadDir, { recursive: true });
      const dest = path.join(cfg.uploadDir, `${Date.now().toString(36)}-${safe}`);
      const out = fs.createWriteStream(dest);
      let size = 0;
      let aborted = false;

      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX && !aborted) {
          aborted = true;
          out.destroy();
          fs.rm(dest, { force: true }, () => {});
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'file too large (max 512 MB)' }));
          req.destroy();
        }
      });
      req.pipe(out);
      out.on('error', (e) => {
        log('[bridge] upload write failed:', e.message);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"ok":false,"error":"write failed"}');
      });
      out.on('finish', () => {
        if (aborted) return;
        log(`[bridge] upload ${safe} (${size} bytes) -> ${dest}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: dest, name: safe, size }));
      });
      return;
    }

    // ---- file/image viewing + download ---------------------------------------
    if (url.pathname === '/api/office-images' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const target = url.searchParams.get('path');
    let out = { ok: false };
    if (!target) out = { ok: false, error: 'path required' };
    else {
      try {
        const resolved = path.resolve(target);
      if (!fileAllowed(resolved)) { denyPath(res, resolved); return; }
        const st = fs.statSync(resolved);
        if (!st.isFile()) throw new Error('not a file');
        if (st.size > 300 * 1024 * 1024) throw new Error('文件超过 300MB');
        const pdf = await ensurePdf(resolved);
        if (!pdf.ok) throw new Error(pdf.error || '无法转换');
        const r = await rasterisePdf(pdf.pdf);
        if (!r.ok) throw new Error(r.error || '无法渲染');
        out = {
          ok: true,
          key: r.key,
          count: r.count,
          pages: Array.from({ length: r.count }, (_, i) => '/api/office-page?k=' + r.key + '&i=' + (i + 1)),
        };
      } catch (e) {
        out = { ok: false, error: e.message };
      }
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/office-page' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const key = String(url.searchParams.get('k') || '');
    const idx = Number(url.searchParams.get('i') || '0');
    if (!/^[0-9a-f]{8,32}$/.test(key) || !(idx >= 1)) { res.writeHead(400).end('bad request'); return; }
    const file = path.join(PDF_IMG_DIR, 'img-' + key, 'page-' + String(idx).padStart(3, '0') + '.jpg');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': st.size, 'cache-control': 'private, max-age=86400' });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  if (url.pathname === '/api/office-pdf' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!requireAuth(req, res)) return;
    const target = url.searchParams.get('path');
    if (!target) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false,"error":"path required"}'); return; }
    const resolved = path.resolve(target);
      if (!fileAllowed(resolved)) { denyPath(res, resolved); return; }
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile()) throw new Error('not a file');
      if (st.size > 200 * 1024 * 1024) throw new Error('文件超过 200MB');
      const ext = path.extname(resolved).toLowerCase();
      if (!OFFICE_EXTS.has(ext)) throw new Error('不是 Office 文件');
      const r = await convertOfficeToPdf(resolved);
      if (!r.ok) {
        res.writeHead(415, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: r.error }));
        return;
      }
      const stat = fs.statSync(r.pdf);
      if (url.searchParams.get('probe') === '1') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, bytes: stat.size, cached: Boolean(r.cached) }));
        return;
      }
      const headers = { 'content-type': 'application/pdf', 'content-length': stat.size, 'cache-control': 'private, max-age=300' };
      if (url.searchParams.get('download') === '1') {
        headers['content-disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(resolved, ext) + '.pdf');
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(r.pdf).pipe(res);
    } catch (e) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (url.pathname === '/api/office-text' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const target = url.searchParams.get('path');
    if (!target) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false,"error":"path required"}'); return; }
    try {
      const out = officeText(path.resolve(target));
      if (!fileAllowed(target)) { denyPath(res, target); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (url.pathname === '/api/file' && req.method === 'GET') {
      if (!isAuthed(req)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error":"unauthenticated"}');
        return;
      }
      const target = url.searchParams.get('path');
      if (!target) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"path required"}'); return; }
      // Relative paths are resolved against ?cwd=, then the configured default.
      // Resolving only against the bridge's own cwd produced 404s for model-emitted
      // paths like "outputs/browser-e2e-20261107/REPORT.md".
      const baseDir = url.searchParams.get('cwd') || cfg.defaultCwd || null;
      let resolved = path.resolve(target);
      if (!path.isAbsolute(target) && baseDir) {
        const candidate = path.resolve(baseDir, target);
        if (fileAllowed(candidate)) resolved = candidate;
      }
      if (!fileAllowed(resolved)) { denyPath(res, resolved); return; }
      fs.stat(resolved, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not a file: ' + resolved);
          return;
        }
        const ext = path.extname(resolved).toLowerCase();
        const mime = MIME[ext] ?? (TEXT_EXT.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
        const headers = {
          'content-type': mime,
          'content-length': st.size,
          'cache-control': 'private, max-age=60',
        };
        if (url.searchParams.get('download') === '1' || mime === 'application/octet-stream') {
          headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`;
        }
        // Range support so Safari can stream video/PDF previews.
        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
          if (m) {
            const start = m[1] ? Number(m[1]) : 0;
            const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
            if (start <= end) {
              headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
              headers['content-length'] = end - start + 1;
              res.writeHead(206, headers);
              fs.createReadStream(resolved, { start, end }).pipe(res);
              return;
            }
          }
        }
        res.writeHead(200, headers);
        fs.createReadStream(resolved).pipe(res);
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (err) {
    log('[bridge] http error:', err.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error');
    else res.end();
  }
});

// ---------------------------------------------------------------- wechat files
// WeChat 4.x keeps received documents with their real names under
//   %USERPROFILE%\Documents\xwechat_files\<account>\msg\file\<YYYY-MM>\<name>
// while images go to hashed .dat caches. 3.x used WeChat Files\<acct>\FileStorage\File.
const WECHAT_ROOTS = [
  path.join(process.env.USERPROFILE || '', 'Documents', 'xwechat_files'),
  path.join(process.env.USERPROFILE || '', 'Documents', 'WeChat Files'),
  path.join(process.env.USERPROFILE || '', 'Documents', 'WeChat_Files'),
];
// Documents only: WeChat stores images/voice as hashed .dat blobs, which carry no
// usable name, so they would be noise in a picker.
const WECHAT_DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|txt|md|markdown|csv|json|xml|ya?ml|toml|ini|log|apk|ipa|exe|msi|sh|ps1|py|js|ts|sql|db3|epub|mobi|dwg|psd|ai|sketch|fig)$/i;
const WECHAT_DENY_DIR = /^(db_storage|cache|temp|log|logs|config|resource|radix|radium|crashinfo|sqlite|Backup|all_users|migrate|emoji|emoticon|favorite|head_image|head_imgs|sns|openim|finder|net|uh|ilink|update|xplugin|xplayer|whatsnew)$/i;

let lastWechatScan = { at: 0, roots: [], dirs: 0, files: 0, accountDirs: [] };

function walkWechatFiles(dir, out, cutoff, depth = 0) {
  if (depth > 5 || out.length > 600) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (WECHAT_DENY_DIR.test(ent.name)) continue;
      walkWechatFiles(full, out, cutoff, depth + 1);
      continue;
    }
    if (!WECHAT_DOC_EXT.test(ent.name)) continue;
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || st.mtimeMs < cutoff) continue;
    out.push({ name: ent.name, path: full, size: st.size, mtime: Math.round(st.mtimeMs / 1000) });
  }
}

function wechatRoots() {
  const roots = [...(cfg.wechatDirs ?? [])];
  const docs = path.join(process.env.USERPROFILE || '', 'Documents');
  // Any folder on the usual drives whose name looks like WeChat's data root.
  return roots.length ? roots : WECHAT_ROOTS;
}

function listWechatFiles(days = 30, limit = 60) {
  const cutoff = Date.now() - days * 86400 * 1000;
  const out = [];
  const scanned = { at: Date.now(), roots: [], dirs: 0, files: 0, accountDirs: [] };

  for (const root of wechatRoots()) {
    let accounts = [];
    try { accounts = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^wxid_|^[0-9a-f]{10,}/i.test(d.name)); } catch { continue; }
    scanned.roots.push(root);
    for (const acct of accounts) {
      const acctDir = path.join(root, acct.name);
      scanned.accountDirs.push(acctDir);
      // walk the whole account dir; the deny list keeps it cheap
      walkWechatFiles(acctDir, out, cutoff);
    }
  }
  scanned.dirs = [...new Set(out.map((f) => path.dirname(f.path)))].length;
  scanned.files = out.length;
  lastWechatScan = scanned;

  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- browser downloads
// The WeChat "仅传输文件" window is a web page (szfilehelper.weixin.qq.com), so its
// files arrive through the browser's download folder. We watch that folder and use
// the browser's own download history to tell which ones came from WeChat.
const DOWNLOAD_DIRS = [
  path.join(process.env.USERPROFILE || '', 'Downloads'),
  path.join(process.env.USERPROFILE || '', '下载'),
];

const HISTORY_PROFILES = [
  // downloads triggered from the dedicated WeChat window land in that profile's history
  path.join(process.env.LOCALAPPDATA || '', 'codex-remote-webtransfer', 'Default'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default'),
  path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default'),
];

let originCache = { at: 0, map: new Map() };

/** target_path -> 'weixin' | 'other', from the browser download history. */
function downloadOrigins() {
  if (Date.now() - originCache.at < 15000) return originCache.map;
  const map = new Map();
  let DatabaseSync = null;
  try { ({ DatabaseSync } = requireLocal('node:sqlite')); } catch (e) { log('[inbox] node:sqlite unavailable: ' + e.message); }
  if (DatabaseSync) {
    for (const dir of HISTORY_PROFILES) {
      const src = path.join(dir, 'History');
      if (!fs.existsSync(src)) continue;
      const tmp = path.join(os.tmpdir(), 'codex-remote-history-' + process.pid + '-' + Date.now() + '.db');
      try {
        fs.copyFileSync(src, tmp);
        for (const ext of ['-wal', '-shm']) {
          if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, tmp + ext);
        }
        const db = new DatabaseSync(tmp, { readOnly: true });
        const rows = db.prepare(`
          SELECT d.target_path AS target, d.tab_referrer_url AS tabref, d.referrer AS ref,
                 (SELECT GROUP_CONCAT(url, ' ') FROM downloads_url_chains c WHERE c.id = d.id) AS chain
          FROM downloads d
          ORDER BY d.start_time DESC LIMIT 200
        `).all();
        for (const r of rows) {
          if (!r.target) continue;
          const origin = [r.tabref, r.ref, r.chain].filter(Boolean).join(' ');
          map.set(path.normalize(String(r.target)), /weixin\\.qq\\.com|szfilehelper/i.test(origin) ? 'weixin' : 'other');
        }
        db.close();
      } catch (e) {
        log('[inbox] history read failed: ' + e.message);
      } finally {
        for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      }
    }
  }
  originCache = { at: Date.now(), map };
  return map;
}

function listDownloads(days = 3, limit = 40) {
  const cutoff = Date.now() - days * 86400 * 1000;
  const origins = downloadOrigins();
  const out = [];
  for (const dir of DOWNLOAD_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!WECHAT_DOC_EXT.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const origin = origins.get(path.normalize(full)) || 'unknown';
      out.push({
        name: ent.name, path: full, size: st.size,
        mtime: Math.round(st.mtimeMs / 1000),
        source: origin === 'weixin' ? 'weixin' : 'download',
        origin,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- wechat watch
const wechatSubs = new Set();
let wechatKnown = new Map(); // path -> mtime (seconds)
let wechatWatchStarted = false;

function wechatBroadcast(payload) {
  const frame = 'event: file\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const res of wechatSubs) {
    try { res.write(frame); } catch { wechatSubs.delete(res); }
  }
}


// The ClawBot channel is the file source now; nothing else announces downloads.


// Generic SSE event next to the file watcher.
function wechatBroadcastEvent(event, payload) {
  const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const res of wechatSubs) {
    try { res.write(frame); } catch { wechatSubs.delete(res); }
  }
}

// Login watcher: the QR flow has no callback, so poll the page and announce the
// transition once. null = not probed yet, false = logged out, true = logged in.
let wechatLoginState = null;

/** Tell the newly logged-in account that remote control is live (once per login). */

// --- greeting bookkeeping -------------------------------------------------
const GREET_FILE = path.join(HERE, 'wechat-greeted.json');
const GREET_MIN_GAP_MS = 30 * 60 * 1000;
function readGreetState() {
  try { return JSON.parse(fs.readFileSync(GREET_FILE, 'utf8')); } catch { return {}; }
}
function writeGreetState(obj) {
  try { fs.writeFileSync(GREET_FILE, JSON.stringify(obj)); } catch { /* best effort */ }
}
/** True when we have not greeted this account recently. */
function shouldGreet(name) {
  const st = readGreetState();
  const last = Number(st[name || 'unknown'] || 0);
  return Date.now() - last > GREET_MIN_GAP_MS;
}
function markGreeted(name) {
  const st = readGreetState();
  st[name || 'unknown'] = Date.now();
  writeGreetState(st);
}

async function sendLoginGreeting(name) {
  const when = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate())
    + " " + pad(when.getHours()) + ":" + pad(when.getMinutes()) + ":" + pad(when.getSeconds());
  const text = "\u2705 Codex \u8fdc\u7a0b\u5df2\u8fde\u63a5"
    + "\n\u8d26\u53f7\uff1a" + (name || "\u672a\u77e5")
    + "\n\u65f6\u95f4\uff1a" + stamp
    + "\n\u4e4b\u540e\u5728\u7f51\u9875\u91cc\u4fdd\u5b58\u7684\u6587\u4ef6\u4f1a\u53d1\u5230\u8fd9\u91cc\u3002";
  try {
    const r = await wechatWeb.sendText(text, log);
    if (r?.ok) log("[wechat] login greeting sent");
    else log("[wechat] login greeting failed: " + (r?.error || "unknown"));
    return r;
  } catch (e) {
    log("[wechat] login greeting threw: " + e.message);
    return { ok: false, error: e.message };
  }
}
function watchWechatLogin() {
  log("[wechat] login watcher started (5s)");
  setInterval(async () => {
    let st;
    try { st = await wechatWeb.state(() => {}); } catch { return; }
    const now = Boolean(st?.loggedIn);
    const name = st?.name ?? null;
    if (wechatLoginState === null) {
      wechatLoginState = now;
      // First probe after a restart: if the account is already logged in we still want
      // one confirmation message (the scan may have happened while we were down).
      if (now && shouldGreet(name)) {
        log("[wechat] already logged in as " + (name || "unknown") + ", greeting once");
        wechatBroadcastEvent("login", { name });
        setTimeout(() => {
          markGreeted(name);
          sendLoginGreeting(name).then((r) => wechatBroadcastEvent("greeting", { ok: Boolean(r?.ok) })).catch(() => {});
        }, 1500);
      }
      return;
    }
    if (now && !wechatLoginState) {
      wechatLoginState = true;
      log("[wechat] logged in as " + (name || "unknown"));
      markGreeted(name);
      wechatBroadcastEvent("login", { name });
      // The page needs a moment to settle before the input exists.
      setTimeout(() => { sendLoginGreeting(name).then((r) => wechatBroadcastEvent("greeting", { ok: Boolean(r?.ok) })).catch(() => {}); }, 2500);
    } else if (!now && wechatLoginState) {
      wechatLoginState = false;
      log("[wechat] logged out");
      wechatBroadcastEvent("logout", {});
    } else {
      wechatLoginState = now;
    }
  }, 5000).unref();
}
function startWechatWatch() {
  if (wechatWatchStarted) return;
  wechatWatchStarted = true;
  // Baseline: everything already on disk is "old" — never auto-attach history.
  try { for (const f of listWechatFiles(7, 500)) wechatKnown.set(f.path, f.mtime); } catch { /* ignore */ }
  setInterval(() => {
    if (!wechatSubs.size) return;
    let now = [];
    try { now = listWechatFiles(1, 200); } catch { /* ignore */ }
    try {
      for (const d of listDownloads(1, 100)) {
        // only classify once; unknown stays unknown until the history catches up
        now.push(d);
      }
    } catch { /* ignore */ }
    for (const f of now) {
      if (!f.path) continue;
      if (wechatKnown.get(f.path) === f.mtime) continue;
      // A download whose origin is not known yet must NOT be marked as handled:
      // the browser writes its history a moment later, and we want to re-evaluate.
      if (f.source === 'download' && f.origin === 'unknown') continue;
      wechatKnown.set(f.path, f.mtime);
      log('[wechat] new file: ' + f.name + ' (' + f.size + 'B)');
      wechatBroadcast(f);
    }
    // keep the map from growing forever
    if (wechatKnown.size > 2000) {
      const keep = new Map([...wechatKnown].slice(-1000));
      wechatKnown = keep;
    }
  }, 4000).unref();
  log('[wechat] watcher started');
  watchWechatLogin();
}

// ---------------------------------------------------------------- websocket proxy
// One upstream app-server connection per browser identity ("session"). A browser
// socket is a *subscriber* of that session, not its owner: closing the tab detaches
// the subscriber but the session — and any turn running inside it — survives.
// ---------------------------------------------------------------- clash / network helpers
function clashHeaders() {
  const h = {};
  if (cfg.clashSecret) h.authorization = 'Bearer ' + cfg.clashSecret;
  return h;
}

async function clashFetch(pathname, opts = {}) {
  const base = cfg.clashApi || 'http://127.0.0.1:9097';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    return await fetch(base + pathname, {
      ...opts,
      headers: { ...clashHeaders(), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function clashSnapshot() {
  try {
    const pxRes = await clashFetch('/proxies');
    const px = await pxRes.json();
    const cfgRes = await clashFetch('/configs');
    const conf = await cfgRes.json();
    // Which groups does traffic actually traverse? In rule mode GLOBAL is not used.
    let liveChains = [];
    try {
      const cRes = await clashFetch('/connections');
      const cJson = await cRes.json();
      const counts = new Map();
      for (const c of cJson.connections ?? []) {
        const chain = c.chains ?? [];
        if (chain.length < 2) continue;
        const key = chain[0] + "\u0000" + chain[1];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      liveChains = [...counts.entries()]
        .map(([k, n]) => { const [node, group] = k.split("\u0000"); return { node, group, count: n }; })
        .sort((a, b) => b.count - a.count);
    } catch { /* connections is best-effort */ }
    const groups = [];
    for (const [name, p] of Object.entries(px.proxies ?? {})) {
      if (!['Selector', 'URLTest', 'Fallback', 'LoadBalance'].includes(p.type)) continue;
      groups.push({
        name,
        type: p.type,
        now: p.now ?? null,
        nodes: (p.all ?? []).map((n) => ({
          name: n,
          type: px.proxies?.[n]?.type ?? null,
          delay: px.proxies?.[n]?.history?.length ? (px.proxies[n].history[px.proxies[n].history.length - 1].delay || null) : null,
        })),
      });
    }
    const inUse = [...new Set(liveChains.map((c) => c.group))];
    const defaultGroup = inUse[0]
      ?? groups.find((g) => g.type === 'Selector' && g.name !== 'GLOBAL')?.name
      ?? groups[0]?.name
      ?? null;
    return { ok: true, mode: conf.mode ?? null, mixedPort: conf['mixed-port'] ?? null, groups, liveChains, inUse, defaultGroup };
  } catch (e) {
    return { ok: false, error: e.message, groups: [] };
  }
}

async function clashDelay(node) {
  try {
    const u = '/proxies/' + encodeURIComponent(node) + '/delay?timeout=5000&url=' + encodeURIComponent('https://www.gstatic.com/generate_204');
    const t0 = Date.now();
    const r = await clashFetch(u, { timeoutMs: 9000 });
    const j = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (typeof j.delay === 'number' && j.delay > 0) return { ok: true, ms: j.delay };
    return { ok: false, ms, error: j.message || 'unreachable' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Ask the app-server for account rate limits: proves the Codex upstream works right now. */

// ---------------------------------------------------------------- node probing
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);
const INFO_ROW = /^(剩余流量|套餐|到期|官网|订阅|重置|客服|网址|流量)/;
const autopickJobs = new Map();
const SETTLE_MS = 0;
const PROBE_TIMEOUT_MS = 4000;

function realNodes(group) {
  return (group?.nodes ?? []).filter((n) => n.type && !GROUP_TYPES.has(n.type) && !INFO_ROW.test(n.name));
}

async function switchNode(groupName, nodeName) {
  const r = await clashFetch('/proxies/' + encodeURIComponent(groupName), {
    method: 'PUT',
    body: JSON.stringify({ name: nodeName }),
  });
  if (r.status >= 300) throw new Error('clash returned ' + r.status);
}

// Codex errors can embed whole HTML pages; keep API responses and tooltips small.
function shortErr(msg) {
  const s = String(msg ?? '');
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 180 ? oneLine.slice(0, 180) + '…' : oneLine;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One persistent app-server connection for probing: the handshake costs 1-2s and would
// otherwise dominate every single measurement.
let probeWs = null;
let probeReady = null;
let probeSeq = 1;
const probePending = new Map();

function probeSocket() {
  if (probeReady) return probeReady;
  probeReady = new Promise((resolve, reject) => {
    const ws = new WebSocket(UPSTREAM, { headers: { 'user-agent': 'codex-remote-probe' } });
    const fail = (e) => { probeReady = null; probeWs = null; reject(e instanceof Error ? e : new Error(String(e))); };
    ws.once('error', fail);
    ws.once('open', () => {
      ws.on('error', () => { probeReady = null; probeWs = null; });
      ws.on('close', () => { probeReady = null; probeWs = null; });
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.id !== undefined && probePending.has(m.id)) {
          const p = probePending.get(m.id);
          probePending.delete(m.id);
          p(m);
        }
      });
      probePending.set(0, (m) => {
        if (m.error) { fail(new Error(m.error.message ?? 'init failed')); return; }
        ws.send(JSON.stringify({ method: 'initialized' }));
        probeWs = ws;
        resolve(ws);
      });
      ws.send(JSON.stringify({
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: { name: 'codex-remote-probe', title: 'probe', version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      }));
    });
  });
  return probeReady;
}

/** One account/rateLimits/read round trip on the shared connection. */
async function codexProbeFast() {
  const t0 = Date.now();
  try {
    const ws = await probeSocket();
    const id = probeSeq++;
    const reply = await Promise.race([
      new Promise((res) => {
        probePending.set(id, res);
        ws.send(JSON.stringify({ method: 'account/rateLimits/read', id, params: {} }));
      }),
      new Promise((res) => setTimeout(() => res({ timeout: true }), PROBE_TIMEOUT_MS)),
    ]);
    if (reply.timeout) {
      probeReady = null;
      try { ws.close(); } catch {}
      return { ok: false, ms: Date.now() - t0, error: 'timeout' };
    }
    if (reply.error) {
      return { ok: false, ms: Date.now() - t0, error: shortErr(reply.error.message ?? JSON.stringify(reply.error)) };
    }
    const rl = reply.result ?? {};
    const b = Array.isArray(rl.buckets) ? rl.buckets[0] : (rl.buckets ?? rl);
    return { ok: true, ms: Date.now() - t0, usedPercent: b?.usedPercent ?? null, resetAt: b?.resetsAt ?? null };
  } catch (e) {
    probeReady = null;
    return { ok: false, ms: Date.now() - t0, error: shortErr(e.message) };
  }
}

/** One-off probe with a fresh connection (used by the single node test). */
function codexProbe() {
  return new Promise((resolve) => {
    const ws = new WebSocket(UPSTREAM, { headers: { 'user-agent': 'codex-remote-bridge' } });
    const t0 = Date.now();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => finish({ ok: false, ms: Date.now() - t0, error: 'timeout' }), 12000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: { name: 'codex-remote-probe', title: 'probe', version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      }));
    });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id === 1 && m.result) {
        ws.send(JSON.stringify({ method: 'initialized' }));
        ws.send(JSON.stringify({ method: 'account/rateLimits/read', id: 2, params: {} }));
        return;
      }
      if (m.id === 1 && m.error) {
        clearTimeout(timer);
        finish({ ok: false, ms: Date.now() - t0, error: m.error.message ?? 'init failed' });
        return;
      }
      if (m.id === 2) {
        clearTimeout(timer);
        const rl = m.result ?? {};
        const b = Array.isArray(rl.buckets) ? rl.buckets[0] : (rl.buckets ?? rl);
        finish({ ok: !m.error, ms: Date.now() - t0, usedPercent: b?.usedPercent ?? null, resetAt: b?.resetsAt ?? null, error: m.error ? shortErr(m.error.message) : null });
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); finish({ ok: false, ms: Date.now() - t0, error: e.message }); });
    ws.on('close', () => { clearTimeout(timer); finish({ ok: false, ms: Date.now() - t0, error: 'closed' }); });
  });
}

/** Switch to the node, settle, then measure Codex through it. */
async function probeNode(groupName, nodeName, knownDelay = null) {
  // Switching takes effect for new connections immediately, so no settle wait.
  try {
    await switchNode(groupName, nodeName);
  } catch (e) {
    return { node: nodeName, delay: knownDelay, codex: { ok: false, error: 'switch failed: ' + e.message } };
  }
  const codex = await codexProbeFast();
  return { node: nodeName, delay: knownDelay, codex };
}

/** Clash-level delay test for many nodes in parallel; no switching, no disruption. */
async function prefilterReachable(nodes) {
  const out = [];
  const queue = nodes.slice();
  // mihomo throttles concurrent delay tests (503/504 beyond ~6), so stay conservative.
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const n = queue.shift();
      if (!n) break;
      const d = await clashDelay(n.name);
      if (d.ok) out.push(n);
    }
  });
  await Promise.all(workers);
  return out;
}
/**
 * Sweep nodes serially (traffic goes through one node at a time). limit <= 0 means all.
 */
async function runSweep(groupName, limit, onProgress) {
  const snap = await clashSnapshot();
  const group = snap.groups.find((g) => g.name === groupName);
  const original = group?.now ?? null;
  let pool = realNodes(group);
  let skipped = 0;
  if (limit > 0) {
    pool = pool
      .filter((n) => typeof n.delay === 'number' && n.delay > 0)
      .sort((a, b) => a.delay - b.delay)
      .slice(0, limit);
  } else {
    // Dead nodes would each burn a full timeout; ask Clash first (parallel, no switching).
    if (pool.length > 6) {
      const before = pool.length;
      const reachable = await prefilterReachable(pool);
      if (reachable.length >= 2) pool = reachable;
      skipped = before - pool.length;
    }
    pool = pool.slice().sort((a, b) => {
      const da = typeof a.delay === 'number' && a.delay > 0 ? a.delay : 1e9;
      const db = typeof b.delay === 'number' && b.delay > 0 ? b.delay : 1e9;
      return da - db;
    });
  }
  const job = { group: groupName, original, total: pool.length, skipped, done: 0, results: [], best: null, selected: null, startedAt: Date.now() };
  // Stop early once a clearly good node is confirmed: further probing costs ~1s each and
  // rarely changes the winner.
  const GOOD_ENOUGH_MS = 800;
  const MIN_TESTS = 6;
  for (const n of pool) {
    const res = await probeNode(groupName, n.name, n.delay ?? null);
    job.results.push(res);
    job.done = job.results.length;
    if (onProgress) onProgress(job);
    const bestSoFar = job.results.filter((r) => r.codex && r.codex.ok).sort((a, b) => a.codex.ms - b.codex.ms)[0];
    if (bestSoFar && bestSoFar.codex.ms <= GOOD_ENOUGH_MS && job.done >= MIN_TESTS) {
      job.earlyStop = true;
      log('[clash] sweep stopped early at ' + job.done + '/' + job.total + ' (' + bestSoFar.node + ' ' + bestSoFar.codex.ms + 'ms)');
      break;
    }
  }
  const ok = job.results.filter((r) => r.codex?.ok).sort((a, b) => a.codex.ms - b.codex.ms);
  job.best = ok[0] ?? null;
  const target = job.best?.node ?? original;
  if (target) { try { await switchNode(groupName, target); } catch {} }
  job.selected = target;
  job.finishedAt = Date.now();
  return job;
}

function startAutopick(groupName, limit) {
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, state: 'running', group: groupName, total: 0, done: 0, results: [], best: null, startedAt: Date.now() };
  autopickJobs.set(id, job);
  runSweep(groupName, limit, (progress) => {
    job.total = progress.total;
    job.done = progress.done;
    job.results = progress.results;
  })
    .then((final) => {
      Object.assign(job, final, { state: 'done' });
      log('[clash] autopick ' + id + ' tested=' + final.total + ' best=' + (final.best?.node ?? 'none') + ' selected=' + (final.selected ?? '-'));
    })
    .catch((e) => { job.state = 'error'; job.error = e.message; })
    .finally(() => { job.finishedAt = Date.now(); });
  return id;
}

// ---------------------------------------------------------------- auto switch
const AUTOSWITCH_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'autoswitch.json');
const autoswitch = { enabled: false, intervalSec: 180, timer: null, busy: false, last: null, lastSwitch: null, switches: 0 };

function loadAutoswitch() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTOSWITCH_FILE, 'utf8'));
    autoswitch.enabled = Boolean(j.enabled);
    autoswitch.intervalSec = Math.min(Math.max(Number(j.intervalSec) || 180, 30), 3600);
  } catch { /* first run */ }
  if (autoswitch.enabled) startAutoswitchTimer();
}

function saveAutoswitch() {
  try {
    fs.writeFileSync(AUTOSWITCH_FILE, JSON.stringify({ enabled: autoswitch.enabled, intervalSec: autoswitch.intervalSec }, null, 2));
  } catch (e) { log('[clash] autoswitch save failed: ' + e.message); }
}

function startAutoswitchTimer() {
  if (autoswitch.timer) clearInterval(autoswitch.timer);
  autoswitch.timer = setInterval(() => { autoSwitchTick().catch(() => {}); }, autoswitch.intervalSec * 1000);
  if (autoswitch.timer.unref) autoswitch.timer.unref();
}

async function autoSwitchTick() {
  if (!autoswitch.enabled || autoswitch.busy) return;
  autoswitch.busy = true;
  try {
    const snap = await clashSnapshot();
    const groupName = snap.defaultGroup;
    const group = snap.groups.find((g) => g.name === groupName);
    if (!group || !group.now) return;
    const cur = await codexProbeFast();
    autoswitch.last = { at: Date.now(), node: group.now, ok: cur.ok, ms: cur.ms, error: cur.error ?? null };
    if (cur.ok) {
      log('[clash] autoswitch ok ' + group.now + ' ' + cur.ms + 'ms');
      return;
    }
    log('[clash] autoswitch failure on ' + group.now + ' -> sweeping all nodes');
    const job = await runSweep(groupName, 0);
    if (job.best) {
      autoswitch.switches += 1;
      autoswitch.lastSwitch = { at: Date.now(), from: group.now, to: job.best.node, ms: job.best.codex.ms };
      log('[clash] autoswitch -> ' + job.best.node + ' (' + job.best.codex.ms + 'ms)');
    } else {
      log('[clash] autoswitch found no working node');
    }
  } catch (e) {
    log('[clash] autoswitch error: ' + e.message);
  } finally {
    autoswitch.busy = false;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of autopickJobs) {
    if (j.finishedAt && now - j.finishedAt > 600000) autopickJobs.delete(id);
  }
}, 60000).unref?.();

// ---------------------------------------------------------------- wechat qr cache
const qrCache = { buf: null, type: null, at: 0, pending: null };

// ---------------------------------------------------------------- office preview
// docx/xlsx/pptx are zip+xml; extract readable text without needing LibreOffice.
import zlib from 'node:zlib';

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return new Map();
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (localOff + 30 <= buf.length) {
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lnameLen + lextraLen;
      out.set(name, { method, data: buf.subarray(dataStart, Math.min(dataStart + compSize, buf.length)) });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function zipText(entry) {
  if (!entry) return '';
  try {
    if (entry.method === 0) return entry.data.toString('utf8');
    return zlib.inflateRawSync(entry.data).toString('utf8');
  } catch {
    return '';
  }
}

function xmlText(xml) {
  return String(xml)
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>|<\/a:p>|<\/text:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function officeText(file) {
  const ext = path.extname(file).toLowerCase();
  const st = fs.statSync(file);
  if (st.size > 80 * 1024 * 1024) return { ok: false, error: '文件过大（>80MB）' };
  const buf = fs.readFileSync(file);
  const entries = zipEntries(buf);
  if (!entries.size) return { ok: false, error: '不是有效的 Office 文件' };

  if (ext === '.docx') {
    const text = xmlText(zipText(entries.get('word/document.xml')));
    return { ok: true, kind: 'docx', text: text.slice(0, 40000), truncated: text.length > 40000 };
  }
  if (ext === '.xlsx') {
    const shared = [...zipText(entries.get('xl/sharedStrings.xml')).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((m) => xmlText(m[1]));
    const sheets = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
    const rows = [];
    const sheetXml = sheets[0] ? zipText(entries.get(sheets[0])) : '';
    for (const rowM of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cM of rowM[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cM[1];
        const body = cM[2];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1];
        const isStr = /t="s"/.test(attrs);
        let val = isStr ? (shared[Number(v)] ?? '') : (inline ? xmlText(inline) : v);
        cells.push(String(val).replace(/\s+/g, ' '));
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }
    const text = rows.join('\n');
    return { ok: true, kind: 'xlsx', text: text.slice(0, 40000), truncated: text.length > 40000, sheets: sheets.length };
  }
  if (ext === '.pptx') {
    const slides = [...entries.keys()]
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
    const parts = [];
    for (const key of slides) {
      const idx = Number(/(\d+)\.xml$/.exec(key)[1]);
      const body = xmlText(zipText(entries.get(key)));
      if (body) parts.push('— 第 ' + idx + ' 页 —\n' + body);
    }
    const text = parts.join('\n\n');
    return { ok: true, kind: 'pptx', text: text.slice(0, 40000), truncated: text.length > 40000, slides: slides.length };
  }
  return { ok: false, error: '不支持的格式：' + ext };
}


// ---------------------------------------------------------------- office -> pdf
const OFFICE_PDF_DIR = path.join(os.tmpdir(), 'codex-remote-office');
const OFFICE_EXTS = new Set(['.pptx', '.ppt', '.ppsx', '.pps', '.odp', '.docx', '.doc', '.rtf', '.odt', '.xlsx', '.xls', '.ods']);
let officeQueue = Promise.resolve();

function officeConvertScript() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'office-to-pdf.ps1');
}

/** Serialise conversions: the Office COM servers are single-instance. */
function convertOfficeToPdf(src) {
  const run = async () => {
    const st = fs.statSync(src);
    const key = crypto.createHash('sha1').update(src + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 16);
    fs.mkdirSync(OFFICE_PDF_DIR, { recursive: true });
    const dest = path.join(OFFICE_PDF_DIR, key + '.pdf');
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return { ok: true, pdf: dest, cached: true };
    const out = await new Promise((resolve) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', officeConvertScript(), '-In', src, '-Out', dest,
      ], { windowsHide: true });
      let text = '';
      ps.stdout.on('data', (d) => { text += d.toString(); });
      ps.stderr.on('data', (d) => { text += d.toString(); });
      const timer = setTimeout(() => { try { ps.kill(); } catch {} resolve({ code: -1, text: 'timeout' }); }, 180000);
      ps.on('exit', (code) => { clearTimeout(timer); resolve({ code, text }); });
    });
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      log('[office] ' + path.basename(src) + ' -> pdf ' + Math.round(fs.statSync(dest).size / 1024) + 'KB');
      return { ok: true, pdf: dest, cached: false };
    }
    return { ok: false, error: String(out.text || 'conversion failed').trim().slice(0, 200) };
  };
  const task = officeQueue.then(run, run);
  officeQueue = task.then(() => {}, () => {});
  return task;
}

// ---------------------------------------------------------------- pdf -> page images
const PDF_IMG_DIR = path.join(os.tmpdir(), 'codex-remote-office');
let rasterQueue = Promise.resolve();

function bridgeDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function pythonExe() {
  const configured = cfg.officePython;
  if (configured && fs.existsSync(configured)) return configured;
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const runtimes = path.join(dshHome, 'dsh-runtimes');
  const candidates = [];
  try {
    for (const profile of fs.readdirSync(runtimes)) {
      candidates.push(path.join(runtimes, profile, 'dependencies', 'python', 'python.exe'));
      candidates.push(path.join(runtimes, profile, 'dependencies', 'python', 'bin', 'python3'));
    }
  } catch { /* no runtimes */ }
  candidates.push(path.join(dshHome, 'python', 'python.exe'), 'python3', 'python');
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'python';
}

/** Rasterise a PDF into cached JPEGs; returns { ok, key, count }. */
function rasterisePdf(pdfPath) {
  const run = async () => {
    const st = fs.statSync(pdfPath);
    const key = crypto.createHash('sha1').update(pdfPath + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 16);
    const dir = path.join(PDF_IMG_DIR, 'img-' + key);
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg'));
    if (existing.length) return { ok: true, key, count: existing.length, cached: true };
    const out = await new Promise((resolve) => {
      const ps = spawn(pythonExe(), [path.join(bridgeDir(), 'pdf-to-images.py'), pdfPath, dir, '1400', '82'], { windowsHide: true });
      let text = '';
      ps.stdout.on('data', (d) => { text += d.toString(); });
      ps.stderr.on('data', (d) => { text += d.toString(); });
      const timer = setTimeout(() => { try { ps.kill(); } catch {} resolve({ code: -1, text: 'timeout' }); }, 180000);
      ps.on('exit', (code) => { clearTimeout(timer); resolve({ code, text }); });
    });
    let parsed = null;
    try { parsed = JSON.parse(String(out.text || '').trim().split('\n').pop()); } catch { /* ignore */ }
    if (parsed && parsed.ok) {
      log('[pdf] rasterised ' + parsed.count + ' pages');
      return { ok: true, key, count: parsed.count, cached: false };
    }
    return { ok: false, error: (parsed && parsed.error) || String(out.text || 'rasterise failed').slice(0, 200) };
  };
  const task = rasterQueue.then(run, run);
  rasterQueue = task.then(() => {}, () => {});
  return task;
}

/** Make sure we have a PDF for this file (converting Office docs when needed). */
async function ensurePdf(target) {
  const ext = path.extname(target).toLowerCase();
  if (ext === '.pdf') return { ok: true, pdf: target };
  if (!OFFICE_EXTS.has(ext)) return { ok: false, error: '不支持的格式' };
  const r = await convertOfficeToPdf(target);
  return r.ok ? { ok: true, pdf: r.pdf } : r;
}

// ---------------------------------------------------------------- desktop catalog sync
// The Codex desktop app lists threads from local_thread_catalog (a scan of the rollout
// files). Archiving/deleting from this web UI removes the rollout but leaves the row,
// so the desktop still shows the thread and fails with "no rollout found".
const CATALOG_DB = path.join(os.homedir(), '.codex', 'sqlite', 'codex.db');
// Only sessions/ counts: an archived thread has its rollout moved to archived_sessions/
// and must disappear from the desktop list too, otherwise archiving looks like a no-op.
const ROLLOUT_DIRS = [
  path.join(os.homedir(), '.codex', 'sessions'),
];
const ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
let catalogBackupDone = false;
let catalogTimer = null;
/** Debounced prune: archive/delete moves files a moment after the notification. */
function scheduleCatalogPrune(delayMs = 1200) {
  if (catalogTimer) clearTimeout(catalogTimer);
  catalogTimer = setTimeout(() => {
    catalogTimer = null;
    try { pruneThreadCatalog(); } catch (e) { log('[catalog] prune failed: ' + e.message); }
  }, delayMs);
}

function liveThreadIds() {
  const ids = new Set();
  for (const dir of ROLLOUT_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir, { recursive: true }); } catch { continue; }
    for (const f of files) {
      const m = String(f).match(ID_RE);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

/** Remove catalog rows for local threads whose rollout is gone. Returns what changed. */
function pruneThreadCatalog() {
  if (!fs.existsSync(CATALOG_DB)) return { ok: false, error: 'catalog db missing' };
  let DatabaseSync;
  try { ({ DatabaseSync } = requireLocal('node:sqlite')); } catch (e) {
    return { ok: false, error: 'node:sqlite unavailable: ' + e.message };
  }
  const live = liveThreadIds();
  if (!live.size) return { ok: false, error: 'no rollouts found, refusing to prune' };
  if (!catalogBackupDone) {
    try { fs.copyFileSync(CATALOG_DB, CATALOG_DB + '.bak-prune'); catalogBackupDone = true; } catch { /* ignore */ }
  }
  let db;
  try {
    db = new DatabaseSync(CATALOG_DB);
    const rows = db.prepare("SELECT thread_id, display_title FROM local_thread_catalog WHERE host_id = 'local'").all();
    const stale = rows.filter((r) => !live.has(r.thread_id));
    if (!stale.length) { db.close(); return { ok: true, removed: 0 }; }
    const del = db.prepare("DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
    db.exec('BEGIN');
    for (const r of stale) del.run(r.thread_id);
    try {
      const delEntry = db.prepare('DELETE FROM local_thread_catalog_scan_entries WHERE thread_id = ?');
      for (const r of stale) delEntry.run(r.thread_id);
    } catch { /* table optional */ }
    db.exec('COMMIT');
    db.close();
    log('[catalog] pruned ' + stale.length + ' stale row(s): ' + stale.map((r) => (r.display_title || r.thread_id).slice(0, 20)).join(', '));
    return { ok: true, removed: stale.length, titles: stale.map((r) => r.display_title || r.thread_id) };
  } catch (e) {
    try { db && db.close(); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------- share links
// WeChat web-file-helper uploads are fine (MB/s) but the phone then downloads from
// WeChat's CDN slowly. For big files we hand the phone a direct link instead: the phone
// is usually already on the tailnet/LAN, where the bridge serves at full speed.
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
function shareSecret() {
  return cfg.shareSecret || (cfg.shareSecret = crypto.randomBytes(24).toString('hex'));
}
function shareSign(pathPart, exp) {
  return crypto.createHmac('sha256', shareSecret()).update(pathPart + '|' + exp).digest('base64url').slice(0, 32);
}
function makeShareToken(file) {
  const exp = Date.now() + SHARE_TTL_MS;
  const p = Buffer.from(file, 'utf8').toString('base64url');
  return p + '.' + exp + '.' + shareSign(p, exp);
}
function readShareToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [p, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  if (shareSign(p, exp) !== sig) return null;
  return Buffer.from(p, 'base64url').toString('utf8');
}
/** Best reachable base URL from a phone: tailnet first, then LAN, then localhost. */
function shareBaseUrls() {
  const urls = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address;
      if (ip.startsWith('198.18.')) continue; // clash tun
      const entry = { ip, iface: name, url: 'http://' + ip + ':' + cfg.port + '/' };
      if (/tailscale/i.test(name) || ip.startsWith('100.')) urls.unshift(entry);
      else urls.push(entry);
    }
  }
  urls.push({ ip: '127.0.0.1', iface: 'loopback', url: 'http://127.0.0.1:' + cfg.port + '/' });
  return urls;
}

// ---------------------------------------------------------------- project mirror
const GLOBAL_STATE = path.join(os.homedir(), '.codex', '.codex-global-state.json');
function readGlobalState() {
  try { return JSON.parse(fs.readFileSync(GLOBAL_STATE, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}
function writeGlobalState(obj) {
  const tmp = GLOBAL_STATE + '.bridge-tmp';
  try { fs.copyFileSync(GLOBAL_STATE, GLOBAL_STATE + '.bak'); } catch { /* first run */ }
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, GLOBAL_STATE);
}
/** Add/update one project in the desktop's own registry (idempotent). */
function mirrorProject({ id, name, roots }) {
  if (!id || !name) throw new Error('id and name required');
  const gs = readGlobalState();
  const local = gs['local-projects'] && typeof gs['local-projects'] === 'object' ? gs['local-projects'] : {};
  const now = Date.now();
  const prev = local[id];
  local[id] = {
    id,
    name,
    rootPaths: (Array.isArray(roots) && roots.length ? roots : prev?.rootPaths ?? [])
      .filter(Boolean)
      .map((r) => path.win32.normalize(String(r))),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  gs['local-projects'] = local;
  const order = Array.isArray(gs['project-order']) ? gs['project-order'] : [];
  if (!order.includes(id)) order.push(id);
  gs['project-order'] = order;
  writeGlobalState(gs);
  return { ok: true, added: !prev, projects: Object.keys(local).length };
}
/** Drop one project from the registry (used when the web UI deletes it). */
function unmirrorProject(id) {
  const gs = readGlobalState();
  const local = gs['local-projects'] || {};
  if (!local[id]) return { ok: true, removed: false };
  delete local[id];
  gs['local-projects'] = local;
  gs['project-order'] = (gs['project-order'] || []).filter((x) => x !== id);
  const sel = gs['selected-project'];
  if (sel && sel.projectId === id) delete gs['selected-project'];
  writeGlobalState(gs);
  return { ok: true, removed: true };
}


// ---------------------------------------------------------------- wechat send jobs
// A 60MB upload takes ~10-60s through the WeChat page. Keeping the fetch open that long
// makes iOS Safari abort it ("Load failed"), so the request only starts a job.
const wechatJobs = new Map();
const WECHAT_JOB_TTL_MS = 10 * 60 * 1000;

function newWechatJob(payload) {
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, state: "running", startedAt: Date.now(), ...payload };
  wechatJobs.set(id, job);
  for (const [k, v] of wechatJobs) if (Date.now() - v.startedAt > WECHAT_JOB_TTL_MS) wechatJobs.delete(k);
  return job;
}

// ---------------------------------------------------------------- desktop app launcher
// Some MCP servers only work against a running desktop app. Calling a QGIS/Photoshop
// tool without the app open fails with a confusing transport error, so start it first.
// Where to look for the desktop apps. Override with config.appRoots = { photoshop: [...], qgis: [...] }.
const DEFAULT_APP_ROOTS = {
  photoshop: [
    "C:\\Program Files\\Adobe",
    "C:\\Program Files (x86)\\Adobe",
    "D:\\Program Files\\Adobe",
  ],
  qgis: ["C:\\Program Files", "D:\\Program Files", "C:\\OSGeo4W"],
};
const appRoots = (name) => (cfg.appRoots && Array.isArray(cfg.appRoots[name]) && cfg.appRoots[name].length
  ? cfg.appRoots[name]
  : DEFAULT_APP_ROOTS[name]);

const APP_SPECS = {
  photoshop: {
    key: "photoshop",
    label: "Photoshop",
    process: /^photoshop(\.exe)?$/i,
    match: /^Adobe Photoshop .*$/i,
    exe: "Photoshop.exe",
  },
  qgis: {
    key: "qgis",
    label: "QGIS",
    process: /^qgis(-ltr)?-bin(\.exe)?$/i,
    match: /^QGIS .*$/i,
    exe: ["qgis-ltr-bin.exe", "qgis-bin.exe"],
  },
};

function findAppExe(spec) {
  for (const root of appRoots(spec.key)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory() || !spec.match.test(d.name)) continue;
      const base = path.join(root, d.name);
      const candidates = Array.isArray(spec.exe) ? spec.exe : [spec.exe];
      for (const exe of candidates) {
        for (const sub of ["", "bin", path.join("bin", "bin")]) {
          const full = path.join(base, sub, exe);
          try { if (fs.statSync(full).isFile()) return full; } catch { /* keep looking */ }
        }
      }
    }
  }
  return null;
}

function appRunning(spec) {
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 8000 });
    for (const line of out.split(/\r?\n/)) {
      const name = (line.split(",")[0] || "").replace(/"/g, "").trim();
      if (name && spec.process.test(name)) return name;
    }
  } catch { /* tasklist unavailable */ }
  return null;
}

async function ensureApp(key, waitMs = 90000) {
  const spec = APP_SPECS[key];
  if (!spec) return { ok: false, error: "unknown app: " + key };
  const running = appRunning(spec);
  if (running) return { ok: true, app: key, label: spec.label, already: true, process: running };

  const exe = findAppExe(spec);
  if (!exe) return { ok: false, app: key, label: spec.label, error: "找不到 " + spec.label + " 的可执行文件" };

  log("[app] starting " + spec.label + ": " + exe);
  const started = Date.now();
  try {
    execFile("cmd", ["/c", "start", "", exe], { windowsHide: true, detached: true }).unref?.();
  } catch (e) {
    return { ok: false, app: key, label: spec.label, error: "启动失败: " + e.message, exe };
  }

  // Wait for the process to exist, then give the UI a moment to accept connections.
  while (Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const proc = appRunning(spec);
    if (proc) {
      await new Promise((r) => setTimeout(r, 2500));
      log("[app] " + spec.label + " up after " + Math.round((Date.now() - started) / 1000) + "s");
      return { ok: true, app: key, label: spec.label, launched: true, process: proc, exe, waitedMs: Date.now() - started };
    }
  }
  return { ok: false, app: key, label: spec.label, error: spec.label + " 启动超时", exe, waitedMs: Date.now() - started };
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

// ClawBot: the dsh-wechat plugin speaks Tencent iLink; we shell out to its CLI.
// Start the inbound pump after boot: without it the state file never gains a binding.
setChannelWorkspace(cfg.defaultCwd);
setChannelConfig(cfg);
startHealing(cfg.defaultCwd);
setTimeout(() => { startChannel(cfg.defaultCwd).catch(() => {}); }, 4000);
process.on('SIGTERM', () => { try { stopChannel(); } catch { /* noop */ } });
const clawJobs = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of clawJobs) if (now - job.startedAt > 30 * 60_000) clawJobs.delete(id);
}, 60_000).unref?.();

// Re-sync every minute: the desktop app can archive/delete on its own, and rollouts may
// appear or vanish outside this bridge.
if (process.env.CODEX_BRIDGE_NO_CATALOG_LOOP !== '1') {
  setInterval(() => {
    try { const r = pruneThreadCatalog(); if (r?.removed) log('[catalog] periodic prune removed ' + r.removed); } catch { /* ignore */ }
  }, 60000).unref();
}
let clientSeq = 0;

/** Stable per-browser id derived from the auth cookie, so reloads find the session. */
function sessionIdFor(req) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE] || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

const sessions = new Map(); // sid -> { upstream, subs, pending, initResult, idleTimer, queue }
const SESSION_IDLE_MS = 30 * 60 * 1000; // drop an unused session after 30 minutes

function sendJson(ws, obj) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch { /* noop */ }
}

function broadcast(session, text) {
  for (const sub of session.subs) {
    try { if (sub.readyState === WebSocket.OPEN) sub.send(text); } catch { /* noop */ }
  }
}

function scheduleIdle(session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (session.subs.size > 0) return;
    if (session.pending.size > 0) {
      // something still waits for a human decision — keep the session alive
      log(`[bridge] session ${session.sid.slice(0, 8)} kept alive: ${session.pending.size} pending request(s)`);
      scheduleIdle(session);
      return;
    }
    log(`[bridge] session ${session.sid.slice(0, 8)} idle, closing upstream`);
    try { session.upstream?.close(1000, 'idle'); } catch { /* noop */ }
    sessions.delete(session.sid);
  }, SESSION_IDLE_MS);
}

function handleUpstreamMessage(session, text) {
  let msg = null;
  try { msg = JSON.parse(text); } catch { /* not json: just forward */ }
  // Any response clears the matching in-flight request.
  if (msg && msg.method === undefined && msg.id !== undefined) {
    if (process.env.RPC_LOG) log('[rpc] ' + session.sid.slice(0, 8) + ' <- id=' + msg.id + ' ' + (msg.error ? 'ERROR ' + JSON.stringify(msg.error).slice(0, 80) : 'ok'));
    session.inflight?.delete(msg.id);
  }
  if (msg && msg.method === undefined && msg.id !== undefined && msg.id === session.pendingInitId) {
    session.initResult = msg.result ?? true;
    session.pendingInitId = null;
  }
  if (msg && msg.method !== undefined) {
    // server -> client request (has an id): remember it so a reconnect can answer
    if (msg.id !== undefined) {
      session.pending.set(msg.id, text);
      log(`[bridge] session ${session.sid.slice(0, 8)} pending request ${msg.method} id=${msg.id}`);
    } else if (msg.method === 'serverRequest/resolved' && msg.params?.requestId != null) {
      session.pending.delete(msg.params.requestId);
    } else if (msg.method === 'error' && msg.params?.requestId != null) {
      session.pending.delete(msg.params.requestId);
    }
  }
  // Keep the local Codex app's thread list consistent with this web UI: whenever a
  // thread is archived/deleted (or comes back), re-sync the catalog shortly after.
  if (msg && (msg.method === 'thread/archived' || msg.method === 'thread/deleted' || msg.method === 'thread/unarchived')) {
    scheduleCatalogPrune(1200);
  }
  broadcast(session, text);
}

function ensureUpstream(session) {
  if (session.upstream && session.upstream.readyState === WebSocket.OPEN) return session.upstream;
  if (session.upstream && session.upstream.readyState === WebSocket.CONNECTING) return session.upstream;

  const upstream = new WebSocket(UPSTREAM, { headers: { 'user-agent': 'codex-remote-bridge' } });
  session.upstream = upstream;
  session.queue = session.queue ?? [];

  upstream.on('open', () => {
    log(`[bridge] session ${session.sid.slice(0, 8)} attached to app-server`);
    for (const m of session.queue.splice(0)) { try { upstream.send(m); } catch { /* noop */ } }
  });
  upstream.on('message', (data) => handleUpstreamMessage(session, data.toString()));
  upstream.on('close', () => {
    log(`[bridge] session ${session.sid.slice(0, 8)} upstream closed`);
    if (session.upstream === upstream) session.upstream = null;
    session.initResult = null;
    for (const sub of [...session.subs]) {
      try { sub.close(1011, 'upstream closed'); } catch { /* noop */ }
      session.subs.delete(sub);
    }
  });
  upstream.on('error', (e) => log(`[bridge] session ${session.sid.slice(0, 8)} upstream error: ${e.message}`));
  return upstream;
}

function attachClient(client, sid, ip) {
  let session = sessions.get(sid);
  if (!session) {
    session = { sid, upstream: null, subs: new Set(), pending: new Map(), inflight: new Map(), initResult: null, idleTimer: null, queue: [] };
    sessions.set(sid, session);
    log(`[bridge] new session ${sid.slice(0, 8)}`);
  }
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
  session.subs.add(client);
  const upstream = ensureUpstream(session);

  // A reconnecting client must see whatever is still awaiting a decision.
  for (const frame of session.pending.values()) {
    try { client.send(frame); } catch { /* noop */ }
  }
  if (session.pending.size) {
    log(`[bridge] session ${sid.slice(0, 8)} replayed ${session.pending.size} pending request(s) to client`);
  }

  client.on('message', (data, isBinary) => {
    const text = isBinary ? data : data.toString();
    let msg = null;
    try { msg = JSON.parse(text); } catch { /* raw */ }

    if (msg && msg.method === 'initialize' && msg.id !== undefined) session.pendingInitId = msg.id;
  if (msg && msg.method === 'initialize' && session.initResult) {
      // Same app-server connection is already initialised: answer locally instead of
      // re-initialising it (which the server would reject).
      sendJson(client, { id: msg.id, result: session.initResult });
      log(`[bridge] session ${sid.slice(0, 8)} answered re-initialize from cache`);
      return;
    }
    if (msg && msg.method === 'initialized' && session.initResult) return; // duplicate

    // A reply to a tracked server request clears it from the pending set.
    if (msg && msg.method === undefined && msg.id !== undefined) {
      if (session.pending.delete(msg.id)) {
        log(`[bridge] session ${sid.slice(0, 8)} answered pending request ${msg.id}`);
      }
    }
    // Client -> server request: remember when it went out so the watchdog can spot
    // an upstream that stopped answering.
    if (msg && msg.method !== undefined && msg.method !== 'initialized' && msg.id !== undefined) {
      if (process.env.RPC_LOG) log('[rpc] ' + sid.slice(0, 8) + ' -> ' + msg.method + ' id=' + msg.id);
      session.inflight.set(msg.id, { method: msg.method, at: Date.now() });
    }

    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.send(text); } catch { /* noop */ }
    } else {
      (session.queue = session.queue ?? []).push(text);
    }
  });

  client.on('close', () => {
    session.subs.delete(client);
    log(`[bridge] client detached from session ${sid.slice(0, 8)} (${session.subs.size} left)`);
    if (session.subs.size === 0) scheduleIdle(session);
  });
  client.on('error', () => {
    session.subs.delete(client);
    if (session.subs.size === 0) scheduleIdle(session);
  });

  return session;
}

/** Force-drop a session's upstream so the next message rebuilds it. */
function resetSession(session, why) {
  if (!session) return;
  log(`[bridge] resetting session ${session.sid.slice(0, 8)}: ${why}`);
  session.inflight?.clear();
  session.pending.clear();
  session.initResult = null;
  session.pendingInitId = null;
  const up = session.upstream;
  session.upstream = null;
  try { up?.terminate(); } catch { /* noop */ }
  // Drop subscriber sockets too: the browser reconnects, re-initializes on the
  // fresh upstream and re-runs its startup reads, which is the cleanest recovery.
  for (const sub of [...session.subs]) {
    try { sub.close(1012, 'session reset'); } catch { /* noop */ }
    session.subs.delete(sub);
  }
}

const INFLIGHT_TIMEOUT_MS = 20000;
setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!session.inflight) continue;
    for (const [id, info] of session.inflight) {
      if (now - info.at < INFLIGHT_TIMEOUT_MS) continue;
      session.inflight.delete(id);
      resetSession(session, `no reply to ${info.method} (id=${id}) in ${INFLIGHT_TIMEOUT_MS}ms`);
      break;
    }
  }
}, 5000).unref();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  if (!isAuthed(req)) {
    log('[bridge] rejecting unauthenticated ws upgrade');
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const sid = sessionIdFor(req);
  wss.handleUpgrade(req, socket, head, (ws) => {
    const id = ++clientSeq;
    const ip = req.socket.remoteAddress || 'unknown';
    const key = sid || `anon-${id}-${crypto.randomBytes(4).toString('hex')}`;
    log(`[bridge] client #${id} connected from ${ip} -> session ${key.slice(0, 8)}`);
    try {
      attachClient(ws, key, ip);
    } catch (e) {
      log('[bridge] attach failed:', e.message);
      try { ws.close(1011, 'attach failed'); } catch { /* noop */ }
    }
  });
});


// ---------------------------------------------------------------- lifecycle
function guessLanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function alreadyServing() {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  // One bridge per machine: a leftover process would open its own long poll for the same
  // bot, so messages arrive twice and "which connection am I on" stops being answerable.
  if (await alreadyServing()) {
    log('[bridge] another bridge is already listening on port ' + cfg.port + '; exiting');
    process.exit(0);
  }
  log('[bridge] config:', JSON.stringify({
    host: cfg.host, port: cfg.port, appServerPort: cfg.appServerPort,
    codexExe: cfg.codexExe, defaultCwd: cfg.defaultCwd || '(inherit)',
  }));
  startAppServer();
  const ready = await waitForUpstream();
  log(ready ? '[bridge] app-server is ready' : '[bridge] WARNING: app-server not ready yet; will keep retrying in background');
  if (!ready) {
    setTimeout(async () => {
      const again = await waitForUpstream(60000);
      log(again ? '[bridge] app-server became ready' : '[bridge] app-server still not ready');
    }, 1000);
  }

  loadAutoswitch();

  server.listen(cfg.port, cfg.host, () => {
    const lan = guessLanAddresses();
    log(`[bridge] listening on http://${cfg.host}:${cfg.port}`);
    log(`[bridge] local:  http://127.0.0.1:${cfg.port}/`);
    for (const ip of lan) log(`[bridge] LAN:    http://${ip}:${cfg.port}/`);
    log(`[bridge] passcode: ${cfg.passcode}`);
  });
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('[bridge] shutting down:', reason);
  if (restartTimer) clearTimeout(restartTimer);
  try { server.close(); } catch { /* noop */ }
  if (appServer) { try { appServer.kill(); } catch { /* noop */ } }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log('[bridge] uncaught:', e.stack || e.message));

main();
