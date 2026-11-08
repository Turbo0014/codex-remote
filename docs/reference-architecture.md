# Reference Architecture: browser-based remote front-end for Codex

Research date: 2026-03-11 (fetches via jsDelivr / Statically / raw.githack mirrors; `github.com` is unreachable on this machine).

Two upstreams were read end to end:

| Target | What was actually fetched |
| --- | --- |
| `bit-capybara/codex_xremote` @ `main` | `README.md`, `package.json`, `KNOWN_ISSUES_AND_DECISIONS.md` (full), `src/server/codexAppServerBridge.ts` (full, ~1.8k lines), `src/server/httpServer.ts`, `src/server/authMiddleware.ts`, `src/server/password.ts`, `src/cli/index.ts`, root directory listing |
| `openai/codex` @ `main` + `rust-v0.120.0` | `codex-rs/app-server/README.md` (both), `codex-rs/app-server-test-client/README.md`, full repo file tree, `app-server-protocol/schema/json/*` inventory |

Fetch notes (no invented content anywhere below):

- `https://cdn.jsdelivr.net/gh/openai/codex@main/codex-rs/app-server/README.md` returned **HTTP 403** on the first attempt, then succeeded on retry through all three mirrors (identical 53,732-byte body). Transient.
- `docs/app-server*.md` **does not exist** in `openai/codex` (404 on all mirrors). The only app-server doc is `codex-rs/app-server/README.md`.
- **Important:** the README on `main` is no longer a getting-started contract doc — it has been converted into a protocol-changelog digest (`# Managed human command checkpoints (experimental)`, `# Thread memory summary (experimental)`, … 60+ such `#` sections). It does **not** document the transport or the initialize→thread→turn flow. For the canonical contract I therefore also fetched the tag **`rust-v0.120.0`**, whose README (85,574 bytes) still has `## Protocol`, `## Lifecycle Overview`, `## Initialization`, `## Events`, `## Approvals`. Section B below quotes mostly from that tag and says which.

---

## 1. codex_xremote: what it actually does

### Verdict

**Option (a), with a hand-written front-end.** It spawns a real `codex app-server` child process and proxies **newline-delimited JSON-RPC over stdin/stdout**. It does *not* (b) reimplement the app-server renderer protocol, and it does *not* (c) serve the extracted Codex desktop `webview/` bundle. It does write its own Vue 3 UI from scratch — so "reimplements the renderer" is true only in the sense of *drawing* the UI, never in the sense of *speaking* the protocol itself.

The evidence is unambiguous, from `package.json`:

```json
"bin": { "codex-xremote": "dist-cli/index.js" },
"files": ["dist/", "dist-cli/"],
"dependencies": { "commander": "^13.1.0", "express": "^5.1.0",
                  "qrcode-terminal": "^0.12.0", "ws": "^8.21.0" },
"devDependencies": { "vue": "^3.5.13", "vite": "^6.4.3", "tailwindcss": "^4.1.18" }
```

`vue` is a **devDependency** (compiled into `dist/`), and there is no `webview` asset path anywhere in the server. `httpServer.ts` serves its own Vite build:

```ts
const distDir = join(__dirname, '..', 'dist')
// 4. Static files from Vue build
app.use(express.static(distDir))
```

The README's own architecture diagram is accurate about the layering:

```text
Browser
  |
  | HTTP/WebSocket
  v
codex-xremote
  |
  | Codex app-server bridge
  v
Codex CLI / app-server runtime
```

### The child process

`src/server/codexAppServerBridge.ts` — this is the whole bridge, in one class. Note the **stdio** transport (no `--listen` at all) and the runtime config overrides:

```ts
class AppServerProcess {
  private process: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private readBuffer = ''
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<number, { resolve: …; reject: … }>()
  private readonly notificationListeners = new Set<(value: { method: string; params: unknown }) => void>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()
  private readonly appServerArgs = [
    'app-server',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="danger-full-access"',
  ]

  private start(): void {
    if (this.process) return
    this.stopping = false
    const codexCommand = getCodexCommandParts()
    const proc = spawn(codexCommand.command, [...codexCommand.args, ...this.appServerArgs], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process = proc
```

Two things to flag immediately:

1. **Transport is stdio JSONL, not WebSocket.** The bridge is one long-lived child, and the browser never sees a socket to Codex.
2. **Approvals and the sandbox are disabled for every thread**: `approval_policy="never"` and `sandbox_mode="danger-full-access"` are hardcoded spawn args. xremote still implements the full approval plumbing (below), but on its default configuration the server will never ask. Treat this as a deliberate "trusted local agent" stance, not as a pattern to copy.

stdout is parsed as JSONL with a manual newline scanner, and writes are one JSON object per line:

