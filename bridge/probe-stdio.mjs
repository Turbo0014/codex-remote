// Ground-truth probe over stdio: start `codex app-server`, run the handshake,
// then enumerate threads. Prints exactly what the server emits.
import { spawn } from 'node:child_process';

const exe = process.env.CODEX_EXE || 'codex';
const child = spawn(exe, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'], shell: true });

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log('RAW  ', line.slice(0, 300)); continue; }
    const keys = Object.keys(msg).join(',');
    console.log('<<  keys=[' + keys + '] ' + JSON.stringify(msg).slice(0, 700));
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  const msg = params === undefined ? { method, id } : { method, id, params };
  console.log('>>  ' + JSON.stringify(msg).slice(0, 400));
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}
function notify(method, params) {
  const msg = params === undefined ? { method } : { method, params };
  console.log('>>  ' + JSON.stringify(msg).slice(0, 200));
  child.stdin.write(JSON.stringify(msg) + '\n');
}

const t0 = Date.now();
const init = await Promise.race([
  request('initialize', {
    clientInfo: { name: 'codex-remote-probe', title: 'Codex Remote Probe', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  }),
  new Promise((r) => setTimeout(() => r({ timeout: true }), 20000)),
]);
console.log('\n=== initialize response ===');
console.log(JSON.stringify(init, null, 2).slice(0, 1500));

notify('initialized');

const list = await Promise.race([
  request('thread/list', { limit: 5 }),
  new Promise((r) => setTimeout(() => r({ timeout: true }), 15000)),
]);
console.log('\n=== thread/list response (truncated) ===');
console.log(JSON.stringify(list).slice(0, 2500));

const models = await Promise.race([
  request('model/list', {}),
  new Promise((r) => setTimeout(() => r({ timeout: true }), 15000)),
]);
console.log('\n=== model/list (truncated) ===');
console.log(JSON.stringify(models).slice(0, 1200));

console.log('\nelapsed ms:', Date.now() - t0);
child.kill();
process.exit(0);
