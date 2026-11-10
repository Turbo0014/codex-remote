// Codex Remote web client — speaks the app-server protocol over the bridge's
// /ws endpoint, and renders threads with the desktop app's visual language.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const dom = {
  login: $('#login'), loginForm: $('#loginForm'), passcode: $('#passcode'),
  loginBtn: $('#loginBtn'), loginError: $('#loginError'),
  app: $('#app'), sidebar: $('#sidebar'), overlay: $('#overlay'),
  sections: $('#sections'), sidebarScroll: $('#sidebarScroll'),
  messages: $('#messages'), scroll: $('#scroll'), main: $('.main'), banner: $('#banner'),
  threadTitle: $('#threadTitle'), cwdChip: $('#cwdChip'),
  input: $('#input'), sendBtn: $('#sendBtn'), stopBtn: $('#stopBtn'),
  modelBtn: $('#modelBtn'), modelLabel: $('#modelLabel'),
  effortBtn: $('#effortBtn'), effortLabel: $('#effortLabel'), composer: $('#composer'),
  accessBtn: $('#accessBtn'), accessLabel: $('#accessLabel'), accessPop: $('#accessPop'),
  modePop: $('#modePop'), modeTitle: $('#modeTitle'), modeReset: $('#modeReset'),
  modeModel: $('#modeModel'), modeModelName: $('#modeModelName'), modeRange: $('#modeRange'),
  modeDots: $('#modeDots'), modeScale: $('#modeScale'),
  connDot: $('#connDot'), connText: $('#connText'),
  menu: $('#menu'), toast: $('#toast'),
  newChatBtn: $('#newChatBtn'), drawerBtn: $('#drawerBtn'),
  themeBtn: $('#themeBtn'), searchBtn: $('#searchBtn'), searchBox: $('#searchBox'),
  searchInput: $('#searchInput'), bellBtn: $('#bellBtn'),
  hint: $('#hint'),
  modeBolt: $('#modeBolt'), modeFastTag: $('#modeFastTag'),
  projectBtn: $('#projectBtn'), projectLabel: $('#projectLabel'),
  projTarget: $('#projTarget'), projTargetLabel: $('#projTargetLabel'),
  modeSwitch: $('#modeSwitch'),
  selectBtn: $('#selectBtn'),
  newThreadBtn: $('#newThreadBtn'), metrics: $('#metrics'),
  quotaBanner: $('#quotaBanner'), quotaBall: $('#quotaBall'),
  toasts: $('#toasts'), cmdk: $('#cmdk'), cmdkInput: $('#cmdkInput'), cmdkList: $('#cmdkList'),
  attachBtn: $('#attachBtn'), attachments: $('#attachments'),
  wxTip: $('#wxTip'), wxTipClose: $('#wxTipClose'),
  dropOverlay: $('#dropOverlay'), slashMenu: $('#slashMenu'),
  panel: $('#panel'), panelTitle: $('#panelTitle'), panelBody: $('#panelBody'), panelTabs: $('#panelTabs'), panelClose: $('#panelClose'),
};

// Loading placeholder used by panels that wait on the app-server.
const SKELETON_HTML = '<div class="skel"><div class="skel-line w-60"></div><div class="skel-line w-80"></div><div class="skel-line w-40"></div></div>';

const state = {
  authed: false,
  threads: [],
  currentThreadId: null,
  turns: [],                 // [{id,status,startedAt,completedAt,durationMs,itemIds:[]}]
  items: new Map(),          // itemId -> item payload
  models: [],
  model: null,
  effort: null,
  access: 'ask',             // ask | auto | full — mirrors Codex's approval picker
  defaultCwd: '',
  currentCwd: '',
  wxAutoSend: false,
  // WeChat login QR: when it was fetched (ms) and whether a forced refresh is pending.
  wxQrStamp: 0,
  transfers: [],        // active + recent save / WeChat transfers
  wxQrRefresh: false,
  busy: false,
  currentTurnId: null,
  search: '',
  approvals: new Map(),
  errors: [],             // inline transcript errors (survive re-render)
  attachments: [],        // pending uploads: {name, path, size, isImage}
  skills: [],             // from skills/list
  skillPick: null,        // {name, path} attached to the next message
  // Collaboration modes are native Codex features, not skills: plan mode sends
  // collaborationMode:"plan" with the turn, goal mode sets a thread goal.
  planMode: false,
  goalMode: false,
  goalObjective: null,    // explicit objective from "/target <text>", else the message
  goal: null,             // the server's ThreadGoal for the current thread
  tokenUsage: null,       // latest thread/tokenUsage/updated payload
  ctxWindows: {},         // model id -> context window, learned from live usage
  fast: false,            // ⚡ Fast service tier (serviceTiers[].id)
  mcpServers: null,       // cached mcpServerStatus/list
  mcpThreadId: null,      // ephemeral thread used for standalone tool calls
  projects: [],           // from /api/projects (desktop registry, read-only)
  electronProjects: [],   // desktop registry (~/.codex/.codex-global-state.json)
  assignmentRemap: {},    // desktop project id -> app-server project id
  projectAssignments: {}, // threadId -> { projectId }
  projectlessIds: [],     // threads the desktop marks project-less
  quota: null,            // { blocked, resetAt, plan } from account/rateLimits/read
  sendCtx: null,          // { threadId, createdFresh, text } for orphan cleanup
  activeProjectId: null,  // sidebar filter / accordion
  selection: null,        // Set<threadId> while batch-select mode is on
  lastPickedId: null,     // anchor for shift-click range selection
  targetProjectId: null,  // where a NEW thread is created (null = this computer)
  ownership: 'unknown',   // unknown | mine | held  (held = desktop app has the writer lock)
  historyCursor: null,
  historyDone: false,
  historyLoaded: false,
  loadingOlder: false,
};

const nodes = new Map();     // itemId -> HTMLElement
let deltaQueue = new Map();  // itemId -> pending text
let flushScheduled = false;

// ---------------------------------------------------------------- utils
const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}分${r}秒` : `${m}分`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60}分`;
}

function shortPath(p) {
  if (!p) return '';
  return String(p).replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~').replace(/\\/g, '/');
}


// ---------------------------------------------------------------- toast stack
const TOAST_ICON = {
  ok: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  err: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 5v4M8 11.2v.1"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 7.5v4M8 4.8v.1"/></svg>',
};

/**
 * toast("saved")                      -> info
 * toast("发送失败：…")                 -> error (by wording)
 * toast("已归档", 2600, { action })    -> explicit options
 */
function toast(msg, ms = 2600, opts = {}) {
  const box = dom.toasts;
  if (!box) return;
  const kind = opts.kind || (/失败|错误|无法|超时|ERR/i.test(String(msg)) ? "err" : /已|成功|完成/.test(String(msg)) ? "ok" : "info");
  const node = document.createElement("div");
  node.className = "toast-item " + kind;
  node.style.setProperty("--t-life", ms + "ms");
  const icon = document.createElement("span");
  icon.className = "t-icon";
  icon.innerHTML = TOAST_ICON[kind] || TOAST_ICON.info;
  const text = document.createElement("span");
  text.className = "t-text";
  text.textContent = String(msg);
  node.append(icon, text);
  if (opts.action && opts.action.label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "t-action";
    b.textContent = opts.action.label;
    b.addEventListener("click", () => { close(); try { opts.action.onSelect?.(); } catch { /* ignore */ } });
    node.append(b);
  }
  const bar = document.createElement("span");
  bar.className = "t-bar";
  node.append(bar);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 200);
  };
  const timer = setTimeout(close, ms);
  node.addEventListener("click", (e) => { if (!e.target.closest(".t-action")) { clearTimeout(timer); close(); } });

  box.append(node);
  while (box.children.length > 3) box.firstElementChild.remove();
}

// ---------------------------------------------------------------- command palette
let cmdkItems = [];
let cmdkIndex = 0;

function cmdkSource() {
  const out = [];
  out.push({ group: '动作', name: '新会话', sub: 'New chat', run: () => app.newChat() });
  out.push({ group: '动作', name: '切换浅色/深色主题', sub: 'Theme', run: () => dom.themeBtn.click() });
  out.push({ group: '动作', name: '刷新会话列表', sub: 'Reload', run: () => app.loadThreads() });
  for (const [rail, label] of [['tools', '技能与 MCP'], ['files', '最近文件'], ['usage', '用量'], ['net', '网络与连通性']]) {
    out.push({ group: '面板', name: label, sub: '面板', run: () => document.querySelector('[data-rail="' + rail + '"]')?.click() });
  }
  out.push({ group: '面板', name: '微信 ClawBot', sub: '账号 / 收到的文件', run: () => openClawFiles() });
  out.push({ group: '面板', name: '新建项目…', sub: '选择本机目录', run: () => openNewProjectDialog() });
  for (const p of state.projects || []) {
    out.push({ group: '项目', name: p.name, sub: (p.roots || [])[0] || '', run: () => { state.targetProjectId = p.id; state.activeProjectId = p.id; updateProjectLabel(); renderThreadList(); toast('已切换到项目：' + p.name); } });
  }
  for (const t of state.threads || []) {
    out.push({ group: '会话', name: t.name || t.preview || t.id.slice(0, 8), sub: shortPath(t.cwd || ''), run: () => app.openThread(t.id, { silent: true }) });
  }
  for (const sk of state.skills || []) {
    out.push({ group: '技能', name: '/' + sk.name, sub: sk.description || '', run: () => { state.skillPick = sk; renderAttachments(); dom.input.focus(); } });
  }
  return out;
}

function renderCmdk(query = "") {
  const list = dom.cmdkList;
  if (!list) return;
  const q = query.trim().toLowerCase();
  const all = cmdkSource();
  cmdkItems = (q ? all.filter((x) => (x.name + " " + (x.sub || "")).toLowerCase().includes(q)) : all).slice(0, 40);
  if (cmdkIndex >= cmdkItems.length) cmdkIndex = Math.max(0, cmdkItems.length - 1);
  list.replaceChildren();
  if (!cmdkItems.length) {
    const empty = document.createElement("div");
    empty.className = "cmdk-empty";
    empty.textContent = "没有匹配项";
    list.append(empty);
    return;
  }
  let lastGroup = null;
  cmdkItems.forEach((item, i) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      const g = document.createElement("div");
      g.className = "cmdk-group";
      g.textContent = item.group;
      list.append(g);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmdk-item" + (i === cmdkIndex ? " is-active" : "");
    const nm = document.createElement("span");
    nm.className = "c-name";
    nm.textContent = item.name;
    b.append(nm);
    if (item.sub) {
      const sub = document.createElement("span");
      sub.className = "c-sub";
      sub.textContent = String(item.sub).slice(0, 40);
      b.append(sub);
    }
    b.addEventListener("mouseenter", () => { cmdkIndex = i; markCmdkActive(); });
    b.addEventListener("click", () => runCmdk(i));
    list.append(b);
  });
  const active = list.querySelector(".cmdk-item.is-active");
  active?.scrollIntoView({ block: "nearest" });
}

function markCmdkActive() {
  const items = [...(dom.cmdkList?.querySelectorAll(".cmdk-item") || [])];
  items.forEach((el, i) => el.classList.toggle("is-active", i === cmdkIndex));
  items[cmdkIndex]?.scrollIntoView({ block: "nearest" });
}

function runCmdk(i) {
  const item = cmdkItems[i];
  closeCmdk();
  try { item?.run?.(); } catch (e) { toast("执行失败：" + e.message); }
}

function openCmdk() {
  if (!dom.cmdk) return;
  if (!dom.cmdk.hidden) return;
  dom.cmdk.hidden = false;
  cmdkIndex = 0;
  if (dom.cmdkInput) dom.cmdkInput.value = "";
  renderCmdk("");
  setTimeout(() => dom.cmdkInput?.focus(), 20);
}

function closeCmdk() {
  if (dom.cmdk) dom.cmdk.hidden = true;
}
// ---------------------------------------------------------------- markdown
function inlineMd(text) {
  let s = escapeHtml(text);

  // Inline math: \( … \) and $…$ become placeholders that typesetMath() renders.
  // The body may contain ( ) itself, so match lazily up to a literal "\\)".
  // Currency like "$5" is left alone (no closing $, or the body is just a number).
  s = s.replace(/\\\(([\s\S]{1,600}?)\\\)/g, (_m, tex) => mathSpan(tex, false));
  s = s.replace(/(^|[^\\$])\$([^$\n]{2,300}?)\$/g, (m, lead, tex) => {
    if (/^[\s\d.,]+$/.test(tex)) return m;
    return lead + mathSpan(tex, false);
  });

  // Images: only real URLs can be shown; local files become a labelled chip.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
    if (/^https?:/i.test(src)) {
      return `<img src="${src}" alt="${alt}" class="md-img" loading="lazy" />`;
    }
    return `<span class="path-chip img-chip" title="${escapeHtml(src)}">🖼 ${escapeHtml(alt || baseName(src))}</span>`;
  });

  // Links: http(s) stay clickable; local paths render as path chips.
  // CommonMark allows <...> around destinations that contain spaces or parens, and
  // models do use it for Windows paths like "...Migration(1)/out.pptx".
  // (the text is already HTML-escaped, so both "<…>" and "&lt;…&gt;" occur here)
  s = s.replace(/\[([^\]]+)\]\((?:&lt;|<)([\s\S]*?)(?:&gt;|>)\)/g, (m, label, href) => {
    const clean = href.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    if (/^https?:/i.test(clean)) {
      return '<a href="' + escapeHtml(clean) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a>';
    }
    return '<span class="path-chip" title="' + escapeHtml(clean) + '">' + escapeHtml(label || baseName(clean)) + '</span>';
  });

  s = s.replace(/\[([^\]]+)\]\((?!&lt;|<)([^)\s]+)\)/g, (m, label, href) => {
    if (/^https?:/i.test(href)) {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return `<span class="path-chip" title="${escapeHtml(href)}">${escapeHtml(label || baseName(href))}</span>`;
  });

  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // Bare Windows / POSIX file paths -> path chips.
  s = s.replace(/(^|[\s(（])([A-Za-z]:\\[^\s<>"'）)]+)/g,
    (m, pre, p) => `${pre}<span class="path-chip" title="${escapeHtml(p)}">${escapeHtml(baseName(p))}</span>`);

  // Bare URLs.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return s;
}

/** Last path segment, used for chip labels and download names. */
function baseName(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}


// ---------------------------------------------------------------- math + tables
// Equations use KaTeX, vendored locally so this box works offline. The library and
// its fonts load the first time a message actually contains math.
let katexLoading = null;
function loadKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (katexLoading) return katexLoading;
  katexLoading = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-katex]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/katex/katex.min.css';
      link.dataset.katex = '1';
      document.head.append(link);
    }
    const sc = document.createElement('script');
    sc.src = '/vendor/katex/katex.min.js';
    sc.onload = () => resolve(window.katex);
    sc.onerror = () => { katexLoading = null; reject(new Error('katex load failed')); };
    document.head.append(sc);
  });
  return katexLoading;
}

/** Typeset every math placeholder under root (idempotent). */
function typesetMath(root) {
  if (!root) return;
  const nodes = root.querySelectorAll('.math[data-tex]:not([data-texed])');
  if (!nodes.length) return;
  loadKatex().then((katex) => {
    for (const el of nodes) {
      if (el.dataset.texed) continue;
      const display = el.classList.contains('math-block');
      try {
        katex.render(el.dataset.tex, el, { displayMode: display, throwOnError: false, strict: false });
      } catch { /* leave the raw TeX visible */ }
      el.dataset.texed = '1';
    }
  }).catch(() => { /* no KaTeX: TeX stays readable as text */ });
}

function mathSpan(tex, display) {
  const tag = display ? 'div' : 'span';
  const cls = display ? 'math math-block' : 'math';
  return '<' + tag + ' class="' + cls + '" data-tex="' + escapeHtml(tex) + '">'
    + (display ? '\\[' : '\\(') + escapeHtml(tex) + (display ? '\\]' : '\\)')
    + '</' + tag + '>';
}

/** GFM table: header row, separator row, body rows. */
function mdTable(header, sep, body) {
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const aligns = cells(sep).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const td = (tag, text, i) => '<' + tag + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '')
    + '>' + inlineMd(text) + '</' + tag + '>';
  const head = cells(header).map((c, i) => td('th', c, i)).join('');
  const rows = body.map((r) => '<tr>' + cells(r).map((c, i) => td('td', c, i)).join('') + '</tr>').join('');
  return '<div class="md-table-wrap"><table class="md-table"><thead><tr>' + head
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function md(text) {
  // Codex emits :codex-file-citation{path="…" purpose="source"} tokens for sources.
  // Render them as a short source note instead of leaking the raw token.
  const cleaned = String(text ?? '').replace(/:codex-file-citation\{([^}]*)\}/g, (_m, attrs) => {
    const p = (attrs.match(/path="([^"]*)"/) || [])[1] || '';
    const name = p.split(/[\\/]/).pop() || p;
    return name ? '（来源：' + name + '）' : '';
  });
  const lines = String(cleaned).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false, fenceBuf = [], listType = null, para = [];
  let inMath = false, mathBuf = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.map(inlineMd).join('<br />') + '</p>'); para = []; }
  };
  const flushList = () => {
    if (listType) { out.push('</' + listType + '>'); listType = null; }
  };
  const flushMath = () => {
    if (inMath) { out.push(mathSpan(mathBuf.join('\n'), true)); inMath = false; mathBuf = []; }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    if (inMath) {
      if (/\\\]\s*$/.test(line) || /\$\$\s*$/.test(line)) {
        mathBuf.push(line.replace(/\\\]|\$\$/g, ''));
        flushMath();
      } else {
        mathBuf.push(raw);
      }
      continue;
    }

    const fence = line.match(/^\x60\x60\x60(\w+)?/);
    if (fence) {
      if (inFence) {
        out.push('<pre><code>' + escapeHtml(fenceBuf.join('\n')) + '</code></pre>');
        inFence = false; fenceBuf = [];
      } else {
        flushPara(); flushList(); inFence = true;
      }
      continue;
    }
    if (inFence) { fenceBuf.push(raw); continue; }

    if (!line.trim()) { flushPara(); flushList(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push('<h' + h[1].length + '>' + inlineMd(h[2]) + '</h' + h[1].length + '>'); continue; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr />'); continue; }

    // Display math on its own line: \[ … \] or $$ … $$
    const mOpen = line.match(/^\s*(?:\\\[|\$\$)\s*(.*)$/);
    if (mOpen) {
      flushPara(); flushList();
      const rest = mOpen[1];
      if (/\\\]\s*$/.test(rest) || /\$\$\s*$/.test(rest)) {
        out.push(mathSpan(rest.replace(/\\\]|\$\$/g, '').trim(), true));
      } else {
        inMath = true;
        mathBuf = [rest];
      }
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { flushList(); out.push('<' + want + '>'); listType = want; }
      out.push('<li>' + inlineMd((ul || ol)[1]) + '</li>');
      continue;
    }

    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { flushPara(); flushList(); out.push('<blockquote>' + inlineMd(bq[1]) + '</blockquote>'); continue; }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      const sep = lines[i + 1] ?? '';
      if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(sep) && /-/.test(sep)) {
        const body = [];
        let j = i + 2;
        while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { body.push(lines[j]); j += 1; }
        out.push(mdTable(line, sep, body));
        i = j - 1;
      } else {
        out.push('<p>' + inlineMd(line) + '</p>');
      }
      continue;
    }

    para.push(line);
  }
  if (inFence && fenceBuf.length) out.push('<pre><code>' + escapeHtml(fenceBuf.join('\n')) + '</code></pre>');
  flushMath();
  flushPara(); flushList();
  return out.join('\n');
}

// ---------------------------------------------------------------- rpc
class Rpc {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    // RequestId is string | number, and several tabs share one upstream connection
    // through the bridge. A per-page prefix keeps their counters from colliding.
    this.idPrefix = 'w' + Math.random().toString(36).slice(2, 9);
    this.pending = new Map();
    this.handlers = {};
    this.connected = false;
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = async () => {
      this.connected = true;
      setConn('ok', '已连接');
      try { await app.onConnected(); } catch (e) { console.error(e); }
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => {
      this.connected = false;
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'));
      this.pending.clear();
      setConn('bad', '已断开，正在重连…');
      if (!app.stopping) setTimeout(() => this.connect(), app.retryDelay());
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'rpc error'), { code: msg.error.code, data: msg.error.data }));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.id !== undefined) { app.onServerRequest(msg); return; }
    if (msg.method) { app.onNotification(msg.method, msg.params ?? {}); }
  }
  send(method, params) {
    // RequestId is string | number, and several tabs share one upstream connection.
    // A per-page prefix keeps their counters from colliding.
    const id = this.idPrefix + '-' + this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('not connected')); return; }
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); }
      }, 120000);
    });
  }
  notify(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }
  reply(id, result) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id, result }));
  }
}

const rpc = new Rpc();

function setConn(kind, text) {
  dom.connDot.className = 'conn-dot' + (kind === 'ok' ? ' ok' : kind === 'bad' ? ' bad' : '');
  document.body.classList.toggle('is-offline', kind === 'bad');
  dom.connText.textContent = text;
}