```ts
proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk: string) => {
  this.readBuffer += chunk
  let lineEnd = this.readBuffer.indexOf('\n')
  while (lineEnd !== -1) {
    const line = this.readBuffer.slice(0, lineEnd).trim()
    this.readBuffer = this.readBuffer.slice(lineEnd + 1)
    if (line.length > 0) { this.handleLine(line) }
    lineEnd = this.readBuffer.indexOf('\n')
  }
})

private sendLine(payload: Record<string, unknown>): void {
  if (!this.process) { throw new Error('codex app-server is not running') }
  this.process.stdin.write(`${JSON.stringify(payload)}\n`)
}
```

stderr is deliberately swallowed — a real operational weakness:

```ts
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', () => {
  // Keep stderr silent in dev middleware; JSON-RPC errors are forwarded via responses.
})
```

### Initialization

One shared connection, initialized lazily exactly once, guarded by an in-flight promise so concurrent first requests don't double-initialize:

```ts
private async ensureInitialized(): Promise<void> {
  if (this.initialized) return
  if (this.initializePromise) { await this.initializePromise; return }
  this.initializePromise = this.call('initialize', {
    clientInfo: { name: 'codex-web-local', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  }).then(() => { this.initialized = true }).finally(() => { this.initializePromise = null })
  await this.initializePromise
}
```

Note it **skips the `initialized` notification** that the official contract requires (see §4). It also hardcodes `experimentalApi: true` with no way for a user to opt out.

---

## 2. Its protocol / transport details

### Exact envelope

xremote is **not** raw JSON-RPC to the browser. Its wire format is a *narrowed, id-less* envelope:

| Direction | Transport | Body |
| --- | --- | --- |
| client → server (request) | `POST /codex-api/rpc` | `{ "method": string, "params"?: unknown }` |
| server → client (response) | HTTP 200 | `{ "result": unknown }` |
| server → client (error) | HTTP 4xx/5xx | `{ "error": string }` |
| server → client (notifications) | WebSocket `/codex-api/ws` **and** SSE `GET /codex-api/events` | `{ "method": string, "params": unknown, "atIso": string }` |

The RPC route is nine lines — there is no `id`, no `jsonrpc` field, no request multiplexing:

```ts
if (req.method === 'POST' && url.pathname === '/codex-api/rpc') {
  const payload = await readJsonBody(req)
  const body = asRecord(payload) as RpcProxyRequest | null

  if (!body || typeof body.method !== 'string' || body.method.length === 0) {
    setJson(res, 400, { error: 'Invalid body: expected { method, params? }' })
    return
  }

  const result = await appServer.rpc(body.method, body.params ?? null)
  setJson(res, 200, { result })
  return
}
```

Errors lose their JSON-RPC code: `call()` rejects with `new Error(message.error.message)`, which the outer `try/catch` turns into `setJson(res, 502, { error: message })`. So `-32602`, `-32001` (overloaded, retryable) etc. all collapse into an opaque HTTP 502 string.

### The WebSocket is server→client only

This is the single most surprising detail. `httpServer.ts` attaches `/codex-api/ws`, sends a `ready` frame, subscribes to notifications — and **never registers a `message` handler**. The socket is a one-way push channel:

```ts
wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ method: 'ready', params: { ok: true }, atIso: new Date().toISOString() }))
  const unsubscribe = bridge.subscribeNotifications((notification) => {
    if (ws.readyState !== 1) return
    ws.send(JSON.stringify(notification))
  })

  ws.on('close', unsubscribe)
  ws.on('error', unsubscribe)
})
```

The identical stream is also exposed as SSE, with a 15 s keepalive comment and `X-Accel-Buffering: no`:

```ts
if (req.method === 'GET' && url.pathname === '/codex-api/events') {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const unsubscribe = middleware.subscribeNotifications((notification) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`data: ${JSON.stringify(notification)}\n\n`)
  })
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
  const keepAlive = setInterval(() => { res.write(': ping\n\n') }, 15000)
```

So: **hybrid HTTP-POST-for-calls + SSE/WS-for-notifications**, with two redundant push transports.

### Server→client requests get a synthetic envelope

Approvals and other server-initiated requests are stripped of their JSON-RPC identity and re-emitted as a *notification* (`server/request`), then answered out-of-band by a second HTTP call. From `handleLine` / `handleServerRequest`:

```ts
// Handle server-initiated JSON-RPC requests (approvals, dynamic tool calls, etc.).
if (typeof message.id === 'number' && typeof message.method === 'string') {
  this.handleServerRequest(message.id, message.method, message.params ?? null)
}

private handleServerRequest(requestId: number, method: string, params: unknown): void {
  const pendingRequest: PendingServerRequest = {
    id: requestId, method, params, receivedAtIso: new Date().toISOString(),
  }
  this.pendingServerRequests.set(requestId, pendingRequest)
  this.emitNotification({ method: 'server/request', params: pendingRequest })
}
```

The answer comes back over HTTP and is validated against the pending map before being turned back into a real JSON-RPC response:

