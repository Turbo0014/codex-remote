// End-to-end test through the bridge: login -> ws -> initialize -> new thread ->
// real turn. Prints the notification stream so the UI contract can be verified.
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const passcode = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8')).passcode;

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ passcode }),
});
const cookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie');
console.log('login:', login.status, Boolean(cookie));

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, {
  headers: { cookie: cookie.split(';')[0] },
});

let nextId = 1;
const pending = new Map();
function send(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify(params === undefined ? { method, id } : { method, id, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const seen = new Set();
let threadId = null;
let done;
const finished = new Promise((r) => { done = r; });

ws.on('open', async () => {
  console.log('ws open');
  const init = await send('initialize', {
    clientInfo: { name: 'codex-remote-e2e', title: 'E2E', version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  console.log('initialize ->', JSON.stringify(init).slice(0, 200));
  ws.send(JSON.stringify({ method: 'initialized' }));

  const list = await send('thread/list', { limit: 3 });
  console.log('thread/list ->', (list.data ?? []).length, 'threads');

  const started = await send('thread/start', { cwd: 'C:\\CHAT' });
  threadId = started.thread?.id ?? started.id;
  console.log('thread/start ->', threadId);

  await send('turn/start', {
    threadId,
    input: [{ type: 'text', text: '只回复两个字：收到', text_elements: [] }],
    effort: 'low',
  });
  console.log('turn/start sent; streaming…');
});

ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    return;
  }
  if (msg.method && msg.id !== undefined) {
    console.log('SERVER-REQ', msg.method, JSON.stringify(msg.params).slice(0, 160));
    ws.send(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }));
    return;
  }
  if (msg.method) {
    if (!seen.has(msg.method)) { seen.add(msg.method); console.log('notif:', msg.method); }
    if (msg.method === 'item/agentMessage/delta') process.stdout.write(msg.params.delta ?? '');
    if (msg.method === 'turn/completed') {
      console.log('\nturn/completed:', msg.params.turn?.status, 'duration', msg.params.turn?.durationMs);
      done();
    }
    if (msg.method === 'error') console.log('\nERROR notif', JSON.stringify(msg.params).slice(0, 300));
  }
});

ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });

setTimeout(() => { console.log('\nTIMEOUT waiting for turn/completed'); done(); }, 120000);

await finished;
console.log('\nnotifications seen:', [...seen].sort().join(', '));
if (threadId) {
  try {
    const r = await send('thread/delete', { threadId });
    console.log('cleanup thread/delete ->', JSON.stringify(r).slice(0, 120));
  } catch (e) { console.log('cleanup failed:', e.message); }
}
ws.close();
process.exit(0);