// ---------------------------------------------------------------- app
const app = {
  stopping: false,
  attempts: 0,
  retryDelay() { this.attempts = Math.min(this.attempts + 1, 6); return Math.min(800 * 2 ** (this.attempts - 1), 8000); },

  async onConnected() {
    this.attempts = 0;
    const step = async (name, fn) => {
      try { return await fn(); } catch (e) { console.error(`startup step "${name}" failed:`, e); document.title = `ERR ${name}: ${e?.message ?? e}`; (window.__startupErrors = window.__startupErrors ?? []).push(`${name}: ${e?.stack ?? e}`); throw e; }
    };
    await step('initialize', () => rpc.send('initialize', {
      clientInfo: { name: 'codex-remote-web', title: 'Codex Remote', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }));
    rpc.notify('initialized');
    // Conversations first: the sidebar is the screen. Loading skills/quota/models ahead
    // of it made a cold start look like "no conversations" for ~10 seconds.
    await step('thread list', async () => {
      await this.loadThreads();
      // A cold bridge can answer the first list before the catalog is ready: retry once.
      if (!state.threads.length) {
        await new Promise((r) => setTimeout(r, 1200));
        await this.loadThreads();
      }
    });
    // Then everything else, in parallel. allSettled: one failing read must not abort
    // startup. Projects re-render the list, so grouping appears a moment later.
    step('startup reads', () => Promise.allSettled([
      this.loadProjects(), this.loadQuota(), this.loadModels(), loadSkills(),
    ])).catch(() => {});
    if (state.currentThreadId) await step('reopen thread', () => this.openThread(state.currentThreadId, { silent: true }));
  },

  async loadModels() {
    try {
      const res = await rpc.send('model/list', {});
      state.models = (res?.data ?? res?.models ?? []).filter((m) => !m.hidden);
      if (!state.model) {
        const cfg = state.models.find((m) => m.isDefault) ?? state.models[0];
        if (cfg) { state.model = cfg.id ?? cfg.model; state.effort = cfg.defaultReasoningEffort ?? null; }
      }
      updateModelLabels();
    } catch (e) { console.warn('model/list failed', e.message); }
  },

  async loadProjects() {
    // Two id spaces exist: the app-server (SQLite) projects from project/list, and the
    // desktop app's own registry in ~/.codex/.codex-global-state.json (thread assignments
    // live only there on this machine). Prefer the API, merge the desktop registry in.
    const bridge = await fetch('/api/projects', { credentials: 'same-origin' })
      .then((r) => r.json())
      .catch(() => ({}));
    state.electronProjects = bridge.projects ?? [];
    state.projectAssignments = bridge.assignments ?? {};
    state.projectlessIds = bridge.projectless ?? [];
    state.projectOrder = bridge.order ?? null;
    if (bridge.defaultCwd) state.defaultCwd = bridge.defaultCwd;

    let apiProjects = [];
    try {
      const res = await rpc.send('project/list', { sortKey: 'position' });
      apiProjects = (res?.data ?? []).map((x) => ({
        id: x.id,
        name: x.name,
        roots: (x.roots ?? []).map((r) => r.path).filter(Boolean),
        position: x.position ?? 0,
        updatedAt: x.updatedAt ?? null,
        recencyAt: x.recencyAt ?? null,
        source: 'api',
      }));
    } catch (e) {
      console.info('project/list unavailable:', e.message);
    }

    // Any app-server project the desktop registry does not know about would be invisible
    // in the desktop sidebar; mirror those so both stores list the same projects.
    // Compare by path, not id: the desktop registry still carries legacy ids for the
    // same folders, and matching on id alone duplicated every migrated project.
    const normPath = (v) => String(v ?? '').replace(/[\\/]+$/, '').toLowerCase().replace(/\\/g, '/');
    const knownIds = new Set(state.electronProjects.map((p) => p.id));
    const knownPaths = new Set(state.electronProjects.flatMap((p) => (p.roots || []).map(normPath)));
    const missing = apiProjects.filter((p) => !knownIds.has(p.id)
      && !(p.roots || []).some((r) => knownPaths.has(normPath(r))));
    if (missing.length) {
      void Promise.all(missing.map((p) => fetch('/api/projects/mirror', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: p.id, name: p.name, roots: p.roots }),
      }).catch(() => {}))).then(() => {
        state.electronProjects = [...state.electronProjects, ...missing];
      });
    }
    const norm = (v) => String(v ?? '').replace(/[\\/]+$/, '').toLowerCase().replace(/\\/g, '/');
    state.assignmentRemap = {};
    if (!apiProjects.length) {
      state.projects = state.electronProjects.map((x) => ({ ...x, source: 'electron' }));
    } else {
      state.projects = apiProjects;
      for (const ep of state.electronProjects) {
        const hit = state.projects.find((x) => x.roots.some((r) => ep.roots.some((er) => norm(r) === norm(er))));
        if (hit) state.assignmentRemap[ep.id] = hit.id;
        else state.projects.push({ ...ep, source: 'electron' });
      }
    }

    if (state.projects.length && !state.activeProjectId) {
      state.activeProjectId = state.projects[0].id;
      state.targetProjectId = state.projects[0].id;
    }
    updateProjectLabel();
    renderThreadList();
  },

  projectById(id) {
    return state.projects.find((x) => x.id === id) ?? null;
  },

  // A thread's project is never derived from its cwd: it comes from the thread itself
  // (thread/start.projectId) or from the desktop app's explicit assignment.
  projectOf(thread) {
    if (!thread) return null;
    if (thread.projectId) return thread.projectId;
    const raw = state.projectAssignments[thread.id]?.projectId;
    if (!raw) return null;
    const mapped = state.assignmentRemap?.[raw] ?? raw;
    return state.projects.some((x) => x.id === mapped) ? mapped : null;
  },

  targetCwd() {
    const pr = this.projectById(state.targetProjectId);
    return pr?.roots?.[0] ?? state.defaultCwd ?? '';
  },

  async loadQuota() {
    try {
      const res = await rpc.send('account/rateLimits/read', {});
      const snap = res?.rateLimits;
      const primary = snap?.primary;
      const used = Number(primary?.usedPercent ?? 0);
      const blocked = res?.ordinaryUsageAllowed === false || used >= 100;
      state.quota = {
        blocked,
        used,
        plan: res?.planType ?? snap?.planType ?? null,
        resetAt: primary?.resetsAt ?? null,
        weeklyUsed: Number(snap?.secondary?.usedPercent ?? 0),
      };
    } catch {
      state.quota = null;
    }
    updateQuotaBanner();
    renderMetrics();
    renderQuotaBall();
    return state.quota;
  },

  async loadThreads() {
    try {
      // The default listing is the one that carries generated titles; it can also
      // return the same thread twice, so collapse by id and keep the best row.
      const res = await rpc.send('thread/list', { limit: 60 });
      const byId = new Map();
      const score = (t) => (t.name ? 1e12 : 0) + (t.updatedAt ?? 0) * 1000 + (t.preview ?? '').length;
      for (const t of res?.data ?? []) {
        const cur = byId.get(t.id);
        if (!cur || score(t) > score(cur)) byId.set(t.id, t);
      }
      state.threads = [...byId.values()];
      renderThreadList();
    } catch (e) { console.warn('thread/list failed', e.message); }
  },

  async openThread(threadId, opts = {}) {
    if (!threadId) return;
    if (threadId !== state.currentThreadId) stopLiveFollow();
    if (state.currentThreadId === threadId && !opts.force) { if (!opts.silent) closeDrawer(); return; }

    state.currentThreadId = threadId;
    state.items.clear(); state.turns = []; nodes.clear(); deltaQueue.clear();
    state.ownership = 'unknown';
    state.errors = [];
    state.historyCursor = null;
    state.historyDone = false;
    state.busy = false; state.currentTurnId = null;
    if (!opts.silent) closeDrawer();
    renderThreadList();

    const thread = state.threads.find((t) => t.id === threadId);
    const ownerProject = app.projectOf(thread);
    if (ownerProject) { state.targetProjectId = ownerProject; updateProjectLabel(); }
    dom.threadTitle.textContent = thread?.name || thread?.preview || '会话';
    dom.cwdChip.textContent = shortPath(thread?.cwd ?? state.defaultCwd);
    // attachments must be copied into THIS thread's workspace, not the default one
    state.currentCwd = thread?.cwd || state.defaultCwd || '';
    if (thread?.model) state.model = thread.model;
    if (thread?.reasoningEffort) state.effort = thread.reasoningEffort;
    updateModelLabels();
    setBanner(thread?.status?.type === 'active' ? 'active' : null);
    updateBusyUi();

    // History is read-only: it never needs a writer lock, so it works even while
    // the desktop app has the thread open. Ownership is claimed lazily on send.
    await this.loadHistory(threadId);
    renderStream();
    scrollToBottom(true);
    // usage is per-thread: drop the previous thread's numbers
    state.tokenUsage = null;
    renderMetrics();
    // goals are per-thread too: show this thread's own objective (if any)
    this.loadGoal(threadId).catch(() => {});
    // A turn may already be running on this machine (desktop app): follow it live.
    startLiveFollow(threadId).catch(() => {});
  },

  /** Mirror the thread's goal into the composer chip (goal mode is a Codex feature). */
  async loadGoal(threadId) {
    if (!threadId) return;
    try {
      const r = await rpc.send('thread/goal/get', { threadId });
      if (threadId !== state.currentThreadId) return;
      const goal = r?.goal ?? null;
      state.goal = goal;
      if (goal?.objective) {
        state.goalObjective = goal.objective;
        state.goalMode = true;
      } else {
        state.goalObjective = null;
      }
      renderAttachments();
    } catch { /* older servers may not expose goals */ }
  },

  async loadHistory(threadId, opts = {}) {
    try {
      const page = await rpc.send('thread/turns/list', {
        threadId,
        limit: 25,
        sortDirection: 'desc',
        itemsView: 'full',
        cursor: opts.cursor ?? null,
      });
      const turns = [...(page?.data ?? [])].reverse();
      state.historyCursor = page?.nextCursor ?? null;
      if (!page?.nextCursor) state.historyDone = true;
      if (turns.length) prependTurns(turns);
      state.historyLoaded = true;
      if (!turns.length) {
        // Very old / empty threads: fall back to a full read.
        const read = await rpc.send('thread/read', { threadId, includeTurns: true });
        hydrateThreadMeta(read?.thread ?? read);
        hydrateTurns((read?.thread ?? read)?.turns ?? []);
      }
    } catch (e) {
      console.warn('history load failed', e);
      // A thread created moments ago (or by another client) is not materialized yet:
      // that is an empty history, not a failure. live-follow fills it in.
      if (!/not materialized/i.test(e.message)) showErrorRow(`历史读取失败：${e.message}`);
    }
    updateBusyUi();
  },

  async loadOlderHistory() {
    if (!state.currentThreadId || !state.historyCursor || state.loadingOlder) return;
    state.loadingOlder = true;
    setBanner('loading-older', true);
    await this.loadHistory(state.currentThreadId, { cursor: state.historyCursor });
    state.loadingOlder = false;
    renderStream();
    setBanner(null);
  },

  // Claim the writer lock only when we actually need to run something.
  async ensureWritable() {
    if (!state.currentThreadId) return true;
    if (state.ownership === 'mine') return true;
    try {
      const res = await rpc.send('thread/resume', { threadId: state.currentThreadId, excludeTurns: true });
      hydrateThreadMeta(res?.thread ?? res);
      state.ownership = 'mine';
      setBanner(null);
      return true;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/active writer|already has an active writer/i.test(msg)) {
        state.ownership = 'held';
        setBanner('held');
        return false;
      }
      toast(`接管会话失败：${msg}`);
      return false;
    }
  },

  // Fork is the clean escape hatch when the desktop app owns the thread.
  async forkCurrent(pendingText) {
    if (!state.currentThreadId) return;
    try {
      const res = await rpc.send('thread/fork', {
        threadId: state.currentThreadId,
        ...(state.defaultCwd ? { cwd: state.defaultCwd } : {}),
      });
      const t = res?.thread ?? res;
      const newId = t?.id;
      if (!newId) throw new Error('fork 未返回新会话 id');
      state.threads.unshift({
        id: newId, preview: pendingText || t?.preview || '（分叉）', name: t?.name ?? null,
        createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000),
        status: { type: 'idle' }, cwd: state.defaultCwd, model: state.model,
        reasoningEffort: state.effort,
      });
      renderThreadList();
      await this.openThread(newId, { force: true });
      state.ownership = 'mine';
      toast('已复制为新会话，可以继续了');
      if (pendingText) { dom.input.value = pendingText; autoGrow(); }
    } catch (e) {
      toast(`复制会话失败：${e.message}`);
    }
  },

  async newChat() {
    stopLiveFollow();
    // A goal belongs to the thread it was set on. Leaving it armed made the next chat
    // inherit it and auto-continue (the E2E run saw 8 turns from one message).
    const prevThread = state.currentThreadId;
    if (prevThread) rpc.send('thread/goal/clear', { threadId: prevThread }).catch(() => {});
    state.goal = null;
    state.goalObjective = null;
    state.goalMode = false;
    state.planMode = false;
    renderModeSwitch();
    state.currentThreadId = null;
    state.turns = []; state.items.clear(); nodes.clear();
    state.busy = false; state.currentTurnId = null;
    state.ownership = 'unknown';
    state.errors = [];
    setBanner(null);
    dom.threadTitle.textContent = 'New chat';
    dom.cwdChip.textContent = shortPath(this.targetCwd());
    updateProjectLabel();
    renderThreadList();
    renderStream();
    closeDrawer();
    dom.input.focus();
  },

  async send() {
    const text = dom.input.value.trim();
    // "/plan" and "/target [objective]" are commands, not prompts: they work whether the
    // slash menu was used or the line was typed straight through. Nothing is sent.
    const modeCmd = /^\/(plan|target)\b\s*([\s\S]*)$/i.exec(text);
    if (modeCmd) {
      const id = modeCmd[1].toLowerCase();
      const rest = modeCmd[2].trim();
      toggleMode(id);
      if (id === 'target' && state.goalMode && rest) {
        state.goalObjective = rest;
        toast('目标已设定：' + rest.slice(0, 40), 3600, { kind: 'ok' });
        renderAttachments();
      }
      dom.input.value = '';
      autoGrow();
      updateSendState();
      hideSlash();
      return;
    }
    // Guard before any await: state.busy is only set later, so a fast double click
    // (or a slow quota check) used to start two threads/turns.
    if ((!text && !state.attachments.length) || state.busy || state.sending) return;
    state.sending = true;
    try {
      return await this._send(text);
    } finally {
      state.sending = false;
    }
  },

  async _send(text) {

    // Pre-flight: a turn that the account cannot run still creates a thread, which is
    // how "new chat" entries pile up. Stop before creating anything.
    if (!state.quota) await this.loadQuota();
    if (state.quota?.blocked) {
      updateQuotaBanner();
      toast(state.quota.resetAt
        ? `额度已用完，${fmtWhen(state.quota.resetAt)} 之后才能继续（草稿保留）`
        : '额度已用完，草稿已保留', 4200);
      return;
    }

    const echo = showPendingEcho(text);
    // The thread we are about to create echoes its own defaults and hydrateThreadMeta()
    // adopts them, which used to overwrite the model the user had just picked. Pin the
    // choice now and use these locals for the first turn.
    const wantModel = state.model;
    const wantEffort = state.effort;
    let createdFresh = false;
    if (!state.currentThreadId) {
      try {
        const cwd = this.targetCwd();
        const startParams = {};
        if (cwd) startParams.cwd = cwd;
        if (state.targetProjectId) startParams.projectId = state.targetProjectId;
        startParams.approvalPolicy = accessPreset().approvalPolicy;
        startParams.approvalsReviewer = accessPreset().approvalsReviewer;
        startParams.sandbox = accessPreset().sandboxMode;
        // Create the thread with the selection already applied, otherwise its defaults
        // come back and the first turn runs on the wrong model.
        if (wantModel) startParams.model = wantModel;
        if (wantEffort) startParams.effort = wantEffort;
        const res = await rpc.send('thread/start', startParams);
        createdFresh = true;
        const t = res?.thread ?? res;
        state.currentThreadId = t?.id ?? null;
        state.ownership = 'mine';
        if (t) hydrateThreadMeta(t);
        if (state.currentThreadId) {
          state.threads.unshift({
            id: state.currentThreadId, preview: text, name: null,
            createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000),
            status: { type: 'active' }, cwd: state.defaultCwd, model: state.model,
          });
          dom.threadTitle.textContent = t?.name || text;
          dom.cwdChip.textContent = shortPath(t?.cwd ?? state.defaultCwd);
        }
        renderThreadList();
      } catch (e) { removePendingEcho(); toast(`创建会话失败：${e.message}`); return; }
    } else if (!(await this.ensureWritable())) {
      // Desktop owns this thread: keep the draft so the user can fork instead.
      toast('这个会话正在桌面端打开，先复制成新会话再发');
      return;
    }

    dom.input.value = '';
    autoGrow();
    updateSendState();
    state.busy = true;
    updateBusyUi();

    const optimisticContent = [{ type: 'text', text }];
    for (const a of state.attachments) optimisticContent.push({ type: a.isImage ? 'localImage' : 'mention', name: a.name, path: a.path });
    const localItem = { type: 'userMessage', id: `local-${Date.now()}`, content: optimisticContent };
    addItem(localItem, state.currentTurnId ?? 'pending');
    renderStream();
    scrollToBottom();

    try {
      const input = [{ type: 'text', text, text_elements: [] }];
      for (const a of state.attachments) {
        // A path outside the workspace is only a name to the agent — it ends up
        // exploring cwd instead of reading the file. Copy it in and use a relative path.
        let filePath = a.path;
        let relPath = null;
        const attachCwd = state.currentCwd || state.threads?.find((x) => x.id === state.currentThreadId)?.cwd || state.defaultCwd || '';
        if (!a.isImage && a.path && attachCwd) {
          try {
            const r = await fetch('/api/attach/import', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ path: a.path, cwd: attachCwd }),
            }).then((x) => x.json());
            if (r.ok) { filePath = r.path; relPath = r.relative; }
          } catch { /* keep the original path */ }
        }
        if (a.isImage) {
          input.push({ type: 'localImage', path: filePath });
        } else if (relPath) {
          input.push({ type: 'mention', name: relPath, path: filePath });
          // also say it in the text so the model cannot miss it
          input[0].text += (input[0].text ? '\n' : '') + '@' + relPath;
        } else {
          input.push({ type: 'mention', name: a.name, path: filePath });
        }
      }
      if (state.skillPick) {
        input.push({ type: 'skill', name: state.skillPick.name, path: state.skillPick.path });
      }

      const params = { threadId: state.currentThreadId, input, ...accessParams(state.currentCwd || state.defaultCwd) };
      if (wantModel) params.model = wantModel;
      if (wantEffort) params.effort = wantEffort;
      // Ask for the model's reasoning summary. Without it the server sends an empty
      // reasoning item and the 思考 card has nothing to show but "…".
      params.summary = state.summary || 'auto';
      const tier = currentServiceTier();
      // Omitting the field inherits the previous turn's tier, so "off" must say "default".
      if (tier) params.serviceTier = state.fast ? tier.id : 'default';
      // Plan mode is a first-class turn parameter. It overrides model/effort, so the
      // settings block has to carry the current ones or the model would silently revert.
      // (Exiting plan mode is handled by toggleMode -> thread/settings/update, NOT by
      //  sending this on every turn: that changed the request shape for all sends.)
      if (state.planMode) {
        params.collaborationMode = {
          mode: 'plan',
          settings: {
            model: state.model || currentModel(),
            reasoning_effort: state.effort || null,
            developer_instructions: null,
          },
        };
      }
      // Goal mode: register the objective on the thread before starting the turn, so the
      // agent keeps working toward it (and can continue after an interruption).
      if (state.goalMode) {
        const objective = (state.goalObjective || text || '').trim();
        if (objective && state.currentThreadId) {
          try {
            const g = await rpc.send('thread/goal/set', {
              threadId: state.currentThreadId,
              objective,
              status: 'active',
            });
            if (g?.goal) state.goal = g.goal;
            state.goalObjective = objective;
            renderAttachments();
          } catch (e) {
            toast('设置目标失败：' + e.message + '（继续正常发送）', 4000, { kind: 'err' });
          }
        }
      }
      stopLiveFollow(); // this turn is ours: deltas stream live from here on
      const res = await rpc.send('turn/start', params);
      if (wantModel) state.model = wantModel;
      if (wantEffort) state.effort = wantEffort;
      updateModelLabels();
      const turn = res?.turn;
      state.sendCtx = { threadId: state.currentThreadId, createdFresh, text };
      if (turn?.id) { state.currentTurnId = turn.id; ensureTurn(turn); }
      state.attachments = [];
      state.skillPick = null;
      renderAttachments();
    } catch (e) {
      state.busy = false;
      updateBusyUi();
      // Keep the draft and explain inline: a disappearing toast reads as "nothing happened".
      dom.input.value = text;
      autoGrow();
      updateSendState();
      const reason = String(e?.message ?? e);
      // thread/start alone never persists a thread, so a rejected send leaves nothing
      // behind. Only an admitted-then-failed first turn is durable; archive that one.
      if (createdFresh && state.currentThreadId && state.turns.length === 0) {
        const orphan = state.currentThreadId;
        state.currentThreadId = null;
        state.threads = state.threads.filter((t) => t.id !== orphan);
        rpc.send('thread/archive', { threadId: orphan }).catch(() => {});
        renderThreadList();
      }
      showErrorRow(/usageLimitExceeded|usage limit/i.test(reason)
        ? `发送失败：账号额度已用完（${reason}）`
        : `发送失败：${reason}`);
      toast('发送失败，草稿已保留');
    }
  },

  async stop() {
    if (!state.currentThreadId) return;
    try {
      const params = { threadId: state.currentThreadId };
      if (state.currentTurnId) params.turnId = state.currentTurnId;
      await rpc.send('turn/interrupt', params);
    } catch (e) {
      try { await rpc.send('turn/interrupt', { threadId: state.currentThreadId }); }
      catch { toast(`停止失败：${e.message}`); }
    }
  },

  onNotification(method, params) {
    switch (method) {
      case 'rawResponse/completed': {
        const u = params?.response?.usage;
        if (u && params.threadId === state.currentThreadId) {
          const b = {
            totalTokens: Number(u.total_tokens ?? 0),
            inputTokens: Number(u.input_tokens ?? 0),
            cachedInputTokens: Number(u.input_tokens_details?.cached_tokens ?? 0),
            cacheWriteInputTokens: 0,
            outputTokens: Number(u.output_tokens ?? 0),
            reasoningOutputTokens: 0,
          };
          const prev = state.tokenUsage ?? { total: { ...b }, last: b, modelContextWindow: null };
          state.tokenUsage = { ...prev, last: b };
          renderMetrics();
        }
        break;
      }
      // Goal mode: the server owns the goal; mirror it into the mode switch.
      case 'thread/goal/updated': {
        const goal = params.goal ?? null;
        if (goal && goal.threadId && goal.threadId === state.currentThreadId) {
          state.goal = goal;
          // Only remember the goal; the switch belongs to the user. Forcing it on here
          // is what re-armed 目标模式 in a fresh chat.
          if (goal.objective) state.goalObjective = goal.objective;
          if (/complete|cleared/i.test(String(goal.status))) state.goalMode = false;
          renderModeSwitch();
          renderAttachments();
        }
        break;
      }
      case 'thread/goal/cleared': {
        state.goal = null;
        state.goalMode = false;
        if (!params?.threadId || params.threadId === state.currentThreadId) {
          state.goalObjective = null;
          renderModeSwitch();
          renderAttachments();
        }
        break;
      }
      // The server saves collaborationMode per thread; mirror it so the switch never lies
      // (the desktop app or another tab may switch it too).
      case 'thread/settings/updated': {
        const ts = params?.threadSettings ?? params;
        if (ts?.threadId && ts.threadId !== state.currentThreadId) break;
        const mode = ts?.collaborationMode?.mode ?? params?.collaborationMode?.mode ?? null;
        if (mode) {
          const on = mode === 'plan';
          if (on !== state.planMode) {
            state.planMode = on;
            if (on) state.goalMode = false;
            renderModeSwitch();
            renderAttachments();
          }
        }
        break;
      }
      case 'thread/started': {
        const t = params.thread;
        if (t && !state.threads.some((x) => x.id === t.id)) {
          state.threads.unshift(t);
          renderThreadList();
        }
        break;
      }
      // Someone else (the desktop app, another tab) archived or deleted a thread:
      // drop it here too so both clients agree without a manual refresh.
      case 'thread/archived':
      case 'thread/deleted': {
        const id = params.threadId;
        if (!id || !state.threads.some((x) => x.id === id)) break;
        state.threads = state.threads.filter((x) => x.id !== id);
        if (state.currentThreadId === id) app.newChat();
        renderThreadList();
        toast(method === 'thread/deleted' ? '该会话已在别处删除' : '该会话已在别处归档');
        break;
      }
      case 'thread/unarchived': {
        // It reappears in thread/list; refresh lazily instead of patching state.
        app.loadThreads().catch(() => {});
        break;
      }
      case 'project/changed': {
        // Projects created/renamed/deleted anywhere (web, desktop) show up here.
        app.loadProjects().then(() => { renderThreadList(); }).catch(() => {});
        break;
      }
      case 'thread/name/updated': {
        const t = state.threads.find((x) => x.id === params.threadId);
        if (t && params.name) {
          t.name = params.name;
          if (state.currentThreadId === t.id) dom.threadTitle.textContent = params.name;
          renderThreadList();
        }
        break;
      }
      // Quota changes on every turn; keep the ball (and the panel) in sync without polling.
      case 'account/rateLimits/updated': {
        const snap = params.rateLimits ?? {};
        const primary = snap.primary ?? {};
        const used = Number(primary.usedPercent ?? state.quota?.used ?? 0);
        state.quota = {
          blocked: used >= 100 || Boolean(state.quota?.blocked && used >= 100),
          used,
          plan: state.quota?.plan ?? snap.planType ?? null,
          resetAt: primary.resetsAt ?? state.quota?.resetAt ?? null,
          weeklyUsed: Number(snap.secondary?.usedPercent ?? state.quota?.weeklyUsed ?? 0),
        };
        updateQuotaBanner();
        renderMetrics();
        renderQuotaBall();
        break;
      }
      case 'thread/status/changed': {
        const t = state.threads.find((x) => x.id === params.threadId);
        if (t) { t.status = params.status; renderThreadList(); }
        // Another client (desktop app) just started a turn on the open thread.
        if (params.threadId === state.currentThreadId
          && /active|inProgress/i.test(String(params.status?.type ?? ''))) {
          startLiveFollow(params.threadId).catch(() => {});
        }
        break;
      }
      case 'turn/started': {
        if (params.threadId !== state.currentThreadId) break;
        ensureTurn(params.turn);
        state.busy = true; state.currentTurnId = params.turn?.id ?? null;
        updateBusyUi();
        renderStream();
        scrollToBottom();
        break;
      }
      case 'turn/completed': {
        this.maybeDropFailedThread(params);
        if (params.threadId === state.currentThreadId) void clawNotifyTurn(params.turn);
        if (params.threadId !== state.currentThreadId) break;
        ensureTurn(params.turn, { final: true });
        state.busy = false; state.currentTurnId = null;
        updateBusyUi();
        renderStream();
        scrollToBottom();
        break;
      }
      case 'item/started': {
        if (params.threadId !== state.currentThreadId) break;
        addItem(params.item, params.turnId);
        renderStream();
        scrollToBottom();
        break;
      }
      case 'item/completed': {
        if (params.threadId !== state.currentThreadId) break;
        addItem(params.item, params.turnId);
        renderStream();
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        if (params.threadId !== state.currentThreadId) break;
        queueDelta(method, params);
        break;
      }
      case 'item/fileChange/patchUpdated': {
        if (params.threadId !== state.currentThreadId) break;
        const it = state.items.get(params.itemId);
        if (it) { it.changes = params.changes ?? it.changes; refreshItem(params.itemId); }
        break;
      }
      case 'thread/tokenUsage/updated': {
        state.tokenUsage = params.tokenUsage ?? params.threadTokenUsage ?? null;
        if (state.tokenUsage?.modelContextWindow && state.model) {
          state.ctxWindows[state.model] = state.tokenUsage.modelContextWindow;
          try { localStorage.setItem('codex-remote-ctx', JSON.stringify(state.ctxWindows)); } catch { /* quota */ }
        }
        renderMetrics();
        break;
      }
      case 'serverRequest/resolved': {
        removeApproval(params.requestId);
        break;
      }
      case 'error': {
        const msg = params?.error?.message ?? params?.message ?? '服务端错误';
        showErrorRow(msg);
        break;
      }
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice': {
        console.warn(method, params);
        break;
      }
      case 'turn/plan/updated': {
        if (params.threadId !== state.currentThreadId) break;
        console.info('plan updated', params);
        break;
      }
      default:
        break;
    }
  },

  // A turn that failed before producing any assistant content leaves an empty thread.
  // Remove it and put the draft back, so repeated attempts never accumulate.
  maybeDropFailedThread(params) {
    const turn = params.turn;
    const ctx = state.sendCtx;
    if (!ctx || !turn || turn.id !== state.currentTurnId) return;
    if (turn.status !== 'failed') { state.sendCtx = null; return; }
    const produced = (turn.items ?? []).some((it) => it.type !== 'userMessage');
    if (produced || !ctx.createdFresh) { state.sendCtx = null; return; }
    state.sendCtx = null;
    const orphan = ctx.threadId;
    // Archive (reversible) instead of deleting: an admitted turn already wrote a rollout.
    rpc.send('thread/archive', { threadId: orphan }).catch(() => {});
    state.threads = state.threads.filter((t) => t.id !== orphan);
    if (state.currentThreadId === orphan) {
      state.currentThreadId = null;
      state.turns = []; state.items.clear(); nodes.clear();
      dom.threadTitle.textContent = 'New chat';
      if (!dom.input.value.trim()) { dom.input.value = ctx.text; autoGrow(); updateSendState(); }
      renderStream();
    }
    renderThreadList();
    toast('这一轮没跑起来，会话已收回（草稿保留）');
  },

  // exposed so deep links / tests can open a file in the dock
  openFilePanel(target, name) { return openFilePanel(target, name); },

  onServerRequest(msg) {
    const { method, id, params } = msg;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
      || method === 'item/permissions/requestApproval' || method === 'item/tool/requestUserInput'
      || method === 'mcpServer/elicitation/request') {
      if (params?.threadId && params.threadId !== state.currentThreadId) {
        // Surface a hint but still allow acting on it.
        toast('有新的授权请求（其他会话）');
      }
      // A reconnect replays the same request id. Update the card we already show
      // instead of stacking a second one for the same approval.
      state.approvals.set(id, { method, params });
      for (const stale of document.querySelectorAll('.approval[data-request-id]')) {
        if (stale.dataset.requestId === String(id)) stale.remove();
      }
      renderApproval(id, method, params);
      scrollToBottom();
      return;
    }
    if (method === 'item/tool/call') {
      rpc.reply(id, { contentItems: [] });
      return;
    }
    // Unknown server request: answer with a cancellation so the agent can continue.
    rpc.reply(id, {});
  },
};

// ---------------------------------------------------------------- state helpers
function ensureTurn(turn, opts = {}) {
  if (!turn?.id) return null;
  let t = state.turns.find((x) => x.id === turn.id);
  if (!t) {
    t = { id: turn.id, status: turn.status ?? 'inProgress', itemIds: [], startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs, error: turn.error };
    state.turns.push(t);
  }
  Object.assign(t, {
    status: turn.status ?? t.status,
    startedAt: turn.startedAt ?? t.startedAt,
    completedAt: turn.completedAt ?? t.completedAt,
    durationMs: turn.durationMs ?? t.durationMs,
    error: turn.error ?? t.error,
  });
  if (opts.final) t.status = turn.status ?? 'completed';
  return t;
}

function addItem(item, turnId) {
  if (!item?.id) return;
  // The server echoes our own message back as an authoritative userMessage item;
  // drop the optimistic placeholder so the bubble does not appear twice.
  if (item.type === 'userMessage' && !String(item.id).startsWith('local-')) dropOptimistic();
  state.items.set(item.id, item);
  let t = state.turns.find((x) => x.id === turnId);
  if (!t) {
    // History items may carry their own turn association through turns[]; else group by nearest turn.
    t = state.turns[state.turns.length - 1];
    if (!t) { t = { id: 'turn-0', status: 'completed', itemIds: [] }; state.turns.push(t); }
  }
  if (!t.itemIds.includes(item.id)) t.itemIds.push(item.id);
}

function dropOptimistic() {
  for (const t of state.turns) {
    t.itemIds = t.itemIds.filter((id) => {
      if (!String(id).startsWith('local-')) return true;
      state.items.delete(id);
      const n = nodes.get(id);
      if (n) { n.remove(); nodes.delete(id); }
      return false;
    });
  }
}

function hydrateThreadMeta(thread) {
  if (!thread) return;
  if (thread.id) state.currentThreadId = thread.id;
  if (thread.name) dom.threadTitle.textContent = thread.name;
  else if (thread.preview) dom.threadTitle.textContent = thread.preview;
  if (thread.cwd) {
    dom.cwdChip.textContent = shortPath(thread.cwd);
    if (!state.defaultCwd) state.defaultCwd = thread.cwd;
  }
  if (thread.model) state.model = thread.model;
  if (thread.reasoningEffort) state.effort = thread.reasoningEffort;
  updateModelLabels();
  if (thread.status?.type === 'active') state.busy = true;
  updateBusyUi();
}

function hydrateTurns(turns) {
  state.turns = [];
  state.items.clear();
  prependTurns(turns);
}

// Merge a page of turns into state (works for both older history and live turns).
function prependTurns(incoming) {
  const byId = new Map(state.turns.map((t) => [t.id, t]));
  for (const turn of incoming ?? []) {
    if (!turn?.id) continue;
    let t = byId.get(turn.id);
    if (!t) {
      t = {
        id: turn.id, status: turn.status ?? 'completed', itemIds: [],
        startedAt: turn.startedAt ?? null, completedAt: turn.completedAt ?? null,
        durationMs: turn.durationMs ?? null, error: turn.error ?? null,
      };
      byId.set(turn.id, t);
    }
    t.status = turn.status ?? t.status;
    t.startedAt = turn.startedAt ?? t.startedAt;
    t.completedAt = turn.completedAt ?? t.completedAt;
    t.durationMs = turn.durationMs ?? t.durationMs;
    t.error = turn.error ?? t.error;
    for (const item of turn.items ?? []) {
      if (!item?.id) continue;
      state.items.set(item.id, item);
      if (!t.itemIds.includes(item.id)) t.itemIds.push(item.id);
    }
  }
  state.turns = [...byId.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

function updateQuotaBanner() {
  const host = dom.quotaBanner;
  if (!host) return;
  const q = state.quota;
  if (!q?.blocked) { host.hidden = true; host.replaceChildren(); return; }
  host.hidden = false;
  host.className = 'quota-banner';
  // `used` is not guaranteed: other code paths (and the keep-alive scheduler) may set a
  // blocked snapshot with only resetAt, and an undefined here used to throw on .toFixed.
  const used = Number.isFinite(Number(q.used)) ? Math.min(100, Math.max(0, Number(q.used))) : null;
  const pct = used == null ? '' : `5 小时窗口已用 ${used.toFixed(0)}%（剩 ${(100 - used).toFixed(0)}%）`;
  host.innerHTML = `<div class="qb-text"><strong>Codex 和工作使用额度已用完</strong>
    <span>${pct}${q.resetAt ? `${pct ? ' · ' : ''}将于 ${fmtWhen(q.resetAt)} 重置` : ''}</span></div>
    <a class="btn" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">查看用量</a>`;
}

function setBanner(kind, busy = false) {
  const b = dom.banner;
  if (!b) return;
  if (!kind) { b.hidden = true; b.replaceChildren(); return; }
  b.hidden = false;
  b.className = `banner ${kind}`;
  if (kind === 'held') {
    b.innerHTML = `<span class="banner-text">桌面端正打开这个会话，这里的操作是只读的。要让这边也能发消息：</span>
      <button class="btn btn-primary-sm" data-act="fork">复制为新会话</button>
      <button class="btn" data-act="retry">再试一次接管</button>`;
    b.querySelector('[data-act="fork"]').addEventListener('click', () => app.forkCurrent(dom.input.value.trim()));
    b.querySelector('[data-act="retry"]').addEventListener('click', async () => {
      if (await app.ensureWritable()) { setBanner(null); toast('已接管这个会话'); }
    });
  } else if (kind === 'active') {
    b.innerHTML = `<span class="banner-text">这个会话正在运行，输出会自动同步过来。</span>`;
  } else if (kind === 'loading-older') {
    b.innerHTML = `<span class="banner-text">正在加载更早的历史…</span>`;
  }
  if (busy) b.classList.add('is-busy');
}

function hydrateThread(thread, opts = {}) {
  if (!thread) return;
  if (opts.replace) { state.turns = []; state.items.clear(); nodes.clear(); }
  hydrateThreadMeta(thread);
  hydrateTurns(thread.turns ?? []);
}

function queueDelta(method, params) {
  const itemId = params.itemId;
  if (!itemId) return;
  const it = state.items.get(itemId);
  if (!it) return;
  const delta = params.delta ?? '';
  if (method === 'item/agentMessage/delta') { it.text = (it.text ?? '') + delta; }
  else if (method === 'item/plan/delta') { it.text = (it.text ?? '') + delta; }
  else if (method === 'item/reasoning/summaryTextDelta') {
    it.summary = it.summary?.length ? it.summary : [];
    const idx = params.summaryIndex ?? 0;
    it.summary[idx] = (it.summary[idx] ?? '') + delta;
  } else if (method === 'item/reasoning/textDelta') { it.content = [(it.content?.[0] ?? '') + delta]; }
  else if (method === 'item/commandExecution/outputDelta') { it.aggregatedOutput = (it.aggregatedOutput ?? '') + delta; }
  else if (method === 'item/fileChange/outputDelta') { it._output = (it._output ?? '') + delta; }

  if (!deltaQueue.has(itemId)) deltaQueue.set(itemId, true);
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      for (const id of deltaQueue.keys()) refreshItem(id);
      deltaQueue = new Map();
      if (state.busy) scrollToBottom();
    }, 70);
  }
}

// ---------------------------------------------------------------- rendering: thread list
function updateProjectLabel() {
  const pr = app.projectById(state.targetProjectId);
  // One pill, one row: it is the project selector and the current project at once.
  if (dom.projectLabel) dom.projectLabel.textContent = pr ? pr.name : '选择项目';
  if (dom.projectBtn) {
    dom.projectBtn.classList.toggle('is-set', Boolean(pr));
    dom.projectBtn.title = pr
      ? `新对话会建在项目 ${pr.name}（${pr.roots?.[0] ?? ''}）`
      : `新对话会建在这台电脑（${state.defaultCwd || '默认目录'}）`;
  }
}