```ts
private resolvePendingServerRequest(requestId: number, reply: ServerRequestReply): void {
  const pendingRequest = this.pendingServerRequests.get(requestId)
  if (!pendingRequest) {
    throw new Error(`No pending server request found for id ${String(requestId)}`)
  }
  this.pendingServerRequests.delete(requestId)
  this.sendServerRequestReply(requestId, reply)
  …
  this.emitNotification({
    method: 'server/request/resolved',
    params: { id: requestId, method: pendingRequest.method, threadId, mode: 'manual',
              resolvedAtIso: new Date().toISOString() },
  })
}
```

### Full endpoint list (from `httpServer.ts` + the big router in `codexAppServerBridge.ts`)

Protocol surface:

- `POST /codex-api/rpc` — the only call channel
- `GET  /codex-api/ws` — notification push (WS), auth-checked on `upgrade`
- `GET  /codex-api/events` — notification push (SSE)
- `POST /codex-api/server-requests/respond` — answer an approval / elicitation
- `GET  /codex-api/server-requests/pending` — **rehydration list for reconnecting clients**
- `GET  /codex-api/meta/methods`, `GET /codex-api/meta/notifications` — method catalog
- `POST /codex-api/mobile-auth/login`, `POST /codex-api/mobile-auth/logout`
- `POST /auth/login` — cookie login (HTML form fallback for non-JS clients)

Non-protocol app surface (this is what makes it a *product* rather than a proxy): `POST /codex-api/upload-file` (hand-rolled multipart parser → temp dir), `POST /codex-api/transcribe` (proxies `https://chatgpt.com/backend-api/transcribe` with the local `~/.codex/auth.json` access token and `originator: Codex Desktop`), `GET/PUT /codex-api/workspace-roots-state`, `GET/PUT /codex-api/thread-titles`, `POST /codex-api/project-root`, `GET /codex-api/project-root-suggestion`, `GET /codex-api/project-root-directories`, `POST /codex-api/composer-file-search` (ripgrep-backed), `GET /codex-api/skills-hub` + `/readme` + `/install` + `/uninstall` + `/update` + `/reinstall` + `/repair`, `GET/PUT /codex-api/project-skill-preferences`, `GET/POST /codex-api/skill-presets`, `POST /codex-api/skill-review`, `GET /codex-api/app-info`, `GET /codex-api/home-directory`, and `GET /codex-local-image?path=…` (serves arbitrary absolute local image paths to make markdown previews work — see "avoid" below).

### Method discovery (the clever bit worth stealing)

Rather than hardcoding app-server methods, it shells out to Codex's own schema exporter and reads the `method` enums out of the generated JSON Schema:

```ts
private async runGenerateSchemaCommand(outDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const codexCommand = getCodexCommandParts()
    const process = spawn(codexCommand.command, [...codexCommand.args, 'app-server', 'generate-json-schema', '--out', outDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
```

```ts
private extractMethodsFromClientRequest(payload: unknown): string[] {
  const root = asRecord(payload)
  const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
  const methods = new Set<string>()
  for (const entry of oneOf) {
    const row = asRecord(entry)
    const properties = asRecord(row?.properties)
    const methodDef = asRecord(properties?.method)
    const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []
    for (const item of methodEnum) {
      if (typeof item === 'string' && item.length > 0) { methods.add(item) }
    }
  }
  return Array.from(methods).sort((a, b) => a.localeCompare(b))
}
```

Cached in `methodCache` / `notificationCache` for process lifetime. This survives Codex protocol drift with zero bridge changes and directly powers `/codex-api/meta/methods`.

### Authentication / pairing

`src/cli/index.ts` — default flow is: check `codex login`, generate a password, listen (with port fallback from 5999), start a **cloudflared quick tunnel by default**, print a QR code of the tunnel URL, and open a browser:

```ts
const requestedPort = parseInt(options.port, 10)
const password = resolvePassword(options.password)
const { app, dispose, attachWebSocket } = createApp({ password })
const port = await listenWithFallback(server, requestedPort)
…
const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${String(localPort)}`], { … })
…
qrcode.generate(tunnelUrl, { small: true })
openBrowser(`http://localhost:${String(port)}`)
```

Passwords are human-transcribable `abc-def-ghi` base36 triples (`src/server/password.ts`):

```ts
export function generatePassword(): string {
  return `${randomGroup(3)}-${randomGroup(3)}-${randomGroup(3)}`
}
```

Two credential types in `authMiddleware.ts`:

1. **Session cookie** — random 32-byte hex placed in an **in-memory `Set`** (`const validTokens = new Set<string>()`), `HttpOnly; SameSite=Strict`:
   ```ts
   const token = randomBytes(32).toString('hex')
   validTokens.add(token)
   res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`)
   ```
   Consequence: **every server restart invalidates all sessions**, and tokens never expire.
2. **Mobile bearer token** — stateless HMAC, so it *does* survive restarts, 30-day TTL, accepted from `Authorization: Bearer`, and also from `?access_token=` (needed for `<img>`/EventSource/WebView):
   ```ts
   function signMobileTokenPayload(payloadPart: string, password: string): string {
     return createHmac('sha256', password).update(payloadPart).digest('base64url')
   }
   …
   if (authToken && isValidMobileAuthToken(authToken, password)) { return true }
   …
   const queryToken = url.searchParams.get('access_token') ?? ''
   return isValidMobileAuthToken(queryToken, password)
   ```
   The HMAC key is the **password itself**, so rotating the password invalidates every issued token — a neat trick, but it means the password is a long-lived signing secret.

