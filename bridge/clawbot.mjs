// ClawBot channel: reuse dsh-wechat-plugin (Tencent iLink gateway) for uploads and
// task notifications. The plugin ships a supported CLI — `dsh-wechat-send "text" --file x`
// — and keeps its login in <DSH_HOME>/wechat/state.json, so the bridge only has to
// locate the CLI, read the state, and call it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

export function clawStatePath() {
  return path.join(DSH_HOME, 'wechat', 'state.json');
}

/** Where the plugin might be installed, newest profile first. */
function cliCandidates(configured) {
  const out = [];
  if (configured) out.push(configured);
  // The copy vendored next to the bridge: works without installing into DSH.
  out.push(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'vendor', 'dsh-wechat-plugin', 'cli.js'));
  // A command on PATH, if the user installed the plugin globally.
  out.push('dsh-wechat-send');
  const profiles = path.join(DSH_HOME, 'profiles');
  let dirs = [];
  try { dirs = fs.readdirSync(profiles, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
  for (const p of dirs) {
    out.push(path.join(profiles, p, 'node_modules', 'dsh-wechat-plugin', 'cli.js'));
  }
  return out;
}

function resolveCli(configured) {
  for (const c of cliCandidates(configured)) {
    if (c === 'dsh-wechat-send') continue; // handled by PATH lookup at spawn time
    try { if (fs.statSync(c).isFile()) return { kind: 'file', path: c }; } catch { /* keep looking */ }
  }
  return { kind: 'command', path: 'dsh-wechat-send' };
}

/** Read the plugin's state file: is a bot bound, and to which account. */
export function clawStatus(configuredCli) {
  const statePath = clawStatePath();
  const cli = resolveCli(configuredCli);
  const out = {
    ok: true,
    plugin: cli.kind === 'file' ? cli.path : null,
    cli: cli.kind === 'command' ? 'dsh-wechat-send' : 'node <plugin>/cli.js',
    statePath,
    installed: cli.kind === 'file',
    loggedIn: false,
    botId: null,
    accounts: 0,
    boundChats: 0,
    stateMtime: null,
  };
  if (cli.kind !== 'file') {
    // The command form may still exist on PATH; report installed=false but usable=unknown.
    out.installed = false;
  }
  try {
    const st = fs.statSync(statePath);
    out.stateMtime = st.mtimeMs;
  } catch { /* no state yet */ }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const accounts = raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
    out.accounts = Object.keys(accounts).length;
    const first = Object.values(accounts)[0] ?? null;
    out.botId = first?.ilinkBotId ?? first?.botId ?? null;
    out.loggedIn = out.accounts > 0;
    const bindings = raw?.bindings && typeof raw.bindings === 'object' ? raw.bindings : {};
    out.boundChats = Object.keys(bindings).length;
  } catch { /* state file missing or unreadable: not logged in */ }
  return out;
}

/** Spark the CLI. Sends can take a while (CDN upload), so callers await a job. */
function runCli(configuredCli, args, timeoutMs) {
  const cli = resolveCli(configuredCli);
  return new Promise((resolve) => {
    const opts = { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
    const done = (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        message: String(stderr || stdout || err?.message || '').trim().slice(0, 400),
      });
    };
    if (cli.kind === 'file') {
      execFile(process.execPath, [cli.path, ...args], opts, done);
    } else {
      execFile('dsh-wechat-send', args, { ...opts, shell: true }, (err, stdout, stderr) => {
        if (err && /not recognized|not found|ENOENT/i.test(String(err.message))) {
          resolve({
            ok: false,
            code: 'missing',
            message: '没有找到 dsh-wechat-send：先安装 dsh-wechat-plugin 并扫码绑定',
          });
          return;
        }
        done(err, stdout, stderr);
      });
    }
  });
}

/** Send a message, optionally with one file. */
export function clawSend(configuredCli, { text, file, timeoutMs = 120000 }) {
  const args = [];
  const body = String(text ?? '').trim();
  if (body) args.push(body);
  if (file) args.push('--file', file);
  if (!args.length) return Promise.resolve({ ok: false, code: 'usage', message: '没有内容可发送' });
  return runCli(configuredCli, args, timeoutMs);
}

/** Files the plugin dropped into a workspace: <cwd>/媒体/*, newest first. */
export function clawInbound(cwd, limit = 20) {
  const dir = path.join(cwd || '', '媒体');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) files.push({ path: full, name, size: st.size, at: st.mtimeMs });
    } catch { /* skip */ }
  }
  files.sort((a, b) => b.at - a.at);
  return files.slice(0, limit);
}