// ---------------------------------------------------------------- new project
async function openNewProjectDialog() {
  openPanel('新建项目');
  const body = dom.panelBody;
  body.replaceChildren();

  const host = document.createElement('div');
  host.className = 'np-block';
  body.append(host);

  let picked = '';

  const paint = async (target) => {
    host.innerHTML = '<div class="net-loading">读取目录…</div>';
    let data;
    try {
      data = await fetch('/api/fs/dirs' + (target ? '?path=' + encodeURIComponent(target) : ''), { credentials: 'same-origin' }).then((r) => r.json());
    } catch (e) {
      host.innerHTML = '<div class="net-error">读取失败：' + escapeHtml(e.message) + '</div>';
      return;
    }
    if (!data.ok) {
      host.innerHTML = '<div class="net-error">' + escapeHtml(data.error || '无法读取') + '</div>';
      return;
    }
    host.replaceChildren();

    const crumb = document.createElement('div');
    crumb.className = 'np-crumbs';
    if (!data.path) {
      const lbl = document.createElement('span');
      lbl.className = 'np-crumb is-current';
      lbl.textContent = '此电脑';
      crumb.append(lbl);
    } else {
      data.crumbs.forEach((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'np-crumb' + (i === data.crumbs.length - 1 ? ' is-current' : '');
        b.textContent = c.name;
        b.addEventListener('click', () => paint(c.path));
        crumb.append(b);
      });
    }
    host.append(crumb);

    const nav = document.createElement('div');
    nav.className = 'np-nav';
    if (data.parent) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'btn btn-sm np-up';
      up.textContent = '↑ 上一级';
      up.addEventListener('click', () => paint(data.parent));
      nav.append(up);
    }
    if (data.path) {
      const mk = document.createElement('button');
      mk.type = 'button';
      mk.className = 'btn btn-sm np-mkdir';
      mk.textContent = '＋ 新建文件夹';
      mk.addEventListener('click', async () => {
        const name = (window.prompt('新文件夹名称') || '').trim();
        if (!name) return;
        mk.disabled = true;
        try {
          const r = await fetch('/api/fs/mkdir', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ path: data.path, name }),
          }).then((x) => x.json());
          if (!r.ok) throw new Error(r.error || '创建失败');
          toast('已创建文件夹：' + name);
          await paint(r.path);
        } catch (e) {
          toast('新建文件夹失败：' + e.message);
          mk.disabled = false;
        }
      });
      nav.append(mk);
    }
    if (nav.childElementCount) host.append(nav);

    if (data.quick && data.quick.length) {
      const q = document.createElement('div');
      q.className = 'np-quick';
      for (const item of data.quick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = item.name;
        b.addEventListener('click', () => paint(item.path));
        q.append(b);
      }
      host.append(q);
    }

    const list = document.createElement('div');
    list.className = 'np-list';
    if (!data.dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = data.path ? '这个文件夹里没有子目录' : '没有可用的驱动器';
      list.append(empty);
    }
    for (const d of data.dirs) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'np-dir';
      row.innerHTML = '<svg aria-hidden="true"><use href="#i-folder"/></svg><span></span>';
      row.querySelector('span').textContent = d.name;
      row.addEventListener('click', () => paint(d.path));
      list.append(row);
    }
    host.append(list);

    // footer: name + create
    const foot = document.createElement('div');
    foot.className = 'np-foot';
    const nameInput = document.createElement('input');
    nameInput.className = 'np-name';
    nameInput.placeholder = '项目名称';
    nameInput.value = data.path ? data.path.split(/[\\/]/).filter(Boolean).pop() : '';
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'btn btn-primary-sm';
    create.textContent = data.path ? '用这个文件夹' : '先在下方选择文件夹';
    create.disabled = !data.path;
    create.addEventListener('click', async () => {
      if (!data.path) return;
      const name = (nameInput.value || '').trim() || data.path.split(/[\\/]/).filter(Boolean).pop();
      create.disabled = true;
      create.textContent = '创建中…';
      try {
        const res = await rpc.send('project/create', {
          name,
          roots: [{ path: data.path }],
          idempotencyKey: 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        });
        const project = res?.project ?? res;
        // The desktop app keeps its own registry in ~/.codex/.codex-global-state.json;
        // project/create only writes the app-server DB, so mirror it to stay in sync.
        if (project?.id) {
          await fetch('/api/projects/mirror', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ id: project.id, name: project.name ?? name, roots: (project.roots ?? [{ path: data.path }]).map((r) => r.path ?? r) }),
          }).catch(() => {});
        }
        await app.loadProjects();
        if (project?.id) {
          state.targetProjectId = project.id;
          state.activeProjectId = project.id;
          updateProjectLabel();
          renderThreadList();
        }
        toast('已创建项目：' + name);
        closePanel();
      } catch (e) {
        toast('创建失败：' + (e.message || e));
        create.disabled = false;
        create.textContent = '用这个文件夹';
      }
    });
    foot.append(nameInput, create);
    host.append(foot);
    picked = data.path;
    void picked;
  };

  await paint('');
}
/** Codex-style picker: search, folder rows, then 新建项目 — opened above the trigger. */
function openProjectPicker() {
  closeMenu();
  menuAnchorEl = dom.projectBtn;

  const wrap = document.createElement('div');
  wrap.className = 'pp-wrap';
  wrap.innerHTML = '<div class="pp-search"><svg aria-hidden="true"><use href="#i-search"/></svg><input type="search" placeholder="搜索项目…" aria-label="搜索项目" /></div><div class="pp-list"></div>';

  const list = wrap.querySelector('.pp-list');
  const paint = (q = '') => {
    const term = q.trim().toLowerCase();
    list.replaceChildren();
    const pick = (pr) => {
      state.targetProjectId = pr.id;
      state.activeProjectId = pr.id;
      updateProjectLabel();
      if (!state.currentThreadId) dom.cwdChip.textContent = shortPath(app.targetCwd());
      renderThreadList();
      closeMenu();
    };
    for (const pr of state.projects.filter((p) => !term || p.name.toLowerCase().includes(term))) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pp-item' + (pr.id === state.targetProjectId ? ' is-selected' : '');
      b.innerHTML = '<svg aria-hidden="true"><use href="#i-folder"/></svg><span class="pp-name"></span>';
      b.querySelector('.pp-name').textContent = pr.name;
      b.addEventListener('click', () => pick(pr));
      list.append(b);
    }
    const local = document.createElement('button');
    local.type = 'button';
    local.className = 'pp-item' + (state.targetProjectId === null ? ' is-selected' : '');
    local.innerHTML = '<svg aria-hidden="true"><use href="#i-monitor"/></svg><span class="pp-name"></span>';
    local.querySelector('.pp-name').textContent = '不使用项目';
    local.addEventListener('click', () => {
      state.targetProjectId = null;
      updateProjectLabel();
      if (!state.currentThreadId) dom.cwdChip.textContent = shortPath(app.targetCwd());
      renderThreadList();
      closeMenu();
    });
    list.append(local);

    const div = document.createElement('div');
    div.className = 'pp-div';
    list.append(div);

    const fresh = document.createElement('button');
    fresh.type = 'button';
    fresh.className = 'pp-item pp-new';
    fresh.innerHTML = '<svg aria-hidden="true"><use href="#i-plus"/></svg><span class="pp-name">新建项目…</span>';
    fresh.addEventListener('click', () => { closeMenu(); openNewProjectDialog(); });
    list.append(fresh);
  };
  paint('');
  const search = wrap.querySelector('input');
  search.addEventListener('input', () => paint(search.value));

  dom.menu.append(wrap);
  dom.menu.hidden = false;
  const rect = dom.projectBtn.getBoundingClientRect();
  const mw = dom.menu.offsetWidth;
  const mh = dom.menu.offsetHeight;
  dom.menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 10)) + 'px';
  // Always above: below the trigger is the composer.
  dom.menu.style.top = Math.max(8, rect.top - mh - 8) + 'px';
  requestAnimationFrame(() => search.focus({ preventScroll: true }));
}

/** Codex-style project popover: identity, path, then the actions. */
function openProjectMenuAt(pr, x, y) {
  closeMenu();
  const head = document.createElement('div');
  head.className = 'menu-proj';
  head.innerHTML = '<div class="mp-name"></div><div class="mp-meta"></div><div class="mp-path"></div>';
  const chats = state.threads.filter((t) => app.projectOf(t)?.id === pr.id).length;
  head.querySelector('.mp-name').textContent = pr.name;
  head.querySelector('.mp-meta').textContent = chats ? `${chats} 次聊天` : '还没有聊天';
  head.querySelector('.mp-path').textContent = pr.roots?.[0] ?? '';
  dom.menu.append(head);
  dom.menu.classList.add('is-compact');

  for (const it of [
    { label: '编辑项目', onSelect: () => openEditProjectDialog(pr) },
    { label: '删除项目…', danger: true, onSelect: () => deleteProject(pr) },
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (it.danger ? ' is-danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { closeMenu(); it.onSelect(); });
    dom.menu.append(b);
  }
  dom.menu.hidden = false;
  const mw = dom.menu.offsetWidth;
  const mh = dom.menu.offsetHeight;
  dom.menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - mw - 10))}px`;
  dom.menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - mh - 10))}px`;
}


/** Copy without Clipboard API (this page is often served over plain http). */
async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** Start a fresh chat whose new thread belongs to this project. */
function newChatInProject(pr) {
  state.targetProjectId = pr?.id ?? null;
  state.activeProjectId = pr?.id ?? null;
  app.newChat();
  toast(pr ? `新对话会建在 ${pr.name}` : '新对话会建在这台电脑');
}

/** Edit a project: rename and/or move its root folder (project/update). */
async function openEditProjectDialog(pr) {
  openPanel('编辑项目');
  const body = dom.panelBody;
  body.replaceChildren();

  const form = document.createElement('div');
  form.className = 'np-block';
  form.innerHTML = `
    <label class="ep-label" for="epName">项目名称</label>
    <input class="np-name" id="epName" />
    <div class="ep-label">项目文件夹</div>
    <div class="ep-path" id="epPath"></div>
    <div class="ep-actions">
      <button type="button" class="btn" id="epPick">更换文件夹…</button>
      <button type="button" class="btn btn-primary-sm" id="epSave">保存</button>
    </div>`;
  body.append(form);

  const nameInput = form.querySelector('#epName');
  const pathEl = form.querySelector('#epPath');
  const save = form.querySelector('#epSave');
  const pick = form.querySelector('#epPick');
  let root = pr.roots?.[0] ?? '';
  nameInput.value = pr.name ?? '';
  pathEl.textContent = root || '（未设置）';

  // Inline folder browser: reuse /api/fs/dirs, avoid redrawing the whole panel.
  const browser = document.createElement('div');
  browser.className = 'ep-browser';
  browser.hidden = true;
  form.append(browser);
  const openBrowser = async (target) => {
    browser.hidden = false;
    browser.textContent = '读取目录…';
    let data;
    try {
      data = await fetch('/api/fs/dirs' + (target ? '?path=' + encodeURIComponent(target) : ''), { credentials: 'same-origin' }).then((r) => r.json());
    } catch (e) {
      browser.textContent = '读取失败：' + e.message;
      return;
    }
    if (!data.ok) { browser.textContent = data.error || '无法读取'; return; }
    browser.replaceChildren();

    const bar = document.createElement('div');
    bar.className = 'np-crumbs';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'np-crumb';
    up.textContent = '↑ 上一级';
    up.addEventListener('click', () => openBrowser(data.parent || ''));
    bar.append(up);
    const here = document.createElement('span');
    here.className = 'np-crumb is-current';
    here.textContent = data.path || '此电脑';
    bar.append(here);
    browser.append(bar);

    const list = document.createElement('div');
    list.className = 'np-dirs';
    for (const d of data.dirs ?? []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'np-dir';
      b.textContent = d.name;
      b.addEventListener('click', () => openBrowser(d.path));
      list.append(b);
    }
    browser.append(list);

    if (data.path) {
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn btn-primary-sm';
      use.textContent = '用这个文件夹';
      use.addEventListener('click', () => {
        root = data.path;
        pathEl.textContent = data.path;
        if (!nameInput.value.trim()) nameInput.value = data.path.split(/[\\/]/).filter(Boolean).pop() || '';
        browser.hidden = true;
      });
      browser.append(use);
    }
  };
  pick.addEventListener('click', () => openBrowser(root));

  save.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('项目名称不能为空'); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    try {
      await rpc.send('project/update', {
        projectId: pr.id,
        name,
        roots: root ? [{ path: root }] : null,
      });
      // Keep the desktop registry in step (the app-server DB and that file are separate).
      await fetch('/api/projects/mirror', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: pr.id, name, roots: root ? [root] : [] }),
      }).catch(() => {});
      await app.loadProjects();
      renderThreadList();
      updateProjectLabel();
      toast('已保存项目修改');
      closePanel();
    } catch (e) {
      toast('保存失败：' + (e.message || e));
      save.disabled = false;
      save.textContent = '保存';
    }
  });
}

async function deleteProject(pr) {
  const yes = window.confirm(`删除项目「${pr.name}」？项目里的对话不会被删除，只是不再归类到这个项目。`);
  if (!yes) return;
  try {
    await rpc.send('project/delete', { projectId: pr.id });
    await fetch('/api/projects/mirror', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'remove', id: pr.id }),
    }).catch(() => {});
    if (state.targetProjectId === pr.id) state.targetProjectId = null;
    if (state.activeProjectId === pr.id) state.activeProjectId = null;
    await app.loadProjects();
    renderThreadList();
    updateProjectLabel();
    toast('已删除项目');
  } catch (e) {
    toast('删除失败：' + (e.message || e));
  }
}

/** Trigger the hidden file input so the panel can upload into a folder (unused hook). */


// ---------------------------------------------------------------- batch editing
// Select mode turns the list into checkboxes: archive, delete or move to a project
// in one go. Selection lives in state.selection and survives re-renders.
function selectionMode() { return state.selection !== null; }
function selectedIds() { return state.selection ? [...state.selection] : []; }

function setSelectionMode(on) {
  state.selection = on ? new Set() : null;
  state.lastPickedId = null;
  document.querySelector('.sidebar')?.classList.toggle('is-selecting', Boolean(on));
  if (dom.selectBtn) dom.selectBtn.setAttribute('aria-pressed', String(Boolean(on)));
  renderThreadList();
  renderBulkBar();
}

function toggleSelected(id, e) {
  if (!state.selection) return;
  if (e && e.shiftKey && state.lastPickedId) {
    const order = state.threads.map((t) => t.id);
    const a = order.indexOf(state.lastPickedId);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      for (let i = from; i <= to; i += 1) state.selection.add(order[i]);
      state.lastPickedId = id;
      renderThreadList();
      renderBulkBar();
      return;
    }
  }
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.lastPickedId = id;
  renderThreadList();
  renderBulkBar();
}

function renderBulkBar() {
  const bar = document.querySelector('#bulkBar');
  if (!bar) return;
  const n = state.selection ? state.selection.size : 0;
  bar.hidden = !state.selection;
  if (!state.selection) return;
  const count = document.querySelector('#bulkCount');
  if (count) count.textContent = String(n);
  for (const id of ['bulkArchive', 'bulkMove', 'bulkDelete']) {
    const b = document.getElementById(id);
    if (b) b.disabled = n === 0;
  }
}

/** Run one RPC per selected thread, then refresh once. */
async function bulkAction(label, fn) {
  const ids = selectedIds();
  if (!ids.length) return;
  const results = await Promise.allSettled(ids.map((id) => fn(id)));
  const failed = results.filter((r) => r.status === 'rejected');
  const okCount = ids.length - failed.length;
  state.selection = new Set();
  await app.loadThreads();
  renderThreadList();
  renderBulkBar();
  if (failed.length) {
    const msgs = failed.map((f) => String(f.reason?.message ?? ''));
    const busyCount = msgs.filter((m) => /active writer/i.test(m)).length;
    const otherCount = failed.length - busyCount;
    const bits = [];
    if (busyCount) bits.push(busyCount + ' 个正在别处打开（跳过）');
    if (otherCount) bits.push(otherCount + ' 个失败：' + (msgs.find((m) => !/active writer/i.test(m)) ?? '').slice(0, 50));
    toast(label + '：' + okCount + ' 个，' + bits.join('；'), 6000, { kind: 'err' });
  } else {
    toast(label + '：' + okCount + ' 个', 3000, { kind: 'ok' });
  }
}

async function doBulkArchive() {
  await bulkAction('已归档', (id) => rpc.send('thread/archive', { threadId: id }));
}

async function doBulkDelete() {
  const n = selectedIds().length;
  if (!n) return;
  if (!window.confirm('删除选中的 ' + n + ' 个对话？删除后无法恢复。')) return;
  await bulkAction('已删除', async (id) => {
    await rpc.send('thread/delete', { threadId: id });
    if (state.currentThreadId === id) app.newChat();
  });
}

/** Move the selected threads into a project (or out of one). */
function doBulkMove() {
  const ids = selectedIds();
  if (!ids.length) return;
  const items = state.projects.map((pr) => ({
    label: pr.name,
    onSelect: () => moveSelected(ids, pr.id, pr.name),
  }));
  items.push({ label: '移出项目（这台电脑）', onSelect: () => moveSelected(ids, '', '这台电脑') });
  const r = document.querySelector('#bulkMove').getBoundingClientRect();
  openMenuAt(r.left, r.top - 8 - items.length * 34, items, '移动 ' + ids.length + ' 个对话到');
}

async function moveSelected(ids, projectId, label) {
  await bulkAction('已移到 ' + label, async (id) => {
    await rpc.send('thread/metadata/update', { threadId: id, projectId });
    // The desktop sidebar reads its own catalog; keep that column in step.
    await fetch('/api/threads/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ threadId: id, projectId }),
    }).catch(() => {});
  });
  await app.loadProjects();
}
function projectRow(pr, threads) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'project-row' + (state.activeProjectId === pr.id ? ' is-open' : '');
  row.innerHTML = '<svg aria-hidden="true"><use href="#i-folder"/></svg><span class="p-name"></span>';
  row.querySelector('.p-name').textContent = pr.name;
  row.setAttribute('aria-label', pr.name);
  row.setAttribute('aria-expanded', String(state.activeProjectId === pr.id));
  row.addEventListener('click', () => {
    state.activeProjectId = state.activeProjectId === pr.id ? null : pr.id;
    state.targetProjectId = pr.id;
    updateProjectLabel();
    renderThreadList();
  });
  // Codex exposes project actions on the row itself: right-click, long-press, or ⋯.
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openProjectMenuAt(pr, e.clientX, e.clientY);
  });
  let press = null;
  row.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    press = setTimeout(() => openProjectMenuAt(pr, t.clientX, t.clientY), 550);
  }, { passive: true });
  const cancel = () => { if (press) { clearTimeout(press); press = null; } };
  row.addEventListener('touchend', cancel);
  row.addEventListener('touchmove', cancel);
  row.addEventListener('touchcancel', cancel);

  const wrap = document.createElement('div');
  wrap.className = 'project-line';

  // ⋯ opens the project menu, ✎ starts a new chat inside this project (Codex layout).
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'project-act project-more';
  more.setAttribute('aria-label', pr.name + ' 的项目操作');
  more.innerHTML = '<svg aria-hidden="true"><use href="#i-more"/></svg>';
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    openProjectMenuAt(pr, r.left, r.bottom + 6);
  });

  const fresh = document.createElement('button');
  fresh.type = 'button';
  fresh.className = 'project-act project-new';
  fresh.setAttribute('aria-label', '在 ' + pr.name + ' 下新建对话');
  fresh.title = '在 ' + pr.name + ' 下新建对话';
  fresh.innerHTML = '<svg aria-hidden="true"><use href="#i-pencil"/></svg>';
  fresh.addEventListener('click', (e) => {
    e.stopPropagation();
    newChatInProject(pr);
  });

  wrap.append(row, more, fresh);
  return wrap;
}

function threadRowEl(t) {
  const btn = document.createElement('button');
  btn.className = 'thread-row' + (t.id === state.currentThreadId ? ' is-active' : '');
  btn.type = 'button';
  btn.dataset.threadId = t.id;
  const span = document.createElement('span');
  span.className = 't';
  const full = t.name || t.preview || '(空会话)';
  span.textContent = full;
  btn.title = full;
  if (t.id === state.currentThreadId) btn.setAttribute('aria-current', 'true');
  btn.append(span);
  if (t.status?.type === 'active') {
    const dot = document.createElement('span');
    dot.className = 'live';
    btn.append(dot);
  }
  if (selectionMode()) {
    const box = document.createElement('span');
    box.className = 'pick-box' + (state.selection.has(t.id) ? ' is-on' : '');
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<svg><use href="#i-check"/></svg>';
    btn.prepend(box);
    btn.classList.toggle('is-picked', state.selection.has(t.id));
    btn.setAttribute('aria-pressed', String(state.selection.has(t.id)));
  }
  btn.addEventListener('click', (e) => {
    if (selectionMode()) { toggleSelected(t.id, e); return; }
    app.openThread(t.id);
  });
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); openThreadMenu(t, e.clientX, e.clientY); });
  let pressTimer = null;
  btn.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    pressTimer = setTimeout(() => {
      // Long-press enters batch select; once selecting, it opens the row menu.
      if (selectionMode()) openThreadMenu(t, touch.clientX, touch.clientY);
      else { setSelectionMode(true); toggleSelected(t.id); }
    }, 550);
  }, { passive: true });
  const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  btn.addEventListener('touchend', cancelPress);
  btn.addEventListener('touchmove', cancelPress);
  btn.addEventListener('touchcancel', cancelPress);
  return btn;
}

function renderThreadList() {
  const q = state.search.trim().toLowerCase();
  const visible = state.threads.filter((t) => !q || `${t.name ?? ''} ${t.preview ?? ''}`.toLowerCase().includes(q));

  const pinned = [];
  const byProject = new Map();
  const loose = [];
  for (const t of visible) {
    const isPinned = t.section?.name && /pinned/i.test(t.section.name);
    if (isPinned) { pinned.push(t); continue; }
    const pid = app.projectOf(t);
    if (pid && state.projects.some((x) => x.id === pid)) {
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(t);
    } else {
      loose.push(t);
    }
  }

  const orderedProjects = state.projects.slice().sort((a, b) => {
    const order = state.projectOrder;
    if (Array.isArray(order)) {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    }
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });

  const frag = document.createDocumentFragment();
  const heading = (text) => {
    const h = document.createElement('div');
    h.className = 'section-label';
    h.textContent = text;
    return h;
  };

  if (pinned.length) {
    frag.append(heading('Pinned'));
    for (const t of pinned) frag.append(threadRowEl(t));
  }

  if (orderedProjects.length) {
    frag.append(heading('项目'));
    for (const pr of orderedProjects) {
      const threads = byProject.get(pr.id) ?? [];
      if (q && !threads.length) continue; // a filter should not list projects with no hits
      frag.append(projectRow(pr, threads));
      if (q || state.activeProjectId === pr.id) {
        if (!threads.length) {
          const empty = document.createElement('div');
          empty.className = 'project-empty';
          empty.textContent = '这个项目还没有会话';
          frag.append(empty);
        }
        for (const t of threads) {
          const el = threadRowEl(t);
          el.classList.add('is-nested');
          frag.append(el);
        }
      }
    }
  }

  if (loose.length || (!orderedProjects.length && !pinned.length)) {
    frag.append(heading(orderedProjects.length ? '其他会话' : 'Recents'));
    if (!loose.length) {
      const p = document.createElement('p');
      p.className = 'project-empty';
      p.textContent = q ? '没有匹配的会话' : '还没有会话';
      frag.append(p);
    }
    for (const t of loose) frag.append(threadRowEl(t));
  }

  dom.sections.replaceChildren(frag);
}

// ---------------------------------------------------------------- rendering: stream
function renderStream() {
  const frag = document.createDocumentFragment();
  nodes.clear();

  if (!state.turns.length) {
    dom.main.classList.add('is-home');
    document.body.classList.add('is-home');
    const div = document.createElement('div');
    div.className = 'empty';
    div.innerHTML = `<div class="empty-logo">◍</div><h2>有什么可以做的？</h2><p>在这台电脑上跑任务，随时从 iPad 或另一台电脑接手。</p>`;
    // Quick starts: three real jobs this panel is for, one click away.
    const starts = document.createElement('div');
    starts.className = 'empty-starts';
    for (const item of [
      { label: '整理一下这个目录', hint: () => '列出 ' + (state.currentCwd || state.defaultCwd || '这个目录') + ' 里的文件并按类型归类' },
      { label: '把文件发到微信', hint: '找一个文件，发到我的微信' },
      { label: '看看本机在跑什么', hint: '现在这台电脑上有哪些任务在跑？' },
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'empty-start';
      b.innerHTML = '<span class="es-label"></span><span class="es-hint"></span>';
      b.querySelector('.es-label').textContent = item.label;
      const hint = typeof item.hint === "function" ? item.hint() : item.hint;
    b.querySelector(".es-hint").textContent = hint;
      b.addEventListener('click', () => {
        dom.input.value = typeof item.hint === "function" ? item.hint() : item.hint;
        autoGrow();
        updateSendState();
        dom.input.focus();
      });
      starts.append(b);
    }
    div.append(starts);
    frag.append(div);
    dom.messages.replaceChildren(frag);
    return;
  }
  dom.main.classList.remove('is-home');
  document.body.classList.remove('is-home');

  for (const turn of state.turns) {
    const turnItems = turn.itemIds.map((id) => state.items.get(id)).filter(Boolean);
    if (!turnItems.length) continue;

    const users = turnItems.filter((i) => i.type === 'userMessage');
    const rest = turnItems.filter((i) => i.type !== 'userMessage');

    for (const item of users) {
      const node = renderItem(item, turn);
      if (node) { nodes.set(item.id, node); frag.append(node); }
    }
    if (!rest.length) continue;

    // Desktop structure: a "Worked for …" divider above the answer, with the
    // intermediate steps collapsed behind it and the final answer below.
    let splitAt = rest.length;
    while (splitAt > 0 && rest[splitAt - 1].type === 'agentMessage') splitAt -= 1;
    const steps = rest.slice(0, splitAt);
    const finals = rest.slice(splitAt);

    const { row, body, rule } = buildWorkedRow(turn, steps);
    frag.append(row, body, rule);

    for (const item of steps) {
      const node = renderItem(item, turn);
      if (node) { nodes.set(item.id, node); body.append(node); }
    }
    for (const item of finals) {
      const node = renderItem(item, turn);
      if (node) { nodes.set(item.id, node); frag.append(node); }
    }
  }

  for (const [id, approval] of state.approvals) {
    if (approval.params?.threadId && approval.params.threadId !== state.currentThreadId) continue;
    frag.append(buildApprovalCard(id, approval.method, approval.params));
  }

  for (const err of state.errors) {
    const row = document.createElement('div');
    row.className = 'error-row';
    row.textContent = err.message;
    frag.append(row);
  }

  // Keep the reading position: a full re-render must not yank the view (that is what
  // made "正在处理…" look like it collapsed and reopened on every update).
  const keepTop = dom.scroll.scrollTop;
  const wasAtBottom = isNearBottom();
  dom.messages.replaceChildren(frag);
  typesetMath(dom.messages);
  if (wasAtBottom) scrollToBottom(true);
  else dom.scroll.scrollTop = keepTop;
}

// Rows are rebuilt whenever the turn re-renders (every item change, poll tick, turn
// completion). Remember which ones the user opened, keyed by turn, or the row snaps
// shut — and then something re-opens it — on every update.
const openWorked = new Set();

function workedKey(turn) {
  return turn?.id ?? ('t-' + (turn?.itemIds?.[0] ?? 'x'));
}

function buildWorkedRow(turn, steps) {
  const key = workedKey(turn);
  const row = document.createElement('div');
  row.className = 'worked' + (openWorked.has(key) ? ' is-open' : '');

  const running = turn.status === 'inProgress';
  const dur = turn.durationMs ?? (turn.startedAt && turn.completedAt ? (turn.completedAt - turn.startedAt) * 1000 : null);
  const statusText = running ? '正在处理…'
    : turn.status === 'failed' ? '执行失败'
      : turn.status === 'interrupted' ? '已中断'
        : dur ? `Worked for ${fmtDuration(dur)}` : '完成';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.innerHTML = `<svg><use href="#i-chevron-right"/></svg>`;
  const label = document.createElement('span');
  label.textContent = statusText;
  btn.prepend(label);
  row.append(btn);

  const body = document.createElement('div');
  body.className = 'worked-body';

  const rule = document.createElement('div');
  rule.className = 'worked-rule';

  if (!steps.length) { row.classList.add('is-plain'); return { row, body, rule }; }

  btn.addEventListener('click', () => {
    const nowOpen = row.classList.toggle('is-open');
    if (nowOpen) openWorked.add(key);
    else openWorked.delete(key);
  });
  return { row, body, rule };
}

// Step cards are rebuilt whenever the turn re-renders (a new item arrives, the turn
// completes, history reloads). Remember which ones the user opened, keyed by item id,
// otherwise an expanded "思考" card snaps shut on the next render.
const openSteps = new Set();

function stepCard({ icon, title, sub, statusText, statusKind, bodyHtml, open = false, key = null }) {
  const card = document.createElement('div');
  const expanded = open || (key ? openSteps.has(key) : false);
  card.className = 'step' + (expanded ? ' is-open' : '');
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'step-head';
  head.innerHTML = `
    <svg class="ico"><use href="#${icon}"/></svg>
    <span class="step-title"></span>
    ${statusText ? `<span class="status-pill ${statusKind ?? ''}"></span>` : ''}
    <span class="step-sub"></span>
    <svg class="caret-ico"><use href="#i-chevron-right"/></svg>`;
  head.querySelector('.step-title').textContent = title;
  if (statusText) head.querySelector('.status-pill').textContent = statusText;
  else head.querySelector('.status-pill')?.remove();
  head.querySelector('.step-sub').textContent = sub ?? '';
  head.addEventListener('click', () => {
    const nowOpen = card.classList.toggle('is-open');
    if (key) {
      if (nowOpen) openSteps.add(key);
      else openSteps.delete(key);
    }
  });
  const body = document.createElement('div');
  body.className = 'step-body';
  if (bodyHtml) body.innerHTML = bodyHtml;
  card.append(head, body);
  return card;
}

function renderItem(item, turn) {
  switch (item.type) {
    case 'userMessage': {
      removePendingEcho();
      const parts = item.content ?? [];
      const text = parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      const extras = parts.filter((c) => c.type !== 'text');

      // Codex stores internal protocol turns (tool replies, env context …) as
      // userMessage items. Showing them as chat bubbles is what made the UI look broken.
      const tag = text.match(/^<([a-zA-Z_][\w-]*)/);
      if (tag) {
        const label = ({
          send_user_message_question_reply: '回答了一个提问',
          user_instructions: '用户指令',
          environment_context: '环境上下文',
          turn_aborted: '本轮已中断',
          permissions: '权限说明',
          goal: '目标',
        })[tag[1]] ?? `系统消息 · ${tag[1]}`;
        return stepCard({
          icon: 'i-file',
          title: label,
          sub: '',
          bodyHtml: '<pre></pre>',
        });
      }

      const wrap = document.createElement('div');
      wrap.className = 'msg msg-user';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (text) {
        bubble.innerHTML = inlineMd(text).replace(/\n/g, '<br />');
      } else if (extras.length) {
        bubble.textContent = extras.map((e) => e.type).join(' · ');
      } else {
        bubble.textContent = '(附件)';
      }
      wrap.append(bubble);

      const chips = extras.map((e) => {
        const name = e.path ?? e.name ?? e.url ?? e.type;
        return `<span class="path-chip">${escapeHtml(String(name).split(/[\\/]/).pop())}</span>`;
      }).join('');
      if (chips) {
        const row = document.createElement('div');
        row.className = 'attach-row';
        row.innerHTML = chips;
        wrap.append(row);
      }
      return wrap;
    }
    case 'agentMessage': {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant';
      const prose = document.createElement('div');
      prose.className = 'prose';
      prose.innerHTML = md(item.text ?? '');
      if (item.streaming) prose.insertAdjacentHTML('beforeend', '<span class="caret"></span>');
      wrap.append(prose);
      return wrap;
    }
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join('\n\n');
      // Some models never emit reasoning text; a finished empty item is noise.
      const finished = item.completedAtMs != null || item.status === 'completed';
      if (!String(text).trim() && finished) return null;
      const card = stepCard({
        icon: 'i-sparkle',
        title: '思考',
        sub: '',
        key: item.id,
        bodyHtml: `<div class="step-body" style="padding:10px 12px;white-space:pre-wrap"></div>`,
      });
      card.classList.add('reasoning');
      card.querySelector('.step-body').innerHTML = text ? md(text) : '思考中…';
      return card;
    }
    case 'commandExecution': {
      const running = item.status === 'inProgress' || item.status === 'in_progress';
      const ok = item.exitCode === 0 || item.status === 'completed';
      const card = stepCard({
        icon: 'i-terminal',
        title: '命令',
        sub: (item.command ?? '').split('\n')[0].slice(0, 120),
        statusText: running ? '运行中' : item.exitCode === null || item.exitCode === undefined ? (ok ? '完成' : '') : `退出码 ${item.exitCode}`,
        statusKind: running ? '' : item.exitCode === 0 ? 'ok' : 'bad',
        bodyHtml: `<pre></pre>`,
      });
      card.querySelector('pre').textContent = item.aggregatedOutput || item.command || '';
      if (item.durationMs) {
        const meta = document.createElement('div');
        meta.className = 'step-meta';
        meta.textContent = `用时 ${fmtDuration(item.durationMs)} · ${shortPath(item.cwd ?? '')}`;
        card.append(meta);
      }
      return card;
    }
    case 'fileChange': {
      const changes = item.changes ?? [];
      const diffText = changes.map((c) => c.patch ?? c.diff ?? JSON.stringify(c)).join('\n');
      const card = stepCard({
        icon: 'i-file',
        title: '文件改动',
        sub: changes.map((c) => shortPath(c.path ?? c.file ?? '')).filter(Boolean).slice(0, 3).join(', '),
        statusText: item.status === 'completed' ? '已应用' : item.status === 'failed' ? '失败' : '',
        statusKind: item.status === 'failed' ? 'bad' : 'ok',
        bodyHtml: `<pre class="diff"></pre>`,
      });
      const pre = card.querySelector('pre');
      pre.textContent = diffText;
      return card;
    }
    case 'plan': {
      const wrap = document.createElement('div');
      wrap.className = 'plan';
      wrap.innerHTML = `<div class="plan-title">计划</div><div class="prose"></div>`;
      wrap.querySelector('.prose').innerHTML = md(item.text ?? '');
      return wrap;
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const name = item.tool ?? item.namespace ?? 'tool';
      const done = item.status === 'completed' || item.status === 'success' || item.success;
      let detail = '';
      try { detail = JSON.stringify(item.arguments ?? item.contentItems ?? '', null, 2); } catch { detail = ''; }
      const card = stepCard({
        icon: 'i-branch',
        title: name,
        sub: item.server ?? '',
        statusText: done ? '完成' : (item.status ?? ''),
        statusKind: item.error ? 'bad' : 'ok',
        bodyHtml: `<pre></pre>`,
      });
      card.querySelector('pre').textContent = detail;
      return card;
    }
    case 'webSearch': {
      const q = item.query ?? '';
      return stepCard({ icon: 'i-search', title: '联网搜索', sub: q, bodyHtml: '' });
    }
    case 'contextCompaction':
      return stepCard({ icon: 'i-library', title: '上下文已压缩', bodyHtml: '' });
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return stepCard({ icon: 'i-check', title: item.type === 'enteredReviewMode' ? '进入审查模式' : '退出审查模式', bodyHtml: '' });
    case 'imageView': {
      const p = item.path ?? '';
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant';
      wrap.innerHTML = `<div class="image-card">
        <img class="md-img" loading="lazy" alt="" />
        <button type="button" class="path-chip img-chip"></button>
      </div>`;
      const img = wrap.querySelector('img');
      const chip = wrap.querySelector('.img-chip');
      chip.textContent = shortPath(p);
      chip.title = p;
      if (p) {
        img.src = `/api/file?path=${encodeURIComponent(p)}`;
        img.addEventListener('error', () => { img.remove(); });
        chip.addEventListener('click', () => openFilePanel(p, shortPath(p)));
      }
      return wrap;
    }
    default: {
      if (item.type === 'sleep') return null;
      return stepCard({ icon: 'i-more', title: item.type ?? '事件', bodyHtml: '' });
    }
  }
}