Localhost bypass is opt-in only, which is the right default:

```ts
function allowLocalhostBypass(): boolean {
  return process.env.CODEXUI_ALLOW_LOCALHOST_BYPASS === '1'
}
```

WebSocket upgrades are gated with the same predicate before `handleUpgrade`:

```ts
if (authSession && !authSession.isRequestAuthorized(req)) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
  socket.destroy()
  return
}
```

Gaps: no login rate-limiting or lockout anywhere in `authMiddleware.ts`; CORS is only opened for Capacitor/localhost origins; `?access_token=` in a URL leaks into Referer/logs.

### Multiple clients and reconnects

**All browser clients share exactly one `codex app-server` child process and one JSON-RPC connection.** `start()` is idempotent (`if (this.process) return`), and notifications are broadcast to every listener:

```ts
private emitNotification(notification: { method: string; params: unknown }): void {
  for (const listener of this.notificationListeners) {
    listener(notification)
  }
}
```

Implications, stated plainly:

- **No per-client or per-thread filtering.** Every tab receives every notification for every thread. The client is expected to drop what it doesn't care about.
- **No replay/backlog.** A reconnecting client gets a fresh `ready` frame and then only *future* notifications. Recovery relies on HTTP reads (`thread/read`, `thread/list`) plus `/codex-api/server-requests/pending`. That pending-requests endpoint is precisely the reconnect fix for approvals — a reloaded page can still discover and answer an outstanding approval.
- **Approvals are global and unattributed.** Any connected client can answer any pending request; first responder wins, and nothing records who answered (`mode: 'manual'` is hardcoded).
- **Crash recovery is per-call, not per-process.** On child exit all pending promises reject and state is cleared; the *next* `rpc()` call lazily respawns and re-initializes:
  ```ts
  proc.on('exit', () => {
    const failure = new Error(this.stopping ? 'codex app-server stopped' : 'codex app-server exited unexpectedly')
    for (const request of this.pending.values()) { request.reject(failure) }
    this.pending.clear(); this.pendingServerRequests.clear()
    this.process = null; this.initialized = false; this.initializePromise = null; this.readBuffer = ''
  })
  ```
- **Disposing kills the shared child** with SIGTERM then SIGKILL after 1.5 s — i.e. one client disconnecting can, in a multi-client deployment, tear down everyone's runtime (guarded only by callers).

---

## 3. KNOWN_ISSUES_AND_DECISIONS.md — the valuable part

The file opens with its own purpose statement, and it reads as scar tissue from a real VPS deployment:

> This file exists to prevent repeat mistakes during future CodexU work.

**Source of truth / drift**
- `upstream-source` is the editable tree; `installed-from-vps/codex-xremote` is an operational snapshot; `recovered-vps-src` is for understanding runtime behavior only.
- "Do not assume the public GitHub repo and the VPS-installed package are identical." Public repo and VPS package were observed at **different versions** — validate behavior against the runtime before trusting the source tree.

**Packaging**
- Linux `npm` hits `ERESOLVE` because `capacitor-secure-storage-plugin` advertises a newer peer than the Capacitor 7 shell → fall back to `npm install --legacy-peer-deps`, as a dev-environment workaround only, never a reason to hand-edit production files.
- Build metadata: changelog used to show `Unknown` → generate `app-build-info.json` during normal builds; when metadata is genuinely missing, "show an explicit reason instead of generic `Unknown`".

**Bash/deploy bugs that already bit them**
- `ps | grep` under `set -e` broke deploys when no process matched → "every `grep`-style process probe in shell scripts must tolerate an empty match (`|| true`)".
- Detached runtime: `nohup … &` unreliable, `setsid -f` "better, but still not stable enough"; restarts printed `dev_health=ok` and then the process died seconds later. Decision: **`systemd-run --user`** as the default detached launcher, `setsid`/`nohup` as fallbacks, and verify restarts with **state-based checks** (PID/unit state, loopback health) — "not only startup log text".

**Windows**
- "`codex_xremote` could not reliably launch the bundled Windows Codex desktop `codex.exe` from its child-process flow." Decision: on Windows, **prefer the npm global Codex CLI** as the runtime target when the bundled executable fails.

**Runtime structure** (their own words, matching §1)
> `codex_xremote` is not the model engine. Runtime structure: browser/app client → `codex_xremote` web server → child `codex app-server` → Codex engine/tool execution.

**Restart vs reload semantics**
- `.codex`, `AGENTS.md`, `config.toml` changes are **restart-required**; validate in a *new session*.
- Skill inventory changes are reloadable because `skills/list` supports `forceReload: true`: `await appServer.rpc('skills/list', { forceReload: true })`.

