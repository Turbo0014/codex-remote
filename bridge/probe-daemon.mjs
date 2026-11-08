// Probe the SHARED app-server daemon through `codex app-server proxy` (stdio <-> control socket).
// The goal: find out whether a second client can read/resume threads without
// hitting "thread-store conflict: already has an active writer".
import { spawn } from 'node:child_process';

const codexExe = process.env.CODEX_EXE
  || 'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\bin\\22cfb1d302613eae\\codex.exe';

const child = spawn(codexExe, ['app-server', 'proxy'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.log('RAW', line.slice(0, 200)); continue; }
    if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      continue;
    }
    if (msg.method) console.log('NOTIF', msg.method);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => console.log('[proxy:err]', d.trim().slice(0, 300)));
child.on('error', (e) => { console.error('spawn error', e.message); process.exit(1); });

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify(params === undefined ? { method, id } : { method, id, params }) + '\n');
  return Promise.race([
    new Promise((r) => pending.set(id, r)),
    new Promise((r) => setTimeout(() => r({ timeout: true }), 15000)),
  ]);
}
const notify = (method, params) => child.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n');

const init = await send('initialize', {
  clientInfo: { name: 'probe-proxy', title: 'Proxy Probe', version: '1' },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
console.log('initialize:', JSON.stringify(init).slice(0, 300));
notify('initialized');

const list = await send('thread/list', { limit: 5 });
const threads = list?.result?.data ?? [];
console.log('thread/list:', threads.length, 'threads');
for (const t of threads.slice(0, 3)) {
  console.log(`  ${t.id}  status=${JSON.stringify(t.status)}  name=${t.name ?? t.preview?.slice(0, 30)}`);
}

// The three threads that conflicted via our private app-server:
const conflictIds = [
  '01a1a1b6-af7b-7393-a2bb-62fa0890ae09',
  '01a1a1e7-cdde-7c13-967f-e8f0d2ad3ad3',
  '01a1a1dd-951d-7b43-ae4b-f70d7ab7f20b',
];

for (const id of conflictIds) {
  const res = await send('thread/resume', { threadId: id, excludeTurns: true });
  const ok = res?.result !== undefined;
  console.log(`resume ${id.slice(0, 8)} -> ${ok ? 'OK' : 'FAIL: ' + JSON.stringify(res.error ?? res).slice(0, 160)}`);
  const page = await send('thread/turns/list', { threadId: id, limit: 5, sortDirection: 'desc', itemsView: 'full' });
  const turns = page?.result?.data ?? [];
  console.log(`   turns/list -> ${turns.length} turns ${page.error ? 'ERR ' + JSON.stringify(page.error).slice(0, 120) : ''}`);
}

child.kill();
process.exit(0);