function refreshItem(itemId) {
  const node = nodes.get(itemId);
  const item = state.items.get(itemId);
  if (!node || !item) return;
  if (item.type === 'agentMessage') {
    const prose = node.querySelector('.prose');
    if (prose) {
      const atBottom = isNearBottom();
      prose.innerHTML = md(item.text ?? '') + (item.streaming ? '<span class="caret"></span>' : '');
      typesetMath(prose);
      if (atBottom) scrollToBottom();
    }
    return;
  }
  if (item.type === 'commandExecution') {
    const pre = node.querySelector('pre');
    if (pre) { pre.textContent = item.aggregatedOutput || item.command || ''; if (isNearBottom()) scrollToBottom(); }
    return;
  }
  if (item.type === 'fileChange') {
    const pre = node.querySelector('pre');
    if (pre && item._output) pre.textContent = item._output;
    return;
  }
  if (item.type === 'reasoning') {
    const body = node.querySelector('.step-body');
    if (body) {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join('\n\n');
      body.innerHTML = text ? md(text) : '思考中…';
    }
    return;
  }
}


// ---------------------------------------------------------------- live follow
// The app-server only streams turn events to the client that started the turn: a
// second client (this page) gets nothing but thread/status/changed. So when a turn is
// running somewhere else on this machine, poll the turn list and merge what appeared.
// itemsView:"full" publishes items while the turn is in flight (reasoning steps show up
// one by one), which is what makes "thinking" visible here too.
let liveTimer = null;
let liveThreadId = null;
let liveSig = '';

function stopLiveFollow() {
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  liveThreadId = null;
  liveSig = '';
}

function liveSignature(turns) {
  return turns.map((t) => (t.items ?? []).map((i) => i.id).join('.') + ':' + (t.status ?? '')).join('|');
}

/** Merge a page of turns for the open thread without disturbing local state. */
function mergeLiveTurns(turns) {
  for (const tn of turns) {
    const items = tn.items ?? [];
    const known = state.turns.find((x) => x.id === tn.id);
    if (!known) {
      state.turns.push({
        id: tn.id,
        status: tn.status ?? 'inProgress',
        startedAt: tn.startedAt,
        completedAt: tn.completedAt,
        durationMs: tn.durationMs,
        itemIds: [],
      });
    } else {
      known.status = tn.status ?? known.status;
      known.completedAt = tn.completedAt ?? known.completedAt;
      known.durationMs = tn.durationMs ?? known.durationMs;
    }
    for (const it of items) addItem(it, tn.id);
    // Snapshots come back in turn order. Adopting it keeps "思考" above the answer even
    // when a later poll is the first one to see the earlier step.
    const mine = state.turns.find((x) => x.id === tn.id);
    if (mine && items.length) {
      const snapshot = new Set(items.map((i) => i.id));
      const extras = mine.itemIds.filter((id) => !snapshot.has(id));
      mine.itemIds = [...items.map((i) => i.id), ...extras];
    }
  }
  state.turns.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

async function pollLiveOnce(threadId) {
  const page = await rpc.send('thread/turns/list', {
    threadId, limit: 6, sortDirection: 'desc', itemsView: 'full',
  });
  if (threadId !== state.currentThreadId) return false;
  const turns = [...(page?.data ?? [])].reverse();
  const sig = liveSignature(turns);
  const atBottom = isNearBottom();
  if (sig !== liveSig) {
    liveSig = sig;
    mergeLiveTurns(turns);
    renderStream();
    if (atBottom) scrollToBottom();
  }
  const running = turns.some((t) => /inProgress|in_progress/.test(String(t.status)));
  if (running) {
    state.busy = true;
    const last = turns[turns.length - 1];
    state.currentTurnId = last?.id ?? state.currentTurnId;
    updateBusyUi();
  } else {
    state.busy = false;
    updateBusyUi();
  }
  return running;
}

/** Follow the open thread while a turn is running elsewhere on this machine. */
async function startLiveFollow(threadId) {
  if (!threadId || state.busy) return; // our own turn already streams live
  if (liveThreadId === threadId && liveTimer) return;
  stopLiveFollow();
  liveThreadId = threadId;
  let misses = 0;
  const tick = async () => {
    if (liveThreadId !== threadId || threadId !== state.currentThreadId) { stopLiveFollow(); return; }
    let running = false;
    try {
      running = await pollLiveOnce(threadId);
      misses = 0;
    } catch {
      misses += 1;
      if (misses >= 4) { stopLiveFollow(); return; }
    }
    if (!running) {
      // One last read so the final answer/step lands, then stop.
      try { await pollLiveOnce(threadId); } catch { /* ignore */ }
      stopLiveFollow();
      return;
    }
    liveTimer = setTimeout(tick, 1800);
  };
  liveTimer = setTimeout(tick, 400);
}

// ---------------------------------------------------------------- approvals
function renderApproval(requestId, method, params) {
  // Plan mode asks real questions ("which approach?") — those are not allow/deny
  // approvals, they need options and a text answer.
  const card = method === 'item/tool/requestUserInput'
    ? buildQuestionCard(requestId, params)
    : buildApprovalCard(requestId, method, params);
  dom.messages.append(card);
  return card;
}

/**
 * item/tool/requestUserInput card.
 * params: { questions: [{ id, header, question, isOther, isSecret, options }], isBlocking }
 * reply:  { answers: { [questionId]: { answers: [string, …] } } }
 */
function buildQuestionCard(requestId, params) {
  const card = document.createElement('div');
  card.className = 'approval question-card';
  card.dataset.requestId = String(requestId);

  const questions = params?.questions ?? [];
  const picked = new Map(); // qid -> Set(labels)
  const typed = new Map();  // qid -> string

  const head = document.createElement('div');
  head.className = 'approval-head';
  head.textContent = questions.length > 1 ? `Codex 想问 ${questions.length} 个问题` : 'Codex 想问你';
  card.append(head);

  const body = document.createElement('div');
  body.className = 'approval-body question-body';
  card.append(body);

  for (const q of questions) {
    const block = document.createElement('div');
    block.className = 'q-block';

    if (q.header) {
      const h = document.createElement('div');
      h.className = 'q-header';
      h.textContent = q.header;
      block.append(h);
    }
    const text = document.createElement('div');
    text.className = 'q-text';
    text.textContent = q.question || '(无标题)';
    block.append(text);

    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length) {
      const list = document.createElement('div');
      list.className = 'q-options';
      const set = new Set();
      picked.set(q.id, set);
      for (const o of opts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'q-option';
        b.innerHTML = '<span class="q-label"></span><span class="q-desc"></span>';
        b.querySelector('.q-label').textContent = o.label;
        b.querySelector('.q-desc').textContent = o.description || '';
        b.addEventListener('click', () => {
          if (set.has(o.label)) { set.delete(o.label); b.classList.remove('is-selected'); }
          else { set.add(o.label); b.classList.add('is-selected'); }
          syncEnabled();
        });
        list.append(b);
      }
      block.append(list);
    }

    if (q.isOther || !opts.length) {
      const input = document.createElement('input');
      input.className = 'q-input';
      input.type = q.isSecret ? 'password' : 'text';
      input.placeholder = q.isSecret ? '输入内容（保密）' : '或者自己写一个答案…';
      input.addEventListener('input', () => { typed.set(q.id, input.value.trim()); syncEnabled(); });
      block.append(input);
    }

    body.append(block);
  }

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary-sm';
  submit.textContent = '提交回答';
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'btn';
  skip.textContent = '跳过';
  actions.append(submit, skip);
  card.append(actions);

  const hasAnswer = () => questions.some((q) => (picked.get(q.id)?.size ?? 0) > 0 || (typed.get(q.id) ?? '') !== '');
  const syncEnabled = () => { submit.disabled = !hasAnswer(); };
  syncEnabled();

  const send = (payload) => {
    try { rpc.reply(requestId, payload); } catch { /* socket gone */ }
    state.approvals.delete(requestId);
    card.remove();
  };

  submit.addEventListener('click', () => {
    const answers = {};
    for (const q of questions) {
      const list = [];
      const sel = picked.get(q.id);
      if (sel) for (const v of sel) list.push(v);
      const t = typed.get(q.id);
      if (t) list.push(t);
      if (list.length) answers[q.id] = { answers: list };
    }
    send({ answers });
  });
  skip.addEventListener('click', () => send({ answers: {} }));

  return card;
}

function buildApprovalCard(requestId, method, params) {
  const card = document.createElement('div');
  card.className = 'approval';
  card.dataset.requestId = String(requestId);

  const isCommand = method === 'item/commandExecution/requestApproval';
  const isFile = method === 'item/fileChange/requestApproval';
  const isElicit = method === 'mcpServer/elicitation/request';
  const title = isCommand ? '请求执行命令' : isFile ? '请求修改文件' : isElicit ? 'MCP 需要确认' : '需要你的确认';
  const detail = isCommand
    ? `${params.reason ? params.reason + '\n' : ''}${params.command ?? ''}`
    : isFile
      ? (params.reason ?? 'Codex 想写入文件改动')
      : isElicit
        ? [params.title, params.message ?? params.description, params.url, params.serverName ? `来自 ${params.serverName}` : ''].filter(Boolean).join('\n')
        : (params.reason ?? '');

  card.innerHTML = `
    <div class="approval-head"></div>
    <div class="approval-body">${detail ? '<pre></pre>' : ''}</div>
    <div class="approval-actions">
      <button class="btn btn-primary-sm" data-decision="accept">允许</button>
      ${isElicit ? '' : '<button class="btn" data-decision="acceptForSession">本会话都允许</button>'}
      <button class="btn btn-danger" data-decision="decline">拒绝</button>
    </div>`;
  card.querySelector('.approval-head').textContent = title;
  const pre = card.querySelector('pre');
  if (pre) pre.textContent = detail;

  card.querySelectorAll('[data-decision]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const decision = btn.dataset.decision;
      if (method === 'item/permissions/requestApproval') {
        // "本会话都允许" used to send scope: 'turn', so it only lasted one turn.
        const scope = decision === 'acceptForSession' ? 'session' : 'turn';
        rpc.reply(requestId, decision === 'decline'
          ? { permissions: {}, scope }
          : { permissions: params.permissions ?? {}, scope });
      } else if (method === 'mcpServer/elicitation/request') {
        // MCP elicitation has its own shape: {action, content, _meta}. Replying with
        // {decision} here makes the server treat it as "user rejected".
        rpc.reply(requestId, {
          action: decision === 'decline' ? 'decline' : 'accept',
          content: decision === 'decline' ? null : {},
          _meta: null,
        });
      } else {
        rpc.reply(requestId, { decision });
      }
      state.approvals.delete(requestId);
      card.remove();
    });
  });
  return card;
}


// ---------------------------------------------------------------- ClawBot channel
// The dsh-wechat plugin (Tencent iLink) is the stable path: it survives account
// switches because the binding lives in <DSH_HOME>/wechat/state.json, not in a browser
// session. The bridge shells out to its CLI, so the page only talks to /api/claw/*.
const CLAW_NOTIFY_KEY = "codex-remote-claw-notify";
let clawChannel = null;
let clawChannelAt = 0;

async function clawChannelState(force = false) {
  if (!force && clawChannel && Date.now() - clawChannelAt < 8000) return clawChannel;
  try {
    clawChannel = await fetch("/api/claw/channel", { credentials: "same-origin" }).then((r) => r.json());
    clawChannelAt = Date.now();
  } catch { clawChannel = null; }
  return clawChannel;
}

function fmtAgo(ms) {
  if (!ms) return "";
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 60) return Math.round(d) + " 秒前";
  if (d < 3600) return Math.round(d / 60) + " 分钟前";
  return Math.round(d / 3600) + " 小时前";
}
let clawCache = null;
let clawCacheAt = 0;

async function clawStatus(force = false) {
  if (!force && clawCache && Date.now() - clawCacheAt < 15000) return clawCache;
  try {
    clawCache = await fetch("/api/claw/status", { credentials: "same-origin" }).then((r) => r.json());
    clawCacheAt = Date.now();
  } catch { clawCache = { ok: false, installed: false, loggedIn: false }; }
  return clawCache;
}

function clawNotifyEnabled() { return localStorage.getItem(CLAW_NOTIFY_KEY) !== "0"; }

/** Send text (and optionally a file) through the ClawBot channel. */
const CLAW_TARGET_KEY = "codex-remote-claw-target";

/**
 * Which WeChat should receive this file?
 * One account: no question. Several: ask once, remember the answer.
 * @returns {Promise<string|null>} accountId, or null when there is nothing bound
 */
async function pickClawTarget() {
  let accounts = [];
  try {
    const r = await fetch("/api/claw/accounts", { credentials: "same-origin" }).then((x) => x.json());
    accounts = r?.accounts ?? [];
  } catch { return null; }
  if (!accounts.length) return null;
  if (accounts.length === 1) return accounts[0].accountId;

  // Several accounts: always ask. Remembering the last pick only decides the order and
  // the ✓, because "send it to the other one this time" has to stay one tap away.
  const remembered = localStorage.getItem(CLAW_TARGET_KEY);
  const sorted = [...accounts].sort((a, b) => (b.accountId === remembered) - (a.accountId === remembered));

  return await new Promise((resolve) => {
    let settled = false;
    const done = (id) => {
      if (settled) return;
      settled = true;
      if (id) localStorage.setItem(CLAW_TARGET_KEY, id);
      resolve(id);
    };
    const items = sorted.map((a) => ({
      label: (a.accountId === remembered ? "✓ " : "") + a.displayName + (a.channel === "running" ? "" : "（未连接）"),
      onSelect: () => done(a.accountId),
    }));
    const r = dom.attachBtn.getBoundingClientRect();
    openMenuAt(r.left, r.top - 8 - items.length * 34, items, "发到哪个微信");
    // Clicking elsewhere closes the menu without a choice; don't hang the send forever.
    setTimeout(() => done(null), 20000);
  });
}

/** Ask again next time (the panel offers this when someone wants to switch). */
function forgetClawTarget() { localStorage.removeItem(CLAW_TARGET_KEY); }

async function clawSend(payload, onTick) {
  const start = await fetch("/api/claw/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  if (!start.ok) return { ok: false, error: start.error || "发送失败" };
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 800));
    let j;
    try {
      j = await fetch("/api/claw/job?id=" + encodeURIComponent(start.jobId), { credentials: "same-origin" }).then((r) => r.json());
    } catch { continue; }
    if (onTick) onTick(j?.job);
    if (j?.job && j.job.state !== "running") return { ok: j.job.state === "done", error: j.job.message };
  }
  return { ok: false, error: "发送超时" };
}

/** Push a short summary to WeChat when a turn ends. */
async function clawNotifyTurn(turn) {
  if (!clawNotifyEnabled()) return;
  const st = await clawStatus();
  if (!st?.loggedIn) return;
  const title = (state.threads.find((t) => t.id === state.currentThreadId)?.name || dom.threadTitle?.textContent || "会话").slice(0, 40);
  const status = String(turn?.status ?? "completed");
  const failed = /fail|error|abort|interrupt/i.test(status);
  const dur = turn?.durationMs ? Math.round(turn.durationMs / 1000) + " 秒" : "";
  const text = (failed ? "⚠️ 任务失败：" : "✅ 任务完成：") + title + (dur ? "（" + dur + "）" : "");
  void clawSend({ text }).catch(() => {});
}

// ---------------------------------------------------------------- network panel
let netState = { snap: null, group: null, busy: false, job: null, codex: {}, note: null };

async function netFetch(path, opts) {
  const r = await fetch(path, { credentials: 'same-origin', ...(opts ?? {}) });
  return r.json();
}


// ---------------------------------------------------------------- wechat in net panel
// The QR flow lives here too: connection health and "can I send a file to my phone"
// are the same question, and this panel is where people look for it.
let wxNetTimer = null;


async function openNetworkPanel() {
  openPanel('网络与连通性');
  const body = dom.panelBody;
  body.replaceChildren();
  const host = document.createElement('div');
  host.className = 'net-block';
  body.append(host);
  netState.host = host;

  host.innerHTML = '<div class="net-loading">正在读取 Clash 状态…</div>';
  try {
    netState.snap = await netFetch('/api/clash');
  } catch (e) {
    host.replaceChildren();
    const box = document.createElement('div');
    box.className = 'panel-error';
    const title = document.createElement('strong');
    title.textContent = '读取网络状态失败';
    const detail = document.createElement('span');
    detail.textContent = String(e.message || e);
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn-sm';
    again.textContent = '重试';
    again.addEventListener('click', () => openNetworkPanel());
    box.append(title, detail, again);
    host.append(box);
    return;
  }
  netState.group = netState.snap.defaultGroup ?? netState.snap.groups?.[0]?.name ?? null;
  try {
    const a = await netFetch('/api/clash/autoswitch');
    if (a.ok) netState.autoswitch = a;
  } catch { /* ignore */ }
  renderNetworkPanel();
  if (netState.autoswitch?.enabled) pollAutoswitch();

  // WeChat lives here too: same question ("can the phone receive files?"), and
  // ClawBot is the only channel now.
  const clawSlot = document.createElement("div");
  clawSlot.className = "net-wx-slot";
  dom.panelBody.prepend(clawSlot);
  void renderClawCard(clawSlot);
  wxNetTimer = setInterval(() => {
    if (!document.contains(clawSlot)) { clearInterval(wxNetTimer); wxNetTimer = null; return; }
    void renderClawCard(clawSlot);
  }, 20000);
}

async function pollAutoswitch() {
  try {
    const r = await netFetch('/api/clash/autoswitch');
    if (r.ok) {
      netState.autoswitch = r;
      if (dom.panel && !dom.panel.hidden && netState.host) renderNetworkPanel();
      if (r.enabled) setTimeout(pollAutoswitch, 8000);
    }
  } catch { /* ignore */ }
}

function netGroup() {
  return netState.snap?.groups?.find((g) => g.name === netState.group) ?? null;
}

const NET_GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);
const NET_INFO_ROW = /^(剩余流量|套餐|到期|官网|订阅|重置|客服|网址|流量)/;

function netNodes() {
  const g = netGroup();
  return (g?.nodes ?? []).filter((n) => n.type && !NET_GROUP_TYPES.has(n.type) && !NET_INFO_ROW.test(n.name));
}

function codexBadge(node) {
  const r = netState.codex[node];
  if (!r) return { text: '未测', cls: 'is-unknown' };
  if (r.ok) return { text: r.ms + 'ms', cls: r.ms < 2500 ? 'is-good' : r.ms < 6000 ? 'is-mid' : 'is-bad' };
  return { text: '失败', cls: 'is-bad' };
}


/** ClawBot card: the stable WeChat channel (independent of any browser session). */
// Login lives outside the card: the network panel repaints and would take the QR with it.
const clawLogin = { active: false, snap: null, timer: null, host: null };

function paintClawLogin() {
  const box = document.querySelector(".claw-qr");
  if (!box) return;
  if (!clawLogin.active || !clawLogin.snap) { box.hidden = true; box.replaceChildren(); return; }
  const snap = clawLogin.snap;
  box.hidden = false;
  box.replaceChildren();
  if (snap.qrPng) {
    const img = document.createElement("img");
    img.className = "claw-qr-img";
    img.alt = "微信扫码绑定 ClawBot";
    img.src = snap.qrPng;
    box.append(img);
  }
  const msg = document.createElement("p");
  msg.className = "claw-qr-msg";
  msg.textContent = snap.message || "";
  box.append(msg);
  if (snap.needsCode && !box.querySelector(".claw-qr-code")) {
    const form = document.createElement("form");
    form.className = "claw-qr-code";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.placeholder = "手机上的配对验证码";
    input.autocomplete = "off";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "btn btn-sm";
    ok.textContent = "提交";
    form.append(input, ok);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await fetch("/api/claw/login/code", {
        method: "POST", headers: { "content-type": "application/json" },
        credentials: "same-origin", body: JSON.stringify({ code: input.value.trim() }),
      }).then((x) => x.json()).catch(() => ({ ok: false }));
      if (!r.ok) toast(r.error || "验证码提交失败");
    });
    box.append(form);
    input.focus();
  }
}

function stopClawLogin() {
  clawLogin.active = false;
  if (clawLogin.timer) { clearInterval(clawLogin.timer); clawLogin.timer = null; }
}

async function startClawLogin() {
  stopClawLogin();
  clawLogin.active = true;
  clawLogin.snap = { message: "正在获取二维码…", qrPng: null };
  paintClawLogin();
  const first = await fetch("/api/claw/login/start", { method: "POST", credentials: "same-origin" })
    .then((r) => r.json()).catch(() => null);
  if (!first) { clawLogin.snap = { message: "无法启动登录" }; paintClawLogin(); return; }
  clawLogin.snap = first;
  paintClawLogin();
  clawLogin.timer = setInterval(async () => {
    const s2 = await fetch("/api/claw/login", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null);
    if (!s2) return;
    clawLogin.snap = s2;
    paintClawLogin();
    if (!s2.running) {
      stopClawLogin();
      if (s2.phase === "confirmed" || s2.phase === "already-bound") {
        clawCache = null;
        // iLink gives us only opaque ids, never a nickname: ask once, right after binding.
        if (s2.phase === "confirmed" && s2.account?.accountId) {
          const name = prompt("给这个微信起个名字（会显示在账号列表里）", "微信");
          if (name) {
            await fetch("/api/claw/account/label", {
              method: "POST", headers: { "content-type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ accountId: s2.account.accountId, name }),
            }).catch(() => {});
          }
        }
        toast(s2.phase === "confirmed" ? "ClawBot 已绑定" : "这个微信已经绑定过了");
        if (clawLogin.host) void renderClawCard(clawLogin.host);
      }
    }
  }, 1500);
}

const clawSelected = new Set();

function clawNotifySet() {
  try { return new Set(JSON.parse(localStorage.getItem(CLAW_NOTIFY_KEY) || "[]")); } catch { return new Set(); }
}

function clawNotifyFor(accountId) {
  return clawNotifySet().has(accountId);
}

function clawSetNotify(accountId, on) {
  const set = clawNotifySet();
  if (on) set.add(accountId); else set.delete(accountId);
  localStorage.setItem(CLAW_NOTIFY_KEY, JSON.stringify([...set]));
}

async function clawAccountAction(kind, ids) {
  const results = [];
  for (const accountId of ids) {
    try {
      if (kind === "test") {
        const r = await fetch("/api/claw/account/test", {
          method: "POST", headers: { "content-type": "application/json" },
          credentials: "same-origin", body: JSON.stringify({ accountId }),
        }).then((x) => x.json());
        results.push({ accountId, ok: r.ok, queued: r.queued, error: r.error });
      } else if (kind === "reconnect") {
        const r = await fetch("/api/claw/account/reconnect", {
          method: "POST", headers: { "content-type": "application/json" },
          credentials: "same-origin", body: JSON.stringify({ accountId }),
        }).then((x) => x.json());
        results.push({ accountId, ok: r.ok, error: r.error });
      } else if (kind === "logout") {
        const r = await fetch("/api/claw/account/logout", {
          method: "POST", headers: { "content-type": "application/json" },
          credentials: "same-origin", body: JSON.stringify({ accountId }),
        }).then((x) => x.json());
        results.push({ accountId, ok: r.ok, error: r.error });
      }
    } catch (e) {
      results.push({ accountId, ok: false, error: e.message });
    }
  }
  return results;
}

async function renderClawCard(host) {
  if (!host || !document.contains(host)) return;
  // One card, always: this runs on a timer and used to stack copies.
  for (const old of host.querySelectorAll(".claw-card")) old.remove();
  clawLogin.host = host;
  const card = document.createElement("div");
  card.className = "claw-card";
  const wx = host.querySelector(".net-wx");
  if (wx && wx.nextSibling) host.insertBefore(card, wx.nextSibling);
  else if (wx) host.append(card);
  else host.prepend(card);

  const st = await clawStatus(true);
  const head = document.createElement("div");
  head.className = "claw-head";
  head.innerHTML = '<span class="claw-title">ClawBot</span><span class="claw-pill"></span>';
  const pill = head.querySelector(".claw-pill");
  pill.textContent = st?.loggedIn ? "已绑定" : st?.installed ? "未绑定" : "未安装";
  pill.className = "claw-pill " + (st?.loggedIn ? "is-ok" : st?.installed ? "is-warn" : "is-off");
  card.append(head);

  const meta = document.createElement("div");
  meta.className = "claw-meta";
  meta.textContent = st?.loggedIn
    ? "任务结束可以推送到勾了「提醒」的微信"
    : st?.installed
      ? "插件已就绪，点下面的 + 扫码绑定。"
      : "没有找到 dsh-wechat 插件。";
  card.append(meta);

  let accounts = [];
  try {
    const acc = await fetch("/api/claw/accounts", { credentials: "same-origin" }).then((r) => r.json());
    accounts = acc?.accounts ?? [];
    const active = acc?.active ?? null;

    const wrap = document.createElement("div");
    wrap.className = "claw-accounts";
    const headRow = document.createElement("div");
    headRow.className = "claw-accounts-head";
    headRow.textContent = "账号 · " + accounts.length + " / 3";
    wrap.append(headRow);

    for (const a of accounts) {
      const row = document.createElement("div");
      row.className = "claw-account" + (a.accountId === active ? " is-active" : "");

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "claw-account-check";
      box.checked = clawSelected.has(a.accountId);
      box.addEventListener("change", () => {
        if (box.checked) clawSelected.add(a.accountId); else clawSelected.delete(a.accountId);
        paintBulk();
      });

      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "claw-account-dot";
      pick.title = a.accountId === active ? "当前发送账号" : "设为发送账号";
      pick.addEventListener("click", async () => {
        const r = await fetch("/api/claw/account/active", {
          method: "POST", headers: { "content-type": "application/json" },
          credentials: "same-origin", body: JSON.stringify({ accountId: a.accountId }),
        }).then((x) => x.json()).catch(() => ({ ok: false }));
        toast(r.ok ? "已切换到 " + a.displayName : r.error || "切换失败", 3000, { kind: r.ok ? "ok" : "err" });
        clawCache = null;
        clawChannelAt = 0;
        void renderClawCard(host);
      });

      const nameBox = document.createElement("span");
      nameBox.className = "claw-account-name";
      nameBox.textContent = a.displayName;
      nameBox.title = "点一下可以改名";
      nameBox.addEventListener("click", async () => {
        const next = prompt("这个微信叫什么？（会显示在这里）", a.displayName);
        if (!next) return;
        const r = await fetch("/api/claw/account/label", {
          method: "POST", headers: { "content-type": "application/json" },
          credentials: "same-origin", body: JSON.stringify({ accountId: a.accountId, name: next }),
        }).then((x) => x.json()).catch(() => ({ ok: false }));
        toast(r.ok ? "已改名" : r.error || "改名失败", 2400, { kind: r.ok ? "ok" : "err" });
        void renderClawCard(host);
      });

      const state = document.createElement("span");
      const running = a.channel === "running" && !a.paused;
      state.className = "claw-account-state " + (running ? "is-ok" : a.channel === "error" ? "is-err" : "is-warn");
      state.textContent = a.paused
        ? "暂停 " + Math.ceil((a.pauseMs || 0) / 1000) + "s"
        : a.channel === "running" ? "已连接"
        : a.channel === "starting" ? "连接中"
        : a.channel === "error" ? "出错"
        : "未连接";
      if (a.error) state.title = a.error;
      if (a.lastMessageAt) state.title = (state.title ? state.title + " · " : "") + "最后收到 " + fmtAgo(a.lastMessageAt);

      // 任务结束提醒：this account's own switch.
      const remind = document.createElement("button");
      remind.type = "button";
      remind.className = "claw-switch" + (clawNotifyFor(a.accountId) ? " is-on" : "");
      remind.setAttribute("role", "switch");
      remind.setAttribute("aria-checked", clawNotifyFor(a.accountId) ? "true" : "false");
      remind.title = "任务结束时推送到这个微信";
      remind.innerHTML = '<span class="claw-switch-knob"></span><span class="claw-switch-text">提醒</span>';
      remind.addEventListener("click", () => {
        const on = !clawNotifyFor(a.accountId);
        clawSetNotify(a.accountId, on);
        remind.classList.toggle("is-on", on);
        remind.setAttribute("aria-checked", on ? "true" : "false");
        toast(on ? a.displayName + " 会收到任务提醒" : a.displayName + " 不再提醒", 2400);
      });

      row.append(box, pick, nameBox, state, remind);
      wrap.append(row);
    }

    // Bulk row
    const bulk = document.createElement("div");
    bulk.className = "claw-bulk";
    const count = document.createElement("span");
    count.className = "claw-bulk-count";
    const paintBulk = () => {
      const n = clawSelected.size;
      count.textContent = n ? "已选 " + n + " 个" : "勾选后可批量操作";
      for (const btn of bulk.querySelectorAll("button")) btn.disabled = !n;
    };
    bulk.append(count);
    for (const [kind, label] of [["test", "测试"], ["reconnect", "重连"], ["logout", "退出"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm" + (kind === "logout" ? " is-danger" : "");
      b.textContent = label;
      b.addEventListener("click", async () => {
        const ids = [...clawSelected];
        if (!ids.length) return;
        if (kind === "logout" && !confirm("退出选中的 " + ids.length + " 个微信绑定？")) return;
        b.disabled = true;
        const rs = await clawAccountAction(kind, ids);
        b.disabled = false;
        const ok = rs.filter((r) => r.ok).length;
        const queued = rs.filter((r) => r.queued).length;
        const msg = kind === "test"
          ? ((ok ? ok + " 个已发出" : "") + (queued ? (ok ? "，" : "") + queued + " 个已排队（等你在微信里回一句话）" : "")) || "发送失败"
          : ok + " / " + ids.length + " 成功";
        toast(msg, 4200, { kind: ok ? "ok" : "err" });
        if (kind === "logout") clawSelected.clear();
        clawCache = null;
        clawChannelAt = 0;
        void renderClawCard(host);
      });
      bulk.append(b);
    }
    wrap.append(bulk);

    // "+" is the last row of the list, and it is the only way to add one.
    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "claw-account-add-row";
    const full = accounts.length >= 3;
    addRow.textContent = full ? "已满 3 个（先退出一个）" : "+ 添加微信";
    addRow.disabled = full;
    addRow.addEventListener("click", () => { void startClawLogin(); });
    wrap.append(addRow);

    card.append(wrap);
    paintBulk();
  } catch { /* no accounts yet */ }

  if (!accounts.length && st?.installed) {
    const solo = document.createElement("button");
    solo.type = "button";
    solo.className = "claw-account-add-row";
    solo.textContent = "+ 添加微信";
    solo.addEventListener("click", () => { void startClawLogin(); });
    card.append(solo);
  }

  const chan = await clawChannelState(true);
  if (chan?.accounts?.length) {
    const line = document.createElement("div");
    line.className = "claw-chan";
    const running = chan.accounts.filter((a) => a.status === "running").length;
    line.textContent = "通道：" + running + "/" + chan.accounts.length + " 在收消息";
    card.append(line);
  }

  const qrBox = document.createElement("div");
  qrBox.className = "claw-qr";
  qrBox.hidden = true;
  card.append(qrBox);

  paintClawLogin();
}

function renderNetworkPanel() {
  const host = netState.host;
  const snap = netState.snap;
  if (!host || !snap) return;
  host.replaceChildren();

  if (!snap?.ok) {
    const err = document.createElement('div');
    err.className = 'net-error';
    err.textContent = 'Clash API 不可用：' + (snap?.error ?? '未知错误');
    host.append(err);
    return;
  }

  const group = netGroup();
  const nodes = netNodes();

  // header: which group, what mode, current node
  const head = document.createElement('div');
  head.className = 'net-head';
  head.textContent = (group?.name ?? '-') + '  ·  ' + (snap.mode ?? '-') + '  ·  ' + nodes.length + ' 个节点';
  host.append(head);

  const now = document.createElement('div');
  now.className = 'net-now';
  now.innerHTML = '<span class="net-now-label">当前节点</span><span class="net-now-node"></span>';
  now.querySelector('.net-now-node').textContent = group?.now ?? '未知';
  host.append(now);

  // primary action
  const actions = document.createElement('div');
  actions.className = 'net-actions';
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'btn btn-primary-sm net-auto';
  const running = netState.job && netState.job.state === 'running';
  auto.textContent = running
    ? '测速中 ' + netState.job.done + '/' + netState.job.total + '…'
    : '一键测速并切换（全组节点）';
  auto.disabled = running || netState.busy;
  auto.addEventListener('click', () => runAutopick());
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'btn btn-sm';
  refresh.textContent = '刷新';
  refresh.disabled = running;
  refresh.addEventListener('click', async () => {
    try { netState.snap = await netFetch('/api/clash'); } catch { /* keep */ }
    netState.group = netState.snap?.defaultGroup ?? netState.group;
    renderNetworkPanel();
  });
  actions.append(auto, refresh);
  host.append(actions);

  // auto-switch supervisor
  const autoRow = document.createElement('label');
  autoRow.className = 'net-auto-row';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'net-auto-box';
  box.checked = Boolean(netState.autoswitch?.enabled);
  box.disabled = Boolean(netState.autoBusy);
  const label = document.createElement('span');
  label.className = 'net-auto-label';
  label.textContent = '自动切换（断线时选 Codex 最快节点）';
  box.addEventListener('change', async () => {
    netState.autoBusy = true;
    renderNetworkPanel();
    try {
      const r = await netFetch('/api/clash/autoswitch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: box.checked }),
      });
      if (!r.ok) throw new Error(r.error);
      netState.autoswitch = { ...(netState.autoswitch ?? {}), enabled: r.enabled, intervalSec: r.intervalSec };
      netState.note = r.enabled ? '已开启自动切换：每 ' + r.intervalSec + ' 秒检查一次' : '已关闭自动切换';
    } catch (e) {
      netState.note = '设置失败：' + e.message;
    } finally {
      netState.autoBusy = false;
      renderNetworkPanel();
      if (netState.autoswitch?.enabled) setTimeout(pollAutoswitch, 3000);
    }
  });
  autoRow.append(box, label);
  host.append(autoRow);

  const sw = netState.autoswitch;
  if (sw?.enabled) {
    const st = document.createElement('div');
    st.className = 'net-auto-state';
    const parts = [];
    if (sw.last) parts.push((sw.last.ok ? '最近检查正常 ' + sw.last.ms + 'ms' : '最近检查失败') + '（' + (sw.last.node ?? '-') + '）');
    else parts.push('等待首次检查…');
    if (sw.switches) parts.push('已自动切换 ' + sw.switches + ' 次');
    if (sw.lastSwitch) parts.push('上次切到 ' + sw.lastSwitch.to);
    st.textContent = parts.join(' · ');
    host.append(st);
  }

  if (netState.note) {
    const note = document.createElement('div');
    note.className = 'net-note';
    note.textContent = netState.note;
    host.append(note);
  }

  // node rows
  const list = document.createElement('div');
  list.className = 'net-nodes';
  const sorted = nodes.slice().sort((a, b) => {
    const ra = netState.codex[a.name];
    const rb = netState.codex[b.name];
    const sa = ra ? (ra.ok ? ra.ms : 1e9) : 5e8;
    const sb = rb ? (rb.ok ? rb.ms : 1e9) : 5e8;
    if (sa !== sb) return sa - sb;
    return (a.delay ?? 1e9) - (b.delay ?? 1e9);
  });
  for (const n of sorted) {
    const row = document.createElement('div');
    row.className = 'net-node' + (n.name === group?.now ? ' is-current' : '');

    const nm = document.createElement('button');
    nm.type = 'button';
    nm.className = 'net-node-main';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'net-node-name';
    nameSpan.textContent = n.name;
    const dl = document.createElement('span');
    dl.className = 'net-node-delay';
    dl.textContent = (typeof n.delay === 'number' && n.delay > 0) ? n.delay + 'ms' : '—';
    nm.append(nameSpan, dl);
    nm.addEventListener('click', async () => {
      if (n.name === group?.now || netState.busy) return;
      netState.busy = true;
      netState.note = '正在切换到 ' + n.name + ' …';
      renderNetworkPanel();
      try {
        const r = await netFetch('/api/clash/select', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ group: group.name, node: n.name }),
        });
        if (!r.ok) throw new Error(r.error || '切换失败');
        group.now = n.name;
        netState.note = '已切换到 ' + n.name + '（新连接生效）';
      } catch (e) {
        netState.note = '切换失败：' + e.message;
      } finally {
        netState.busy = false;
        renderNetworkPanel();
      }
    });

    const badge = codexBadge(n.name);
    const cbadge = document.createElement('span');
    cbadge.className = 'net-codex ' + badge.cls;
    cbadge.textContent = 'Codex ' + badge.text;
    cbadge.title = netState.codex[n.name]?.error ?? 'Codex 实测延迟';

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'net-probe';
    testBtn.textContent = '测';
    testBtn.disabled = netState.busy || (netState.job?.state === 'running');
    testBtn.addEventListener('click', async () => {
      netState.busy = true;
      netState.note = '正在实测 ' + n.name + ' …';
      renderNetworkPanel();
      try {
        const r = await netFetch('/api/clash/probe', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ group: group.name, node: n.name }),
        });
        if (r.ok) {
          netState.codex[n.name] = r.codex;
          netState.note = n.name + '：' + (r.codex?.ok ? 'Codex 连通 ' + r.codex.ms + 'ms' : 'Codex 不通（' + (r.codex?.error ?? '') + '）');
        } else {
          netState.note = '实测失败：' + r.error;
        }
        netState.snap = await netFetch('/api/clash');
        netState.group = netState.group;
      } catch (e) {
        netState.note = '实测失败：' + e.message;
      } finally {
        netState.busy = false;
        renderNetworkPanel();
      }
    });

    row.append(nm, cbadge, testBtn);
    list.append(row);
  }
  host.append(list);

}