**UI/UX decisions not to revert** (all learned the hard way)
- **Chat vs Commands split**: rendering every shell command inline "made the main chat unreadable" → default view `Chat`, command detail in `Commands`, keep `Running commands: N` visible in chat.
- **Native-first skills**: long wrapper policy text to force skill usage was removed; "CodexU is a control plane, not a prompt-forcing layer."
- **Plan tab auto-switch**: jumping to the Plan tab on arrival stole context → keep the current tab, increment a `Plan` badge, leave a short plan summary card in `Chat`.
- **Skill review** is a preflight confirmation only; "it never silently explores or installs new skills."
- **Context vs quota**: never present context usage as account quota; show `Context` as a thread-level chip, compute % against `model_auto_compact_token_limit`, fall back to `modelContextWindow` explicitly.
- **Compact threshold**: `model_auto_compact_token_limit = 225000` as the thread-level 100% mark, "an early compact threshold to stay below the higher-cost region."
- **Presets** belong in their own top-level tab, not inside Skills Hub.

**Ports / tunnels**
- prod `5999`, dev `10000`, both Funnel-exposed; prod is promoted from the dev tree, never edited directly.
- Funnel is only allowed on capability-granted ports — observed `443`, `8443`, `10000`.
- Historical note kept for migration: the old `6001`/`6101` split existed because reusing one port for app + Tailscale listener caused unstable rebind; retired.

**Notably absent from the file:** nothing about the hardcoded `approval_policy="never"` / `danger-full-access`, nothing about multi-client approval races, nothing about the in-memory session set. The security-relevant defaults are undocumented.

---

## 4. openai/codex app-server contract

Source: `codex-rs/app-server/README.md` @ `rust-v0.120.0` (the `main` version no longer documents the transport — see fetch notes).

### Transport

> Similar to MCP, `codex app-server` supports bidirectional communication using JSON-RPC 2.0 messages (with the `"jsonrpc":"2.0"` header omitted on the wire).

```markdown
Supported transports:

- stdio (`--listen stdio://`, default): newline-delimited JSON (JSONL)
- websocket (`--listen ws://IP:PORT`): one JSON-RPC message per websocket text frame (**experimental / unsupported**)
- off (`--listen off`): do not expose a local transport
```

The `ws://` listener doubles as an HTTP health probe *and* rejects anything browser-shaped:

```markdown
- `GET /readyz` returns `200 OK` once the listener is accepting new connections.
- `GET /healthz` returns `200 OK` when no `Origin` header is present.
- Any request carrying an `Origin` header is rejected with `403 Forbidden`.

Websocket transport is currently experimental and unsupported. Do not rely on it for production workloads.
```

Remote/auth guidance, verbatim:

```markdown
- Loopback websocket listeners (`ws://127.0.0.1:PORT`) remain appropriate for localhost and SSH port-forwarding workflows.
- Non-loopback websocket listeners currently allow unauthenticated connections by default during rollout. If you expose one remotely, configure websocket auth explicitly now.
- Supported auth modes are app-server flags:
  - `--ws-auth capability-token --ws-token-file /absolute/path`
  - `--ws-auth signed-bearer-token --ws-shared-secret-file /absolute/path` for HMAC-signed JWT/JWS bearer tokens, with optional `--ws-issuer`, `--ws-audience`, `--ws-max-clock-skew-seconds`
