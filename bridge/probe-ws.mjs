// Feasibility probe: talk to `codex app-server --listen ws://` over WebSocket
// using a capability token in the Authorization header, then run `initialize`.
import fs from 'node:fs';
import WebSocket from 'ws';

const [url, tokenFile] = process.argv.slice(2);
const token = tokenFile && tokenFile !== '-' ? fs.readFileSync(tokenFile, 'utf8').trim() : null;

const ws = token
  ? new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
  : new WebSocket(url);

const id = () => (id.n = (id.n ?? 0) + 1);

function send(method, params) {
  const msg = { jsonrpc: '2.0', id: id(), method, params };
  ws.send(JSON.stringify(msg));
  console.log('>>', JSON.stringify(msg).slice(0, 300));
}

ws.on('open', () => {
  console.log('OPEN');
  send('initialize', {
    clientInfo: { name: 'codex-remote-web-probe', title: 'Codex Remote Web', version: '0.0.1' },
    capabilities: { experimentalApi: true },
  });
});

ws.on('message', (buf) => {
  const text = buf.toString();
  console.log('<<', text.slice(0, 600));
  // Stop after the initialize response arrives.
  const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (parsed && (parsed.result?.userAgent !== undefined || parsed.error)) {
    console.log('OK: initialize round-trip completed');
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => { console.error('ERROR', e.message); process.exit(1); });
ws.on('close', (code, reason) => { console.log('CLOSE', code, reason.toString()); process.exit(0); });

setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 15000);