async function runAutopick() {
  const group = netGroup();
  if (!group) return;
  netState.busy = true;
  netState.note = '开始测速：先并行筛掉连不通的节点，再逐个实测 Codex，约 1-2 分钟…';
  renderNetworkPanel();
  let id;
  try {
    const r = await netFetch('/api/clash/autopick', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // no limit: the bridge tests every node in the group (unreachable ones are pre-filtered)
      body: JSON.stringify({ group: group.name }),
    });
    if (!r.ok) throw new Error(r.error);
    id = r.id;
  } catch (e) {
    netState.note = '启动失败：' + e.message;
    netState.busy = false;
    renderNetworkPanel();
    return;
  }
  netState.job = { state: 'running', done: 0, total: 8 };
  renderNetworkPanel();

  const tick = async () => {
    let finished = false;
    try {
      const r = await netFetch('/api/clash/autopick?id=' + encodeURIComponent(id));
      if (!r.ok) throw new Error(r.error);
      const job = r.job;
      for (const item of job.results ?? []) netState.codex[item.node] = item.codex;
      netState.job = job;
      if (job.state === 'running') {
        renderNetworkPanel();
        setTimeout(tick, 1200);
        return;
      }
      finished = true;
      netState.snap = await netFetch('/api/clash');
      netState.group = netState.snap?.defaultGroup ?? netState.group;
      if (job.best) {
        const skipped = job.skipped ? '，跳过 ' + job.skipped + ' 个不通节点' : '';
        netState.note = '测了 ' + job.total + ' 个节点' + skipped + '，已切到 ' + job.best.node + '（Codex ' + job.best.codex.ms + 'ms）';
        toast('已切换到 Codex 最快节点：' + job.best.node);
      } else {
        netState.note = '没有节点能连通 Codex，已恢复到原节点' + (job.original ? '（' + job.original + '）' : '');
      }
    } catch (e) {
      finished = true;
      netState.note = '测速中断：' + e.message;
    }
    // Only clean up when the job is really over: this used to run on every poll,
    // which cleared netState.job after the first tick and stopped polling.
    if (finished) {
      netState.busy = false;
      netState.job = null;
      renderNetworkPanel();
    }
  };
  setTimeout(tick, 1500);
}
function removeApproval(requestId) {
  state.approvals.delete(requestId);
  const el = dom.messages.querySelector(`.approval[data-request-id="${requestId}"]`);
  el?.remove();
}

// Inline errors stay in the transcript: they explain why a turn stopped.
// They live in state (not the DOM) so a re-render cannot silently wipe them.
function showErrorRow(message) {
  state.errors.push({ at: Date.now(), message: String(message) });
  if (state.errors.length > 4) state.errors.shift();
  renderStream();
  scrollToBottom(true);
}

// ---------------------------------------------------------------- composer / ui
// The long placeholder wraps and gets clipped on phones.
function syncPlaceholder() {
  const narrow = window.innerWidth < 520;
  const busy = state.busy;
  const wide = '描述你的任务，Enter 发送，Shift+Enter 换行；输入 / 调用技能；可拖入文件';
  const phone = '描述任务，Enter 发送';
  dom.input.placeholder = busy ? '正在执行…' : (narrow ? phone : wide);
}

function autoGrow() {
  const t = dom.input;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
}

function updateSendState() {
  // attachments alone are enough to send (e.g. "summarise this file")
  const has = dom.input.value.trim().length > 0 || state.attachments.length > 0;
  dom.sendBtn.disabled = !has || state.busy || !rpc.connected;
}

function updateBusyUi() {
  dom.stopBtn.hidden = !state.busy;
  updateSendState();
  syncPlaceholder();
}

function currentModel() {
  return state.models.find((m) => (m.id ?? m.model) === state.model) ?? null;
}

function currentServiceTier() {
  const m = currentModel();
  const tiers = m?.serviceTiers ?? [];
  return tiers.length ? tiers[0] : null;
}

function updateFastUi() {
  const btn = dom.modeBolt;
  if (!btn) return;
  const tier = currentServiceTier();
  if (!tier) { state.fast = false; btn.hidden = true; if (dom.modeFastTag) dom.modeFastTag.hidden = true; return; }
  btn.hidden = false;
  btn.classList.toggle('is-on', state.fast);
  btn.setAttribute('aria-pressed', state.fast ? 'true' : 'false');
  btn.title = state.fast
    ? `${tier.name} 已开启：${tier.description ?? ''}（再点关闭）`
    : `开启 ${tier.name}：${tier.description ?? ''}`;
  if (dom.modeFastTag) {
    dom.modeFastTag.hidden = !state.fast;
    dom.modeFastTag.textContent = tier.name;
  }
  btn.setAttribute('aria-label', `${tier.name} 加速档${state.fast ? '（已开启）' : ''}`);
}

// ---------------------------------------------------------------- metrics strip
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
}

function renderMetrics() {
  const host = dom.metrics;
  if (!host) return;
  const u = state.tokenUsage;
  const ctxTotal = u?.modelContextWindow ?? state.ctxWindows?.[state.model] ?? null;
  const last = u?.last ?? null;
  const totalTok = u?.total?.totalTokens ?? null;

  // context % = this turn's tokens against the model window
  const ctxPct = (ctxTotal && last) ? Math.min(100, (last.totalTokens / ctxTotal) * 100) : null;
  // cache hit rate = cached input / total input for the last turn
  const hitPct = (last && last.inputTokens > 0)
    ? (last.cachedInputTokens / last.inputTokens) * 100
    : null;
  const quotaPct = state.quota && Number.isFinite(state.quota.used) ? state.quota.used : null;

  const cell = (label, value, title, tone) => {
    if (value == null || value === '—') return null; // nothing to say yet
    const d = document.createElement('span');
    d.className = 'metric' + (tone ? ' ' + tone : '');
    d.title = title;
    const l = document.createElement('span');
    l.className = 'm-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'm-value';
    v.textContent = value;
    d.append(l, v);
    return d;
  };

  host.replaceChildren();
  const ctxTitle = (ctxTotal && last)
    ? '本次请求占用 ' + fmtTokens(last.totalTokens) + ' / 窗口 ' + fmtTokens(ctxTotal)
    : ctxTotal ? '窗口 ' + fmtTokens(ctxTotal) + '，还没有本轮用量' : '还没有拿到上下文窗口（跑一轮后才有）';
  const cells = [
    cell('上下文', ctxPct == null ? '—' : ctxPct.toFixed(0) + '%', ctxTitle,
      ctxPct != null && ctxPct >= 85 ? 'bad' : ctxPct != null && ctxPct >= 65 ? 'warn' : ''),
    cell('tokens', totalTok == null ? '—' : fmtTokens(totalTok), '本会话累计 token'),
    cell('命中率', hitPct == null ? '—' : hitPct.toFixed(0) + '%',
      last ? '缓存命中 ' + fmtTokens(last.cachedInputTokens) + ' / 输入 ' + fmtTokens(last.inputTokens) : '还没有命中数据'),
    cell('5h 额度', quotaPct == null ? '—' : quotaPct.toFixed(0) + '%',
      state.quota?.resetAt ? '将于 ' + fmtWhen(state.quota.resetAt) + ' 重置' : '5 小时窗口已用',
      quotaPct != null && quotaPct >= 90 ? 'bad' : quotaPct != null && quotaPct >= 70 ? 'warn' : ''),
  ].filter(Boolean);
  // Nothing known yet reads better as an empty strip than as four dashes.
  host.hidden = cells.length === 0;
  if (cells.length) host.append(...cells);
}

function updateModelLabels() {
  const m = state.models.find((x) => (x.id ?? x.model) === state.model);
  dom.modelLabel.textContent = m?.displayName ?? state.model ?? '模型';
  dom.effortLabel.textContent = effortLabel(state.effort);
  if (dom.modeModelName) dom.modeModelName.textContent = dom.modelLabel.textContent;
  if (dom.effortBtn) dom.effortBtn.title = `模型：${dom.modelLabel.textContent}　强度：${effortLabel(state.effort)}`;
  applyAccessUi();
  if (dom.modePop && !dom.modePop.hidden) renderModePop();
  updateFastUi();
  renderMetrics();
}

// Codex-compatible approval presets. Each level maps onto the app-server triple
// approvalPolicy / approvalsReviewer / sandboxPolicy.
const ACCESS_LEVELS = {
  ask: {
    label: '请求批准',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxMode: 'workspace-write',
    sandboxPolicy: (cwd) => ({
      type: 'workspaceWrite',
      writableRoots: cwd ? [cwd] : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }),
  },
  auto: {
    label: '帮我批准',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandboxMode: 'workspace-write',
    sandboxPolicy: (cwd) => ({
      type: 'workspaceWrite',
      writableRoots: cwd ? [cwd] : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }),
  },
  full: {
    label: '完全访问',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxMode: 'danger-full-access',
    sandboxPolicy: () => ({ type: 'dangerFullAccess' }),
  },
};

function accessPreset() {
  return ACCESS_LEVELS[state.access] ?? ACCESS_LEVELS.ask;
}

/** Params shared by thread/start and turn/start for the current access level. */
function accessParams(cwd) {
  const p = accessPreset();
  return {
    approvalPolicy: p.approvalPolicy,
    approvalsReviewer: p.approvalsReviewer,
    sandboxPolicy: p.sandboxPolicy(cwd),
  };
}

function applyAccessUi() {
  const p = accessPreset();
  if (dom.accessLabel) dom.accessLabel.textContent = p.label;
  if (dom.accessBtn) {
    dom.accessBtn.classList.toggle('is-danger', state.access === 'full');
    dom.accessBtn.setAttribute('aria-label', `审批方式：${p.label}`);
  }
  if (dom.accessPop) {
    for (const btn of dom.accessPop.querySelectorAll('[data-access]')) {
      btn.setAttribute('aria-selected', btn.dataset.access === state.access ? 'true' : 'false');
    }
  }
}

function setAccess(level) {
  if (!ACCESS_LEVELS[level]) return;
  state.access = level;
  try { localStorage.setItem('codex-remote-access', level); } catch { /* quota */ }
  applyAccessUi();
  closeAccessPop();
  if (level === 'full') toast('完全访问权限：不再询问，可读写任意文件并联网');
}

function positionAccessPop() {
  const anchor = dom.composer ?? dom.accessBtn;
  if (!anchor || !dom.accessPop) return;
  const r = anchor.getBoundingClientRect();
  const pop = dom.accessPop;
  pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 10));
  let top = r.top - ph - 10;
  if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - ph - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function openAccessPop() {
  if (!dom.accessPop) return;
  closeMenu();
  dom.accessPop.hidden = false;
  applyAccessUi();
  positionAccessPop();
}

function closeAccessPop() {
  if (dom.accessPop) dom.accessPop.hidden = true;
}

function effortLabel(e) {
  return ({ low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '极限' })[e] ?? (e || '思考');
}

function isNearBottom() {
  const el = dom.scroll;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}
/** Optimistic echo of the message being sent: the RPC round trip must not be visible. */
function showPendingEcho(text) {
  removePendingEcho();
  const node = document.createElement('div');
  node.className = 'msg msg-user is-pending';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = inlineMd(text).replace(/\n/g, '<br />');
  node.append(bubble);
  dom.messages.append(node);
  state.pendingEcho = node;
  scrollToBottom(true);
  return node;
}

function removePendingEcho() {
  if (state.pendingEcho) {
    state.pendingEcho.remove();
    state.pendingEcho = null;
  }
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    requestAnimationFrame(() => { dom.scroll.scrollTop = dom.scroll.scrollHeight; });
  }
}

// menus
let menuAnchorEl = null;
function closeMenu() { dom.menu.hidden = true; dom.menu.replaceChildren(); dom.menu.classList.remove('is-compact'); menuAnchorEl = null; }
function openMenu(anchor, items, label) {
  // second click on the same chip closes the menu instead of rebuilding it
  if (menuAnchorEl === anchor && !dom.menu.hidden) { closeMenu(); return; }
  closeMenu();
  menuAnchorEl = anchor;
  const rect = anchor.getBoundingClientRect();
  if (label) {
    const l = document.createElement('div');
    l.className = 'menu-label';
    l.textContent = label;
    dom.menu.append(l);
  }
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (it.selected ? ' is-selected' : '');
    b.textContent = it.label;
    if (it.hint) {
      const s = document.createElement('small');
      s.textContent = it.hint;
      b.append(s);
    }
    b.addEventListener('click', () => { it.onSelect(); closeMenu(); });
    dom.menu.append(b);
  }
  dom.menu.hidden = false;
  const mw = dom.menu.offsetWidth, mh = dom.menu.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - mw - 10);
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 10) top = Math.max(10, rect.top - mh - 6);
  dom.menu.style.left = `${Math.max(8, left)}px`;
  dom.menu.style.top = `${top}px`;
}

function openModelMenu() {
  const items = state.models.map((m) => ({
    label: m.displayName ?? m.id ?? m.model,
    hint: m.description ? '' : '',
    selected: (m.id ?? m.model) === state.model,
    onSelect: () => {
      state.model = m.id ?? m.model;
      const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
      if (efforts.length && !efforts.includes(state.effort)) state.effort = m.defaultReasoningEffort ?? efforts[0];
      if (!(m.serviceTiers ?? []).length) state.fast = false;
      updateModelLabels();
    },
  }));
  if (!items.length) items.push({ label: '暂无模型', onSelect: () => {} });
  // anchor to the visible merged chip: #modeModel sits inside the popover, which is hidden by now
  openMenu(dom.effortBtn, items, '选择模型');
}

// Ordered lowest -> highest; only levels the model actually supports are shown.
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function effortLevels() {
  const m = state.models.find((x) => (x.id ?? x.model) === state.model);
  const supported = (m?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  const list = EFFORT_ORDER.filter((e) => !supported.length || supported.includes(e));
  return list.length ? list : ['low', 'medium', 'high'];
}

function setEffort(level, { close = false } = {}) {
  state.effort = level;
  updateModelLabels();
  renderModePop();
  if (close) closeModePop();
}

let modePopWired = false;

function renderModePop() {
  if (!dom.modePop || dom.modePop.hidden) return;
  const levels = effortLevels();
  const idx = Math.max(0, levels.indexOf(state.effort));
  dom.modeTitle.textContent = effortLabel(state.effort);
  dom.modeRange.max = String(levels.length - 1);
  dom.modeRange.value = String(idx);
  dom.modeRange.style.setProperty('--pct', `${levels.length > 1 ? (idx / (levels.length - 1)) * 100 : 100}%`);

  const m = state.models.find((x) => (x.id ?? x.model) === state.model);
  dom.modeModelName.textContent = m?.displayName ?? state.model ?? '模型';

  dom.modeDots.replaceChildren();
  dom.modeScale.replaceChildren();
  levels.forEach((lv, i) => {
    const dot = document.createElement('span');
    dot.className = 'mode-dot' + (i <= idx ? ' is-on' : '');
    dot.style.left = `${levels.length > 1 ? (i / (levels.length - 1)) * 100 : 100}%`;
    dom.modeDots.append(dot);

    const tick = document.createElement('span');
    tick.className = 'mode-tick' + (i === idx ? ' is-active' : '');
    tick.textContent = effortLabel(lv);
    dom.modeScale.append(tick);
  });
}

function positionModePop() {
  // anchor to the whole composer so the popover never covers the text field
  const wrap = dom.composer ?? dom.input;
  const r = wrap.getBoundingClientRect();
  const pop = dom.modePop;
  pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 10));
  // prefer above the chip (it sits near the bottom of the screen)
  let top = r.top - ph - 10;
  if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - ph - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function openModePop() {
  if (!dom.modePop) return;
  closeMenu();
  dom.modePop.hidden = false;
  dom.modePop.dataset.open = '1';
  positionModePop();
  renderModePop();
  wireModePop();
  dom.modeRange.focus({ preventScroll: true });
}

function closeModePop() {
  if (!dom.modePop) return;
  dom.modePop.hidden = true;
  delete dom.modePop.dataset.open;
}

function wireModePop() {
  if (modePopWired) return;
  modePopWired = true;
  dom.modeRange.addEventListener('input', () => {
    const levels = effortLevels();
    setEffort(levels[Number(dom.modeRange.value)] ?? state.effort);
  });
  dom.modeRange.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeModePop(); }
  });
  dom.modeReset.addEventListener('click', () => {
    const m = state.models.find((x) => (x.id ?? x.model) === state.model);
    setEffort(m?.defaultReasoningEffort ?? effortLevels()[0]);
  });
  dom.modeModel.addEventListener('click', () => {
    closeModePop();
    openModelMenu();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!dom.modePop || dom.modePop.hidden) return;
    if (dom.modePop.contains(e.target) || dom.effortBtn.contains(e.target)) return;
    closeModePop();
  }, true);
  window.addEventListener('resize', () => { if (!dom.modePop.hidden) positionModePop(); });
}

// drawer
function openDrawer() { dom.sidebar.classList.add('is-open'); dom.overlay.hidden = false; }
function closeDrawer() { dom.sidebar.classList.remove('is-open'); dom.overlay.hidden = true; }

// theme

// ---------------------------------------------------------------- usage ball
// Outer ring = 5h window, inner ring = weekly window, centre = countdown to the next
// 5h reset. Everything is driven by state.quota so the panel and the ball never disagree.
const QB_OUTER_C = 2 * Math.PI * 24;
const QB_INNER_C = 2 * Math.PI * 16;

function fmtCountdown(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = Math.floor(secs % 60);
  // Far out: hours are what matters ("4h32"). Inside the hour: show seconds so the
  // countdown is visibly live ("32:15").
  if (h > 0) return h + "h" + String(m).padStart(2, "0");
  return m + ":" + String(sec).padStart(2, "0");
}

function quotaBallInfo() {
  const q = state.quota;
  const used = Math.max(0, Math.min(100, Number(q?.used ?? 0)));
  const weekUsed = Math.max(0, Math.min(100, Number(q?.weeklyUsed ?? 0)));
  // The rings show what is LEFT, so a fresh window draws a full circle and spending
  // drains it — the opposite of "used" would read as a filling progress bar.
  const five = Math.round((100 - used) * 10) / 10;
  const week = Math.round((100 - weekUsed) * 10) / 10;
  const left = q?.resetAt ? Math.max(0, q.resetAt - Math.floor(Date.now() / 1000)) : null;
  return { five, week, used, weekUsed, left, blocked: Boolean(q?.blocked), plan: q?.plan ?? null };
}

function renderQuotaBall() {
  const ball = dom.quotaBall;
  if (!ball) return;
  const info = quotaBallInfo();
  const has = state.quota && (info.five > 0 || info.week > 0 || state.quota.resetAt || info.blocked);
  ball.hidden = !has;
  if (!has) return;

  const outer = ball.querySelector(".qb-arc-outer");
  const inner = ball.querySelector(".qb-arc-inner");
  if (outer) {
    outer.style.setProperty("--c", QB_OUTER_C.toFixed(2));
    outer.style.strokeDashoffset = (QB_OUTER_C * (1 - info.five / 100)).toFixed(2);
  }
  if (inner) {
    inner.style.setProperty("--c", QB_INNER_C.toFixed(2));
    inner.style.strokeDashoffset = (QB_INNER_C * (1 - info.week / 100)).toFixed(2);
  }
  // Remaining-based thresholds: amber under 30% left, red under 10%, blocked at 0.
  ball.classList.toggle("is-warn", info.five <= 30 && info.five > 10);
  ball.classList.toggle("is-danger", info.five <= 10);
  ball.classList.toggle("week-warn", info.week <= 30 && info.week > 10);
  ball.classList.toggle("week-danger", info.week <= 10);
  ball.classList.toggle("is-blocked", info.blocked || info.five <= 0);

  const timeEl = ball.querySelector(".qb-time");
  if (timeEl) timeEl.textContent = info.left == null ? "--" : fmtCountdown(info.left);

  // Any real change (not the 1s countdown tick) gets a short glow so the update is seen.
  const prev = state.quotaBallPrev;
  if (prev && (prev.five !== info.five || prev.week !== info.week || prev.blocked !== info.blocked)) {
    ball.classList.remove("is-flash");
    void ball.offsetWidth;
    ball.classList.add("is-flash");
    setTimeout(() => ball.classList.remove("is-flash"), 800);
  }
  state.quotaBallPrev = { five: info.five, week: info.week, blocked: info.blocked };
  const title = "5 小时剩余 " + Math.round(info.five) + "% · 每周剩余 " + Math.round(info.week) + "%"
    + (info.left == null ? "" : " · " + fmtCountdown(info.left) + " 后重置")
    + (info.plan ? " · " + info.plan : "");
  ball.title = title;
  ball.setAttribute("aria-label", "用量：" + title);
}

function syncBallPosition() {
  const c = dom.composer?.getBoundingClientRect();
  if (!c) return;
  const gap = 14;
  const bottom = Math.max(72, Math.round(window.innerHeight - c.top + gap));
  document.documentElement.style.setProperty("--ball-bottom", bottom + "px");
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('codex-remote-theme', theme);
  dom.themeBtn.querySelector('use').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0F0F10' : '#F6F6F6');
}

// ---------------------------------------------------------------- auth / boot
async function checkAuth() {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  const data = await res.json();
  state.defaultCwd = data.defaultCwd || '';
  return data.authed === true;
}

function showLogin() {
  dom.login.hidden = false;
  dom.app.hidden = true;
  document.documentElement.classList.add('is-ready'); // drop the boot splash
  dom.passcode.focus();
}

function showApp() {
  dom.login.hidden = true;
  dom.app.hidden = false;
  document.documentElement.classList.add('is-ready'); // drop the boot splash
  dom.cwdChip.textContent = shortPath(state.defaultCwd);
}

async function boot() {
  applyTheme(localStorage.getItem('codex-remote-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  // Pairing link: ?t=<passcode> authenticates once, then the token is stripped
  // from the address bar so it does not linger in history or screenshots.
  const token = new URL(location.href).searchParams.get('t');
  if (token) {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passcode: token }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        const url = new URL(location.href);
        url.searchParams.delete('t');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    } catch { /* fall through to the login screen */ }
  }

  const authed = await checkAuth().catch(() => false);
  if (!authed) { showLogin(); return; }
  showApp();
  renderStream();
  renderThreadList();
  rpc.connect();
  // Only now is the session cookie in place, otherwise the SSE endpoint answers 401.

  syncDesktopCatalog(true);
}

dom.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  dom.loginError.textContent = '';
  dom.loginBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: dom.passcode.value }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const map = {
        'wrong passcode': '密码错误',
        'too many attempts, wait 5 minutes': '尝试次数过多，请 5 分钟后再试',
      };
      dom.loginError.textContent = map[data.error] || data.error || '密码错误';
      return;
    }
    showApp();
    rpc.connect();
  
  } catch (err) {
    dom.loginError.textContent = '无法连接桥接服务';
  } finally {
    dom.loginBtn.disabled = false;
  }
});

dom.input.addEventListener('input', () => { autoGrow(); updateSendState(); onInputChanged(); });
dom.input.addEventListener('keydown', (e) => {
  const slashOpen = dom.slashMenu && !dom.slashMenu.hidden;
  if (slashOpen) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = slashItems.length;
      if (n) {
        slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        [...dom.slashMenu.children].forEach((el, i) => el.classList.toggle('is-active', i === slashIndex));
      }
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickSkill(slashIndex);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); hideSlash(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    app.send();
  }
});
dom.sendBtn.addEventListener('click', () => app.send());
dom.stopBtn.addEventListener('click', () => app.stop());
dom.newChatBtn.addEventListener('click', () => app.newChat());
dom.projectBtn?.addEventListener('click', openProjectPicker);

// ---------------------------------------------------------------- batch buttons
dom.selectBtn?.addEventListener('click', () => setSelectionMode(!selectionMode()));
document.querySelector('#bulkCancel')?.addEventListener('click', () => setSelectionMode(false));
document.querySelector('#bulkAll')?.addEventListener('click', () => {
  if (!state.selection) return;
  for (const t of state.threads) state.selection.add(t.id);
  renderThreadList();
  renderBulkBar();
});
document.querySelector('#bulkArchive')?.addEventListener('click', () => void doBulkArchive());
document.querySelector('#bulkDelete')?.addEventListener('click', () => void doBulkDelete());
document.querySelector('#bulkMove')?.addEventListener('click', () => doBulkMove());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectionMode()) { setSelectionMode(false); }
});

if (dom.modeSwitch) {
  dom.modeSwitch.addEventListener('click', (e) => {
    const seg = e.target.closest('.ms-seg');
    if (seg) setMode(seg.dataset.mode);
  });
  dom.modeSwitch.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const order = ['default', 'plan', 'target'];
    const cur = state.planMode ? 'plan' : state.goalMode ? 'target' : 'default';
    const i = order.indexOf(cur);
    const nextIdx = (i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length;
    setMode(order[nextIdx]);
    dom.modeSwitch.querySelector('.ms-seg.is-active')?.focus();
  });
  renderModeSwitch();
}
dom.newThreadBtn?.addEventListener('click', () => app.newChat());
// merged into #effortBtn: model switching now lives inside the effort popover