- Clients present the credential as `Authorization: Bearer <token>` during the websocket handshake. Auth is enforced before JSON-RPC `initialize`.
```

Backpressure is part of the contract:

```markdown
- When request ingress is saturated, new requests are rejected with a JSON-RPC error code `-32001` and message `"Server overloaded; retry later."`.
- Clients should treat this as retryable and use exponential backoff with jitter.
```

### Lifecycle (the documented minimal flow)

```markdown
- Initialize once per connection: Immediately after opening a transport connection, send an `initialize` request with your client metadata, then emit an `initialized` notification. Any other request on that connection before this handshake gets rejected.
- Start (or resume) a thread: Call `thread/start` to open a fresh conversation. The response returns the thread object and you'll also get a `thread/started` notification. If you're continuing an existing conversation, call `thread/resume` with its ID instead. …
- Begin a turn: To send user input, call `turn/start` with the target `threadId` and the user's input. … This immediately returns the new turn object. The app-server emits `turn/started` when that turn actually begins running.
- Stream events: After `turn/start`, keep reading JSON-RPC notifications on stdout. You'll see `item/started`, `item/completed`, deltas like `item/agentMessage/delta`, tool progress, etc.
- Finish the turn: When the model is done (or the turn is interrupted via making the `turn/interrupt` call), the server sends `turn/completed` with the final turn state and token usage.
```

`initialize` takes `clientInfo` and optional `capabilities`; the response returns the user agent, `codexHome`, `platformFamily`, `platformOs`. Two error states matter: `"Not initialized"` for premature calls, `"Already initialized"` for a double init. The example, verbatim:

```json
{
  "method": "initialize",
  "id": 0,
  "params": {
    "clientInfo": {
      "name": "codex_vscode",
      "title": "Codex VS Code Extension",
      "version": "0.1.0"
    }
  }
}
```

Per-connection notification suppression exists via `capabilities.optOutNotificationMethods` — exact match, no wildcards:

```json
"capabilities": {
  "experimentalApi": true,
  "optOutNotificationMethods": ["thread/started", "item/agentMessage/delta"]
}
```

`thread/start` example (note config can be set per thread, and `approvalPolicy`/`sandbox` are per-thread knobs, not global flags):

```json
{ "method": "thread/start", "id": 10, "params": {
    "model": "gpt-5.1-codex",
    "cwd": "/Users/me/project",
    "approvalPolicy": "never",
    "sandbox": "workspaceWrite",
    "personality": "friendly",
    "serviceName": "my_app_server_client",
    "sessionStartSource": "startup"
} }
{ "id": 10, "result": {
    "thread": { "id": "thr_123", "preview": "", "modelProvider": "openai", "createdAt": 1730910000 }
} }
{ "method": "thread/started", "params": { "thread": { … } } }
```

`turn/start` example, including the discriminated `input` union:

```json
{ "method": "turn/start", "id": 30, "params": {
    "threadId": "thr_123",
    "input": [ { "type": "text", "text": "Run tests" } ],
    "cwd": "/Users/me/project",
    "approvalPolicy": "unlessTrusted",
    "sandboxPolicy": {
        "type": "workspaceWrite",
        "writableRoots": ["/Users/me/project"],
        "networkAccess": true
    },
    "model": "gpt-5.1-codex",
    "effort": "medium",
    "summary": "concise",
    "personality": "friendly"
} }
```

`input` items: `{"type":"text","text":"…"}`, `{"type":"image","url":"https://…png"}`, `{"type":"localImage","path":"/tmp/screenshot.png"}` (plus `{"type":"skill","name","path"}` for explicit skill invocation).

### Streaming: which notifications to render

> The per-item lifecycle is always: `item/started` → zero or more item-specific deltas → `item/completed`.

Turn-level: `turn/started`, `turn/completed` (`completed` | `interrupted` | `failed`), `turn/diff/updated` (aggregated unified diff per turn), `turn/plan/updated` (`{step, status}` with `pending`/`inProgress`/`completed`), `model/rerouted`, `thread/tokenUsage/updated`, `error`.

Item-level (`ThreadItem` union): `userMessage`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `collabToolCall`, `webSearch`, `imageView`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`, `compacted` (deprecated).

Deltas: `item/agentMessage/delta`, `item/plan/delta` (experimental), `item/reasoning/summaryTextDelta` (+ `summaryPartAdded`, keyed by `summaryIndex`), `item/reasoning/textDelta` (keyed by `contentIndex`), `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`.

Two important caveats, verbatim:

> Today both notifications carry an empty `items` array even when item events were streamed; rely on `item/*` notifications for the canonical item list until this is fixed.

> `item/completed` — sends the final `item` once that work itself finishes …; treat this as the authoritative execution/result state.

### Answering server→client requests (approvals)

> When `turn/start` is used, the app-server drives an approval flow by sending a server-initiated JSON-RPC request to the client. The client must respond to tell Codex whether to proceed. UIs should present these requests inline with the active turn…
>
> - Requests include `threadId` and `turnId`—use them to scope UI state to the active conversation.
> - Respond with a single `{ "decision": ... }` payload.

Documented ordering for a command approval:

```markdown
1. `item/started` — shows the pending `commandExecution` item with `command`, `cwd`, and other fields so you can render the proposed action.
2. `item/commandExecution/requestApproval` (request) — carries the same `itemId`, `threadId`, `turnId`, optionally `approvalId` … 
3. Client response — for example `{ "decision": "accept" }`, `{ "decision": "acceptForSession" }`, `{ "decision": { "acceptWithExecpolicyAmendment": … } }`, `{ "decision": { "applyNetworkPolicyAmendment": … } }`, `{ "decision": "decline" }`, or `{ "decision": "cancel" }`.
4. `serverRequest/resolved` — `{ threadId, requestId }` confirms the pending request has been resolved or cleared, including lifecycle cleanup on turn start/complete/interrupt.
5. `item/completed` — final `commandExecution` item with `status: "completed" | "failed" | "declined"` and execution output. Render this as the authoritative result.
```

File changes follow the same five-step shape with `item/fileChange/requestApproval` and only `accept`/`acceptForSession`/`decline`/`cancel`.

Other server→client requests:

| Method | Response shape |
| --- | --- |
| `item/commandExecution/requestApproval` | `{ decision }` |
| `item/fileChange/requestApproval` | `{ decision }` |
| `item/tool/requestUserInput` | answers object; server then emits `serverRequest/resolved` |
| `item/permissions/requestApproval` | `{ permissions: <granted subset> }`, optional `scope: "session"` |
| `mcpServer/elicitation/request` | `{ action: "accept"\|"decline"\|"cancel", content }` |

