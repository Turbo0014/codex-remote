// Determine exactly what a second app-server can and cannot do against threads the
// desktop app currently holds: read-only history vs. session creation (resume/turn).
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:8787';
const passcode = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8')).passcode;

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ passcode }),
});
const cookie = (login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie')).split(';')[0];

const ws = new WebSocket('ws://127.0.0.1:8791');
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

let id = 1;
const pending = new Map();
ws.on('message', (b) => {
  const m = JSON.parse(b.toString());
  if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params) => {
  const mid = id++;
  ws.send(JSON.stringify(params === undefined ? { method, id: mid } : { method, id: mid, params }));
  return Promise.race([
    new Promise((r) => pending.set(mid, r)),
    new Promise((r) => setTimeout(() => r({ timeout: true }), 20000)),
  ]);
};

await send('initialize', { clientInfo: { name: 'probe-writers', title: 'W', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
ws.send(JSON.stringify({ method: 'initialized' }));

const list = await send('thread/list', { limit: 12 });
const threads = list.result?.data ?? [];
console.log('threads:', threads.length);

const targets = [
  '01a1a1b6-af7b-7393-a2bb-62fa0890ae09',
  '01a1a1e7-cdde-7c13-967f-e8f0d2ad3ad3',
  '01a1a1dd-951d-7b43-ae4b-f70d7ab7f20b',
];

for (const t of targets) {
  const meta = threads.find((x) => x.id === t);
  console.log(`\n=== ${t.slice(0, 8)}  ${meta?.name ?? meta?.preview?.slice(0, 40) ?? '(not in list)'} ===`);

  // 1) read-only: turns list without any resume
  const page = await send('thread/turns/list', { threadId: t, limit: 50, sortDirection: 'desc', itemsView: 'full' });
  if (page.error) console.log('  turns/list  -> ERR', JSON.stringify(page.error).slice(0, 160));
  else {
    const turns = page.result?.data ?? [];
    const items = turns.reduce((n, x) => n + (x.items?.length ?? 0), 0);
    console.log(`  turns/list  -> OK  turns=${turns.length} items=${items}`);
  }

  // 2) metadata read
  const read = await send('thread/read', { threadId: t });
  console.log(`  thread/read -> ${read.error ? 'ERR ' + JSON.stringify(read.error).slice(0, 140) : 'OK'}`);

  // 3) session creation (the thing that collides)
  const resume = await send('thread/resume', { threadId: t, excludeTurns: true });
  console.log(`  resume      -> ${resume.error ? 'ERR ' + JSON.stringify(resume.error).slice(0, 140) : 'OK'}`);
}

ws.close();
process.exit(0);