// ---- access / approval picker
dom.accessBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (dom.accessPop.hidden) { closeModePop(); openAccessPop(); } else closeAccessPop();
});
dom.accessPop?.querySelectorAll('[data-access]').forEach((btn) => {
  btn.addEventListener('click', () => setAccess(btn.dataset.access));
});
document.addEventListener('pointerdown', (e) => {
  if (!dom.accessPop || dom.accessPop.hidden) return;
  if (dom.accessPop.contains(e.target) || dom.accessBtn.contains(e.target)) return;
  closeAccessPop();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dom.accessPop && !dom.accessPop.hidden) { e.preventDefault(); closeAccessPop(); }
});
window.addEventListener('resize', () => { if (dom.accessPop && !dom.accessPop.hidden) positionAccessPop(); });
applyAccessUi();
dom.modeBolt?.addEventListener('click', () => {
  const tier = currentServiceTier();
  if (!tier) { toast('当前模型不支持加速档'); return; }
  state.fast = !state.fast;
  try { localStorage.setItem('codex-remote-fast', state.fast ? '1' : '0'); } catch { /* quota */ }
  updateFastUi();
  toast(state.fast ? `已开启 ${tier.name}（${tier.description ?? ''}）` : '已关闭加速档');
});
dom.effortBtn.addEventListener('click', () => {
  if (!dom.modePop.hidden) closeModePop();
  else openModePop();
});
dom.drawerBtn.addEventListener('click', openDrawer);
for (const b of document.querySelectorAll('.rail-btn[data-rail]')) {
  b.addEventListener('click', () => {
    const rail = b.dataset.rail;
    setRailActive(rail);
    if (rail === 'home') { closePanel(); app.newChat(); }
    else if (rail === 'tools') openToolsPanel();
    else if (rail === 'files') openFilesPanel();
    else if (rail === 'usage') openUsagePanel();
    else if (rail === 'net') openNetworkPanel();
  });
}
dom.panelClose?.addEventListener('click', closePanel);
dom.overlay.addEventListener('click', closeDrawer);
dom.themeBtn.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
dom.searchBtn.addEventListener('click', () => {
  dom.searchBox.hidden = !dom.searchBox.hidden;
  if (!dom.searchBox.hidden) dom.searchInput.focus();
});
dom.searchInput.addEventListener('input', () => { state.search = dom.searchInput.value; renderThreadList(); });
dom.bellBtn.addEventListener('click', () => toast('通知：远程任务会在浏览器里提示'));
document.addEventListener('click', (e) => {
  // #modeModel lives inside the effort popover and opens the model menu; the click that
  // opens it must not immediately close it again.
  if (!dom.menu.hidden && !dom.menu.contains(e.target) && !e.target.closest('.chip') && !e.target.closest('.bulk-bar') && !e.target.closest('.proj-pick') && !e.target.closest('.proj-target') && !e.target.closest('.mode-model')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); closeDrawer(); closePanel(); closeModePop(); }
});

// Older history is fetched on demand when the user scrolls to the top.
dom.scroll.addEventListener('scroll', () => {
  if (dom.scroll.scrollTop < 120) app.loadOlderHistory();
}, { passive: true });

// ================================================================ attachments
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|heic|heif|svg)$/i;

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function uploadOne(file) {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name || 'upload.bin'),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `上传失败 (${res.status})`);
  return {
    name: data.name,
    path: data.path,
    size: data.size,
    isImage: IMAGE_EXT.test(data.name) || /^image\//.test(file.type || ''),
  };
}

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  let ok = 0;
  for (const f of files) {
    try {
      const a = await uploadOne(f);
      state.attachments.push(a);
      touchFile(a.path, a.name);
      ok += 1;
    } catch (e) {
      toast(`${f.name}：${e.message}`, 4000);
    }
  }
  renderAttachments();
  if (ok) toast(`已添加 ${ok} 个文件（已保存到这台电脑）`);
}

function renderAttachments() {
  const list = state.attachments;
  if (!dom.attachments) return;
  if (!list.length && !state.skillPick) {
    dom.attachments.hidden = true;
    dom.attachments.replaceChildren();
    updateSendState();
    return;
  }
  dom.attachments.hidden = false;
  const frag = document.createDocumentFragment();
  queueMicrotask(() => updateSendState());

  if (state.skillPick) {
    const chip = document.createElement('span');
    chip.className = 'att-chip skill';
    chip.innerHTML = `<svg><use href="#i-sparkle"/></svg><span></span>`;
    chip.querySelector('span').textContent = `/ ${state.skillPick.name}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'att-x';
    x.innerHTML = '<svg><use href="#i-close"/></svg>';
    x.addEventListener('click', () => { state.skillPick = null; renderAttachments(); });
    chip.append(x);
    frag.append(chip);
  }


  for (const a of list) {
    const chip = document.createElement('span');
    chip.className = 'att-chip';
    const icon = a.isImage ? '#i-file' : '#i-attach';
    chip.innerHTML = `<svg><use href="${icon}"/></svg><span class="att-name"></span><span class="att-size"></span>`;
    chip.querySelector('.att-name').textContent = a.name;
    chip.querySelector('.att-size').textContent = fmtSize(a.size);
    chip.addEventListener('click', (e) => {
      if (e.target.closest('.att-x')) return;
      openFilePanel(a.path, a.name);
    });
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'att-x';
    x.innerHTML = '<svg><use href="#i-close"/></svg>';
    x.addEventListener('click', () => {
      state.attachments = state.attachments.filter((z) => z !== a);
      renderAttachments();
    });
    chip.append(x);
    frag.append(chip);
  }
  dom.attachments.replaceChildren(frag);
}

// drag & drop (desktop) + file picker (iPad: Photos / Camera / Files)
let dragDepth = 0;
let dragWatchdog = null;
function hideDropOverlay() {
  dragDepth = 0;
  if (dragWatchdog) { clearTimeout(dragWatchdog); dragWatchdog = null; }
  if (dom.dropOverlay) dom.dropOverlay.hidden = true;
}
function armDropWatchdog() {
  // dragleave can arrive without dataTransfer, or never arrive if the cursor leaves
  // the window fast — which used to leave a full-screen overlay stuck over the UI.
  if (dragWatchdog) clearTimeout(dragWatchdog);
  dragWatchdog = setTimeout(hideDropOverlay, 2000);
}
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth += 1;
  if (dom.dropOverlay) dom.dropOverlay.hidden = false;
  armDropWatchdog();
});
window.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  armDropWatchdog();
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !e.dataTransfer) { hideDropOverlay(); return; }
  if (![...(e.dataTransfer.types || [])].includes('Files')) { hideDropOverlay(); return; }
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) hideDropOverlay();
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  hideDropOverlay();
  addFiles(e.dataTransfer.files);
});
window.addEventListener('dragend', hideDropOverlay);
window.addEventListener('blur', hideDropOverlay);

// One picker for everything local: on iOS and Android an input without `capture`
// offers camera + photo library + files, which covers "拍照上传" and "选文件" at once.
const FILE_MODES = [
  { label: '拍照 / 选文件', accept: '*/*' },
];
function pickFiles(mode) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (mode.accept) input.setAttribute('accept', mode.accept);
  if (mode.capture) input.setAttribute('capture', mode.capture);
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.append(input);
  input.addEventListener('change', () => {
    const files = input.files;
    input.remove();
    if (files?.length) addFiles(files);
  });
  input.click();
}

const WX_HELP = [
  ['iPhone / iPad', [
    '微信里打开文件 → 右上角 ⋯ → 「用其他应用打开」或「存储到"文件"」',
    '回到网页点回形针 → 「拍照 / 选文件」',
    '在「文件」App 里选 我的 iPhone → 微信，或点「最近项目」',
  ]],
  ['Android', [
    '微信里长按文件 → 「保存到手机」，或「用其他应用打开」时选浏览器',
    '回到网页点回形针 → 「拍照 / 选文件」',
    '在系统文件选择器里进 内部存储 → tencent → MicroMsg → Download',
  ]],
  ['微信内置浏览器', [
    '微信自己的 WebView 不允许网页读取聊天文件，这是沙箱限制，不是网页的问题',
    '点右上角 ⋯ → 「在浏览器打开」，再用上面的步骤操作',
  ]],
];

let wxCardTimer = null;

function stopWxCard() {
  if (wxCardTimer) { clearInterval(wxCardTimer); wxCardTimer = null; }
}


// Files already received in WeChat on this PC. The phone only has to forward the
// file to 文件传输助手; a second later it shows up here and attaches in one tap.
// ---------------------------------------------------------------- wechat send job
// Long uploads used to hold the fetch open; iOS Safari aborts those ("Load failed").
// The bridge now returns a job id immediately, so we poll.


// ------------------------------------------------ wechat auto-mount
const WX_AUTO_KEY = 'codex-remote-wx-auto';
const WX_ALL_KEY = 'codex-remote-wx-all'; // also mount downloads that aren't from WeChat
const WX_SEEN_KEY = 'codex-remote-wx-seen';

function wxAutoEnabled() {
  return localStorage.getItem(WX_AUTO_KEY) !== '0';
}

function wxAllDownloadsEnabled() {
  return localStorage.getItem(WX_ALL_KEY) === '1';
}

/** Which arrivals may attach by themselves. WeChat's web transfer page lands in
 *  Downloads; the browser history tells us those apart from ordinary downloads. */
function wxShouldAutoAttach(file) {
  if (!wxAutoEnabled()) return false;
  // the bridge labels WeChat-sourced arrivals 'weixin'; older paths used 'wechat'
  if (file.source === 'wechat' || file.source === 'weixin') return true;
  if (file.source === 'download') {
    return file.origin === 'weixin' || wxAllDownloadsEnabled();
  }
  return false; // unknown source: never surprise the user
}

function wxSeen() {
  try { return JSON.parse(localStorage.getItem(WX_SEEN_KEY) || '{}') || {}; } catch { return {}; }
}

function wxMarkSeen(path, mtime) {
  const seen = wxSeen();
  seen[path] = mtime;
  const keys = Object.keys(seen);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete seen[k];
  try { localStorage.setItem(WX_SEEN_KEY, JSON.stringify(seen)); } catch { /* quota */ }
}

const CLAW_SEEN_KEY = "codex-remote-claw-seen";
let clawFilesCache = [];
let clawFilesAt = 0;

function clawSeen() {
  try { return JSON.parse(localStorage.getItem(CLAW_SEEN_KEY) || "{}"); } catch { return {}; }
}

function clawMarkSeen(path, at) {
  const seen = clawSeen();
  seen[path] = at;
  localStorage.setItem(CLAW_SEEN_KEY, JSON.stringify(seen));
}

/** Files ClawBot received into <cwd>/媒体 for the conversation that is open now. */
async function clawFiles(force = false) {
  if (!force && Date.now() - clawFilesAt < 6000) return clawFilesCache;
  const cwd = state.currentCwd || state.defaultCwd || "";
  try {
    const r = await fetch("/api/claw/files?cwd=" + encodeURIComponent(cwd), { credentials: "same-origin" }).then((x) => x.json());
    clawFilesCache = r?.files ?? [];
  } catch { clawFilesCache = []; }
  clawFilesAt = Date.now();
  return clawFilesCache;
}

/** New arrivals mount themselves, the way downloads used to. */
async function clawAutoMount() {
  const files = await clawFiles(true);
  const seen = clawSeen();
  for (const f of files) {
    if (seen[f.path] === f.at) continue;
    clawMarkSeen(f.path, f.at);
    if (state.attachments.some((a) => a.path === f.path)) continue;
    const isImage = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name);
    state.attachments.push({ name: f.name, path: f.path, size: f.size, isImage });
    touchFile(f.path, f.name);
    if (typeof renderAttachments === "function") renderAttachments();
    toast("微信收到 " + f.name + "，已挂载", 3800);
  }
}

async function openClawFiles() {
  const files = await clawFiles(true);
  if (!files.length) { toast("微信还没收到文件：在微信里发给机器人即可"); return; }
  const items = files.slice(0, 12).map((f) => ({
    label: f.name + " · " + fmtSize(f.size),
    onSelect: async () => {
      if (state.attachments.some((a) => a.path === f.path)) { toast(f.name + " 已经在挂载列表里"); return; }
      const isImage = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name);
      state.attachments.push({ name: f.name, path: f.path, size: f.size, isImage });
      touchFile(f.path, f.name);
      renderAttachments();
      toast("已挂载 " + f.name);
    },
  }));
  const r = dom.attachBtn.getBoundingClientRect();
  openMenuAt(r.left, r.top - 8 - items.length * 34, items, "微信收到的文件");
}

function wxAutoAttach(file) {
  if (!file?.path || !file?.name) return;
  if (!wxShouldAutoAttach(file)) return;
  const seen = wxSeen();
  if (seen[file.path] === file.mtime) return;
  if (state.attachments.some((a) => a.path === file.path)) { wxMarkSeen(file.path, file.mtime); return; }
  const isImage = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name);
  state.attachments.push({ name: file.name, path: file.path, size: file.size, isImage });
  wxMarkSeen(file.path, file.mtime);
  touchFile(file.path, file.name);
  renderAttachments();
  const where = file.source === 'wechat' ? '微信收到' : '下载完成';
  toast(`${where} ${file.name}，已自动挂载`, 3800);
}

let wxStream = null;

function openWechatHelp() {
  openPanel('从微信取文件');
  const body = dom.panelBody;
  body.replaceChildren();
  for (const [title, steps] of WX_HELP) {
    const h = document.createElement('h3');
    h.className = 'help-title';
    h.textContent = title;
    body.append(h);
    const ol = document.createElement('ol');
    ol.className = 'help-steps';
    for (const s of steps) {
      const li = document.createElement('li');
      li.textContent = s;
      ol.append(li);
    }
    body.append(ol);
  }
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = '选中的文件会先上传到这台电脑（%TEMP%\codex-remote），再作为附件随下一条消息发出。';
  body.append(p);
}

function openAttachMenu() {
  const r = dom.attachBtn.getBoundingClientRect();
  const items = FILE_MODES.map((m) => ({ label: m.label, onSelect: () => pickFiles(m) }));
  items.push({ label: '微信收到的文件（ClawBot）', onSelect: openClawFiles });
  openMenuAt(r.left, r.top - 8 - items.length * 34, items, '添加文件');
}

dom.attachBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  // Same menu everywhere: the three accept/capture combinations matter on phones,
  // and on desktop the third entry is still the fastest way to a real file.
  openAttachMenu();
});

dom.input?.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});


// ---------------------------------------------------------------- session expiry
// The cookie lives 30 days, but it can still be revoked (new passcode, cleared data).
// One interception beats sprinkling 401 checks through every call site.
(() => {
  const raw = window.fetch.bind(window);
  let fired = false;
  window.fetch = async (input, init) => {
    const res = await raw(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (res.status === 401 && /\/api\//.test(url) && !/\/api\/(login|me)\b/.test(url) && !fired) {
      fired = true;
      toast('登录已过期，请重新输入密码', 6000);
      showLogin();
    }
    return res;
  };
})();
// ================================================================ viewer
const VIEWER_IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const VIEWER_TEXT = /\.(txt|md|log|csv|json|js|mjs|ts|tsx|jsx|css|html|xml|yml|yaml|toml|ini|ps1|cmd|bat|sh|py|rs|go|java|c|h|cpp|sql|geojson|topojson|gpx|kml)$/i;
const VIEWER_VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const VIEWER_AUDIO = /\.(mp3|wav|m4a|ogg|flac|aac)$/i;
const VIEWER_PDF = /\.pdf$/i;
const VIEWER_OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;

function fileUrl(p) { return `/api/file?path=${encodeURIComponent(p)}`; }

// Files are previewed in the same right-hand dock the sidebar panels use.
const DOCK_MD = /\.(md|markdown|mdx)$/i;
const DOCK_HTML = /\.(html?|htm)$/i;

function dockToolbar(fields) {
  const bar = document.createElement('div');
  bar.className = 'dock-toolbar';
  for (const f of fields) bar.append(f);
  return bar;
}

function dockTabButton(label, active, onSelect) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `dock-tab${active ? ' is-active' : ''}`;
  b.textContent = label;
  b.addEventListener('click', onSelect);
  return b;
}

async function fetchText(src) {
  const res = await fetch(src, { headers: { range: 'bytes=0-524287' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function openFilePanel(target, name) {
  // Models sometimes wrap destinations in <...> or quote them, and older messages may
  // still carry the raw token; normalise before touching the filesystem.
  target = String(target ?? '')
    .trim()
    .replace(/^[<"'\u201c\u2018]+/, '')
    .replace(/[>"'\u201d\u2019]+$/, '')
    .replace(/^file:\/\/\/?/i, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
  if (!target) return;
  // "@attachments/a.md" and "outputs/x/REPORT.md" are relative to the thread's cwd.
  // Without this the bridge resolved them against its own directory and returned 404.
  target = target.replace(/^@+/, '');
  // Imports land in <cwd>/.attachments, and messages refer to them as @attachments/x.
  if (/^attachments[\\/]/.test(target)) target = '.attachments/' + target.replace(/^attachments[\\/]/, '');
  const isAbs = /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\\\');
  if (!/^https?:/i.test(target) && !isAbs) {
    const base = state.currentCwd || state.defaultCwd || '';
    if (base) target = base.replace(/[\\/]+$/, '') + '/' + target.replace(/^\.\//, '');
  }
  touchFile(target, name);
  const isRemote = /^https?:/i.test(target);
  const src = isRemote ? target : fileUrl(target);
  // always the real file name: a chip's text is prose (打开...) and would save without an extension
  const label = baseName(target);
  openPanel(label);

  const body = dom.panelBody;
  body.replaceChildren();

  const download = document.createElement('a');
  download.className = 'icon-btn dock-save';
  download.title = '保存到本机';
  download.setAttribute('aria-label', '保存到本机');
  download.innerHTML = '<svg aria-hidden="true"><use href="#i-save"/></svg>';
  download.href = isRemote ? target : `${fileUrl(target)}&download=1`;
  download.setAttribute('download', label);   // basename only: a full path becomes C__CHAT_…
  // Track it: a 60MB file with no visible progress feels broken on a tablet. The list is
  // opened right away so the progress row appears without hunting for it.
  download.addEventListener('click', (e) => {
    e.preventDefault();
    openFilesPanel().catch(() => {});
    saveFileWithProgress(target, label);
  });
  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  // send the same file to the WeChat file-transfer assistant
  const wxBtn = document.createElement('button');
  wxBtn.type = 'button';
  wxBtn.className = 'icon-btn dock-wx';
  wxBtn.title = "发送到微信" + (localStorage.getItem(CLAW_TARGET_KEY) ? "" : "");
  wxBtn.setAttribute('aria-label', '发送到微信');
  wxBtn.innerHTML = '<svg aria-hidden="true"><use href="#i-wechat"/></svg>';
  const LARGE_FILE = 5 * 1024 * 1024;

  const sendAsFile = async () => {
    // Which WeChat first: asking after the transfer row appears leaves a ghost entry
    // behind when the user backs out of the menu.
    const st0 = await clawStatus();
    if (!st0?.loggedIn) {
      toast("还没有绑定 ClawBot：网络面板 → ClawBot → 扫码绑定", 5000);
      closePanel();
      document.querySelector('[data-rail="net"]')?.click();
      return;
    }
    const accountId = await pickClawTarget();
    if (!accountId) return;

    wxBtn.disabled = true;
    wxBtn.classList.add("is-busy");
    const tid = addTransfer({ kind: "wechat", name: label, path: target, size: 0 });
    toast("正在发到微信…", 3000);
    try {
      const r = await clawSend({ file: target, text: label, accountId }, (job) => {
        if (job?.state === "done") patchTransfer(tid, { loaded: 1, total: 1 });
      });
      endTransfer(tid, { ok: Boolean(r.ok), error: r.error });
      if (r.ok) toast("已发到微信：" + label, 4000);
      else if (r.queued) toast(r.error, 5000);
      else toast("发送失败：" + (r.error || "未知错误"), 5000, { action: { label: "重试", onSelect: () => sendAsFile() } });
    } catch (e) {
      const msg = e && /Load failed|Failed to fetch|NetworkError/i.test(e.message) ? "网络中断或请求超时" : e.message;
      endTransfer(tid, { ok: false, error: msg });
      toast("发送失败：" + msg, 5000, { action: { label: "重试", onSelect: () => sendAsFile() } });
    } finally {
      wxBtn.disabled = false;
      wxBtn.classList.remove("is-busy");
    }
  };
;

  const sendLink = async (url) => {
    wxBtn.disabled = true;
    wxBtn.classList.add("is-busy");
    const lid = addTransfer({ kind: "wechat", name: label + "（链接）", path: target, size: 0 });
    toast("正在发送下载链接…", 3000);
    try {
      const accountId = await pickClawTarget();
      const r = await clawSend({ text: label + "\n" + url, accountId });
      endTransfer(lid, { ok: Boolean(r.ok), error: r.error });
      if (r.ok) toast("已把下载链接发到微信：" + url, 6000);
      else toast("发链接失败：" + (r.error || "未知错误"));
    } catch (e) {
      toast("发链接失败：" + e.message);
    } finally {
      wxBtn.disabled = false;
      wxBtn.classList.remove("is-busy");
    }
  };

  // One path only: upload the file itself. The old "link or file?" menu made the click
  // feel broken and the link route is not what people expect from 发送到微信.
  const wxSend = async () => {
    if (wxBtn.disabled) return;
    await sendAsFile();
  };
  wxBtn.addEventListener('click', wxSend);
  if (state.wxAutoSend) {
    download.addEventListener('click', () => { wxSend(); });
  }

  // ---- pdf / office: render every page as an image (inline PDF viewers are a no-op
  //      on mobile Chrome/Safari, so this is the only reliable cross-device preview)
  if (!isRemote && (VIEWER_PDF.test(target) || VIEWER_OFFICE.test(target))) {
    const body2 = dom.panelBody;
    void body2;
    renderDocumentPages(body, target, label, [spacer, wxBtn, download]);
    return;
  }
  // ---- image
  if (isRemote || VIEWER_IMAGE.test(target)) {
    body.append(dockToolbar([spacer, wxBtn, download]));
    const wrap = document.createElement('div');
    wrap.className = 'dock-doc';
    const img = document.createElement('img');
    img.src = src;
    img.alt = label;
    img.className = 'dock-media';
    img.addEventListener('error', () => { wrap.innerHTML = '<p class="muted">无法预览这个文件</p>'; });
    wrap.append(img);
    body.append(wrap);
    return;
  }

  // ---- video / audio
  if (VIEWER_VIDEO.test(target) || VIEWER_AUDIO.test(target)) {
    body.append(dockToolbar([spacer, wxBtn, download]));
    const wrap = document.createElement('div');
    wrap.className = 'dock-doc';
    const el = document.createElement(VIEWER_VIDEO.test(target) ? 'video' : 'audio');
    el.src = src;
    el.controls = true;
    el.className = 'dock-media';
    wrap.append(el);
    body.append(wrap);
    return;
  }

  // ---- markdown / html / source
  if (VIEWER_TEXT.test(target)) {
    const wantsMd = DOCK_MD.test(target);
    const wantsHtml = DOCK_HTML.test(target);
    let mode = wantsHtml ? 'preview' : (wantsMd ? 'preview' : 'source');
    let text = '';

    const previewBtn = dockTabButton('预览', mode === 'preview', () => { mode = 'preview'; paint(); });
    const sourceBtn = dockTabButton('源码', mode === 'source', () => { mode = 'source'; paint(); });
    const tabs = (wantsMd || wantsHtml) ? [previewBtn, sourceBtn] : [];
    body.append(dockToolbar([...tabs, spacer, wxBtn, download]));

    const view = document.createElement('div');
    view.className = 'dock-doc';
    view.textContent = '读取中…';
    body.append(view);

    const paint = () => {
      previewBtn.classList.toggle('is-active', mode === 'preview');
      sourceBtn.classList.toggle('is-active', mode === 'source');
      view.replaceChildren();
      view.className = mode === 'source' ? '' : 'dock-doc';

      if (mode === 'preview' && wantsMd) {
        const prose = document.createElement('div');
        prose.className = 'prose';
        prose.innerHTML = md(text);
        view.append(prose);
        return;
      }
      if (mode === 'preview' && wantsHtml) {
        // sandbox: markup and CSS render, scripts and same-origin access do not.
        const frame = document.createElement('iframe');
        frame.className = 'dock-html-frame';
        frame.setAttribute('sandbox', '');
        frame.style.height = '58vh';
        frame.srcdoc = text;
        view.append(frame);
        const note = document.createElement('p');
        note.className = 'muted';
        note.style.padding = '0 16px 12px';
        note.textContent = '预览在隔离沙箱里运行（脚本与本站存储不可访问）；依赖外部 JS/资源的页面可能显示为空白，可切到「源码」。';
        view.style.display = 'block';
        view.style.overflow = 'auto';
        view.append(note);
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'dock-code';
      pre.textContent = text;
      view.append(pre);
    };

    try {
      text = await fetchText(src);
    } catch (e) {
      view.textContent = /HTTP 404/.test(e.message)
        ? `找不到这个文件：${target}\n（相对路径会按当前会话的工作目录解析）`
        : `读取失败：${e.message}`;
      return;
    }
    paint();
    return;
  }

  // ---- unknown binary: card with type/size + save button
  body.append(dockToolbar([spacer, wxBtn, download]));
  const card = document.createElement('div');
  card.className = 'dock-fallback';
  const icon = document.createElement('div');
  icon.className = 'dock-fallback-ico';
  icon.innerHTML = '<svg aria-hidden="true"><use href="#i-file"/></svg>';
  const info = document.createElement('div');
  info.className = 'dock-fallback-text';
  const ext = (String(target).match(/\.([a-z0-9]+)$/i)?.[1] || '文件').toUpperCase();
  const title = document.createElement('b');
  title.textContent = label;
  const sub = document.createElement('span');
  sub.textContent = `${ext} 文件 · 这个类型还不能在线预览，点右上角图标保存后打开`;
  info.append(title, sub);
  card.append(icon, info);
  body.append(card);
}



/** Scrollable stack of page images produced by the bridge (PDF + Office). */
async function renderDocumentPages(body, target, label, actions) {
  body.append(dockToolbar(actions));
  const wrap = document.createElement('div');
  wrap.className = 'dock-doc doc-pages-doc';
  const note = document.createElement('p');
  note.className = 'muted dock-note';
  note.textContent = '正在渲染页面（首次约 10-20 秒，之后有缓存）…';
  wrap.append(note);
  body.append(wrap);

  let data = null;
  try {
    data = await fetch(`/api/office-images?path=${encodeURIComponent(target)}`, { credentials: 'same-origin' }).then((r) => r.json());
  } catch (e) {
    note.textContent = '渲染失败：' + e.message;
    return;
  }
  if (!data || !data.ok) {
    note.textContent = '无法预览：' + ((data && data.error) || '未知错误') + '（可以保存后用本机应用打开）';
    return;
  }

  note.textContent = `共 ${data.count} 页 · 逐页渲染`;
  const pages = document.createElement('div');
  pages.className = 'doc-pages';
  data.pages.forEach((url, i) => {
    const fig = document.createElement('figure');
    fig.className = 'doc-page';
    const img = document.createElement('img');
    img.loading = i < 2 ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.src = url;
    img.alt = `${label} 第 ${i + 1} 页`;
    const cap = document.createElement('figcaption');
    cap.textContent = `${i + 1} / ${data.count}`;
    fig.append(img, cap);
    pages.append(fig);
  });
  wrap.append(pages);
}

// Any path/media chip in the transcript opens the viewer.
document.addEventListener('click', (e) => {
  const chip = e.target.closest?.('.path-chip, .img-chip');
  if (!chip) return;
  const target = chip.getAttribute('title') || chip.dataset.target;
  if (target) openFilePanel(target, chip.textContent.trim());
});

// ================================================================ skills (slash)
async function loadSkills() {
  try {
    const params = state.defaultCwd ? { cwds: [state.defaultCwd] } : {};
    const res = await rpc.send('skills/list', params);
    const seen = new Set();
    const flat = [];
    for (const entry of res?.data ?? []) {
      for (const s of entry.skills ?? []) {
        if (s.enabled === false || seen.has(s.name)) continue;
        seen.add(s.name);
        flat.push(s);
      }
    }
    state.skills = flat;
    console.info(`skills: ${flat.length}`);
  } catch (e) {
    console.warn('skills/list failed', e.message);
    state.skills = [];
  }
}

let slashItems = [];
let slashIndex = 0;

function hideSlash() {
  if (dom.slashMenu) dom.slashMenu.hidden = true;
  slashItems = [];
}

function skillLabel(sk) {
  // names coming from skills/list already carry their plugin namespace
  return sk.name;
}

// Codex's own collaboration modes. They live in the slash menu but are NOT skills:
// no plugin, no path, they flip a switch that changes how the turn is executed.
const BUILTIN_MODES = [
  {
    kind: 'mode',
    id: 'plan',
    token: 'plan',
    title: '计划模式',
    desc: '只阅读和规划，先给方案再动手（Codex plan mode）',
    on: (st) => st.planMode,
  },
  {
    kind: 'mode',
    id: 'target',
    token: 'target',
    title: '目标模式',
    desc: '设定目标，Codex 会持续推进直到完成（thread goal）',
    on: (st) => st.goalMode,
  },
];

/** Human-readable state of the two modes, for the chips. */
function modeSummary() {
  const out = [];
  if (state.planMode) out.push('计划模式');
  if (state.goalMode) out.push(state.goalObjective ? '目标：' + state.goalObjective : '目标模式');
  return out;
}

// The token under the caret: "/foo" preceded by start-of-line or whitespace.
function slashContext() {
  const v = dom.input.value;
  const caret = dom.input.selectionStart ?? v.length;
  const before = v.slice(0, caret);
  const m = /(^|\s)\/(\S*)$/.exec(before);
  if (!m) return null;
  return { query: m[2], start: m.index + m[1].length };
}

function renderSlash(query) {
  if (!dom.slashMenu) return;
  const q = (query || '').toLowerCase().trim();

  // Built-in modes come first and are visually separated: they are not skills.
  const modeHits = BUILTIN_MODES.filter((m) => {
    if (!q) return true;
    return m.token.startsWith(q) || m.title.includes(q) || m.desc.toLowerCase().includes(q);
  });

  const scored = [];
  for (const sk of state.skills) {
    const label = skillLabel(sk).toLowerCase();
    const hay = `${sk.name} ${sk.shortDescription ?? ''} ${sk.description ?? ''}`.toLowerCase();
    if (!q) { scored.push({ sk, rank: 2 }); continue; }
    if (label.startsWith(q) || sk.name.toLowerCase().startsWith(q)) scored.push({ sk, rank: 0 });
    else if (label.includes(q)) scored.push({ sk, rank: 1 });
    else if (hay.includes(q)) scored.push({ sk, rank: 3 });
  }
  scored.sort((a, b) => a.rank - b.rank || skillLabel(a.sk).localeCompare(skillLabel(b.sk)));
  const bestRank = scored.length ? scored[0].rank : 9;
  // If the query matches names, do not dilute the list with description-only hits.
  const shown = bestRank <= 1 ? scored.filter((x) => x.rank <= 1) : scored;
  // A mode hit wins over skills when the query looks like one of them.
  const skillSlots = Math.max(0, 12 - modeHits.length);
  slashItems = [
    ...modeHits.map((m) => ({ kind: 'mode', mode: m })),
    ...shown.slice(0, skillSlots).map((x) => ({ kind: 'skill', sk: x.sk })),
  ];
  if (!slashItems.length) { hideSlash(); return; }
  slashIndex = 0;

  const frag = document.createDocumentFragment();
  let lastKind = null;
  slashItems.forEach((entry, idx) => {
    if (entry.kind !== lastKind) {
      lastKind = entry.kind;
      const group = document.createElement('div');
      group.className = 'slash-group';
      group.textContent = entry.kind === 'mode' ? '模式' : '技能与 MCP';
      frag.append(group);
    }
    const isMode = entry.kind === 'mode';
    const item = document.createElement('div');
    item.className = 'slash-row';
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `slash-item${isMode ? ' is-mode' : ''}${idx === 0 ? ' is-active' : ''}`;
    row.innerHTML = `<svg aria-hidden="true"><use href="${isMode ? '#i-bolt' : '#i-sparkle'}"/></svg><span class="s-name"></span>`;
    const name = isMode ? `/${entry.mode.token}` : `/${skillLabel(entry.sk)}`;
    row.querySelector('.s-name').textContent = isMode ? `${name}  ${entry.mode.title}` : name;
    row.setAttribute('aria-label', isMode ? `${name} ${entry.mode.title}` : name);
    const sBlurb = isMode
      ? (entry.mode.on(state) ? '已启用 · 再点一次关闭' : entry.mode.desc)
      : (entry.sk.shortDescription || entry.sk.description || '');
    const sDesc = document.createElement('span');
    sDesc.className = 's-desc';
    sDesc.setAttribute('aria-hidden', 'true');
    sDesc.textContent = sBlurb.length > 70 ? sBlurb.slice(0, 70) + '…' : sBlurb;
    if (isMode) item.classList.add('is-mode-row');
    item.append(row, sDesc);
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => pickSkill(idx));
    frag.append(item);
  });
  dom.slashMenu.replaceChildren(frag);
  dom.slashMenu.hidden = false;

  const anchorEl = dom.composer ?? dom.input;
  const r = anchorEl.getBoundingClientRect();
  const mh = dom.slashMenu.offsetHeight;
  const mw = dom.slashMenu.offsetWidth;
  dom.slashMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - mw - 8))}px`;
  dom.slashMenu.style.top = `${Math.max(8, r.top - mh - 8)}px`;
}

/** Paint the segmented control from state (exactly one segment is active). */
function renderModeSwitch() {
  if (!dom.modeSwitch) return;
  const current = state.planMode ? 'plan' : state.goalMode ? 'target' : 'default';
  for (const seg of dom.modeSwitch.querySelectorAll('.ms-seg')) {
    const on = seg.dataset.mode === current;
    seg.classList.toggle('is-active', on);
    seg.setAttribute('aria-checked', String(on));
    seg.tabIndex = on ? 0 : -1;
  }
  dom.modeSwitch.title = current === 'plan' ? '计划模式：先给方案，不改文件'
    : current === 'target' ? '目标模式：持续做到目标完成'
      : '普通模式';
}

/**
 * Exclusive mode selection: 普通 / 计划 / 目标.
 * Plan and goal used to be independent toggles; a three-way switch needs one state,
 * so selecting either clears the other.
 */
function setMode(mode, opts = {}) {
  const next = mode === 'plan' || mode === 'target' ? mode : 'default';
  const wasPlan = state.planMode;
  const wasGoal = state.goalMode;
  state.planMode = next === 'plan';
  state.goalMode = next === 'target';
  if (!state.goalMode) state.goalObjective = null;
  // A goal lives on the server. Switching it off here has to clear it there, or the
  // agent keeps working toward it.
  if (wasGoal && !state.goalMode && state.currentThreadId) {
    rpc.send('thread/goal/clear', { threadId: state.currentThreadId }).catch(() => {});
    state.goal = null;
  }

  // Leaving plan mode must reach the server: collaborationMode is saved per thread.
  if (wasPlan && !state.planMode && state.currentThreadId) {
    rpc.send('thread/settings/update', {
      threadId: state.currentThreadId,
      collaborationMode: {
        mode: 'default',
        settings: {
          model: state.model || currentModel(),
          reasoning_effort: state.effort || null,
          developer_instructions: null,
        },
      },
    }).catch(() => { /* older server: the next turn simply omits the field */ });
  }

  renderModeSwitch();
  renderAttachments();
  updateSendState();
  if (opts.quiet) return;
  toast(next === 'plan' ? '计划模式：先给方案，不改文件'
    : next === 'target' ? '目标模式：把消息设为目标，持续推进到完成'
      : '普通模式', 2600, { kind: next === 'default' ? 'info' : 'ok' });
}

/** Kept for the /plan and /target commands. */
function toggleMode(id) {
  if (id === 'plan') setMode(state.planMode ? 'default' : 'plan');
  else if (id === 'target') setMode(state.goalMode ? 'default' : 'target');
}

function pickSkill(idx) {
  const entry = slashItems[idx];
  if (!entry) return;

  // A mode is a switch, not an attachment: consume the token and flip the flag.
  if (entry.kind === 'mode') {
    toggleMode(entry.mode.id);
    const ctx = slashContext();
    if (ctx) {
      const v = dom.input.value;
      const caret = dom.input.selectionStart ?? v.length;
      dom.input.value = v.slice(0, ctx.start) + v.slice(caret);
    } else {
      dom.input.value = dom.input.value.replace(/^\s*\/\S+\s*/, '');
    }
    // "/target 整理测试文件" -> the rest of the line becomes an explicit objective.
    const rest = dom.input.value.trim();
    if (entry.mode.id === 'target' && state.goalMode && rest) {
      state.goalObjective = rest;
      dom.input.value = '';
      toast('目标已设定：' + rest.slice(0, 40), 3600, { kind: 'ok' });
      renderAttachments();
    }
    hideSlash();
    autoGrow();
    updateSendState();
    dom.input.focus();
    return;
  }

  const sk = entry.sk;
  const ctx = slashContext();
  const label = skillLabel(sk);
  const token = `/${label} `;
  const v = dom.input.value;
  if (ctx) {
    dom.input.value = v.slice(0, ctx.start) + token + v.slice(dom.input.selectionStart ?? v.length);
  } else {
    dom.input.value = token + v;
  }
  state.skillPick = { name: sk.name, path: sk.path, label };
  hideSlash();
  autoGrow();
  updateSendState();
  renderAttachments();
  dom.input.focus();
  const pos = dom.input.value.indexOf(token) + token.length;
  dom.input.setSelectionRange(pos, pos);
}

function onInputChanged() {
  const ctx = slashContext();
  if (ctx) renderSlash(ctx.query);
  else hideSlash();

  // If the visible /token disappears, drop the attached skill too.
  if (state.skillPick) {
    const token = `/${state.skillPick.label}`;
    if (!dom.input.value.includes(token)) {
      state.skillPick = null;
      renderAttachments();
    }
  }
}

// ================================================================ side panel
// One panel shell, four destinations from the rail: skills+MCP, recent files, usage.
let lastFocusedBeforePanel = null;


// ---------------------------------------------------------------- resizable dock
// Desktop only: file previews and panels share the right-hand dock, and how wide it
// should be depends on what you are reading. Drag the edge, width is remembered.
const DOCK_MIN = 320;
const DOCK_MAX_RATIO = 0.72;

function applyDockWidth(px) {
  const max = Math.round(window.innerWidth * DOCK_MAX_RATIO);
  const w = Math.max(DOCK_MIN, Math.min(max, Math.round(px)));
  document.documentElement.style.setProperty("--dock-w", w + "px");
  return w;
}

function restoreDockWidth() {
  const saved = Number(localStorage.getItem("codex-remote-dock-w") || 0);
  if (saved >= DOCK_MIN) applyDockWidth(saved);
}

function wireDockResizer() {
  const panel = dom.panel;
  if (!panel || panel.querySelector(".dock-resizer")) return;
  const grip = document.createElement("div");
  grip.className = "dock-resizer";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "调整面板宽度");
  grip.tabIndex = 0;
  panel.append(grip);

  const isWide = () => window.matchMedia("(min-width: 1000px)").matches;
  let startX = 0;
  let startW = 0;

  const onMove = (e) => {
    const dx = startX - (e.touches ? e.touches[0].clientX : e.clientX);
    applyDockWidth(startW + dx);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onUp);
    document.body.classList.remove("dock-resizing");
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--dock-w"), 10);
    if (w >= DOCK_MIN) localStorage.setItem("codex-remote-dock-w", String(w));
  };
  const onDown = (e) => {
    if (!isWide()) return;
    startX = e.touches ? e.touches[0].clientX : e.clientX;
    startW = panel.getBoundingClientRect().width;
    document.body.classList.add("dock-resizing");
    e.preventDefault();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
  };
  grip.addEventListener("mousedown", onDown);
  grip.addEventListener("touchstart", onDown, { passive: false });
  grip.addEventListener("keydown", (e) => {
    if (!isWide()) return;
    const cur = panel.getBoundingClientRect().width;
    if (e.key === "ArrowLeft") { applyDockWidth(cur + 24); e.preventDefault(); }
    if (e.key === "ArrowRight") { applyDockWidth(cur - 24); e.preventDefault(); }
  });
}
function openPanel(title, tabs = null) {
  if (dom.panel.hidden) lastFocusedBeforePanel = document.activeElement;
  dom.panel.hidden = false;
  dom.app?.classList.add('dock-open');
  document.body.classList.add('dock-open');
  wireDockResizer();
  dom.panelTitle.textContent = title;
  dom.panelTabs.hidden = !tabs;
  dom.panelTabs.replaceChildren();
  for (const t of tabs ?? []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tab${t.active ? ' is-active' : ''}`;
    b.textContent = t.label;
    b.addEventListener('click', () => t.onSelect());
    dom.panelTabs.append(b);
  }
}

function closePanel() {
  stopWxCard();

  const wasOpen = !dom.panel.hidden;
  dom.panel.hidden = true;
  dom.app?.classList.remove('dock-open');
  document.body.classList.remove('dock-open');
  if (wasOpen && lastFocusedBeforePanel && document.contains(lastFocusedBeforePanel)) {
    try { lastFocusedBeforePanel.focus(); } catch { /* gone */ }
  }
  lastFocusedBeforePanel = null;
  dom.panelBody.replaceChildren();
}

function setRailActive(name) {
  for (const b of $$('.rail-btn[data-rail]')) b.classList.toggle('is-active', b.dataset.rail === name);
}

// ---------------------------------------------------------------- skills + MCP
let toolsTab = 'skills';

async function openToolsPanel(tab = toolsTab) {
  toolsTab = tab;
  openPanel('技能与 MCP', [
    { label: '技能', active: tab === 'skills', onSelect: () => openToolsPanel('skills') },
    { label: '插件', active: tab === 'plugins', onSelect: () => openToolsPanel('plugins') },
    { label: 'MCP', active: tab === 'mcp', onSelect: () => openToolsPanel('mcp') },
  ]);
  const body = dom.panelBody;
  body.innerHTML = SKELETON_HTML;
  if (tab === 'skills') {
    if (!state.skills.length) await loadSkills();
    renderSkillsPanel(body);
    return;
  }
  if (tab === 'plugins') {
    await renderPluginsPanel(body);
    return;
  }
  // Listing MCP servers starts them, which takes a few seconds on a cold start.
  // Say so instead of showing a bare skeleton (that read as "nothing here").
  body.innerHTML = SKELETON_HTML
    + '<p class="muted" id="mcpWait">正在连接 MCP 服务…（首次启动各服务需要几秒）</p>';
  const waitT0 = Date.now();
  const waitTimer = setInterval(() => {
    const el = document.getElementById('mcpWait');
    if (!el) { clearInterval(waitTimer); return; }
    const s = Math.round((Date.now() - waitT0) / 1000);
    el.textContent = `正在连接 MCP 服务… ${s}s（首次启动各服务需要几秒）`;
  }, 1000);
  try {
    const res = await rpc.send('mcpServerStatus/list', { detail: 'full' });
    clearInterval(waitTimer);
    state.mcpServers = res?.data ?? [];
    renderMcpPanel(body, state.mcpServers);
  } catch (e) {
    clearInterval(waitTimer);
    body.innerHTML = `<p class="error-row">读取失败：${escapeHtml(e.message)}</p>`;
  }
}

function renderSkillsPanel(body) {
  if (!state.skills.length) {
    body.innerHTML = '<p class="muted">没有找到技能（~/.codex/skills）</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = `共 ${state.skills.length} 个技能，点一下挂到下一条消息（等同输入 / 名称）`;
  frag.append(hint);

  const search = document.createElement('input');
  search.className = 'panel-search';
  search.placeholder = '搜索技能…';
  frag.append(search);

  const list = document.createElement('div');
  list.className = 'skill-list';
  const paint = (q) => {
    const term = (q || '').toLowerCase().trim();
    list.replaceChildren();
    // Rank like the "/" menu: name hits win; description hits only when no name hit.
    let pool = state.skills;
    if (term) {
      const byName = state.skills.filter((s) => s.name.toLowerCase().includes(term));
      pool = byName.length
        ? byName
        : state.skills.filter((s) => `${s.name} ${s.description ?? ''}`.toLowerCase().includes(term));
    }
    let shown = 0;
    let total = 0;
    for (const s of pool) {
      total += 1;
      // Rendering ~200 rows at once is slow and floods the a11y tree; filter instead.
      if (shown >= 40) continue;
      shown += 1;
      const wrap = document.createElement('div');
      wrap.className = 'skill-item';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'skill-row';
      row.innerHTML = '<svg aria-hidden="true"><use href="#i-sparkle"/></svg><span class="s-name"></span>';
      row.querySelector('.s-name').textContent = `/${s.name}`;
      row.setAttribute('aria-label', `/${s.name}`);
      const blurb = s.shortDescription || s.description || '';
      const descEl = document.createElement('span');
      descEl.className = 's-desc';
      descEl.setAttribute('aria-hidden', 'true');
      // Long English prose makes rows unreadable and floods the a11y tree;
      // show a clipped line and keep the full text in the row tooltip.
      descEl.textContent = blurb.length > 64 ? blurb.slice(0, 64) + '…' : blurb;
      wrap.append(row, descEl);
      row.addEventListener('click', () => {
        state.skillPick = { name: s.name, path: s.path };
        renderAttachments();
        closePanel();
        toast(`已挂上技能 ${s.name}`);
      });
      list.append(wrap);
    }
    if (!list.children.length) list.innerHTML = '<p class="muted">没有匹配</p>';
    if (total > shown) {
      const more = document.createElement('p');
      more.className = 'muted';
      more.textContent = `已显示 ${shown} / ${total}，继续输入以缩小范围`;
      list.append(more);
    }
  };
  search.addEventListener('input', () => paint(search.value));
  paint('');
  frag.append(list);
  body.replaceChildren(frag);
}

async function renderPluginsPanel(body) {
  body.innerHTML = SKELETON_HTML;
  let data;
  try {
    data = await rpc.send('plugin/list', {});
  } catch (e) {
    body.innerHTML = `<p class="error-row">插件读取失败：${escapeHtml(e.message)}</p>`;
    return;
  }
  const markets = data?.marketplaces ?? [];
  if (!markets.length) {
    body.innerHTML = '<p class="muted">没有安装插件</p>';
    return;
  }
  if (!state.skills.length) await loadSkills();

  const ownsSkill = (pl) => (sk) => {
    if (!sk.pluginId) return false;
    return sk.pluginId === pl.id || sk.pluginId === pl.name || sk.pluginId.startsWith(`${pl.name}@`);
  };

  const frag = document.createDocumentFragment();
  for (const mk of markets) {
    const head = document.createElement('div');
    head.className = 'panel-group';
    head.textContent = mk.name;
    frag.append(head);

    for (const pl of mk.plugins ?? []) {
      const skills = state.skills.filter(ownsSkill(pl));
      const box = document.createElement('div');
      box.className = 'plugin-row';
      box.innerHTML = `<div class="p-head"><span class="p-name"></span><span class="status-pill"></span></div>
        <div class="p-meta"></div><div class="p-skills"></div>`;
      box.querySelector('.p-name').textContent = pl.name;
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', `${pl.name}，${skills.length} 个技能，${pl.enabled ? '已启用' : '未启用'}`);
      const pill = box.querySelector('.status-pill');
      pill.textContent = pl.enabled ? '启用' : '未启用';
      if (!pl.enabled) pill.classList.add('bad');
      box.querySelector('.p-meta').textContent = [
        pl.localVersion || pl.version || '',
        skills.length ? `${skills.length} 个技能` : '',
      ].filter(Boolean).join(' · ');

      const chips = box.querySelector('.p-skills');
      if (!skills.length) {
        const t = document.createElement('span');
        t.className = 'muted';
        t.textContent = '（这个插件没有暴露可挂载的技能）';
        chips.append(t);
      }
      for (const sk of skills) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'path-chip';
        b.textContent = `/${sk.name}`;
        b.title = sk.description ?? '';
        b.addEventListener('click', () => {
          state.skillPick = { name: sk.name, path: sk.path, label: sk.name };
          renderAttachments();
          closePanel();
          toast(`已挂上 ${sk.name}`);
        });
        chips.append(b);
      }
      frag.append(box);
    }
  }
  body.replaceChildren(frag);
}

function renderMcpPanel(body, servers) {
  if (!servers.length) {
    body.innerHTML = '<p class="muted">没有配置 MCP 服务器（~/.codex/config.toml 的 [mcp_servers.*]）</p>';
    return;
  }
  // 238 tools in one list is unusable: filter across servers and cap what one server
  // expands to, with an explicit "show all".
  const search = document.createElement('input');
  search.className = 'panel-search';
  search.placeholder = '搜索工具或服务…';
  const host = document.createElement('div');
  host.className = 'mcp-host';

  const paint = (q = '') => {
    const term = q.toLowerCase().trim();
    const frag = document.createDocumentFragment();
    for (const srv of servers) {
      const all = Object.values(srv.tools ?? {});
      const tools = term
        ? all.filter((t) => `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(term))
        : all;
      if (term && !tools.length && !srv.name.toLowerCase().includes(term)) continue;

      const box = document.createElement('div');
      box.className = 'mcp-server';
      box.innerHTML = `<div class="mcp-head"><span class="mcp-name"></span><span class="status-pill"></span></div><div class="mcp-tools"></div>`;
      box.querySelector('.mcp-name').textContent = srv.name;

      // Status: runtimeStatus when the server reports one, otherwise infer from tools.
      // `authStatus: "unsupported"` used to be shown as the state, which made every
      // server look broken even though 100+ tools were loaded.
      const rt = srv.runtimeStatus?.type ?? null;
      const pill = box.querySelector('.status-pill');
      let label;
      let cls;
      if (rt && rt !== 'ready') { label = rt; cls = 'is-bad'; }
      else if (tools.length) { label = `就绪 · ${tools.length} 个工具`; cls = 'is-ok'; }
      else if (srv.toolsError) { label = '工具不可用'; cls = 'is-bad'; }
      else { label = '未连接'; cls = 'is-off'; }
      if (srv.authStatus && /bearerToken|oauth/i.test(srv.authStatus)) label += ' · 需授权';
      pill.textContent = label;
      pill.className = 'status-pill ' + cls;

      const list = box.querySelector('.mcp-tools');
      if (!tools.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = srv.toolsError ? `工具不可用：${srv.toolsError}` : '没有暴露工具';
        list.append(p);
      }

      const CAP = 20;
      let expanded = Boolean(term);
      const paintTools = () => {
        list.querySelectorAll('.mcp-tool-row, .mcp-more').forEach((n) => n.remove());
        const shown = expanded ? tools : tools.slice(0, CAP);
        for (const t of shown) {
          const toolWrap = document.createElement('div');
          toolWrap.className = 'mcp-tool-row';
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'mcp-tool';
          row.innerHTML = '<svg aria-hidden="true"><use href="#i-wrench"/></svg><span class="t-name"></span>';
          row.querySelector('.t-name').textContent = t.name;
          row.setAttribute('aria-label', `调用工具 ${t.name}`);
          const tBlurb = [(t.title ?? ''), (t.description ?? '')].filter(Boolean).join(' · ').slice(0, 90);
          const tDesc = document.createElement('span');
          tDesc.className = 't-desc';
          tDesc.setAttribute('aria-hidden', 'true');
          tDesc.textContent = tBlurb;
          toolWrap.append(row, tDesc);
          row.addEventListener('click', () => callToolRow(srv.name, t, list));
          list.append(toolWrap);
        }
        if (tools.length > CAP) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'btn btn-sm mcp-more';
          more.textContent = expanded ? '收起' : `显示全部 ${tools.length} 个`;
          more.addEventListener('click', () => { expanded = !expanded; paintTools(); });
          list.append(more);
        }
      };
      if (tools.length) paintTools();
      frag.append(box);
    }
    if (!frag.childElementCount) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = '没有匹配的工具';
      frag.append(p);
    }
    host.replaceChildren(frag);
  };

  search.addEventListener('input', () => paint(search.value));
  body.replaceChildren(search, host);
  paint('');
}