Also documented: `approvalsReviewer` on `turn/start` can be `"user"` (default) or `"guardian_subagent"` — i.e. approvals can be delegated to a subagent rather than the UI. And `item/commandExecution/requestApproval` may include `availableDecisions`, which clients "can prefer … when present to render the exact set of choices the server wants to expose".

### Protocol version pinning

`codex app-server generate-ts --out DIR` and `codex app-server generate-json-schema --out DIR` produce artifacts "specific to the version of Codex you used to run the command, so the generated artifacts are guaranteed to match that version."

---

## 5. Recommended architecture for our case

**What we already have** (`codex-remote/`): Node bridge `bridge/server.mjs` (399 lines) that spawns `codex app-server --listen ws://127.0.0.1:8791`, gates a `/ws` upgrade on an HMAC-signed cookie, and then **pipes browser WS ↔ app-server WS 1:1** (`attachUpstream`). Static UI in `codex-remote/web/` (`app.js`, 48 KB) speaks **raw JSON-RPC** — it sends `initialize` then `rpc.notify('initialized')`, and answers approvals with `{ decision }` via `rpc.reply(requestId, …)`.

That is a fundamentally different (and mostly better) shape than xremote. Keep it.

### Keep: our raw-JSON-RPC 1:1 proxy is the right call

xremote's id-less envelope is a *liability*. Because it strips `id` and `jsonrpc`, it can only ever support one in-flight request per method from the whole server, it flattens JSON-RPC error codes into HTTP 502 strings (destroying `-32001`'s "retry with backoff" semantics and `-32602` validation detail), and it has to bolt on `server/request` + `/server-requests/respond` + `/pending` just to recover request/response correlation that raw JSON-RPC gives for free. We get all of that by not translating. Concretely:

| | xremote | ours |
| --- | --- | --- |
| Browser wire format | `{method, params}` + `{result}` | real JSON-RPC 2.0, ids preserved |
| Upstream transport | stdio child, single shared connection | `--listen ws://127.0.0.1:8791`, **one connection per browser tab** |
| Streaming | SSE + WS (duplicated), all clients get everything | WS, per-connection subscription semantics from app-server |
| Adding a new method | needs UI work only (method-agnostic), but errors stay opaque | zero bridge work, full error fidelity |
| Approvals | global, unattributed, any client answers | naturally routed to the connection that owns the turn |
| Client count | 1 shared JSON-RPC identity | N independent identities |