// Servers that only work against a running desktop app (started on demand).
const APP_FOR_SERVER = { photoshop: 'photoshop', qgis: 'qgis' };
const APP_FOR_SERVER_LABEL = { photoshop: 'Photoshop', qgis: 'QGIS' };

function callToolRow(serverName, tool, container) {
  container.querySelector('.mcp-call')?.remove();
  const box = document.createElement('div');
  box.className = 'mcp-call';
  const schema = tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [];
  box.innerHTML = `<div class="mcp-call-head"></div>
    <textarea rows="4" spellcheck="false"></textarea>
    <div class="mcp-call-actions"><button class="btn btn-primary-sm" data-act="run">调用</button>
    <button class="btn" data-act="cancel">取消</button></div>
    <pre class="mcp-result" hidden></pre>`;
  box.querySelector('.mcp-call-head').textContent =
    `${serverName} · ${tool.name}${schema.length ? `（参数：${schema.join(', ')}）` : ''}`;
  const ta = box.querySelector('textarea');
  ta.placeholder = 'JSON 参数，例如 {"path":"C:\\\\CHAT"}';
  ta.value = '{}';
  box.querySelector('[data-act="cancel"]').addEventListener('click', () => box.remove());
  box.querySelector('[data-act="run"]').addEventListener('click', async () => {
    const out = box.querySelector('.mcp-result');
    let args = {};
    try { args = JSON.parse(ta.value || '{}'); } catch { toast('参数不是合法 JSON'); return; }
    // Sending {} for a tool with required fields just produces a validation error on the
    // server; say what is missing instead.
    const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
    const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      out.hidden = false;
      out.textContent = '还缺必填参数：' + missing.join(', ');
      ta.focus();
      return;
    }
    out.hidden = false;
    out.textContent = '调用中…';
    try {
      // Prefer the open thread (it already holds MCP connections); otherwise spin up a
      // disposable one so a tool call never requires the user to start a chat first.
      let threadId = state.currentThreadId || state.mcpThreadId || null;
      if (!threadId) {
        const started = await rpc.send('thread/start', {
          ...(state.defaultCwd ? { cwd: state.defaultCwd } : {}),
          ephemeral: true,
        });
        threadId = (started?.thread ?? started)?.id ?? null;
        state.mcpThreadId = threadId;
      }
      if (!threadId) throw new Error('无法创建临时会话');

      // Some servers drive a desktop app: without it running the call fails with an
      // opaque transport error. Start it first and say so in the result panel.
      const appKey = APP_FOR_SERVER[serverName];
      if (appKey) {
        out.textContent = `正在启动 ${APP_FOR_SERVER_LABEL[appKey]}…（首次可能需要 20-60 秒）`;
        try {
          const ens = await fetch('/api/app/ensure', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ app: appKey }),
          }).then((x) => x.json());
          if (!ens.ok) {
            out.textContent = `启动 ${APP_FOR_SERVER_LABEL[appKey]} 失败：${ens.error || '未知错误'}`;
            return;
          }
          out.textContent = ens.already
            ? `${APP_FOR_SERVER_LABEL[appKey]} 已在运行，正在调用…`
            : `${APP_FOR_SERVER_LABEL[appKey]} 已打开（${Math.round((ens.waitedMs || 0) / 1000)}s），正在调用…`;
        } catch (e) {
          out.textContent = `启动 ${APP_FOR_SERVER_LABEL[appKey]} 失败：${e.message}`;
          return;
        }
      } else {
        out.textContent = '调用中…';
      }

      const res = await rpc.send('mcpServer/tool/call', {
        threadId, server: serverName, tool: tool.name, arguments: args,
      });
      out.textContent = JSON.stringify(res, null, 2);
    } catch (e) {
      out.textContent = `失败：${e.message}`;
    }
  });
  container.prepend(box);
  ta.focus();
}

// ---------------------------------------------------------------- recent files
const RECENT_KEY = 'codex-remote-recent-files';

function loadRecentFiles() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function touchFile(path, name) {
  if (!path || typeof path !== 'string') return;
  const list = loadRecentFiles().filter((f) => f.path !== path);
  list.unshift({ path, name: name || path.split(/[\\/]/).pop(), at: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 40))); } catch { /* quota */ }
}


// ---------------------------------------------------------------- transfers
// "保存文件" and "发到微信" both take time, and on a tablet there is no download bar to
// watch. Every transfer becomes a row with byte progress + elapsed time, shown in the
// 最近文件 panel and summarised by a count badge on the rail/tab button.
let transferSeq = 0;
let transferTimer = null;

function activeTransfers() {
  return state.transfers.filter((t) => t.state === "running");
}

function addTransfer({ kind, name, path: p, size = 0 }) {
  const t = {
    id: "t" + (++transferSeq),
    kind, name, path: p, size, loaded: 0, total: size,
    state: "running", startedAt: Date.now(), error: null,
  };
  state.transfers.unshift(t);
  if (state.transfers.length > 12) state.transfers.length = 12;
  renderTransferBadge();
  paintTransfers();
  if (!transferTimer) transferTimer = setInterval(paintTransfers, 500);
  return t.id;
}

function patchTransfer(id, patch) {
  const t = state.transfers.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  paintTransfers();
}

function endTransfer(id, { ok, error = null, keepMs = 4000 } = {}) {
  const t = state.transfers.find((x) => x.id === id);
  if (!t) return;
  t.state = ok ? "done" : "error";
  if (ok && t.total > 0) t.loaded = t.total;
  t.error = error;
  t.endedAt = Date.now();
  renderTransferBadge();
  paintTransfers();
  setTimeout(() => {
    state.transfers = state.transfers.filter((x) => x.id !== id);
    renderTransferBadge();
    paintTransfers();
  }, keepMs);
}

function fmtElapsed(ms) {
  const s2 = Math.max(0, Math.round(ms / 1000));
  if (s2 < 60) return s2 + "s";
  return Math.floor(s2 / 60) + "m" + String(s2 % 60).padStart(2, "0") + "s";
}

/** Count badge on the rail (desktop) and tab bar (mobile). */
function renderTransferBadge() {
  const n = activeTransfers().length;
  for (const btn of document.querySelectorAll("[data-rail=\"files\"]")) {
    let dot = btn.querySelector(".rail-badge");
    if (!n) { dot?.remove(); continue; }
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "rail-badge";
      btn.append(dot);
    }
    dot.textContent = String(n);
  }
  const filesBtn = document.querySelector("[data-rail=\"files\"]");
  filesBtn?.setAttribute("aria-label", n ? "最近文件（" + n + " 个正在传输）" : "最近文件");
}

/** Re-render 最近文件 when a save just added an entry. */
function refreshFilesPanelIfOpen() {
  if (dom.panel && !dom.panel.hidden && dom.panelTitle?.textContent === "最近文件") {
    openFilesPanel().catch(() => {});
  }
}

/** Repaint every mounted transfer list (panel section). */
function paintTransfers() {
  for (const host of document.querySelectorAll(".transfer-list")) {
    if (!document.contains(host)) continue;
    renderTransferRows(host);
  }
}

function renderTransferRows(host) {
  host.replaceChildren();
  if (!state.transfers.length) { host.hidden = true; return; }
  host.hidden = false;
  const head = document.createElement("div");
  head.className = "transfer-head";
  const n = activeTransfers().length;
  head.textContent = n ? "正在传输 " + n + " 个文件" : "传输记录";
  host.append(head);

  for (const t of state.transfers) {
    const row = document.createElement("div");
    row.className = "transfer-row " + t.state;

    const icon = document.createElement("span");
    icon.className = "t-kind";
    icon.textContent = t.kind === "wechat" ? "微信" : "保存";

    const meta = document.createElement("div");
    meta.className = "t-meta";
    const name = document.createElement("div");
    name.className = "t-name";
    name.textContent = t.name;
    const sub = document.createElement("div");
    sub.className = "t-sub";
    const parts = [];
    const measurable = t.total > 0 && t.loaded > 0;
    if (measurable) parts.push(Math.min(100, Math.round((t.loaded / t.total) * 100)) + "%");
    if (t.total) parts.push(fmtSize(t.total));
    parts.push(t.state === "running" ? fmtElapsed(Date.now() - t.startedAt)
      : t.state === "done" ? "完成 · " + fmtElapsed((t.endedAt || Date.now()) - t.startedAt)
        : "失败：" + (t.error || "未知错误"));
    sub.textContent = parts.join(" · ");
    meta.append(name, sub);
    row.append(icon, meta);

    if (t.state === "running") {
      const bar = document.createElement("div");
      bar.className = "t-bar";
      const fill = document.createElement("i");
      if (t.total > 0 && t.loaded > 0) {
        fill.style.width = Math.max(2, Math.min(100, (t.loaded / t.total) * 100)) + "%";
      } else {
        fill.className = "indeterminate";
      }
      bar.append(fill);
      row.append(bar);
    }

    host.append(row);
  }
  if (activeTransfers().length && !transferTimer) {
    transferTimer = setInterval(paintTransfers, 500);
  }
  if (!state.transfers.length && transferTimer) {
    clearInterval(transferTimer);
    transferTimer = null;
  }
}

/** Download a file while showing real byte progress, then hand it to the browser. */
async function saveFileWithProgress(target, label) {
  const id = addTransfer({ kind: "save", name: label, path: target, size: 0 });
  try { touchFile(target, label); } catch { /* list is best effort */ }
  toast("开始保存：" + label, 2200);
  try {
    const res = await fetch(fileUrl(target), { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const total = Number(res.headers.get("content-length") || 0);
    patchTransfer(id, { total, size: total });
    // A 60MB Blob is fine; a 300MB one is not (iPad Safari will drop the tab). Above the
    // limit we hand the URL to the browser, which streams straight to disk.
    const BLOB_LIMIT = 80 * 1024 * 1024;
    if (total > BLOB_LIMIT) {
      try { res.body?.cancel?.(); } catch { /* ignore */ }
      const a = document.createElement("a");
      a.href = fileUrl(target);
      a.download = label;
      document.body.append(a);
      a.click();
      a.remove();
      endTransfer(id, { ok: true, keepMs: 20000 });
      toast("文件较大（" + fmtSize(total) + "），已交给浏览器下载：" + label, 4000);
      return;
    }
    const chunks = [];
    let loaded = 0;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        patchTransfer(id, { loaded });
      }
    } else {
      const buf = await res.arrayBuffer();
      chunks.push(new Uint8Array(buf));
      loaded = buf.byteLength;
      patchTransfer(id, { loaded });
    }
    const blob = new Blob(chunks, { type: res.headers.get("content-type") || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = label;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    endTransfer(id, { ok: true, keepMs: 20000 });
    toast("已保存：" + label, 3000, { kind: "ok" });
  } catch (e) {
    // Fall back to the plain link: the browser download manager takes over.
    try {
      const a = document.createElement("a");
      a.href = fileUrl(target);
      a.download = label;
      document.body.append(a);
      a.click();
      a.remove();
      endTransfer(id, { ok: true, keepMs: 20000 });
      toast("已交给浏览器下载：" + label, 3000);
    } catch {
      endTransfer(id, { ok: false, error: e.message });
      toast("保存失败：" + e.message, 4000, { kind: "err" });
    }
  }
}
async function openFilesPanel() {
  openPanel('最近文件');
  const merged = new Map();
  for (const f of loadRecentFiles()) merged.set(f.path, f);
  // Files ClawBot received are a source in their own right now.
  for (const f of await clawFiles()) {
    merged.set(f.path, { path: f.path, name: f.name, size: f.size, mtime: f.at, source: 'claw' });
  }
  // files touched by the conversation that is currently open
  for (const t of state.turns) {
    for (const id of t.itemIds) {
      const it = state.items.get(id);
      if (!it) continue;
      if (it.type === 'fileChange') {
        for (const c of it.changes ?? []) {
          const p = c.path ?? c.file;
          if (p && !merged.has(p)) merged.set(p, { path: p, name: String(p).split(/[\\/]/).pop(), at: Date.now() });
        }
      }
      if (it.type === 'imageView' && it.path && !merged.has(it.path)) {
        merged.set(it.path, { path: it.path, name: String(it.path).split(/[\\/]/).pop(), at: Date.now() });
      }
    }
  }
  // Nothing remembered yet and no thread open: harvest the newest conversation.
  if (!merged.size && state.threads.length) {
    try {
      for (const candidate of state.threads.slice(0, 3)) {
        if (merged.size) break;
        const page = await rpc.send('thread/turns/list', {
          threadId: candidate.id, limit: 8, sortDirection: 'desc', itemsView: 'full',
        });
        for (const turn of page?.data ?? []) {
          for (const it of turn.items ?? []) {
            if (it.type === 'fileChange') {
              for (const c of it.changes ?? []) {
                const fp = c.path ?? c.file;
                if (fp && !merged.has(fp)) {
                  merged.set(fp, { path: fp, name: String(fp).split(/[\\/]/).pop(), at: Date.now() });
                }
              }
            }
            if (it.type === 'imageView' && it.path && !merged.has(it.path)) {
              merged.set(it.path, { path: it.path, name: String(it.path).split(/[\\/]/).pop(), at: Date.now() });
            }
          }
        }
      }
    } catch { /* panel stays empty */ }
  }
  const rows = [...merged.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  // Transfers sit on top: this is the panel people open to check "is it moving?".
  dom.panelBody.replaceChildren();
  const transferHost = document.createElement('div');
  transferHost.className = 'transfer-list';
  dom.panelBody.append(transferHost);
  renderTransferRows(transferHost);

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '还没有文件。拖一个进来，或在会话里点开某个路径，就会出现在这里。';
    dom.panelBody.append(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of rows) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `<svg><use href="#i-file"/></svg>
      <div class="f-meta"><div class="f-name"></div><div class="f-dir"></div></div>
      <button class="btn" data-act="view">查看</button>
      <a class="btn" data-act="dl" download>下载</a>`;
    row.querySelector('.f-name').textContent = f.name;
    row.querySelector('.f-dir').textContent = f.path;
    row.querySelector('[data-act="view"]').addEventListener('click', () => openFilePanel(f.path, f.name));
    const dl = row.querySelector('[data-act="dl"]');
    dl.href = `/api/file?path=${encodeURIComponent(f.path)}&download=1`;
    dl.setAttribute('download', f.name);
    frag.append(row);
  }
  dom.panelBody.append(frag);   // append, not replace: the transfer list above must survive
}

// ---------------------------------------------------------------- usage
function pctBar(pct) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  const tone = v >= 90 ? 'bad' : v >= 70 ? 'warn' : '';
  return `<div class="bar ${tone}"><span style="width:${v}%"></span></div>`;
}

function fmtWhen(ts) {
  if (!ts) return '';
  // The server sends either epoch seconds or an ISO string depending on the call site;
  // treat both, and never print "NaN/NaN" when neither parses.
  const ms = typeof ts === 'number'
    ? (ts > 1e12 ? ts : ts * 1000)
    : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return '稍后';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function windowLabel(w) {
  const mins = w.windowDurationMins;
  if (!mins) return '限额';
  if (mins % 1440 === 0) return `${mins / 1440} 天窗口`;
  if (mins % 60 === 0) return `${mins / 60} 小时窗口`;
  return `${mins} 分钟窗口`;
}

function renderLimits(res) {
  const snap = res?.rateLimits;
  if (!snap) return '<p class="muted">没有额度信息</p>';
  const plan = res.planType ?? snap.planType ?? '';
  const parts = [`<div class="usage-head"><span class="plan-chip"></span></div>`];
  const head = `<div class="usage-head"><span class="plan-chip">${escapeHtml(String(plan || '未知套餐'))}</span>`;
  parts[0] = head + `</div>`;
  for (const w of [snap.primary, snap.secondary]) {
    if (!w) continue;
    parts.push(`<div class="usage-block">
      <div class="usage-line"><span>${escapeHtml(windowLabel(w))}</span><span class="muted">${Number(w.usedPercent).toFixed(0)}% 已用 · 剩 ${(100 - Number(w.usedPercent)).toFixed(0)}%</span></div>
      ${pctBar(w.usedPercent)}
      <div class="usage-sub">${w.resetsAt ? `重置：${fmtWhen(w.resetsAt)}` : ''}</div>
    </div>`);
  }
  if (snap.credits) {
    const left = snap.credits.unlimited ? '无限' : (snap.credits.balance ?? '—');
    parts.push(`<div class="usage-block"><div class="usage-line"><span>剩余 credits</span><span>${escapeHtml(String(left))}</span></div></div>`);
  }
  if (res.ordinaryUsageAllowed === false) {
    parts.push('<p class="muted">当前账号的额度已用尽（ordinaryUsageAllowed=false）。</p>');
  }
  return parts.join('');
}

function renderThreadUsage(u) {
  const total = u?.total;
  if (!total) return '';
  const ctx = u.modelContextWindow;
  const used = total.inputTokens ?? total.totalTokens ?? 0;
  const pct = ctx ? Math.min(100, (used / ctx) * 100) : 0;
  return `<div class="usage-block">
    <div class="usage-line"><span>本会话上下文</span><span class="muted">${ctx ? `${pct.toFixed(0)}%` : ''}</span></div>
    ${ctx ? pctBar(pct) : ''}
    <div class="usage-sub">${Number(used).toLocaleString()} tokens${ctx ? ` / ${Number(ctx).toLocaleString()}` : ''}</div>
  </div>`;
}

async function openUsagePanel() {
  openPanel('用量');
  dom.panelBody.innerHTML = SKELETON_HTML;
  const parts = [];
  try {
    const r = await rpc.send('account/rateLimits/read', {});
    parts.push(renderLimits(r));
    // Keep the ball on the same numbers the panel shows.
    const snap = r?.rateLimits;
    const primary = snap?.primary;
    if (primary) {
      state.quota = {
        blocked: r?.ordinaryUsageAllowed === false || Number(primary.usedPercent ?? 0) >= 100,
        used: Number(primary.usedPercent ?? 0),
        plan: r?.planType ?? snap?.planType ?? state.quota?.plan ?? null,
        resetAt: primary.resetsAt ?? state.quota?.resetAt ?? null,
        weeklyUsed: Number(snap?.secondary?.usedPercent ?? state.quota?.weeklyUsed ?? 0),
      };
      updateQuotaBanner();
      renderQuotaBall();
    }
  } catch (e) {
    parts.push(`<p class="error-row">额度读取失败：${escapeHtml(e.message)}</p>`);
  }
  if (state.tokenUsage) parts.push(renderThreadUsage(state.tokenUsage));
  try {
    const u = await rpc.send('account/usage/read', {});
    const s = u?.summary;
    if (s) {
      const num = (v) => (v == null ? '—' : Number(v).toLocaleString());
      parts.push(`<div class="usage-block"><div class="usage-line"><span>累计 tokens</span><span>${num(s.lifetimeTokens)}</span></div>
        <div class="usage-sub">单日峰值 ${num(s.peakDailyTokens)} · 连续 ${s.currentStreakDays ?? '—'} 天 · 最长 ${s.longestStreakDays ?? '—'} 天</div></div>`);
    }
  } catch { /* usage/read is optional */ }
  dom.panelBody.innerHTML = parts.join('');
}

// ================================================================ thread management
function openMenuAt(x, y, items, label) {
  closeMenu();
  menuAnchorEl = null;
  if (label) {
    const l = document.createElement('div');
    l.className = 'menu-label';
    l.textContent = label;
    dom.menu.append(l);
  }
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (it.selected ? ' is-selected' : '') + (it.danger ? ' is-danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { it.onSelect(); closeMenu(); });
    dom.menu.append(b);
  }
  dom.menu.hidden = false;
  const mw = dom.menu.offsetWidth, mh = dom.menu.offsetHeight;
  const left = Math.max(8, Math.min(x, window.innerWidth - mw - 10));
  const top = Math.max(8, Math.min(y, window.innerHeight - mh - 10));
  dom.menu.style.left = `${left}px`;
  dom.menu.style.top = `${top}px`;
}

function openThreadMenu(thread, x, y) {
  openMenuAt(x, y, [
    { label: '重命名', onSelect: () => renameThread(thread) },
    { label: '归档', onSelect: () => archiveThread(thread) },
    { label: '删除…', danger: true, onSelect: () => deleteThread(thread) },
  ], thread.name || thread.preview?.slice(0, 24) || '会话');
}

async function renameThread(thread) {
  const next = window.prompt('新的会话名称', thread.name || thread.preview || '');
  if (next === null) return;
  const name = next.trim();
  if (!name) return;
  try {
    await rpc.send('thread/name/set', { threadId: thread.id, name });
    thread.name = name;
    if (state.currentThreadId === thread.id) dom.threadTitle.textContent = name;
    renderThreadList();
    toast('已重命名');
  } catch (e) { toast(`重命名失败：${e.message}`); }
}

/** Keep the local Codex app in sync: drop catalog rows whose rollout is gone. */
async function syncDesktopCatalog(quiet = true) {
  try {
    const r = await fetch('/api/threads/prune', { method: 'POST', credentials: 'same-origin' }).then((x) => x.json());
    if (r && r.ok && r.removed > 0) {
      toast('已同步本机 Codex：清理 ' + r.removed + ' 条失效会话记录');
    } else if (!quiet && r && !r.ok) {
      toast('同步失败：' + (r.error || '未知错误'));
    }
    return r;
  } catch (e) {
    if (!quiet) toast('同步失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

async function archiveThread(thread) {
  try {
    await rpc.send('thread/archive', { threadId: thread.id });
    state.threads = state.threads.filter((t) => t.id !== thread.id);
    if (state.currentThreadId === thread.id) app.newChat();
    renderThreadList();
    toast('已归档');
    syncDesktopCatalog();
  } catch (e) { toast(`归档失败：${e.message}`); }
}

async function deleteThread(thread) {
  if (!window.confirm(`永久删除「${thread.name || thread.preview || thread.id}」？此操作不可撤销。`)) return;
  try {
    await rpc.send('thread/delete', { threadId: thread.id });
    state.threads = state.threads.filter((t) => t.id !== thread.id);
    if (state.currentThreadId === thread.id) app.newChat();
    renderThreadList();
    toast('已删除');
    syncDesktopCatalog();
  } catch (e) { toast(`删除失败：${e.message}`); }
}

// ================================================================ wiring
dom.slashMenu?.addEventListener('mousedown', (e) => e.preventDefault());

// Diagnostics hook: lets the CDP test harness drive the UI the same way a user does.
window.app = app;
window.__diag = {
  renderThreadList, renderItem, renderStream, openPanel, closePanel,
  showLogin, showApp, syncDesktopCatalog, toast, openCmdk, closeCmdk, addTransfer, endTransfer, saveFileWithProgress,
};
window.__openFilePanel = openFilePanel;
window.__state = state;
window.__rpc = rpc;

try {
  if (localStorage.getItem('codex-remote-fast') === '1') state.fast = true;
  {
    state.wxAutoSend = localStorage.getItem('codex-remote-wx-autosend') === '1';
    const savedAccess = localStorage.getItem('codex-remote-access');
    if (savedAccess && ACCESS_LEVELS[savedAccess]) state.access = savedAccess;
  }
  const saved = JSON.parse(localStorage.getItem('codex-remote-ctx') || '{}') || {};
  Object.assign(state.ctxWindows, saved);
} catch { /* ignore */ }

// WeChat's WebView cannot reach chat files; say it before the user gets stuck.
if (/MicroMessenger/i.test(navigator.userAgent) && dom.wxTip) {
  dom.wxTip.hidden = false;
}
dom.wxTipClose?.addEventListener('click', () => { if (dom.wxTip) dom.wxTip.hidden = true; });

// Usage ball: click opens the details panel, the countdown ticks once a second and the
// position tracks the composer so a multi-line draft never hides it.
dom.quotaBall?.addEventListener('click', () => { openUsagePanel(); });
setInterval(() => { try { renderQuotaBall(); } catch { /* ignore */ } }, 1000);
setInterval(() => { if (rpc.connected) app.loadQuota().catch(() => {}); }, 60000);
if (typeof ResizeObserver !== 'undefined' && dom.composer) {
  new ResizeObserver(syncBallPosition).observe(dom.composer);
}
window.addEventListener('resize', syncBallPosition);
// Remember how wide the user likes the dock, and re-clamp it when the window changes.
restoreDockWidth();
window.addEventListener('resize', () => {
  const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-w'), 10);
  if (cur >= DOCK_MIN) applyDockWidth(cur);
});
window.addEventListener('orientationchange', () => setTimeout(syncBallPosition, 120));

// Ctrl/Cmd-K opens the palette; arrows/enter/escape drive it.
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (dom.cmdk && !dom.cmdk.hidden) closeCmdk(); else openCmdk();
    return;
  }
  if (!dom.cmdk || dom.cmdk.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIndex = Math.min(cmdkIndex + 1, cmdkItems.length - 1); markCmdkActive(); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); cmdkIndex = Math.max(cmdkIndex - 1, 0); markCmdkActive(); return; }
  if (e.key === 'Enter') { e.preventDefault(); runCmdk(cmdkIndex); return; }
});
dom.cmdkInput?.addEventListener('input', () => { cmdkIndex = 0; renderCmdk(dom.cmdkInput.value); });
dom.cmdk?.addEventListener('click', (e) => { if (e.target === dom.cmdk) closeCmdk(); });

updateSendState();
syncPlaceholder();
renderMetrics();
window.addEventListener('resize', syncPlaceholder);
boot();

// ---------------------------------------------------------------- error surface
// A thrown render error used to leave a blank panel with nothing in the console the
// user would ever see. Surface it once, and keep the app usable.
let lastErrorToast = 0;
function reportFatal(where, err) {
  const msg = String(err?.message || err || '未知错误');
  console.error(where, err);
  const now = Date.now();
  if (now - lastErrorToast < 3000) return; // don't spam on a render loop
  lastErrorToast = now;
  toast('页面出错：' + msg.slice(0, 80) + '（已记录到控制台）', 6000);
}
window.addEventListener('error', (e) => {
  if (e.filename || e.message) reportFatal('window.error', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => reportFatal('unhandledrejection', e.reason));

// ---------------------------------------------------------------- keep-alive & task monitor
// Heartbeat-style supervision: sample every task, judge its state, and (when 保持 is on for
// that chat) recover it — reconnect, continue after an abnormal stop, or wait out a quota
// reset. Everything lives in the page: the app-server already exposes what we need.

const KA_KEY = 'codex-remote-keepalive';
const KA_LEADER_KEY = 'codex-remote-keepalive-leader';
const KA_MAX_PER_HOUR = 6;
const KA_COOLDOWN_MS = 8000;
const KA_STALL_MS = 90000;
const KA_TICK_MS = 2000;

state.keepalive = new Set();
state.keepaliveUserStop = null; // threadId the user just stopped by hand
state.tasks = new Map();        // threadId -> { status, lastActivityAt, step, turnId, startedAt, note }
const kaRecovery = new Map();   // threadId -> { count, hourStart, lastAt, timer }
let kaWasConnected = true;
let kaLastTick = 0;

function kaLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(KA_KEY) || '[]');
    if (Array.isArray(raw)) state.keepalive = new Set(raw.filter((x) => typeof x === 'string'));
  } catch { /* ignore */ }
}
function kaSave() {
  try { localStorage.setItem(KA_KEY, JSON.stringify([...state.keepalive])); } catch { /* quota */ }
}
function kaIsLeader() {
  // One tab recovers; the others only render. A stale lock (10s) is taken over.
  const me = kaInstanceId();
  try {
    const cur = JSON.parse(localStorage.getItem(KA_LEADER_KEY) || 'null');
    if (cur && cur.id !== me && Date.now() - cur.ts < 10000) return false;
    localStorage.setItem(KA_LEADER_KEY, JSON.stringify({ id: me, ts: Date.now() }));
  } catch { /* ignore */ }
  return true;
}
let kaId = null;
function kaInstanceId() {
  if (!kaId) kaId = 'k' + Math.random().toString(36).slice(2, 10);
  return kaId;
}

/** A turn is "active" if anything moved in the last KA_STALL_MS. */
function kaTask(threadId) {
  let t = state.tasks.get(threadId);
  if (!t) {
    t = { status: 'idle', lastActivityAt: Date.now(), step: '', turnId: null, startedAt: null, note: '' };
    state.tasks.set(threadId, t);
  }
  return t;
}

function kaNoteActivity(threadId, step, kind) {
  if (!threadId) return;
  const t = kaTask(threadId);
  t.lastActivityAt = Date.now();
  if (step) t.step = step;
  if (kind === 'start') { t.status = 'running'; t.startedAt = t.startedAt ?? Date.now(); }
  else if (t.status !== 'recovering' || kind === 'recovered') t.status = 'running';
}

/** Human label for the most recent item, used as "当前步骤". */
function kaStepLabel(method, params) {
  const it = params?.item;
  const type = it?.type;
  if (type === 'commandExecution') return '执行命令 ' + String(it.command || '').split('\n')[0].slice(0, 40);
  if (type === 'reasoning') return '思考中';
  if (type === 'fileChange') return '修改文件';
  if (type === 'mcpToolCall') return '调用工具 ' + (it.tool?.name ?? '');
  if (method.includes('agentMessage')) return '写回答';
  return '';
}

function kaOnNotification(method, params) {
  const threadId = params?.threadId;
  if (threadId) {
    if (method === 'turn/started') {
      const t = kaTask(threadId);
      t.turnId = params.turn?.id ?? t.turnId;
      t.startedAt = Date.now();
      kaNoteActivity(threadId, '开始', 'start');
    } else if (method === 'turn/completed') {
      const status = String(params.turn?.status ?? '');
      const t = kaTask(threadId);
      t.status = /fail|error|abort/i.test(status) ? 'errored' : 'idle';
      t.lastActivityAt = Date.now();
      t.step = t.status === 'errored' ? '异常结束' : '完成';
      if (t.status === 'errored') kaMaybeRecover(threadId, 'errored');
    } else if (method === 'item/started' || method === 'item/completed') {
      kaNoteActivity(threadId, kaStepLabel(method, params));
    } else if (method.endsWith('Delta')) {
      kaNoteActivity(threadId, kaStepLabel(method, params));
    } else if (method === 'thread/status/changed') {
      const t = kaTask(threadId);
      t.status = /active/i.test(String(params.status?.type ?? '')) ? 'running' : t.status === 'running' ? 'idle' : t.status;
    }
  }

  if (method === 'error' && params?.threadId) {
    const t = kaTask(params.threadId);
    t.status = 'errored';
    t.step = String(params.error?.message ?? params.message ?? '出错').slice(0, 60);
    kaMaybeRecover(params.threadId, 'error');
  }

  if (method === 'account/rateLimits/updated' && state.quota?.blocked) {
    for (const id of state.keepalive) kaScheduleQuotaRetry(id);
  }
}

/** Wait for the quota window and pick the task back up. */
function kaScheduleQuotaRetry(threadId) {
  const rec = kaRecovery.get(threadId) ?? { count: 0, hourStart: Date.now(), lastAt: 0, timer: null };
  if (rec.timer) return;
  // The window arrives as epoch seconds, epoch ms or an ISO string. new Date() on epoch
  // seconds yields 1970 — that made the job wake every 5s instead of at the real reset.
  const resetRaw = state.quota?.resetAt ?? null;
  const resetMs = resetRaw == null ? NaN
    : typeof resetRaw === 'number' ? (resetRaw > 1e12 ? resetRaw : resetRaw * 1000)
      : new Date(resetRaw).getTime();
  const wait = Number.isFinite(resetMs)
    ? Math.max(5000, resetMs - Date.now() + 20000)
    : 10 * 60000;
  const t = kaTask(threadId);
  t.status = 'blocked';
  t.note = Number.isFinite(resetMs)
    ? '等额度到 ' + new Date(resetMs).toLocaleTimeString()
    : '额度用尽';
  rec.timer = setTimeout(async () => {
    rec.timer = null;
    try { await app.loadQuota(); } catch { /* ignore */ }
    if (!state.quota?.blocked) kaAutoContinue(threadId, 'quota');
    else kaScheduleQuotaRetry(threadId);
  }, Math.min(wait, 30 * 60000));
  kaRecovery.set(threadId, rec);
}

async function kaMaybeRecover(threadId, reason) {
  if (!state.keepalive.has(threadId)) return;
  if (state.keepaliveUserStop === threadId) return;
  if (state.quota?.blocked) { kaScheduleQuotaRetry(threadId); return; }
  kaAutoContinue(threadId, reason);
}

/** Send 继续 into the thread, but only when it really is not running. */
async function kaAutoContinue(threadId, reason) {
  if (!state.keepalive.has(threadId)) return;
  if (!kaIsLeader()) return;
  if (!rpc.connected) return; // the reconnect path will retry
  const rec = kaRecovery.get(threadId) ?? { count: 0, hourStart: Date.now(), lastAt: 0, timer: null };
  if (Date.now() - rec.hourStart > 3600000) { rec.count = 0; rec.hourStart = Date.now(); }
  if (rec.count >= KA_MAX_PER_HOUR) {
    kaTask(threadId).note = '本小时已达自动恢复上限（' + KA_MAX_PER_HOUR + ' 次）';
    kaRecovery.set(threadId, rec);
    return;
  }
  if (Date.now() - rec.lastAt < KA_COOLDOWN_MS) return;

  // Guard: somebody else may already be running this turn.
  try {
    const page = await rpc.send('thread/turns/list', { threadId, limit: 2, sortDirection: 'desc', itemsView: 'notLoaded' });
    const running = (page?.data ?? []).some((t) => /inProgress/i.test(String(t.status)));
    if (running) {
      // Still alive on the server: nothing to recover, just clear the "断线" flag.
      const alive = kaTask(threadId);
      alive.status = 'running';
      alive.note = '仍在运行，无需继续';
      alive.lastActivityAt = Date.now();
      kaRenderIfOpen();
      return;
    }
  } catch { return; }

  rec.count += 1;
  rec.lastAt = Date.now();
  kaRecovery.set(threadId, rec);

  const t = kaTask(threadId);
  t.status = 'recovering';
  t.note = '自动继续（' + ({ errored: '异常结束', reconnect: '断线重连', quota: '额度恢复', error: '出错' }[reason] ?? reason) + '）';
  try {
    const params = { threadId, input: [{ type: 'text', text: '继续' }] };
    if (state.model) params.model = state.model;
    if (state.effort) params.effort = state.effort;
    await rpc.send('turn/start', params);
    kaNoteActivity(threadId, '已自动继续', 'recovered');
    toast('已自动继续：' + (state.threads.find((x) => x.id === threadId)?.name || '会话').slice(0, 18), 3200, { kind: 'ok' });
  } catch (e) {
    t.status = 'errored';
    t.note = '自动继续失败：' + String(e.message).slice(0, 40);
  }
  kaRenderIfOpen();
}

/** After a reconnect, pick up whatever we were watching when the socket died. */
async function kaAfterReconnect() {
  for (const threadId of state.keepalive) {
    const t = state.tasks.get(threadId);
    if (!t) continue;
    if (t.status === 'running' || t.status === 'recovering') {
      t.status = 'disconnected';
      t.note = '连接恢复，核对状态';
      await kaAutoContinue(threadId, 'reconnect');
    }
  }
  kaRenderIfOpen();
}

/** One heartbeat: sample, judge, repaint. */
function kaTick() {
  kaLastTick = Date.now();
  const connected = Boolean(rpc.connected);
  if (kaWasConnected && !connected) {
    for (const [threadId, t] of state.tasks) {
      if (t.status === 'running' || t.status === 'recovering') {
        t.status = 'disconnected';
        t.note = '连接断开，等待重连';
      }
    }
    kaRenderIfOpen();
  }
  if (!kaWasConnected && connected) {
    setConn('ok', '已连接');
    kaAfterReconnect().catch(() => {});
  }
  kaWasConnected = connected;

  // Mark stalls and refresh elapsed time.
  const now = Date.now();
  for (const [threadId, t] of state.tasks) {
    if (t.status === 'running' && now - t.lastActivityAt > KA_STALL_MS) {
      t.status = 'stalled';
      t.note = '超过 ' + Math.round(KA_STALL_MS / 1000) + ' 秒无活动';
    }
  }
  // Threads running in other windows: status comes from the thread list.
  for (const th of state.threads) {
    if (th.status?.type === 'active' && th.id !== state.currentThreadId) {
      const t = kaTask(th.id);
      if (t.status === 'idle' || !t.status) { t.status = 'running'; t.note = '在其他窗口运行'; }
    }
  }
  kaRenderIfOpen();
  kaRenderKeepButton();
}

function kaElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

const KA_LABEL = {
  running: '运行中', idle: '空闲', stalled: '疑似卡住', disconnected: '断线',
  errored: '异常结束', blocked: '等额度', recovering: '恢复中',
};

function kaRows() {
  const rows = [];
  const seen = new Set();
  for (const th of state.threads) {
    const t = state.tasks.get(th.id);
    const active = th.status?.type === 'active';
    if (!t && !active) continue;
    if (t && ['idle'].includes(t.status) && !state.keepalive.has(th.id)) continue;
    seen.add(th.id);
    rows.push({ thread: th, task: t, status: t?.status ?? 'running' });
  }
  for (const [threadId, t] of state.tasks) {
    if (seen.has(threadId)) continue;
    if (t.status === 'idle') continue;
    rows.push({ thread: state.threads.find((x) => x.id === threadId) ?? { id: threadId, name: '(已关闭的会话)' }, task: t, status: t.status });
  }
  const order = { recovering: 0, running: 1, stalled: 2, blocked: 3, errored: 4, disconnected: 5, idle: 6 };
  rows.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return rows;
}

function kaToggle(threadId) {
  if (state.keepalive.has(threadId)) {
    state.keepalive.delete(threadId);
    toast('已关闭保持');
  } else {
    state.keepalive.add(threadId);
    if (state.keepaliveUserStop === threadId) state.keepaliveUserStop = null;
    toast('已开启保持：断联、异常结束或额度恢复后会自动继续', 3600, { kind: 'ok' });
  }
  kaSave();
  kaRenderKeepButton();
  kaRenderIfOpen();
}

function kaRenderKeepButton() {
  const btn = document.querySelector('#keepBtn');
  if (!btn) return;
  const id = state.currentThreadId;
  const on = id ? state.keepalive.has(id) : false;
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('is-on', on);
  btn.disabled = !id;
  const rec = id ? kaRecovery.get(id) : null;
  btn.title = on
    ? '保持已开启：断联、异常结束或额度恢复后会自动继续'
      + (rec?.count ? '（本小时已恢复 ' + rec.count + ' 次）' : '')
    : '保持：断联、异常结束或额度恢复后自动继续';
}

function kaRenderIfOpen() {
  const title = document.querySelector('#panelTitle')?.textContent;
  if (title === '任务监测') kaPaintTasks();
}

function kaPaintTasks() {
  const body = dom.panelBody;
  if (!body) return;
  const rows = kaRows();
  const running = rows.filter((r) => ['running', 'recovering'].includes(r.status)).length;
  const keeping = [...state.keepalive].length;

  body.replaceChildren();
  const head = document.createElement('div');
  head.className = 'task-summary';
  head.innerHTML = '<span class="task-stat"><b></b> 运行中</span><span class="task-stat"><b></b> 保持中</span>';
  head.querySelectorAll('b')[0].textContent = String(running);
  head.querySelectorAll('b')[1].textContent = String(keeping);
  body.append(head);

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '现在没有正在运行的任务。';
    body.append(p);
    return;
  }

  const list = document.createElement('div');
  list.className = 'task-list';
  for (const row of rows) {
    const t = row.task;
    const el = document.createElement('div');
    el.className = 'task-row is-' + row.status;

    const dot = document.createElement('span');
    dot.className = 'task-dot';
    el.append(dot);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'task-main';
    const name = document.createElement('div');
    name.className = 'task-name';
    name.textContent = row.thread.name || row.thread.preview || '(空会话)';
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const bits = [KA_LABEL[row.status] ?? row.status];
    if (t?.startedAt && (row.status === 'running' || row.status === 'recovering')) bits.push('已跑 ' + kaElapsed(Date.now() - t.startedAt));
    if (t?.lastActivityAt) bits.push('最近活动 ' + kaElapsed(Date.now() - t.lastActivityAt) + ' 前');
    if (t?.step && row.status !== 'idle') bits.push(t.step);
    meta.textContent = bits.join(' · ');
    main.append(name, meta);
    if (t?.note) {
      const note = document.createElement('div');
      note.className = 'task-note';
      note.textContent = t.note;
      main.append(note);
    }
    main.addEventListener('click', () => { closePanel(); app.openThread(row.thread.id); });
    el.append(main);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'task-toggle' + (state.keepalive.has(row.thread.id) ? ' is-on' : '');
    toggle.textContent = state.keepalive.has(row.thread.id) ? '保持中' : '保持';
    toggle.setAttribute('aria-pressed', String(state.keepalive.has(row.thread.id)));
    toggle.addEventListener('click', (e) => { e.stopPropagation(); kaToggle(row.thread.id); });
    el.append(toggle);
    list.append(el);
  }
  body.append(list);
}

async function openTasksPanel() {
  openPanel('任务监测');
  kaPaintTasks();
}

// ---- wiring
kaLoad();
setInterval(kaTick, KA_TICK_MS);
kaTick();

if (dom.tasksRail ?? true) { /* rail button handled below */ }
for (const b of document.querySelectorAll('.rail-btn[data-rail="tasks"]')) {
  b.addEventListener('click', () => { setRailActive('tasks'); openTasksPanel(); });
}
document.querySelector('#keepBtn')?.addEventListener('click', () => {
  if (!state.currentThreadId) { toast('先打开一个会话'); return; }
  kaToggle(state.currentThreadId);
});

// Activity and failure signals come from the notification stream.
const kaBaseNotify = app.onNotification.bind(app);
app.onNotification = function kaWrappedNotify(method, params) {
  try { kaOnNotification(method, params); } catch (e) { console.warn('keepalive:', e.message); }
  return kaBaseNotify(method, params);
};

// A manual stop must not be undone by the watchdog.
const kaBaseStop = app.stop.bind(app);
app.stop = async function kaWrappedStop() {
  const id = state.currentThreadId;
  if (id && state.keepalive.has(id)) {
    state.keepalive.delete(id);
    state.keepaliveUserStop = id;
    kaSave();
    kaRenderKeepButton();
    toast('已停止；该会话的「保持」已自动关闭');
  }
  return kaBaseStop();
};

kaRenderKeepButton();


// Public handles for tests and for anything outside this module.
window.__keepalive = {
  tick: kaTick,
  toggle: kaToggle,
  scheduleQuota: kaScheduleQuotaRetry,
  autoContinue: kaAutoContinue,
  afterReconnect: kaAfterReconnect,
  rows: kaRows,
};

// Public handles for tests (the module scope is not global).
// New ClawBot attachments arrive without a page reload.
setInterval(() => { void clawAutoMount().catch(() => {}); }, 20000);
if (typeof window !== "undefined") {
  setTimeout(() => { void clawAutoMount().catch(() => {}); }, 6000);
}

window.__claw = {
  status: clawStatus,
  send: clawSend,
  notify: clawNotifyTurn,
  files: clawFiles,
  openFiles: openClawFiles,
  autoMount: clawAutoMount,
  setStatus: (st) => { clawCache = st; clawCacheAt = Date.now(); },
};