Two consequences of ours that are *correct* and should not be "fixed" by copying xremote: because each tab has its own connection, `thread/start` auto-subscribes only that connection, and an approval request lands only on the connection that owns the turn. That is precisely the per-client isolation xremote lacks. (xremote's global broadcast is only "better" if you want any device to answer any approval — a product choice, not a correctness one.)

### Copy 1: durable pending-approval tracking (highest value)

This is xremote's genuinely hard-won reconnect fix and we have nothing equivalent. A page reload mid-approval currently loses the prompt forever, and the turn hangs.

Implement in the bridge, without adopting their envelope:

- Track server→client requests as they cross the pipe. The bridge sees `{"id":N,"method":"…"}` frames with an `id` *and* a `method`, and their answers (`{"id":N,"result":…}` or `{"id":N,"error":…}`) — cheap to sniff without terminating the JSON-RPC contract.
- Expose `GET /api/pending-requests` returning `[{id, method, params, receivedAt}]` scoped to that client, plus `POST /api/reply` that writes the raw response frame upstream.
- On WS reconnect for a session, have the UI fetch pending requests and re-render. Keep ids monotonic per upstream connection so a reply can never be misrouted.
- Broadcast/record a resolution event (mirroring `serverRequest/resolved`) so a *second* tab doesn't render a stale approval card.

xremote's `listPendingServerRequests()` + `resolvePendingServerRequest()` id-validation ("No pending server request found for id") is the shape to copy; its global `Map` is the part to make per-session.

### Copy 2: schema-driven method/notification discovery

`generate-json-schema` (or `generate-ts`, which is friendlier for our plain-JS UI) is the sanctioned way to stay in sync, and the docs explicitly guarantee the artifacts match the running binary. Add a bridge endpoint `GET /api/protocol` that runs `codex app-server generate-json-schema --out <tmp>`, extracts the `method` enums from `ClientRequest.json` / `ServerNotification.json`, and caches by **`codex --version`** (xremote caches only for process lifetime — cache to disk instead). That turns every future "unknown notification" bug into a UI data problem rather than a dropped frame, and lets us validate outgoing methods before sending them.

### Copy 3: stdio with lazy respawn, as a *fallback* transport

xremote's crash story is better than ours in one respect: the app-server child is respawned lazily on the next call, and a dead child rejects pending calls instead of wedging the bridge. Ours already restarts with `2s → 5s` backoff and gates on `/readyz`, which is good, but two gaps are worth closing: reject in-flight pipes on child exit (so the UI gets an error instead of silence), and surface child `stderr` into `bridge/logs/bridge.log` rather than discarding it.

Longer term, note that the official docs call `--listen ws://` **"experimental / unsupported"** while stdio is the default, supported transport. Spawning `codex app-server` over stdio and multiplexing N browser sessions over it (per-session id namespacing, which is what xremote avoids by collapsing to one identity) would be the fully-supported path. Not urgent — loopback-only `ws://` is explicitly blessed for local/SSH use — but it should be a documented known-limitation, not an accident.

### Avoid

1. **Never adopt `-c approval_policy="never" -c sandbox_mode="danger-full-access"` as spawn defaults.** This is xremote's single worst decision and it is not even documented in their known-issues file. Approvals are a documented protocol feature with a clean UI story (`availableDecisions`, `acceptForSession`, `serverRequest/resolved`); disabling them converts every remote browser session into unrestricted local code execution. Ours is right to leave policy to `thread/start`/`turn/start` (which is exactly what the official `thread/start` example shows).
2. **Don't strip JSON-RPC ids or flatten error codes** — see the table above.
3. **Don't serve arbitrary local absolute paths.** xremote's `GET /codex-local-image?path=` `sendFile`s any absolute path with `dotfiles: 'allow'` behind only the session cookie. If we need markdown image previews, allowlist the thread cwd / a temp upload dir and validate with `path.resolve` prefix checks.
4. **Don't put long-lived tokens in the query string.** xremote accepts `?access_token=` (EventSource/WebView convenience). Our signed cookie is sufficient; if a WS-only client needs a token, use a short-TTL, single-use ticket endpoint.
5. **Don't use an in-memory token set** (xremote logs every session out on restart) and **don't key the HMAC to the raw password** — derive a separate token-signing secret. Keep our existing login rate limit (`8 attempts / 5 min`) which xremote lacks entirely.
6. **Don't ship two redundant push transports.** WS carries notifications for us already; SSE would double the fan-out code for no benefit.
7. **Don't broadcast all threads to all clients.** xremote's firehose is a consequence of its single shared connection; in our per-connection model we should keep filtering by `threadId` on the client and avoid adding a server-side global broadcast.

### Concrete work list

1. `bridge/server.mjs`: add server-request tracking + `GET /api/pending-requests` + `POST /api/reply`; reject pending on child exit; log child stderr.
2. `bridge/server.mjs`: add `GET /api/protocol` (schema-derived method/notification lists, disk-cached by `codex --version`).
3. `web/app.js`: on WS open, `GET /api/pending-requests` and re-render approval cards; handle a resolution event to clear cards answered elsewhere.
4. Document in `README.md` that `--listen ws://127.0.0.1:8791` is officially **experimental/unsupported**, that loopback use is blessed, and that the app-server rejects any request with an `Origin` header with `403` — which is exactly why a browser cannot bypass our bridge and hit 8791 directly.
5. Show `Context` token usage from `thread/tokenUsage/updated` as a thread-level chip, never as account quota (adopt xremote's decision, and their `model_auto_compact_token_limit` framing).

---

## Appendix: fetch log

| URL | Result |
| --- | --- |
| `https://cdn.jsdelivr.net/gh/bit-capybara/codex_xremote@main/README.md` | 200, 3,742 B |
| `…/main/package.json` | 200, 2,699 B — version `0.1.8` |
| `…/main/KNOWN_ISSUES_AND_DECISIONS.md` | 200, 7,168 B — read in full |
| `…/main/src/server/codexAppServerBridge.ts` | 200, ~1.8k lines — read in full |
| `…/main/src/server/httpServer.ts`, `authMiddleware.ts`, `password.ts`, `src/cli/index.ts` | 200 |
| `https://cdn.jsdelivr.net/gh/openai/codex@main/codex-rs/app-server/README.md` | **403 on first try**, then 200 / 53,732 B on retry — protocol-changelog format, no transport section |
| `https://cdn.statically.io/gh/openai/codex/main/codex-rs/app-server/README.md` | 200, 53,732 B (identical) |
| `https://raw.githack.com/openai/codex/main/codex-rs/app-server/README.md` | 200, 53,732 B (identical) |
| `…/openai/codex@rust-v0.120.0/codex-rs/app-server/README.md` | 200, 85,574 B — **canonical contract doc, quoted in §4** |
| `…/openai/codex@rust-v0.51.0/…/README.md` | 200, 808 B (stub — too old) |
| `…/openai/codex@rust-v0.44.0/…/README.md` | 404 |
| `docs/app-server.md`, `docs/app-server-protocol.md` | 404 — do not exist |
| `codex-rs/app-server-test-client/README.md` | 200 — confirms `serve --listen ws://127.0.0.1:4222`, `request_user_input` interaction, thread-rejoin testing |
| `https://data.jsdelivr.com/v1/packages/gh/openai/codex@main` | 200, 2,573 files — used to enumerate `app-server-protocol/schema/**` |
