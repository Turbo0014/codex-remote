# Codex Remote — 用 iPad / 另一台电脑操作本机 Codex

把本机（KLV-WX9）上的 Codex 变成一个**固定地址的 Web 界面**：iPad、另一台 Windows 电脑打开浏览器就能接管本机的 Codex 会话，任务仍然跑在这台机器上。

不需要梯子、不需要公网 IP、不需要端口映射。

---

## 0. 先说三件事实

1. **`npx codex-xremote` 不存在。** npm 上没有 `codex-xremote`，也没有 `codex_xremote`（GitHub 上有个同名仓库，但没发包），所以那条命令必然 404。本方案不依赖它。
2. **本机 Codex 0.166.0 自带官方远程能力**，这套东西就建在它上面：
   - `codex app-server --listen ws://127.0.0.1:8791` — 官方的 WebSocket 服务端（实测可直接跑，且只绑本机回环）
   - 协议是官方生成的 TypeScript 绑定（`protocol/`，760 个类型文件），请求形如 `{method, id, params}` → `{id, result}`
3. **界面是从 Codex 桌面端本身提取出来对齐的**：配色直接取自桌面端窗口截图的像素采样，字体/圆角/间距取自它自己的 CSS 变量（`web/tokens.css` 由 `desktop-webview/` 里的真实样式表合并而成）。

---

## 1. 现在怎么用

```text
这台电脑（被控）                         你的 iPad / 笔记本
┌──────────────────────────┐            ┌─────────────────┐
│ Codex app-server :8791   │            │                 │
│   ↑ 只绑 127.0.0.1       │            │  浏览器          │
│ bridge (Node) :8787      │◄──HTTP/WS──│  http://…:8787  │
│   · 静态页面 + WS 代理    │            │                 │
│   · 口令登录 + 签名 Cookie│            │                 │
└──────────────────────────┘            └─────────────────┘
```

| 场景 | 地址 |
|---|---|
| 本机 | <http://127.0.0.1:8787/> |
| 同一 Wi-Fi / 局域网 | <http://<lan-ip>:8787/> （IP 变了以 `bridge/logs/bridge.log` 启动那几行为准） |
| 任何网络（Tailscale，已配好） | <http://<tailnet-ip>:8787/> |

**访问密码**在 `bridge/config.json` 的 `passcode` 字段里，当前是：

```powershell
(Get-Content .\bridge\config.json -Raw | ConvertFrom-Json).passcode
```

打开页面输入一次，之后 30 天内不用再输（HttpOnly 签名 Cookie）。

**iPad 上建议「添加到主屏幕」**：Safari 打开 → 分享 → 添加到主屏幕，之后就是一个全屏 App 的样子，没有浏览器地址栏。

---

## 2. 外网访问

### 2.1 Tailscale（已配置，当前方案）

不给域名、不花钱、不用公网 IP。本机已加入 tailnet，节点信息：

| 项 | 值 |
|---|---|
| 节点 IP | `<tailnet-ip>` |
| MagicDNS | `pc-20261014odxq.taild17e9c.ts.net` |
| 访问地址 | <http://<tailnet-ip>:8787/> |
| 配对链接 | <http://<tailnet-ip>:8787/?t=`<你的 passcode>`> |

链路是 WireGuard 端到端加密的，所以 HTTP 也是加密的（浏览器只会提示"不安全"是因为没证书，不影响保密性）。

**iPad 上四步：** App Store 装 `Tailscale`（厂商 Tailscale Inc.）→ 同一个账号登录 → 打开 VPN 开关 → Safari 打开上面的地址，输一次密码，然后「分享 → 添加到主屏幕」。

**新设备想加入**：在那个设备上装 Tailscale 并用同一账号登录即可，不需要改本机任何配置。

常用命令：

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" status      # 看谁在线
& "C:\Program Files\Tailscale\tailscale.exe" ip -4       # 本机 tailnet IP
```

**可选：换成 HTTPS 地址**（去掉"不安全"提示，iOS 的 PWA 体验也更完整）

1. 打开 <https://login.tailscale.com/f/serve?node=nyzbRqQvef11CNTRL> 启用 Serve（一次性）
2. 然后执行 `& "C:\Program Files\Tailscale\tailscale.exe" serve --bg http://127.0.0.1:8787`
3. 地址变成 `https://pc-20261014odxq.taild17e9c.ts.net/`

### 2.2 Cloudflare Tunnel（备选，需要自己的域名）

本机也装了 `cloudflared`（2026.10.7）。这条路需要**你自己的域名并托管到 Cloudflare**，好处是域名更好记、可以叠 Cloudflare Access 做邮箱验证码二次验证。**实测注意**：免账号的临时隧道（`-Quick`）从这条网络现在返回 `429`，不要指望它。

```powershell
# 1) 登录（会打开浏览器，选你的域名授权）
& "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe" tunnel login

# 2) 建命名隧道 + 绑域名 + 注册登录自启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-tunnel.ps1 -Hostname codex.example.com
```

跑完就有固定入口 `https://codex.example.com/`，且重启后自动带起来。

- 只想先试试、没有域名：`scripts\setup-tunnel.ps1 -Quick` 会给一个随机 `*.trycloudflare.com` 地址，**重启就变**，不建议长期用。
- 移除隧道入口：`scripts\setup-tunnel.ps1 -Uninstall`（Cloudflare 面板里的隧道和 DNS 记录要手动删）。

> 为什么不推荐 frp / DDNS：都要一台公网服务器或路由器端口映射；Cloudflare Tunnel 是纯出站连接，CGNAT 后面也能用，而且免费额度对单人够用。

---

## 3. 开机自启与日常操作

已经注册好计划任务 `CodexRemoteBridge`（登录时启动，无窗口，失败每分钟重试）：

```powershell
# 看状态
Get-ScheduledTask -TaskName CodexRemoteBridge | Select TaskName,State
# 立即启动 / 停止
Start-ScheduledTask -TaskName CodexRemoteBridge
Stop-ScheduledTask  -TaskName CodexRemoteBridge
# 健康检查
Invoke-WebRequest http://127.0.0.1:8787/healthz -UseBasicParsing | Select -Expand Content
# 卸载自启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
```

日志：`bridge/logs/bridge.log`（含 app-server 的 stderr，超过 4 MB 自动轮转一次）。

---

## 4. 安全边界（重要）

- app-server **只监听 127.0.0.1:8791**，局域网上任何人都摸不到它；对外只有 bridge 的 8787。
- 8787 需要口令登录，Cookie 是 HMAC-SHA256 签名 + 30 天过期 + HttpOnly + SameSite=Lax；同一个 IP 5 分钟内错 8 次会被限流。
- 口令等同于这台电脑的 Codex 操作权（Codex 会执行命令、改文件）。**别把带 `?t=` 的配对链接发到群里**，用完可以改 `config.json` 的 `passcode` 再重启 bridge。
- 本机三个防火墙配置文件目前都是关闭的，所以局域网能直连。**如果你以后开了防火墙**，需要放行 8787（管理员权限）：

  ```powershell
  New-NetFirewallRule -DisplayName 'Codex Remote 8787' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Domain,Private
  ```

---

## 5. 界面与桌面端对齐到什么程度

已经对齐的：三栏骨架（图标栏 / 会话列表 / 对话区）、#F6F6F6 顶栏与图标栏、#FCFCFC 侧栏、纯白画布、近黑色用户气泡、`Worked for …` 分隔行 + 细分隔线、13.5px 侧栏字与 15px 正文、20px 气泡圆角、胶囊形模型/思考强度选择器、暗色主题、iPad 双栏与手机抽屉式布局。

**尚未逐像素复刻的**：它不是 Electron 渲染的那份前端（那份要逆向主进程通信协议，见第 7 节）；命令卡片、diff、审批卡是按同一套设计语言重写的，不是桌面端原组件。想再逼近，可以直接对着 `docs/ui-*.png` 和 `docs/ref-desktop.png` 提具体差异点，我按截图逐屏修。

截图（都是真机数据，不是假数据）：

| 文件 | 说明 |
|---|---|
| `docs/ref-desktop.png` | Codex 桌面端原件（颜色采样来源） |
| `docs/ui-desktop.png` | 本方案 · 桌面尺寸 |
| `docs/ui-thread.png` | 本方案 · 打开真实会话 |
| `docs/ui-ipad.png` | 本方案 · iPad 横屏 1180×820 |
| `docs/ui-phone.png` | 本方案 · 手机 390×844 |
| `docs/ui-dark.png` | 本方案 · 暗色 |
| `docs/ui-home.png` | 本方案 · 新会话首页 |

---

## 5.5 实现状态（哪些是真跑通的，哪些没有）

这一节按**实测**写，不按"看起来像"写。验证手段在 `tools/`：`flow-test.mjs`、`held-test.mjs`、`cdp-diag.mjs`。

### 已实现且实测通过

| 能力 | 验证方式 |
|---|---|
| 浏览器 ↔ app-server 全双工 JSON-RPC | `cdp-diag.mjs`：零未捕获异常，`已连接` |
| 会话列表（含 Pinned/Recents 分组、置顶顺序） | 11 条真实会话 |
| **打开桌面端正在编辑的会话**（只读） | 实测 4 轮 / **224 个 item**、16 消息 / **161 个步骤卡片**全部渲染 |
| 分页历史 + 上滑加载更早 | `thread/turns/list` + cursor |
| 新建会话并发送 | `flow-test.mjs`：气泡单条、标题同步、RPC 往返成功 |
| 失败原因常驻展示 | 额度错误以内联红条留在正文里（不再一闪而过的 toast） |
| **桌面端占用检测与逃生** | `held-test.mjs`：出现只读横幅 +「复制为新会话 / 再试一次接管」，草稿保留；`thread/fork` 实测成功（复制 2 轮）|
| 协议内部消息折叠 | `<send_user_message_question_reply>` 等不再冒充用户气泡 |
| 路径 / 图片引用 | `[文字](C:\...)`、`![图](C:\x.png)` 渲染成 chip，不再显示原始 Markdown |
| 明暗主题、iPad 双栏、手机抽屉 | 截图见 `docs/ui-*.png` |
| 登录鉴权、限流、签名 Cookie | 8 次/5 分钟限流、HMAC 签名、30 天 |

### 已实现但没能实测（被账号额度挡住）

| 能力 | 状态 |
|---|---|
| 流式输出（`item/*/delta`） | 代码路径完整，e2e 里收到过 `turn/started`→`item/started`→`error`→`turn/completed` 全序列，但没跑完一轮真实回答 |
| 审批弹窗（`item/commandExecution/requestApproval` 等） | 响应体按协议实现（`{decision:"accept"}`），额度恢复后需真跑一次 |
| 停止（`turn/interrupt`） | 同上 |
| 命令卡片展开、diff 着色 | 已按 161 个真实 item 渲染，输出内容为空是因为历史里 `aggregatedOutput` 本就为空 |

### 明确没做

- **页面刷新会丢掉未决审批**：`codex_xremote` 用 `GET /pending` 补这个洞，我们的连接是「每个浏览器 WS 一条上游」，刷新即断。下一步应把上游连接提升为按会话常驻（见参考文档建议 1）。
- ~~文件/图片不能在本机之外打开~~ → 已实现 `/api/upload` + `/api/file`，见 5.6。
- ~~会话重命名 / 归档 / 删除没有 UI~~ → 已实现，右键/长按会话行。
- `approval_policy` 与 `sandbox_mode` **保持 Codex 自己的配置**，不像 codex_xremote 那样硬塞 `never` + `danger-full-access`。


## 5.6 附件 / 技能 / MCP / 会话管理（已实现）

### 加文件（三条入口）

| 入口 | 说明 |
|---|---|
| 点回形针 | 弹出系统文件选择器。**iPad 上会给出「照片图库 / 拍照 / 选择文件」**，可以直接从相册或相机加图 |
| 拖拽 | 把文件拖到页面上，出现虚线遮罩，松手即上传 |
| 粘贴 | 在输入框里直接粘贴截图或复制的文件 |

文件**不是传到浏览器**，而是落到被控机：`%TEMP%\codex-remote\<时间戳>-<原名>`。发送时按类型组进消息：

- 图片（png/jpg/gif/webp/heic/svg…）→ `{type:"localImage", path}`，Codex 能直接看图
- 其它文件 → `{type:"mention", name, path}`

上限 512 MB。实测：`text + localImage + mention + skill` 四种混合输入被 `turn/start` 正常接受。

### 看文件 / 下载

附件 chip、正文里的路径 chip、`imageView` 卡片都可以点开查看器：

- 图片 → 直接渲染（走 `/api/file`，支持 Range 所以 Safari 能流式播放视频/PDF）
- 文本 / 代码 / markdown → 拉前 512 KB 显示
- 视频 / 音频 → 原生播放器
- 其它 → 右上角「下载」

### 技能（`/` 快捷调用）

输入框打 `/` 弹出已装技能（本机实测 **197 个**，来自 `skills/list`）。↑↓ 选择，Enter/点击确认，技能会作为 chip 挂在消息上（`{type:"skill", name, path}`）。

### ⚡ Fast 加速档（实测生效）

输入框右侧的 ⚡ 按钮就是 Codex 桌面端的那个"闪电"。点一下变成蓝色 **Fast**，再点关闭。

实测请求体里真的带上了：

```json
{ "method": "turn/start", "params": { "serviceTier": "priority", ... } }
```

取值来自 `model/list` 的 `serviceTiers[0].id`（本机是 `priority`，名字 Fast，说明"2x speed, increased usage"）。模型不支持时按钮自动隐藏；换模型时若新模型没有加速档会自动关闭。

### 插件（新增页签）

「技能与 MCP」面板现在是三个页签：**技能 / 插件 / MCP**。

插件页签实测读到 4 个市场：`openai-primary-runtime`、`openai-bundled`、`context-mode`、`openai-curated-remote`，每个插件显示名字、版本、启用状态和**可直接挂载的技能 chip**：

```text
documents        26.1026.10807  1 个技能   /documents:documents
pdf              26.1026.10807  1 个技能   /pdf:pdf
spreadsheets     26.1026.10807  2 个技能   /spreadsheets:Spreadsheets  /spreadsheets:excel-live-control
presentations    26.1026.10807  1 个技能   /presentations:Presentations
template-creator 26.1026.10807  1 个技能   /template-creator:template-creator
codex-app-tools  26.1027.30824  （只有 MCP 工具，没有技能）
browser / unified-computer-use / computer-use / chrome / visualize  （同上）
```

> 澄清一点：Codex 的"插件"不是一个可以直接调用的函数，它是**技能 + MCP 工具 + app 工具**的集合。所以"调用插件"拆成两条路：它的技能走技能页签（挂到消息上），它的工具走 MCP 页签（直接调）。两条现在都通了。

### MCP 实测调用（context-mode）

不是"列出来"，是真的调了。面板里点 `ctx_stats` → 调用 → 返回：

```text
context-mode  < 1 min  0 calls
No tool calls yet. Use batch_execute or execute to start saving tokens.
  Skipped (1): Codex CLI
$0.00 this session  ·  $0.00 lifetime
v1.0.169
```

另外 `ctx_search` 也调通了（返回"知识库为空"的正常提示）。**没有会话也能调**：会自动开一个临时会话（`ephemeral: true`）承载 MCP 连接，不污染会话列表。

### `/` 检索：修了三个真 bug

| 问题 | 现象 | 修法 |
|---|---|---|
| 命名空间重复拼接 | 显示 `humanizer:humanizer:humanizer` | `skills/list` 返回的 name 本身已带命名空间，不再二次拼接 |
| 描述级匹配污染 | 打 `/hum` 出来一堆不相干的 | 有名字命中时直接丢弃"只在描述里出现"的结果；前缀命中排最前 |
| token 被吃掉 | 选完技能输入框变空，看不出挂了什么 | 保留可见的 `/名称` token；删掉 token 时 chip 自动取消 |

也可以不经过菜单：直接输入 `/名称` 再按空格，效果一样。

### 项目（Projects）

**先纠正一个我自己先前的错误结论**：我一开始查 109 个客户端方法没找到 `project/*`，就断言"协议里没有"。实际上**有 7 个**：

```text
project/list   project/read   project/create   project/import
project/update  project/move  project/delete
```

它们全都标了 `#[experimental]`，而 `codex app-server generate-ts` **默认 `experimental_api: false`，会把实验性请求从产出里过滤掉**（通知不过滤，所以 `project/changed` 一直在）。这是我那份绑定里只有通知、没有请求的原因。

修复用了两步：

```powershell
# 1) 重新生成绑定（767 → 915 个类型文件）
codex app-server generate-ts --experimental --out codex-remote\protocol
# 2) 客户端 initialize 时声明能力（我们本来就带）
{ capabilities: { experimentalApi: true, requestAttestation: false } }
```

本机实测：

```text
project/list -> OK   1 个项目 "Remote"
  roots = C:\Users\…\Codex_Migration_20261031T104701Z
  position = 0    recencyAt = null
```

**项目的真实位置是 app-server 的 SQLite 线程库，不是 config.toml。** `config.toml` 里的 `[projects.'C:\…']` 只有一个 `trust_level` 字段，是 `thread/start` 在写时顺手落下的信任标记，和"项目"列表无关。SQLite 存储不可用时 `project/list` 会返回 `-32601`，所以要按"可选能力"处理。

#### 归属：绝不按 cwd 推断

上一版我用"cwd 落在项目 root 下"来猜归属，**这是错的**。真实来源只有三处：

| 来源 | 说明 |
|---|---|
| `thread/start { cwd, projectId }` | 新建时指定，**两个字段都要发**，互不影响 |
| `thread/metadata/update { projectId }` | 事后改归属（没有 `thread/projectUpdate` 这个方法） |
| fork 继承 | 分叉时继承父线程的项目 |

现在客户端实测发出的参数：

```json
{ "method": "thread/start", "params": {
    "cwd": "<outputs>\\Codex_Migration_20261031T104701Z",
    "projectId": "01a1920c-cfcc-7f83-9028-17f04339287a" } }
```

#### 两套 id 空间的现实

这台机器上同时存在两份项目数据，**id 不同**：

- app-server（SQLite）：`project/list` 给的 `01a1920c-…`，其中 **0 条线程**
- 桌面端（`~/.codex/.codex-global-state.json`）：`b3076195-…`，其中有 **2 条线程归属**

桌面端界面显示的是后者。所以现在的做法是：**以 `project/list` 为准**，再把桌面端注册表按 **root 路径相同** 做一次 id 映射（`b3076195 → 01a1920c`），这样两边的线程都能落到同一个项目分组里；匹配不上的桌面项目作为附加项保留。

界面表现与之前一致：侧栏「项目」分组、文件夹图标 + 名称 + 会话数、点子会话缩进、输入框项目 chip（决定新会话的 `cwd` 与 `projectId`）、标题栏 + 按钮。

### 额度预检 + 空会话回收（解决"新建对话同时存在多个"）

根因有两层，实测确认：

1. 额度用完时 `turn/start` **依然会成功返回**，然后这一轮才失败——这种"已受理后失败"的线程是**持久化且不会回滚**的，于是就留下一个只有一条用户消息的空会话。
2. 但 **`thread/start` 本身不落盘**（代码注释："Fresh threads have no rollout until their first turn"）。所以光点"新建对话"不会产生任何孤儿——真正产生垃圾的是第 1 条。

现在的处理：

1. 连上就 `account/rateLimits/read`，5 小时窗口 `usedPercent >= 100` 或 `ordinaryUsageAllowed === false` 视为耗尽
2. 耗尽时输入框上方直接显示横幅（和桌面端同款）：
   ```text
   Codex 和工作使用额度已用完
   5 小时窗口已用 100% · 将于 11/4 03:37 重置            [查看用量]
   ```
3. **发送直接被拦下**，不入队、不建会话（实测拦下后请求列表为空、侧栏条数不变）
4. 万一仍然发生（比如额度中途耗尽），`turn/completed` 为 `failed` 且这一轮**零助手产出**时，自动 `thread/archive` 收起该会话（用 archive 而不是 delete：这一轮已经写过 rollout，archive 可逆），并把草稿放回输入框

### 左侧栏（只有 4 个入口）

| 图标 | 作用 |
|---|---|
| 首页 | 回到新会话 |
| 技能与 MCP | 两个页签：**技能**（197 个，可搜索，点一下挂到下一条消息，等同输入 `/名称`）；**MCP**（8 个服务器、实测 507 个工具，点工具填 JSON 直接调 `mcpServer/tool/call`）|
| 最近文件 | 上传过的 + 会话里出现过的文件（实测 29 条），每行「查看 / 下载」 |
| 用量 | 套餐、5 小时 / 7 天窗口已用百分比与重置时间、剩余 credits、累计 tokens 与连击天数 |

底部保留一个明暗主题切换（iPad 上确实需要）。

### 用量面板实测输出

```text
PLUS
5 小时窗口   100% 已用   重置 11/4 03:37   <- 就是它挡住了任务执行
7 天窗口      34% 已用   重置 11/8 19:20
剩余 credits  0
累计 tokens   1,015,696,789（单日峰值 83,770,069 · 连续 9 天 · 最长 18 天）
```

### 会话管理

在会话行上**右键**（iPad 上**长按**）→ 重命名 / 归档 / 删除，对应 `thread/name/set`、`thread/archive`、`thread/delete`。

> **列表重复的修复**：`thread/list` 默认会扫 JSONL 做元数据修复，同一条线程可能返回两次。现在改用 `useStateDbOnly: true`，并在客户端按 id 再去重一次：实测 12 条 → **10 条、0 重复**。

## 5.7 排版体检与修复（数据驱动）

用 CDP 在真实浏览器里量，不靠眼睛：`tools/layout-audit.mjs` 会在 1440×920 / 1180×820 / 390×844 三个尺寸下检查
横向溢出、越界元素、固定层相互遮挡，并落三张截图到 `docs/audit-*.png`。

第一次审计结果：

| 尺寸 | 横向溢出 | 越界 | 遮挡 |
|---|---|---|---|
| 1440×920 | 无 | 无 | 无 |
| 1180×820（iPad） | 无 | 无 | 无 |
| 390×844（手机） | 无 | 抽屉左移（正常） | **模型 chip 换行成 3 行并溢出输入框边框** |
| 侧面板打开 | — | — | **面板压住输入框**（panel.left 1008 < composer.right 1278） |

修的三处：

1. **输入框 chip 行禁止换行 + 横向滚动**（`.composer-row { flex-wrap: nowrap; overflow-x: auto }`，隐藏滚动条），窄屏进一步缩小 chip 内边距与字号；`.chip` 加 `white-space: nowrap`
2. **窄屏用短占位文字**：`window.innerWidth < 520` 时改成「描述任务，Enter 发送」，并在 resize 时同步（原来是长句被截断）
3. **侧面板加遮罩**：作为 sheet 出现（`#panelBackdrop`，点击关闭），不再"静默盖住输入框"；手机上面板改为左右各留 8px 的全宽

修复后复测：三尺寸 `overflowX` 全为空，手机截图里 chip 单行、占位文字完整。

### 关于 dsh-pilot

想装 `dsh-pilot`（浏览器操控插件）时遇到的是**架构限制**，不是网络问题：

```text
$ npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile desktop add dsh-pilot
error: profile "desktop" is managed exclusively by the Electron application
```

- 本机用的是 `desktop` profile（`~/.dsh/profiles/desktop`），由 Electron 独占管理，CLI 拒绝写入
- 该 profile 目录里**没有 node_modules**，而 dsh-pilot 的 peer 依赖（`@deepseek-ai/cordis`、`dsh-tools`、`schemastery`）都在应用包内，手工 `npm i` 解析不到
- GUI 的 19387 端口有 401 鉴权，token 只在内存里
- 应用内确实有插件管理页（包名 `@deepseek-ai/dsh-client-ui-settings-plugins`）

正确装法（入口在**左侧栏第二行**，不是设置里）：

1. 左侧栏点 **插件**（「新会话」正下方，插头图标）
2. 点 **添加插件**
3. 包名填 `dsh-pilot`（可选版本后缀），按 Enter 或点 **安装**
4. 装完点 **立即启用**
5. 若提示需要重载，重启应用

那个页面就是插件管理器（包名 `dsh-client-ui-plugin-manager`），支持包名 / Git 地址 / 压缩包 / 本地绝对路径，还能选 npm 官方源或中国大陆镜像源。装好后 agent 的工具里会出现
`pilot_navigate / pilot_snapshot / pilot_act / pilot_wait / pilot_screenshot / pilot_close`。

## 5.8 右侧 Dock：面板与文件预览共用一块区域

以前侧栏面板是浮层、文件预览是模态框，两套东西会互相盖住。现在只有**一块右侧 Dock**：

- 侧栏四个入口（技能与 MCP / 最近文件 / 用量）打开的都是它
- 点会话里的路径 chip、附件 chip、`imageView` 卡片、最近文件的「查看」，**也开在同一个位置**
- 宽度 `--dock-w: 420px`，从顶部到底部整列；≥1000px 时对话区自动让位（`main { margin-right: 420px }`），不再压住输入框；<1000px 时占满宽度
- 模态遮罩已删除——它是真正的布局列，不是弹窗

### 文件预览支持

| 类型 | 行为 |
|---|---|
| `.md` / `.markdown` / `.mdx` | **渲染成 markdown**（标题/列表/代码块/链接），带「预览 / 源码」切换 |
| `.html` | 「预览 / 源码」切换；预览跑在 `<iframe sandbox="">` 里（脚本与本站存储隔离） |
| 代码 / 文本 / json / toml … | 源码视图（等宽、换行、上限 512 KB） |
| 图片 | 直接显示 |
| 视频 / 音频 | 原生播放器 |
| 其它 | 只给「下载」 |

> HTML 预览的边界：因为沙箱禁脚本，**依赖外部 JS 的页面（例如 Vite 打包出来的 SPA 壳）会显示为空白**，Dock 里会显示一行说明提示切到「源码」。自包含的 HTML（报告、表格、静态页）能正常渲染。

### 顺带的两处调整

- **侧栏文本单行 + 左对齐**：会话名、项目名都是 `white-space: nowrap` + 省略号，不再折成两行
- **去掉侧栏的「Codex」品牌按钮**（它点了只弹 toast，是个假控件）
- **首屏加载并行化**：`project/list`、`account/rateLimits/read`、`model/list`、`skills/list` 一起发，再取线程列表——实测首屏从 15 秒降到 **3.5 秒**

## 5.9 对话标题栏的实时用量条

每个对话的标题栏右侧现在是四个胶囊：

```text
上下文 35%   tokens 412.0k   命中率 82%   5h 额度 100%
```

| 指标 | 算法 | 数据来源 |
|---|---|---|
| 上下文 | 本轮 `last.totalTokens / modelContextWindow` | `thread/tokenUsage/updated` 或 `rawResponse/completed` |
| tokens | 本会话累计 `total.totalTokens` | 同上 |
| 命中率 | 本轮 `cachedInputTokens / inputTokens` | 同上 |
| 5h 额度 | `primary.usedPercent` | `account/rateLimits/read`（全局，一直有）|

颜色：≥65% 变黄、≥85%（额度是 ≥70% / ≥90%）变红，一眼能看出快满。

窄屏自适应：<1100px 隐去文字标签只留数值，<700px 整条隐藏。

### 一个必须说清的限制

**历史对话拿不到用量。** 我查过所有可能的口径：

- `Turn` 没有 usage 字段
- `account/usage/read { threadId }` 在本机返回空对象（SQLite 里没有 per-thread 用量）
- `model/list` 与 `modelProvider/capabilities/read` 都不给上下文窗口大小

用量只存在于两条**实时通知**里（`thread/tokenUsage/updated`、`rawResponse/completed`），也就是只有这个会话在本机跑过至少一轮之后才有数。所以刚打开一个历史会话时，前三个胶囊显示 `—`（悬停有说明），跑起来就会自动填充。

上下文窗口会按模型记在 `localStorage`（`codex-remote-ctx`），下次同一模型开新会话时，第一轮就能直接算出百分比，不用等第二次通知。

## 5.10 会话常驻上游：关页、刷新、断网都不丢

以前每个浏览器 socket 独占一条上游连接，关页就等于把 app-server 那条连接掐了。现在改成**会话级常驻上游**：

- 会话 id 由登录 cookie 派生（`sha256(cookie).slice(0,24)`），所以刷新、关页、锁屏、网络抖动都回到**同一条** app-server 连接
- 浏览器 socket 只是这条会话的**订阅者**；断一个订阅者不影响会话，也不影响里面正在跑的轮次
- 重连时把仍待人工决定的请求（审批卡片）**原样重放**给新订阅者
- 重复的 `initialize` 由桥接**用缓存应答**，不会去重初始化上游（协议不允许）

### 实测（真实任务，非桩）

```
client A: turn/start 后 1.2s 收到 16 条通知，断开
client B: 1.5s 后重连同一会话
        → 又收到 118 条通知（其中 98 条 item/agentMessage/delta）
        → turn/completed，最终 status=completed
```

也就是说断线期间任务在跑，重连后流式输出继续接到新页面上。

### 看门狗：常驻带来的新风险及兜底

常驻的代价是「上游一卡，刷新也救不回来」（同 cookie 同会话）。所以补了两层：

| 机制 | 行为 |
|---|---|
| 看门狗 | 每条客户端请求登记；**20 秒没有应答**就判定上游僵死，拆掉重建 |
| `POST /api/session/reset` | 手动重置该 cookie 的会话，返回 `{ok, found}` |
| 重置动作 | 终止上游 + 关闭订阅者 socket；浏览器自动重连、重新初始化、重跑启动读取 |

实测：`A 正常 → reset(200, found:true) → A 的 socket 被关闭 → B 重连 initialize ok、thread/list 5 条`。

## 5.11 手机上传：三个真实入口 + 微信引导

回形针不再是一个通用选择器，而是一个菜单（桌面端同样走这个菜单）：

| 入口 | `accept` / 属性 | 用途 |
|---|---|---|
| 照片 / 视频 | `image/*,video/*` | iOS 直接进照片图库 |
| 拍照 / 录像 | `image/*,video/*` + `capture=environment` | 直接开相机 |
| 任意文件（微信下载/文件 App） | `*/*` | 走到系统「文件」App，能进微信目录 |
| 从微信取文件…… | — | 打开右侧 Dock 的分平台步骤说明 |

**为什么需要说明页**：微信聊天文件在微信自己的沙盒里，网页（包括微信内置浏览器）**拿不到**——这是平台限制，不是实现问题。所以：

- 内置浏览器检测（UA `MicroMessenger`）→ 顶部提示「点右上角 ⋯ → 在浏览器打开」
- 说明页给出精确路径：iOS 走「存储到文件 → 我的 iPhone/微信」；Android 走「内部存储 → tencent → MicroMsg → Download」

> 理论上能做得更进一步的是 Android PWA 的 `share_target`（从微信「分享」直接进本应用），但它要求 HTTPS + 已安装 PWA，当前是 tailnet 上的 http，所以没做。

## 5.12 顺手修掉的启动崩溃

指标条上线后引入了一个真实 bug：`renderMetrics` 里只判断了「已知上下文窗口」，没判断「本轮用量」——

```js
ctxTotal ? '本次请求占用 ' + fmtTokens(last.totalTokens) ...   // last 可能是 null
```

凡是 localStorage 里**记住过窗口**的浏览器（也就是跑过至少一轮的），一启动就 `TypeError: Cannot read properties of null (reading 'totalTokens')`，`loadQuota` 抛出 → `Promise.all` 全挂 → `loadThreads` 根本不执行 → **侧栏永远空着**。干净浏览器（没有缓存窗口）反而不触发，所以很容易漏。

已修：区分「有窗口无用量」和「两者都有」两种文案。同时给 `onConnected` 的每一步加了 `console.error` 上报，同类问题以后会直接出现在控制台。

## 5.13 移动端布局修复

「手机上侧边栏没了」的根因不是侧栏本身，而是小于 900px 时 `rail` 被 `display: none` 隐藏——顺带把**技能与 MCP / 最近文件 / 用量**的唯一入口也一起藏了。这一轮把整条移动端链路重做了一遍。

| 问题 | 以前 | 现在 |
|---|---|---|
| 导航入口 | 窄屏直接 `display:none`，四个面板无处可达 | **底部标签栏**（首页/技能/最近文件/用量/主题），`52px + safe-area` |
| Dock 宽度 | `width:100vw` 实测右移出屏 **8px** | `left:0; right:0; width:auto`，实测 `x=0 w=390` |
| 发送按钮 | 在横向滚动的 chip 行里，窄屏被**裁出视野** | 移出滚动区，`.composer-line` 里固定右侧，永远可见 |
| 标题栏指标 | 媒体查询只看视口，Dock 一开对话区变窄就**竖排**（「上 下 文」） | 改用 `@container convo`，按对话列宽降级：<820px 去标签，<520px 整条隐藏 |
| 技能/工具行 | 长 id（`app-<uuid>:name`）撑破面板，描述折三行 | 名字与描述各占一行、超长省略；手机上名字一行 + 描述一行 |
| 首页输入框 | 底部留 `16vh`，手机上近 1/5 屏是空的 | 窄屏降到 `5vh` |
| 抽屉 | 层级与遮罩未对齐 | 抽屉 46 / 遮罩 44 / 标签栏 45，点遮罩关闭 |

### 实测数据（390×844）

```
rail        : flex, {x:0, y:792, w:390, h:52}
composer    : {y:669, bottom:792}
overlap     : clear（输入框底边正好贴标签栏顶边，不重叠）
技能/MCP   : dock 390×792, title=技能与 MCP
最近文件    : dock 390×792
用量        : dock 390×792
drawer      : open → 点遮罩 → closed
JS errors   : []
```

iPad 横屏（1180×820）也复测过：导轨恢复竖排 64px、侧栏常驻、Dock 401px 且对话区仍有 423px，标题栏不再竖排。

### 顺带：本地回环不再被登录限流

测试中被「8 次失败 / 5 分钟」挡住（脚本反复登录）。改成 **来自 `127.0.0.1`/`::1` 的登录请求不限流**——本机就是主人，限流只为挡局域网暴力尝试。

## 5.14 思考强度：Codex 风格滑块弹层

原来点「低/中/高」是一个普通菜单列表。现在换成和桌面端一致的弹层：

- 顶部：⚡ 图标 · 当前档位（蓝色加粗）· 重置按钮
- 中间：模型名（点一下切模型）
- 滑块：蓝色已选段带白点、灰色未选段带灰点、白色圆形滑块；下面一排档位文字，当前档高亮
- 键盘可用（方向键）、Esc 关闭、点外部关闭；宽度 <520px 时铺满

档位来自 model.supportedReasoningEfforts，只显示模型真实支持的级别（当前 6 档：低/中/高/极高/最大/极限）。

### 闪电 = Fast 加速档开关

和桌面端一致：弹层左上角那个 ⚡ 本身就是 Fast（priority service tier）开关，输入框下方原来的 `⚡ Fast` chip 已删除。

- 关：灰色描边图标；开：蓝色填充 + 淡蓝底，标题旁出现 `Fast` 徽标
- `aria-pressed` 同步，键盘可操作；切换有 toast 说明「2x speed, increased usage」
- 选择记在 `localStorage`（`codex-remote-fast`），刷新后保持
- 发送时作为 `turn/start` 的 `serviceTier` 传给 app-server（沿用原有链路，未改动）
- 当前模型没有 serviceTiers 时，这个按钮会自动隐藏并把状态归零

实测：

```text
fast chip gone : true
composer chips : [projectBtn, modelBtn, effortBtn]
bolt click     : state.fast=true, aria-pressed=true, Fast 徽标出现
再点一次       : state.fast=false, 徽标消失
```
## 5.15 微信文件：先说做不到的，再说做到的

### 做不到：网页唤起微信「选择聊天文件」

这是平台限制，不是实现问题：

- wx.chooseMessageFile 只能在微信内置浏览器里用，且必须先过 **公众号 AppID + JS-SDK 签名**（后端换 jsapi_ticket），还要求页面在公众号的「JS 接口安全域名」里、域名已备案、走 HTTPS。
- 顺带的坏消息：这台机器所在的 tailnet **不支持签发 TLS 证书**——实测 tailscale serve --https 与 tailscale cert 都返回 "your Tailscale account does not support getting TLS certs"。没有 HTTPS 就没有安全上下文，Android 的 **PWA 分享目标**（从微信「分享 → 保存到本应用」）也一并装不上。

### 做到了：微信文件落到本机后，一键挂载

微信 4.x 把收到的文档**保留原文件名**存在：

```text
%USERPROFILE%\Documents\xwechat_files\<账号>\msg\file\<YYYY-MM>\<原始文件名>
```

（图片进的是哈希命名的 msg\attach\*.dat 缓存，拿不到原名，所以只列文档类。）

桥接新增 GET /api/wechat-files?days=60&limit=60，扫描上述目录（3.x 的 WeChat Files\<账号>\FileStorage\File 也兼容），按修改时间倒序返回。

前端在回形针菜单里加了「**微信收到的文件（本机）**」：列出最近文件，点「挂载」直接把它作为附件塞进下一条消息——**不重新上传**，因为 Codex 的附件本来就是本机路径（localPath / mention），app-server 自己读盘。

实测（390×844，iPhone UA）：

```text
菜单     : 照片/视频 · 拍照/录像 · 任意文件 · 微信收到的文件（本机） · 从微信取文件……
面板     : 「微信收到的文件」1 行
文件     : Codex_Migration_20261031T104701Z(1).zip  52.6 MB · 10/31 19:47 · 微信
点挂载后 : 输入框出现 1 个附件 chip，面板自动关闭，JS 报错 0
```

### 手机上的实际用法（3 步）

1. 手机微信里长按文件 → **转发 → 文件传输助手**
2. 网页点回形针 → **微信收到的文件（本机）**
3. 点 **挂载** → 文件随下一条消息发出

比走系统文件管理器进 tencent/MicroMsg/Download 找文件要快，也不会因为微信重命名或清缓存而找不到。
## 5.17 仅传输文件（网页版）怎么挂载

`szfilehelper.weixin.qq.com` 是**网页版**文件传输助手：文件不经过微信客户端的存储目录，而是走浏览器的下载通道。所以盯 `xwechat_files` 永远看不到它。

### 做法：盯下载目录 + 用浏览器自己的下载记录判定来源

- 桥接新增 `/api/inbox`，把两个来源合并：微信客户端的文档 + 浏览器下载目录（默认 `~/Downloads`、`~/下载`）
- 来源判定读 Edge / Chrome / Brave 的 `History`（**先复制再以只读方式打开**，用内置 `node:sqlite`），查 `downloads` 表 + `downloads_url_chains`，看 referrer / URL 链里是否含 `weixin.qq.com` 或 `szfilehelper`
- 判定为微信来源的文件标记 `origin: weixin`，**自动挂载**；其它下载标记 `origin: other/unknown`，默认不动
- 面板里两行开关：「新收到的微信文件自动挂载」（默认开）、「其他浏览器下载也挂载」（默认关）

### 实测

```text
/api/inbox 分类: 7z2605-x64.exe → download/other（bing 来源）
                 ChatGPT Installer.exe → download/other
                 Codex_Migration_...zip → wechat

门控测试: 未知来源下载 + 开关关 → 0 chips（不打扰）
          打开「其他浏览器下载也挂载」+ 再下载 → 1 chip（自动挂上）
```

### 用法

1. 在 `szfilehelper.weixin.qq.com` 页面里点文件的**下载**
2. 文件落进 `~/Downloads`，4 秒内自动挂到输入框

如果微信页面用的是「另存为」让你选目录，选到 `Downloads` 就行；如果下载后**没有**自动挂上，说明浏览器的下载记录没能把来源判成微信（比如用了 File System Access API 或隐私模式），把面板里第二个开关「其他浏览器下载也挂载」打开即可。

### 边界

- 只认文档类扩展名（pdf/docx/xlsx/zip/md/txt…），图片仍排除（微信客户端里是哈希 `.dat`）
- 浏览器 History 每 15 秒缓存一次；刚下载的文件最多等 15 秒才被判定为微信来源
- History 被浏览器独占时复制可能失败，这时全部按 unknown 处理（需要第二个开关）
## 5.16 微信文件自动挂载

目标：本机微信登录（含「仅传输文件」模式）后，其他设备发给「文件传输助手」的文件，**到达即自动挂到输入框**，不用点任何按钮。

### 实现

- 桥接新增 `GET /api/wechat-watch`（SSE）。启动时先给磁盘上的历史文件打基线，之后每 4 秒扫一次 `msg\file`，按 `path + mtime` 判断新文件并推送 `file` 事件。
- 前端用 `EventSource` 订阅；收到新文件就 `state.attachments.push(...)` + 重绘附件区 + toast，**零上传**（附件本来就是本机路径）。
- 已挂载的文件记在 `localStorage`（`codex-remote-wx-seen`，上限 300 条），刷新页面不会重复挂；同一路径已在输入框里也会跳过。
- 面板里有「新收到的文件自动挂载」开关（`codex-remote-wx-auto`），默认开。

### 实测

在真实微信目录 `xwechat_files\wxid_...\msg\file\2026-11\` 落一个文件模拟手机转发：

```text
before : 0 chips
dropped: 自动挂载测试_报告.txt
after  : 1 chip  → 自动挂载测试_报告.txt  70 B
console: wechat watcher connected
```

页面没有任何点击操作，chip 自己出现。

### 为什么「其他账号（仅传输文件）」发的文件不出现

实测结论：**微信没把它写到磁盘**。

- 全盘只有 `wxid_t488viizdxam22_d018` 一个账号目录（另一个账号登录后并没有生成新的 `wxid_*` 目录）
- `msg\file` 里仍然只有 10/31 那个 zip
- 最近 45 分钟用户目录里唯一的文档就是那张 jpg（在 `temp\RWTemp`）

微信在文件是「未下载」状态时只留消息记录、不落盘，于是扫描器看不到。对策：

1. 在电脑版微信里**点开那个文件一次**，它才开始下载到 `msg\file`，随后 4 秒内自动挂载
2. 或者把微信设置里的「自动下载」打开

扫描器本身已经放宽：不再只看 `msg\file`，而是遍历整个账号目录（排除 db/cache/temp 等），按扩展名白名单收文档，深度 5 层；面板上有「刷新」和「扫描 N 个账号目录 · M 个文档」的诊断行，空列表时还会直接提示「未下载的文件不会落盘」。
### 行为边界

- **实时**：文件落地后 4 秒内挂上。
- **不补挂历史**：桥接启动时已在磁盘上的文件只做基线，不会开机刷出一堆旧文件；它们仍在「微信收到的文件」列表里可手动挂载。
- **图片不进列表**：微信把图片存成哈希命名的 `msg\attach\*.dat`，拿不到原名，所以只处理文档类（pdf/zip/docx/xlsx/txt 等）。
- 关掉网页期间到达的文件不会在重开后自动挂，需要开页后再发一次，或在列表里手动挂。
## 5.18 微信文件传输：扫码登录接进网页

微信「仅传输文件」窗口是一个网页应用 `szfilehelper.weixin.qq.com`，它的会话只在**页面内存**里，而且登录二维码图片接口对普通 HTTP 客户端返回 0 字节（风控）。所以桥接的做法是：

- 维护一个**专用调试窗口**（独立配置 `%LOCALAPPDATA%\codex-remote-webtransfer`，端口 9333）
- 通过 CDP 把窗口里的二维码**截成 PNG**，由 `GET /api/wechat/qr` 交给我们的网页显示
- `GET /api/wechat/state` 报登录态与账号名；`POST /api/wechat/reset` 换一张新码（切换账号）
- `GET /api/wechat/messages` 从页面 DOM 解析文件消息（`a.msg-file` / `.msg-file__title` / `.msg-file__desc`）
- `POST /api/wechat/download {index}` 用 CDP 派发**可信鼠标事件**点击 `a.icon__download`

面板入口：回形针 → **微信文件传输（扫码登录）**。未登录显示二维码（每 4 秒刷新），登录后显示账号名 + 文件消息列表 + 「下载并挂载」+「切换账号」。

### 协议（抓包所得，供后续做纯服务端实现）

```text
GET  login.wx2.qq.com/jslogin?appid=wx_webfilehelper  → window.QRLogin.uuid
GET  login.wx2.qq.com/cgi-bin/mmwebwx-bin/login?...   → window.code=200 + redirect_uri
GET  .../webwxnewloginpage?ticket=&uuid=              → skey / wxsid / wxuin / pass_ticket
POST .../webwxinit   {BaseRequest:{Uin,Sid,Skey,DeviceID}}
GET  .../synccheck   → 长轮询
POST .../webwxsync   → AddMsgList[]；文件消息 MsgType=49，
     Content 里是 XML：<title>文件名</title><totallen>字节</totallen><attachid>@cdn_…</attachid>
GET  file.wx2.qq.com/cgi-bin/mmwebwx-bin/webwxgetmedia → 加密字节（页面负责解密）
```

### 当前状态与已知问题

已验证：扫码 → 登录 → 网页显示账号名 → 列出文件消息（实测 `中国国有企业改革…pptx / 59.74MB`）→ 点击触发 `webwxgetmedia` 请求。

未完成：页面在点击后进入 `progress` 状态且长时间不落盘（`fetch → 解密 → blob → 保存`，所以没有 `.crdownload` 可观察）。需要确认是页面自身在该状态下卡住，还是合成点击的问题；备选方案是解析 `MsgId`+`attachid` 后**在服务端下载并解密**，绕开页面。
## 5.19 微信文件传输：全链路已跑通

**入口**：回形针 → **微信文件传输（扫码登录）**。

| 环节 | 实现 |
|---|---|
| 扫码登录 | 桥接维护一个专用调试窗口（独立配置，端口 9333），把窗口里的二维码**截成 PNG** 给网页显示（微信的图片接口对普通 HTTP 客户端返回 0 字节） |
| 切换账号 | 面板「切换账号」→ `POST /api/wechat/reset` 让窗口回到新二维码 |
| 列文件 | `GET /api/wechat/messages` 解析页面 DOM（`.msg-file__title` / `.msg-file__desc`） |
| 触发下载 | `POST /api/wechat/download {index}` 用 CDP 派发**可信鼠标事件**点 `a.icon__download` |
| 挂载 | 文件落到 `~/Downloads` → inbox 监听按浏览器下载记录识别来源 `weixin` → SSE 推送 → 自动挂到输入框 |

**实测（390×844）**

```
[12s] Downloads 出现 中国国有企业改革…(7).pptx
[27s] 输入框出现 chip：中国国有企业改革_30分钟_35页… 59.7 MB
      toast：下载完成 中国国有企业改革…(7).pptx，已自动挂载
```

### 过程中修掉的两个真 bug

1. **来源判定漏了专用窗口**：`downloadOrigins()` 只读默认 Edge 配置的 `History`，而从调试窗口触发的下载记在 `%LOCALAPPDATA%\codex-remote-webtransfer\Default\History`。加上这个 profile 后，所有微信窗口下载都被正确标成 `weixin`。
2. **`unknown` 被当成已处理**：文件刚落盘时浏览器还没写下载记录，来源是 `unknown`；监听第一次看到就标记为已处理，之后来源变成 `weixin` 也不会再广播。改成「来源 unknown 时不标记，下一轮再看」。
3. **source 名字不一致**：桥接广播 `source: 'weixin'`，客户端只认 `'wechat'`/`'download'`，策略直接返回 false。两边统一。

### 说明

- 大文件（60MB）在页面里下载约需 2~3 分钟，期间行内图标显示进度；没有 `.crdownload` 可观察（页面是 fetch → 解密 → blob → 保存）
- 服务端直接下载+解密（`bridge/wechat-fetch.mjs`）已写好但**默认关闭**（`config.json` 里 `wechatServerFetch: true` 可启用）：CDN 对跨域 fetch 返回 CORS 错误或 0 字节，目前只有页面这条路可用
- 那个调试窗口**不能关**（会话只在内存里），最小化即可
## 5.20 附件真的被读到了 + 两处渲染修复

### 问题一：附件只发了个路径，agent 读的是当前目录

现象：消息里能看到文件名，但 agent 去 `ls` 当前目录、总结的是目录里的东西。

原因：`mention` 传的是**工作区之外的绝对路径**（`C:\Users\...\Downloads\xxx.pdf`），模型只把它当成一个名字。

修复：发送前通过 `POST /api/attach/import` 把文件**复制进当前会话的 cwd**（`.attachments/<name>`，重名自动加序号），然后：

- `mention` 的 `name` 用**相对路径**（`.attachments/xxx.pdf`）
- 文本里再补一行 `@.attachments/xxx.pdf`，双保险

关键点：cwd 必须取**当前会话的** `thread.cwd`（`state.currentCwd`），不能用 `defaultCwd`——两者经常不同，用错就会复制到别的项目里。

实测：

```
mention name = .attachments/Zhang+等+-+2025+-+JailGuard+….compare-1.pdf
path         = <workspace>/….attachments/…-1.pdf
agent 回答    = 该文研究大语言模型及多模态大语言模型中的文本和图像越狱攻击检测问题…
```

### 问题二：命令卡片的「退出码」竖排成一列

`.status-pill` 是 flex 子项，默认会被压缩；`.step-sub`（命令文本）没有 `flex-shrink` 限制，把 pill 挤到接近 0 宽，中文逐字换行就竖过来了。

修复：`.status-pill { flex: none; white-space: nowrap }`、`.step-title { flex: none }`、`.step-sub { flex: 1 1 auto; min-width: 0 }`。

### 问题三：`:codex-file-citation{…}` 原样显示

模型输出里的来源标记被当成普通文本渲染。现在 `md()` 会把它换成「（来源：文件名）」。
## 5.21 context-mode：网页端与本地 Codex 都真正生效

### 做了什么（四个缺一不可）

| 步骤 | 内容 | 为什么 |
|---|---|---|
| 1. 打开 hooks 特性 | `~/.codex/config.toml` 里加 `[features] plugin_hooks = true` / `hooks = true` | 不打开，插件 hooks 一律不执行 |
| 2. 升级插件 | 1.0.169 → **2.0.0**（从本地 marketplace 目录换成 npm 2.0.0 包，零依赖） | v2 修了 Codex 适配，且不再需要 36 MB 的 node_modules |
| 3. 修 v2 清单 | `mcp.json` 里 `node` 与 `server.mjs` 改**绝对路径**、`cwd` 固定 `<workspace>` | Codex 不把会话 cwd 传给 MCP，`./server.mjs` 会解析到错误目录导致握手失败 |
| 4. 建立可信 hooks | `context-mode setup --agents codex -y`（`CM_HOOK_OVERHEAD_BUDGET_MS=150`） | 插件自带 hooks 的哈希与旧信任记录对不上 → Codex 视为 untrusted、不执行 |

### 第 4 步的坑

setup 默认要求 hook 开销 p95 ≤ 15 ms，Windows 上 node 冷启动就 20 ms，会被回滚（`hook overhead p95 20 ms > 15 ms (rolled back)`）。
用 `CM_HOOK_OVERHEAD_BUDGET_MS=150` 放宽后 PASS。

setup 生成/修改：`~/.codex/hooks.json`（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse）、
`config.toml` 的 `[mcp_servers.context-mode]` 与四条 `[hooks.state."...hooks.json:..."]` 信任记录、以及三个技能 `ctx-doctor` / `ctx-stats` / `ctx-upgrade`。

### 让模型真的去用它

`~/.codex/AGENTS.md` 增加了一节规则（大文件/日志用 `ctx_execute`、多命令用 `ctx_batch`、反复查先 `ctx_index`、被拒不要重试）。
全局文件，桌面端与网页端共用。

### 实测

网页会话（390×844，cwd=<workspace>）：

```text
问题：统计 314KB 日志里 status=500 的数量 + 前 3 个 route
command items: 0        ← 一条 shell 都没走
mcp calls    : 5        ← ctx_resume, ctx_execute ×3, ctx_doctor
答案         : 572      ← 正确，且在本地算完
hook runs    : 12
enforcement  : deny-reason（D10 PASS）
```

本地 CLI（同一套配置）：`codex exec --cd <workspace> ...` 同样返回 `572`，`ctx_stats` 里 `By agent: codex` 计数随之增加。

### 仍然存在的两条 warning（不影响使用）

- `D3/D5`：`ctx_doctor` 报「plugin hooks untrusted」——实际生效的是 setup 写入的**全局 hooks.json**（已验证 pre-tool-use 在跑、拦截模式 deny-reason），插件自带那份没被信任只是冗余。
- `D11`：没装 Git Bash。`ctx_execute` 用 `powershell` / `javascript` 都正常，装 Git for Windows 可以消除这条提示。
## 5.22 QGIS MCP 端到端：上传 → 处理 → 返回文件

测试用例：上传 5 个点的 GeoJSON → 让 agent 用 QGIS MCP 做 10 km 缓冲区 → 返回 GeoJSON。

### 结果

```text
upload    /api/upload  -> %TEMP%\codex-remote\mw2gjmn7-points.geojson
import    /api/attach/import -> <工作区>\.attachments\mw2gjmn7-points.geojson
agent 调用 qgis MCP 7 次：
  add_vector_layer    -> 5 features
  get_algorithm_help  -> native:buffer
  get_layer_extent    -> 117.16..117.3 / 31.79..31.9
  execute_processing  -> native:reprojectlayer (EPSG:4326 → EPSG:32650)
  execute_processing  -> native:buffer (10 km)
  export_layer        -> buffer.geojson（30,330 字节）
  add_vector_layer    -> 复核 5 features
耗时 39 秒，输出 5 个 MultiPolygon，EPSG:4326
```

文件在网页端可直接预览（右侧 dock）并下载（`/api/file?path=…&download=1`），点开后也会进入「最近文件」。

### 修掉的三个问题

| # | 问题 | 原因 | 修复 |
|---|---|---|---|
| 1 | 任务卡住不动，5 分钟没有任何 qgis 调用 | MCP 工具调用要审批，客户端没应答 → 一直等 | `[mcp_servers.qgis]` 加 `default_tools_approval_mode = "approve"` |
| 2 | `qgis/add_vector_layer -> failed: user rejected MCP tool call` | 网页端把 elicitation 当普通审批，回 `{decision}`；MCP 要 `{action, content, _meta}` | `app.js` 的审批卡片按方法分支；elicitation 回 `{action:"accept"\|"decline", content, _meta}`，标题/正文/按钮也改成 MCP 专用 |
| 3 | 返回的 `.geojson` 只能下载、不能预览 | 桥接 MIME 表没有地理格式 | 补 `.geojson/.topojson/.gpx/.kml/.csv`，并把它们加进前端的文本预览列表 |

### 排查经验

- **QGIS MCP 只是代理**：真正干活的是 `localhost:9876` 上的 QGIS 实例（本次为 QGIS 3.44.15，插件监听）。
  判断 server 是否健康，别用 `mcpServerStatus/list + threadId`（会卡 >180 s），直接用 stdio 起 server 走一遍 MCP 握手（`tools/qgis-stdio-probe.mjs`）：initialize 2 s、125 个工具、单次调用 35 ms 即为正常。
- 有 tool call 在等审批时，桥接日志里能看到 `pending request item/commandExecution/requestApproval id=…` 且没有对应的 `answered`。
- QGIS 打开过的目录会被占用，测试目录要每次换新（`EPERM` 就是它）。

### 已知限制

「最近文件」只记录**你打开过的**文件；agent 新生成的文件要等你点一次它的链接才会进列表。
## 5.23 审批方式选择器（对齐 Codex 三档）

composer 里新增一枚盾牌 chip（默认「请求批准」），点开是三档，与 Codex 桌面端一一对应：

| 档位 | approvalPolicy | approvalsReviewer | sandboxPolicy | 实测行为 |
|---|---|---|---|---|
| 请求批准 | `on-request` | `user` | `workspaceWrite`，roots=[会话 cwd]，`networkAccess:false` | 写工作区外文件 → **弹出审批卡片** |
| 帮我批准 | `on-request` | `auto_review` | 同上 | 同样的写入 → **自动审查放行，不打扰用户** |
| 完全访问 | `never` | `user` | `dangerFullAccess` | 同样的写入 → 直接成功，无审批 |

选择存在 `localStorage['codex-remote-access']`，切到「完全访问」时 chip 变红并弹提示。
发送时同时作用于 `thread/start`（`approvalPolicy` / `approvalsReviewer` / `sandbox`）和 `turn/start`（`approvalPolicy` / `approvalsReviewer` / `sandboxPolicy`），所以老会话改档也立即生效。

### 踩到的坑

`SandboxPolicy.workspaceWrite.networkAccess` 是 **boolean**，不是 `"restricted"` 字符串：
写成字符串会让 `turn/start` 直接报 `Invalid request: invalid type: string "restricted", expected a boolean`，
也就是「请求批准 / 帮我批准」两档完全发不出去。`NetworkAccess` 枚举只用于 `externalSandbox`。

另外：chip 的事件绑定最初被我放进了 `wireModePop()`（只有打开思考弹层才执行），导致点击无反应；已移到启动绑定段。
## 5.24 选择器收放、重复发送、网络面板

### 修掉的两个问题

| 问题 | 原因 | 修复 |
|---|---|---|
| 模型 / 项目 / 思考 chip 点第二下收不回去（只能点空白处关） | `openMenu()` 每次都先 `closeMenu()` 再重新展开，没有 toggle | 记录 `menuAnchorEl`，同 chip 第二次点击直接关闭 |
| 连点两次发送会开两个会话 / 跑两轮 | `send()` 只在 `state.busy` 为真时返回，而 `busy` 要等 `loadQuota` / `thread/start` 之后才置位 | 入口处立刻置 `state.sending`，`finally` 复位；真正的发送体拆到 `_send()` |

实测：三个 chip 都是 `closed-on-second-click=true`；并发调用两次 `app.send()` 只发出 1 个 `thread/start` + 1 个 `turn/start`。

### 网络面板（导航栏第 5 项 · 地球图标）

桥接新增三个接口，全部走 Clash 的外部控制器（默认 `http://127.0.0.1:9097`）：

| 接口 | 作用 |
|---|---|
| `GET /api/clash` | 模式、混合端口、4 个策略组及其节点（含上次测速延迟） |
| `POST /api/clash/select` `{group,node}` | 切换指定策略组的节点 |
| `POST /api/clash/test` `{group?,node?}` | 节点延迟（`/proxies/{name}/delay`）+ **Codex 连通性**（新建 app-server 连接跑 `account/rateLimits/read`，返回毫秒数、已用额度或失败原因） |

面板内容：模式/端口/组数 → 策略组 tab（GLOBAL / 故障转移 / 自动选择 / 良心云）→ 当前节点 → 节点列表（延迟按 <300 / <800 / 更慢着色，`0` 视为未知显示 `—`）→ 测试按钮。

实测一轮（节点 🇯🇵日本高速04）：

```text
节点延迟：141ms
Codex：连通 · 834ms
```

同一分钟里换到被墙的节点会变成 `Codex：失败（failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)）`，这正是这个面板要暴露的信息。

切换验证：`良心云` 组 🇯🇵日本高速04 → 🇸🇬新加坡高速01（`ok:true`）→ 再切回 🇯🇵日本高速04，`matches original: true`。

### 移动端适配

- 底部 tab 现在是 6 项（首页 / 技能 / 文件 / 用量 / 网络 / 主题），390px 宽度下仍是一行。
- 面板：节点列表限高 `34vh` 独立滚动，行内文字省略号截断，测试按钮整宽。
### 为什么「网页里切的节点和 Clash Verge 显示的不一样」

一度以为面板连到了别的 Clash，实际排查结论：**确实是本机同一个核心**——只有 `127.0.0.1:9097` 一个控制器在线（9090/9091/9099/6170 全部 ECONNREFUSED），`/configs` 显示 `mode: rule`、`mixed-port: 7897`、`tun: true`。

真正的原因是**切错了组**：面板默认落在 `GLOBAL`，而规则模式下 `GLOBAL` 不参与路由。
`/connections` 里真实流量走的是：

```text
26x  DIRECT
 8x  良心云 > 🇯🇵日本高速04|BGP|CUCM
 4x  良心云 > 🇸🇬新加坡高速01|BGP|CTCUCM
```

所以在 GLOBAL 里改节点，Clash Verge 当然「看起来没变」。

修复后 `/api/clash` 会带回 `liveChains` / `inUse` / `defaultGroup`：

- 面板**默认打开实际在用的组**（当前为 `良心云 ·在用`）
- 顶部列出「当前生效链路」，直接显示 组 → 节点（N 条连接）
- 规则模式下 `GLOBAL` 标为虚线 idle，点开会提示「GLOBAL 不会影响实际流量，实际生效的是：良心云」
- 嵌套组（`自动选择` / `故障转移`）带 `›` 可下钻，`剩余流量 / 套餐到期` 这类订阅信息行置灰不可点
- 「重新读取」按钮刷新状态与实时链路
- 切换提示改为「已切换到 X（新连接生效，旧连接保持原节点）」，避免误以为立刻全量生效
### 顺手修的安全问题（重要）

排查节点问题时发现：除了 `/healthz`、`/api/me`、`/api/login`、`/api/logout`，**其余 API 全都没有鉴权**，
局域网 / Tailscale 内任何设备不带密码就能调用：

```
/api/session/reset     杀掉上游会话
/api/wechat/download   触发下载并落盘
/api/wechat/qr         拿登录二维码
/api/inbox             读微信消息
/api/clash/select      改你的代理节点
/api/attach/import     把任意文件复制进工作区
```

现在全部走 `requireAuth()`，未登录一律 401；登录后功能不变。实测：

```
/api/projects -> 401   /api/clash -> 401   /api/wechat/state -> 401
/api/inbox    -> 401   /api/wechat-files -> 401
（带 cookie 后全部 200）
```
### 简化后的网络面板 + 一键切换

面板只剩一屏：

```text
良心云 · rule · 44 个节点
当前节点  🇯🇵日本专线01|BGP|流媒体
[ 一键切换（Codex 最快） ]  [ 刷新 ]
已切到 🇯🇵日本专线01|BGP|流媒体（Codex 726ms）
🇯🇵日本专线01|BGP|流媒体   59ms   Codex 726ms   [测]
🇸🇬新加坡专线03|BGP|流媒体 100ms   Codex 1062ms  [测]
…
```

- **只列当前在用组**的节点（`defaultGroup` 来自实时连接），不再有 GLOBAL / 其它组的 tab。
- 每行：Clash 延迟 + **Codex 实测**（未测 / 连通 xxx ms / 失败）+ 单行「测」按钮。
- 列表按 Codex 实测延迟升序排，未测的排在后面按 Clash 延迟排。

### 一键切换怎么测的

`POST /api/clash/autopick` 起一个后台任务：

1. 取在用组里 Clash 延迟最低的 N 个真实节点（默认 8，上限 20；跳过嵌套组和「剩余流量」这类订阅信息行）
2. 逐个：切到该节点 → 等 700ms → 用新建的 app-server 连接跑 `account/rateLimits/read` 测真实 Codex 延迟
3. 全部测完，切到 Codex 最快的那个；**一个都不通就恢复原节点**
4. 结果缓存在前端 `netState.codex`，行内直接显示

前端轮询 `GET /api/clash/autopick?id=`，按钮实时显示 `测速中 3/8…`。

实测：8 个节点约 25 秒，选出 `🇯🇵日本专线01（Codex 726ms）` 并自动切换，弹 toast 确认。

> 注意：测速过程会真的在节点之间来回切，正在使用的连接会受影响；旧连接保持原节点，新连接才走新节点。

### 同一轮里修掉的 bug

轮询函数里把清理逻辑写在了 `finally`，导致**第一次轮询就清空任务状态**、按钮立刻复原（表现为点了一键切换没反应）。改为只在任务真正结束时清理。
### 模型选择并入强度 chip

输入框那排从 4 枚 chip 变成 3 枚：

```
Remote | GPT-6.1-Sol · 低 | 请求批准
```

- `#modelBtn` 删除，`#effortBtn` 变成合并 chip（`#modelLabel` + `·` + `#effortLabel`），点开就是原来的强度弹层。
- 弹层里的「GPT-6.1-Sol ›」那一行仍然可以换模型，换完合并 chip 立刻更新（实测 `GPT-6.1-Sol·低 → GPT-6-Astra·低`）。
- `title` 提示同时给出模型与强度全文。

**顺手修的两个 bug：**

1. **在弹层里点模型，菜单一闪就消失**。根因是全局 `click` 监听「非 `.chip` 的点击就关菜单」，而 `#modeModel` 不是 chip，于是同一次点击既打开又立刻关闭。现在把 `.mode-model` 排除。
2. **菜单飘到屏幕左上角**。原来锚定 `#modeModel`，而它在关掉的弹层里（尺寸为 0）。改为锚定合并 chip。

移动端：≤430px 时 chip 缩到 10.5px 字号、合并 chip 上限 44vw；≤380px 时项目 chip 只留文件夹图标。实测 360/390/430px 三档 `scrollWidth == width`，三个 chip 全部露出，回形针与发送按钮不再被压到。
## 5.25 全节点测速 · 自动切换 · 二维码 · 文件预览

### 一键测速改成测「所有节点」

原来的 `limit=8` 只测 Clash 延迟最低的 8 个；现在默认测整组（`limit` 省略或 0 = 全部）。

速度靠两步优化：

1. **复用一条 app-server 连接**做 Codex 探测。原来每个节点都新建连接、重跑 `initialize`（1-2 秒），现在握手一次，之后每个节点只发 `account/rateLimits/read`。
2. **先用 Clash 自己的 `/proxies/{node}/delay` 并行预筛**（8 并发、不切换），把连不通的节点剔掉再串行实测。死节点每个要等满超时，这一步省掉一大半时间。

实测（48 个节点的组）：44 个真实节点 → 预筛剩 30 个 → 串行实测 **105 秒**，全部测完。
结果里会写明「测了 N 个节点，跳过 M 个不通节点」。

### 自动切换守护

面板里新增开关：**自动切换（断线时选 Codex 最快节点）**。

- 每 180 秒用共享连接探一次 Codex；正常就记一笔 `最近检查正常 1180ms（节点名）`。
- 探测失败才触发全节点扫描，切到最快节点；一个都不通就保持原样。
- 开关状态存 `bridge/autoswitch.json`，重启桥接后自动恢复。

接口：`GET/POST /api/clash/autoswitch`（`{enabled, intervalSec}`，间隔 30-3600 秒）。

### 微信二维码「显示不稳定」

根因有两个，都不是网络问题：

1. **每次取二维码要 10-25 秒**。原实现是 `Page.captureScreenshot` 截后台 Edge 窗口，后台窗口合成被节流。现在改成：页内读出二维码 `<img>` 的 URL（约 10ms）→ **Node 直接下载该 URL**（带浏览器 UA/Referer，约 200ms）。截图只作兜底，并先开 `Emulation.setFocusEmulationEnabled` 解节流。
2. **前端每 4 秒重建 `<img>`** 并带 `?t=时间戳`，等于反复重新下载 → 看着就是闪。现在登录态不变时不重建 DOM。

实测：`24 852ms → 305 / 154 / 150 / 176ms`；连续 6 秒轮询，`<img src>` 完全不变。

### 文件预览补全 + 保存图标

| 类型 | 预览方式 |
|---|---|
| 图片 png/jpg/gif/webp/avif/bmp/svg | `<img>` |
| **PDF** | 浏览器原生 PDF 查看器（`<iframe src=… #view=FitH>`，支持翻页、缩放） |
| **Word / Excel / PowerPoint**（docx/xlsx/pptx，含 odt/ods/odp/rtf） | 服务端解 zip 抽 XML 文本（不依赖 LibreOffice），带「第 N 页」分页与页数提示 |
| 音视频 mp4/webm/mov/m4v · mp3/wav/m4a/ogg/flac/aac | `<video>` / `<audio>` |
| 文本/代码/md/html/json/geojson/gpx/kml | 现有预览 + 源码切换 |
| 其它（zip 等） | 文件卡片：文件名、扩展名、说明 + 保存按钮 |

新增接口 `GET /api/office-text?path=`：docx 取 `word/document.xml`、pptx 按 `slideN.xml` 分页、
xlsx 取 sharedStrings + 第一张工作表，正文截断到 4 万字符。实测那份 35 页 pptx：`ok, slides: 35, 4786 chars`。

右上角的「下载」文字按钮换成了**保存图标**（`#i-save`，向下箭头 + 托盘），`aria-label="保存到本机"`。
### 五个收尾修正

**1. 前端还在传 `limit: 8`**
服务端默认已是「全部节点」，但 `runAutopick()` 里写死了 `limit: 8`，把默认值覆盖了。已删掉，按钮文案也改成「一键测速并切换（全组节点）」。

**2. 自动切换的实战验证**
手工切到被墙的 `🇭🇰香港高速01`，再打开开关：

```text
3s    last={node:香港高速01, ok:false, ms:2665, error:…403 Forbidden}
96s   switch={from:香港高速01, to:🇸🇬新加坡专线03, ms:800}
final node: 🇸🇬新加坡专线03 | codex on final node: 812ms   ← 恢复成功
```

**3. 错误信息里塞了整页 HTML**
Codex 的 403 会把 chatgpt.com 的 HTML 错误页带进 `error` 字段（约 15 KB），整个塞进 API 响应和 tooltip。
新增 `shortErr()`，压到 181 字符以内。

**4. Office 预览在手机上**
390px 下 docx 正文、xlsx 表格（制表符分列，列能对齐）、保存图标都正常，`codeWidth 337 / panelH 741`。

**5. 预览接口补测**
docx：标题 + 两段正文 + 表格单元格（`姓名	分数` / `张三	95`）全部抽出，11 ms；
xlsx：`月份 销量 备注 / 1月 120 开门红 / 2月 98 春节`，5 ms。
## 5.26 文件名 / 保存 / 发到微信

### 文件名与保存名的问题（已修）

三个地方都用了整条路径：

| 位置 | 原来 | 现在 |
|---|---|---|
| 会话里的路径 chip | 显示 `<workspace>\qgis-run-…\.attachments\mw2gjmn7-points.geojson` | 显示 `mw2gjmn7-points.geojson`，完整路径留在 tooltip |
| dock 标题 | 整条路径 | `buffer.geojson` |
| `<a download>` | `download="<workspace>\…\buffer.geojson"` → 浏览器消毒成 `C__CHAT_…` | `download="buffer.geojson"` |

新增 `baseName()`，chip / 标题 / 下载名统一用它；服务端 `content-disposition` 本来就用 basename，所以直链下载也一直是对的。

### 发到微信

dock 右上角现在有两个图标：**发送到微信**（气泡）和 **保存**（下箭头）。

```
POST /api/wechat/send { path }
  -> { ok: true, name, how: "input" | "chooser", ms }
  -> { ok: false, error: "需要先在「微信文件传输」里扫码登录" }
```

实现（`wechat-web.mjs` 的 `sendFile()`）：

1. 先确认页面已登录（没有输入框/消息列表就直接返回 `not-logged-in`）。
2. 页面里已有 `input[type=file]` 就 `DOM.setFileInputFiles` 直接塞进去。
3. 否则 `Page.setInterceptFileChooserDialog` 拦截文件选择器，按文本/类名挑最像「上传」的按钮点一下，
   等 `Page.fileChooserOpened` 拿到 `backendNodeId` 再塞文件。
4. 之后轮询页面文本，直到文件名出现，才算发送成功（最多等 20 秒，超时标记 `unconfirmed`）。

「微信文件传输」面板顶部新增开关 **在会话里保存文件后，自动发到微信**（存 `localStorage["codex-remote-wx-autosend"]`）。
打开后，dock 里点保存会同时推一份到文件传输助手，手机微信立刻能收到。

发送失败且原因是未登录时，会自动弹出扫码面板，不用自己找入口。

> 限制：网页版文件传输助手要求先扫码登录（内存态，重开窗口就要重扫）；单文件上限 200MB。
### 结果文件点不开 / 存下来没扩展名（已修）

模型输出的是 CommonMark 的尖括号链接（路径里有 `(1)` 这类括号时必须这么写）：

```md
[打开优化版 PPTX](<C:/…/Codex_Migration_20261031T104701Z(1)/…/中国国有企业改革_前三页优化版.pptx>)
```

三个连环 bug：

| # | 问题 | 后果 |
|---|---|---|
| 1 | `inlineMd()` **先 escapeHtml 再解析链接**，`<` 已变成 `&lt;`，尖括号正则永不命中 | 退回普通正则，`[^)\s]+` 在路径里的 `(1)` 处截断 → 路径残缺 |
| 2 | 残缺路径以 `<C:` 开头，`path.resolve` 当相对路径处理 | 拼成 `…\codex-remote\bridge\<C:\…` → `ENOENT`（就是截图里那条报错） |
| 3 | dock 的 `download` 取的是 chip 文字 | 存成「打开优化版 PPTX」，没有扩展名，双击打不开 |

修复：

- 链接正则同时接受 `<…>` 与 `&lt;…&gt;` 两种形式，并把捕获到的目标反转义后再用；
- 普通链接正则加 `(?!&lt;|<)` 负向前瞻，避免把尖括号目标当普通链接再切一刀；
- `openFilePanel()` 入口统一清洗目标（去 `<>`/引号、`file://`、`&lt;` 实体）；
- dock 标题与保存名**一律用真实文件名**（`baseName(target)`），chip 文字只当展示用。

实测（就是坏掉的那条消息）：

```text
chip 打开优化版 PPTX -> title 完整 .pptx 路径
dock 标题  中国国有企业改革_前三页优化版.pptx
预览       文本预览（35 页幻灯片），4931 字符
保存       download=中国国有企业改革_前三页优化版.pptx
           GET /api/file?…&download=1 -> 200, 62,639,777 B, 正确 MIME + UTF-8 文件名
```

同一条消息里的 `查看三页预览`（.jpg）也正常走图片预览。

### 「挂载」和「保存」是一套路径吗

不是同一套，但都落在本机同一个文件上：

| 动作 | 链路 |
|---|---|
| 上传/微信挂载 | `/api/upload` → `%TEMP%\codex-remote\…` → `/api/attach/import` → `<工作区>\.attachments\<文件名>` → 作为 `mention` 交给模型 |
| 结果文件保存 | 消息里链接的**原始路径**（如 `outputs/xxx.pptx`）→ `/api/file?path=…&download=1` |

所以「挂载」负责把文件送进工作区给模型读，「保存」负责把结果取回本机；
这次的问题全在保存/预览一侧的路径解析，与挂载无关。
### Office 文件现在渲染真实排版（PPT / Word / Excel → PDF）

之前 pptx/xlsx/docx 只做「解 zip 抽文本」，能看到字但看不到版式 —— 用户看到的就是「没有实际内容」。
这台机器没装 LibreOffice，但 **Office 的 COM 服务是注册过的**，所以直接用 PowerPoint / Word / Excel 导出 PDF。

新增 `GET /api/office-pdf?path=…`（另有 `&probe=1` 只做转换并返回 JSON）：

```text
pptx/ppt/ppsx/odp  -> PowerPoint  Presentation.SaveAs(dst, 32)   # ppSaveAsPDF
docx/doc/rtf/odt   -> Word        Document.SaveAs(dst, 17)       # wdFormatPDF
xlsx/xls/ods       -> Excel       Workbook.ExportAsFixedFormat(0, dst)
```

要点：

- 转换脚本 `bridge/office-to-pdf.ps1`，桥接用 `powershell.exe -NoProfile -File` 调它；
- **串行队列**：Office COM 是单实例，并发打开会互相打架；
- **按 路径+大小+mtime 缓存**到 `%TEMP%\codex-remote-office\<hash>.pdf`，二次打开 60ms 级；
- 前端先 `&probe=1` 触发转换（首次 3-15 秒，显示「正在转成 PDF…」），成功后把 iframe 指向 PDF；
- 转换失败时**自动退回文本抽取**，不会白屏。

实测：

| 文件 | 首次 | 缓存 | 产物 |
|---|---|---|---|
| 35 页 pptx（61 MB） | 14.4 s | 67 ms | 10.4 MB PDF，封面版式完整 |
| test.docx | 3.1 s | 12 ms | 80 KB PDF |
| test.xlsx | 3.4 s | 12 ms | 29 KB PDF |

PDF 仍然走浏览器原生查看器（可翻页/缩放），手机上的 dock 同样铺满。

> 已知限制：iOS Safari 的内联 PDF 只显示第一页，需要翻页时用保存按钮导出后用系统「文件」打开；Android Chrome 正常。
### 移动端看不了 PDF/Office —— 改成逐页图片

桌面端把 PDF 塞进 `<iframe>` 能看，但 **手机浏览器根本不内联渲染 PDF**：
Android Chrome 直接显示一个「PDF / 打开」的下载卡片，iOS Safari 只给第一页。
这是浏览器行为，不是我们的 bug，所以换方案：**服务端把每页渲染成 JPEG，前端当图片流滚动**。

链路：

```text
pdf              ──┐
pptx/docx/xlsx   ──┴─> Office COM 转 PDF（缓存）─> PyMuPDF 逐页转 JPEG（缓存）─> <img> 列表
```

接口：

| 接口 | 作用 |
|---|---|
| `GET /api/office-images?path=` | 返回 `{ok, count, pages:[url…]}`，首次触发转换+光栅化 |
| `GET /api/office-page?k=<key>&i=<n>` | 返回第 n 页 JPEG（`cache-control: max-age=86400`） |

细节：

- 光栅化用 `bridge/pdf-to-images.py`（PyMuPDF），按页宽 1400px、JPEG q82，一页约 100-180KB；
- 缓存键是 `路径+大小+mtime` 的 sha1，第二次打开 4ms 返回页数，图片走浏览器缓存；
- 转 PDF 和光栅化各自串行排队（Office COM 单实例、CPU 密集）；
- 前端 `loading="lazy"`，只有前两页 eager，长文档不会一次拉完；
- 每页右下角有 `n / 总数` 角标。

实测（移动视口 390×844）：

| 文件 | 页数 | 首屏 |
|---|---|---|
| 35 页 pptx | 35 页 | 1.2s 出现图片，页图 1440×810 |
| 12 页 PDF | 12 页 | 1400×906 |
| test.docx | 1 页 | 1400×1812 |
| test.xlsx | 1 页 | 1400×1980 |

首次打开 35 页 pptx 约 10 秒（转 PDF 14s 只在第一次 + 光栅化 7s），之后秒开。
### 测速为什么不能真并行，以及把它压到 24 秒

先验证了两个假设，结论都是「不行」：

```text
1) Clash 的 /proxies/<node>/delay 能不能代替 Codex 探测？
   被墙的 🇭🇰香港高速01 测 https://chatgpt.com/ 照样返回 delay=118ms ——
   mihomo 只当 HTTP 通了就记成功，看不到 OpenAI 的 403。

2) 那能不能并发测？
   12 个并发里 7 个直接 503/504（An error occurred in the delay test）——
   mihomo 自己会限流。
```

而且切换节点是**全局**的，同一时刻只能有一个节点在承流量，真并行测 Codex 必然互相污染。
所以保留串行确认，但把每节点开销砍掉 + 提前收敛：

| 改动 | 之前 | 现在 |
|---|---|---|
| 每节点前的 settle 等待 | 250 ms | **0**（Clash 对新连接立即生效） |
| 每节点重复的 Clash 延迟测试 | 有（≈300ms） | 用预筛结果，去掉 |
| 失败节点超时 | 6 s | 4 s |
| 预筛并发 | 8（会 503） | 4 |
| 提前停止 | 无 | 已确认 ≤800ms 的节点且测满 6 个就停 |

结果：同样的组，**105 秒 → 24 秒**（测了 6 个就锁定 🇯🇵日本专线02，Codex 677ms）。
自动切换守护走的也是这条路径，所以“断线后重选”同样变快。

### 上传菜单精简

原来 5 项（照片/视频、拍照/录像、任意文件、微信文件传输、从微信取文件），现在 2 项：

```text
添加文件
  拍照 / 选文件        <- 一个 input[type=file] 不设 capture，手机系统面板里同时给相机和文件
  微信文件传输         <- 扫码 + 取微信文件
```

`accept="*/*"` 且不设 `capture`：iOS 会弹「照片图库 / 拍照 / 选取文件」，Android 弹「相机 / 文件」，
一个入口覆盖原来的三项。
## 5.27 全功能实测（35 项）

用 CDP 驱动真实浏览器把页面上**所有可见功能**跑了一遍，三套脚本：`tools/qa-suite2.mjs`（17 项）、
`qa-suite3.mjs`（12 项）、`qa-suite4.mjs`（6 项）。结果 **35/35 通过**，无 console 异常、无 4xx/5xx。

### 覆盖范围

| 区域 | 检查项 |
|---|---|
| 登录 | 表单显示、错误密码被拒、正确密码进入、配对链接 `?t=` |
| 导航 | 6 个 rail 按钮、主题切换与持久化、面板开关 |
| 侧栏 | 会话列表、搜索过滤、项目分组折叠/展开、新会话 |
| 输入区 | 合并 chip（模型·强度）、强度弹层、权限弹层（3 档）、附件菜单（2 项）、斜杠菜单（12 项技能）|
| 会话 | 打开历史会话、指标条、拖拽上传、停止按钮中断 |
| 预览 | md / html / 图片 / 代码 / PDF（12 页）/ Office（35 页）/ 未知类型卡片，保存名 = 文件名 |
| 面板 | 技能与 MCP、最近文件、用量、网络（测速 + 自动切换开关）、微信（二维码 + 刷新）|
| 移动端 | 底部 6 tab、每个 tab 都能开面板、dock 全宽、chip 不溢出、主题跨刷新保持 |

### 测出并修掉的 4 个问题

**1. 微信自动挂载一直失效**
`/api/wechat-watch`（SSE）在**登录之前**就被订阅了 → 401。现在改成 `boot()` 认证成功后、以及表单登录成功后
才启动，并加了「出错就 5 秒后重试」的保护。实测 `http failures: none`。

**2. 拖拽浮层会卡住挡住整个界面**
`dragleave` 在两种情况下不会触发收尾：事件里没有 `dataTransfer`，或鼠标快速移出窗口。
加了 `relatedTarget === null` 判定 + 2 秒看门狗 + `dragend`/`blur` 兜底。

**3. `#fileInput` 是死代码**
页面里那个 `<input type="file" id="fileInput">` 从来没绑过事件（真正的选择器是 `pickFiles()` 动态创建的），
已删除，避免以后误以为能用。

**4. 只挂文件不写文字时无法发送**
`updateSendState()` 只看输入框文字，附件不计入；而且 `renderAttachments()` 之后没刷新按钮状态。
现在「有附件」也算内容，挂上文件后发送按钮立刻可用，发出去的是 `mention` + 空文本。
## 5.28 本机 Codex 会话同步 · 大文件走直链

### 网页端删除/归档后，本机 Codex 还显示（已修）

现象：网页里删掉的会话在桌面 App 里还在，点开报 `继续聊天未成功 no rollout found for thread id …`。

根因不在 app-server，而在桌面端自己的目录表 `~/.codex/sqlite/codex.db` 里的 `local_thread_catalog`：
桌面列表来自这张表（扫描 rollout 文件生成）。`thread/archive` 只把文件移到 `archived_sessions/`、
`thread/delete` 只删掉文件 —— 表里的行没人清理，于是桌面照旧列出，点开才发现 rollout 不在了。

实测确认（真实坏条目）：

```text
catalog row: {thread_id: 01a1a4ac..., display_title: "111", missing_candidate: 0}
rollout on disk: 没有（sessions / archived_sessions 都没有）
```

修复：新增 `POST /api/threads/prune`，扫描 `~/.codex/sessions` 里真实存在的 rollout，
把 `host_id` 为 local 且文件已消失的目录行删掉（连带 `scan_entries`），首次运行把 `codex.db` 备份成 `codex.db.bak-prune`。

调用时机：桥接启动、网页端归档后、网页端删除后、每次进页面 boot 一次。

实测：

```text
调用前  local rows: 20, without rollout: 2   <- "111" 和 "test"
POST /api/threads/prune -> {"ok":true,"removed":2,"titles":["111","test"]}
调用后  local rows: 18, without rollout: 0
```

UI 侧确认：`boot requests: [POST /api/threads/prune]`，归档一次后变成两条。

### 微信里的大文件下载慢（改用直链）

先量了上传侧：5MB 只需 934ms（约 5.4MB/s），所以慢的不是我们上传，而是手机从微信 CDN 拉取
（60MB 的 pptx 尤其明显）。而手机通常就在同一个 tailnet/LAN 里，直接从桥接下载快得多（实测 60MB / 0.4s）。

新增接口：

| 接口 | 作用 |
|---|---|
| `POST /api/share {path}` | 生成 24 小时有效的直链（HMAC 签名，含路径+过期），返回 tailnet/LAN 优先的 URL |
| `GET /s/<token>` | 免登录下载（token 本身是凭证），`Content-Disposition` 带正确文件名 |
| `POST /api/wechat/send-text {text}` | 往文件传输助手发文字（用于发链接） |

前端：dock 的「发送到微信」先查文件大小，超过 5MB 弹三选一：

```text
59.7MB · 选择方式
  发送下载链接（推荐，手机直连）
  发送文件（59.7MB，微信下载较慢）
  复制链接
```

小文件保持直接发送。实测：59.7MB 弹菜单、200KB 图片直接发；选「发送下载链接」后 1.2 秒内文字就进了微信
（页面里能读到 `http://<tailnet-ip>:8787/s/...`）。
## 5.29 新建项目（在本机选目录）

手机/远程端没法用系统的文件夹对话框（它弹在主机上），所以做了一个**网页内的目录浏览器**：

```text
项目 chip -> ＋ 新建项目…
  面包屑 C:\ › CHAT         [↑ 上一级]
  快捷: 主目录 / 桌面 / 文档 / 下载
  [文件夹列表，点一下就进去]
  项目名称 [CHAT]            [用这个文件夹]
```

接口：`GET /api/fs/dirs?path=`（需登录）

- 不带 `path` 时返回驱动器列表（`C:\`、`D:\`…）和常用位置；
- 带 `path` 时返回该目录下的子目录、上级目录、面包屑；
- 跳过 `node_modules` / `.git`，单目录最多 400 项，按中文排序。

创建走 app-server 的官方 `project/create`（而不是直接改 `~/.codex/.codex-global-state.json`），
所以桌面 App 也会立刻看到这个项目：

```js
rpc.send('project/create', { name, roots: [{ path }], idempotencyKey })
```

创建成功后自动 `project/list` 刷新、把新项目设为当前目标并更新 chip 文案。

实测（浏览器自动化）：菜单里出现「＋ 新建项目…」→ 面板打开在默认目录 → 建出
`{"name":"CHAT","roots":["<workspace>"]}` → chip 变成「CHAT」；测试项目随后已删除。
## 5.30 新建项目：从「此电脑」开始 + 就地新建文件夹

之前对话框固定从当前工作目录开始，只能往下钻，够不到别的盘。现在：

```text
新建项目
  此电脑                      <- 起始视图：C:\ D:\ + 常用位置
  [↑ 上一级] [＋ 新建文件夹]
  主目录 / 桌面 / 文档 / 下载 / 当前工作目录   <- 快捷位置
  [文件夹列表]
  项目名称 [..]              [用这个文件夹]
```

改动：

- 打开时 `paint('')`，直接进「此电脑」（驱动器列表），面包屑可以从任意层级点回 `此电脑`；
- 快捷位置里补了「当前工作目录」，从根视图一步回到平时用的目录；
- 新增 `POST /api/fs/mkdir {path, name}`，对话框里「＋ 新建文件夹」创建后**自动进入**该文件夹；
- 名称校验：拒绝 `\ / : * ? " < > |`、`.`、`..`、超长、同名已存在。

实测：

```text
根视图   crumbs=此电脑  dirs=C:\,D:\  quick=主目录,桌面,文档,下载,当前工作目录
进入     C:\ -> <workspace> -> 新建文件夹 qa-folder-…（磁盘上真的建出来了）
创建     project/list -> ["Remote","qa-folder-…"]，chip 同步更新
非法名   {"ok":false,"error":"名称不能包含 \\ / : * ? " < > |"}
```

（测试用的项目与文件夹已删除。）
## 5.31 切换账号后二维码不出来（已修）

现象：iPad 上点「切换账号」，二维码区域不更新 / 扫了没用。

定位过程：

```text
接口侧   POST /api/wechat/reset -> 2.6s；之后 4s 内 /api/wechat/qr 就返回 37KB 真图（150ms）
页面侧   重置后 WeChat 登录页没有 <img>，只有 .login-scan__panel；日志里是 qr download empty (200)
前端侧   <img src> 的 ?t= 一直是同一个值（1793899268801），说明根本没重新取图
```

根因：为了防闪烁加的那行早退

```js
if (mode === 'login' && host.dataset.mode === 'login' && host.querySelector('.wx-qr')) return;
```

它把「已经有一个 img 就不再重建」当成了通用规则——于是换账号后仍然显示**上一个账号的旧码**
（那个码已经失效，扫了自然没反应）。二维码本身有有效期，这条规则也让过期码永远不刷新。

修复分三层：

1. **前端按新鲜度重建**：记录 `state.wxQrStamp`，只有「模式没变 + 图片存在 + 不到 2 分钟 + 没有强制刷新」才早退；
   「切换账号」「刷新二维码」两个按钮都会置 `wxQrStamp = 0; wxQrRefresh = true`，强制换新图；
   图片加载失败时把 `wxQrStamp` 清零，下一个轮询周期自动重试（而不是永远停在提示文字上）。
2. **桥接在 reset 时清空二维码缓存**，避免把上一个账号的图继续发 2 秒。
3. **下载失败且页面显示「二维码无法加载，点击刷新」时**，先点它的刷新链接（或 reload），等 2.5s 再取一次，
   全部失败才退回截图——否则截图会把错误提示拍下来当二维码发出去。

实测（820×1180 平板视口，真实点击「刷新二维码」）：

```text
before: {"hasImg":true,"loaded":true,"w":430,"t":"1793899456744"}
  +2s  {"t":"1793899456744"}                       ← 还没换
  +4s  {"t":"1793899464594","loaded":true} NEW-IMAGE  ← 新码已加载
```
## 5.32 网页操作后本机 Codex 立刻一致（双向同步）

状态分散在三个地方，必须先弄清谁读谁：

```text
app-server (codex.exe, :8791)   会话/项目的真实索引 + 广播通知
~/.codex/sessions/, archived_sessions/   rollout 文件
~/.codex/sqlite/codex.db -> local_thread_catalog   桌面端侧栏的会话列表
~/.codex/.codex-global-state.json -> local-projects  桌面端的项目注册表
```

实测 app-server 的广播是齐全的：

```text
thread/archive  -> thread/archived {"threadId": ...}
thread/delete   -> thread/deleted  {"threadId": ...}
project/create  -> project/changed {"projectId": ..., "changeType": "created"}
```

### 网页 -> 本机（持久化状态）

| 操作 | 之前 | 现在 |
|---|---|---|
| 删除会话 | 只删 rollout，目录表留行 → 桌面显示、点开报 no rollout found | 桥接收到 `thread/deleted` 后 **1.2s 防抖清理**，行消失（实测 1.4s） |
| 归档会话 | 只把文件挪到 `archived_sessions/`，行还在 | 目录表现在**只认 `sessions/` 里的 rollout**，归档即从桌面列表消失 |
| 新建项目 | 只写 app-server SQLite，`global-state.json` 没有 → 桌面侧栏看不到 | 镜像写入 `local-projects` + `project-order`（Windows 反斜杠路径，写前备份 `.bak`） |

另外每分钟兜底扫一次目录表，桌面端自己的增删也能被纠正。

### 本机 -> 网页（实时通知）

网页端以前只处理 `thread/started`，桌面删/归档后网页纹丝不动。现在补上：

```js
case 'thread/archived':          // 从列表移除 + toast「该会话已在别处归档」
case 'thread/deleted':           // 同上 + toast「该会话已在别处删除」
case 'thread/unarchived':        // 静默 loadThreads()
case 'project/changed':          // loadProjects() 后重绘项目分组
```

### 实测（两次独立客户端，模拟桌面 vs 网页）

```text
网页归档  -> 目录表 0.7s 仍在, 1.4s 已删除        ✓
网页删除  -> 目录表 1.4s 已删除                  ✓
别的客户端归档 -> 网页 1.2s 内从列表消失，27 -> 26，toast 正确   ✓
别的客户端建项目 -> 网页 1.2s 内出现，无需刷新                 ✓
网页建项目 -> global-state 立刻有，rootPaths=["<workspace>"]      ✓
```

去重注意：legacy 项目 id 与 app-server 项目 id 不同，镜像时**按路径判重**，否则每个迁移过的项目都会被复制一份。
## 5.33 上线前的审计与优化（商用目标）

按「安全 / 性能 / 鲁棒性 / 可访问性」四项做了一轮实测，改完再验一遍。全部脚本在 `tools/`：
`prelaunch-audit.mjs`、`latency-profile2.mjs`、`stress-test.mjs`、`ux-audit.mjs`、`reconnect-test.mjs`、`launch-checklist.mjs`。

### 安全（都实测过）

| 项目 | 改前 | 改后 |
|---|---|---|
| 任意路径读文件 | `/api/file?path=C:/Windows/win.ini` 直接返回内容 | **403**（允许根 = 主目录 + 工作目录 + 项目根；`fileScope:"home"`，可改 `"any"`） |
| 安全响应头 | 全无 | `nosniff` `X-Frame-Options: DENY` `Referrer-Policy` `Permissions-Policy` 和一套 CSP |
| CSRF | 跨站 POST 返回 200 | 校验 Origin/Referer，跨站 **403** |
| 登录暴力破解 | 已有按 IP 限流（回环豁免） | 保持，并把英文错误映射成中文 |
| Cookie | `HttpOnly; SameSite=Lax; 30d` | 不变（HTTPS 下自动加 `Secure`） |

CSP 刻意保留了 `style-src unsafe-inline`（页面用 JS 设内联样式），但 `script-src` 只允许同源，
页面本身也没有内联脚本，所以 XSS 里最危险的一类被挡住。

### 性能

| 指标 | 改前 | 改后 |
|---|---|---|
| 首屏传输 | 238 KB | **65 KB**（gzip：app.js 166→47KB，css 57→11KB，html 15→4.7KB） |
| FCP（手机 390×844，4× CPU 降速） | 736 ms | **408 ms**（新增纯 CSS 启动画面，首帧不再是白屏） |
| 点击发送 → 自己的气泡出现 | 426 ms | **5 ms**（乐观渲染，服务端回显后对齐） |
| 面板首开（网络面板） | 583 ms 白屏 | 先画骨架，再填数据 |
| 500 个会话渲染 | — | 47 ms |
| 21k 字消息渲染 | — | 10 ms |
| 面板连点帧时间 | — | p50 17 ms / p95 59 ms |

启动画面是纯 CSS 的，并带 `6s` 自动淡出兜底——即使 JS 挂了也不会把用户卡在启动页。

### 鲁棒性

| 场景 | 结果 |
|---|---|
| 桥接进程被杀 | UI 立刻显示「已断开，正在重连…」+ `body.is-offline` 横幅 |
| 桥接恢复 | **8 秒内自动重连**，RPC 恢复正常，不需要刷新页面 |
| 会话过期（cookie 被清） | 任一 API 返回 401 → 自动回到登录页并提示「登录已过期」 |
| 未捕获异常 | 统一 toast + 控制台，不再静默白屏 |
| 二维码卡死 | 每个 CDP 调用 8s 超时 + 路由 8s 兜底，返回 503 而不是挂住连接 |

### 可访问性 / 移动端

- 图标按钮 100% 有 `aria-label`，输入框 100% 有 placeholder 或 label，图片都有 alt；
- 手机端会话行 / 菜单项 ≥ 44px（原来 30-32px），符合触控建议；
- 加了 `:focus-visible` 焦点环（键盘可见、鼠标不可见）；
- 尊重 `prefers-reduced-motion`；
- `lang="zh-CN"`、`viewport-fit=cover`、`theme-color` 随主题切换；
- 无横向溢出（390px 视口实测）。

### 上线清单（15 项，全过）

```text
security: CSP / nosniff / DENY / referrer-policy       PASS
security: 拦截系统目录，放行项目文件                     PASS
security: 跨站 POST 403，同源 POST 200                  PASS
weight:   gzip 全开，首屏 65.3KB < 80KB                 PASS
ui:       启动画面正常消失、无横向溢出                   PASS
a11y:     触控目标 ≥ 40px、焦点环存在                    PASS
robust:   401 自动回登录                                PASS
console:  无错误                                        PASS
```
## 5.34 对话页用量悬浮球 + 动效克制化

小红书那篇「24 个高级 UI 交互」的链接在这台机器上打不开（`xhslink.cn` / `xiaohongshu.com`
解析到非公网地址，被网络策略拦了），所以按这类清单里**适合生产级对话工具**的部分来做：
能用、不喧哗、不拖性能。

### 用量悬浮球（对话页实时显示）

```text
   ╭──────────╮
   │  ╭────╮  │   外环 蓝 = 5 小时窗口**还剩**（满环 = 全新，越用越短；≤30% 橙，≤10% 红，0% 脉冲）
   │  │4h27│  │   内环 灰 = 每周窗口**还剩**（同样有橙/红两级）
   │  ╰────╯  │   中心   = 距 5 小时重置的倒计时
   ╰──────────╯
```

细节：

- 倒计时格式：离得远显示 `4h27`（分钟级），进入 1 小时内显示 `27:13`（逐秒跳）；
- **实时**：订阅 app-server 的 `account/rateLimits/updated` 通知（每一轮对话都会推），
  再叠加 60 秒兜底轮询，数字变化时球体会闪一下光圈，让「更新了」看得见；
- 位置跟着输入框走：`ResizeObserver` 监测 composer 高度，写进 `--ball-bottom`，
  输入框长高（多行草稿）也不会被挡住；
- 打开右侧面板时球自动淡出（`.dock-open`），关闭后恢复；
- 点击打开「用量」详情面板，`aria-label` 带完整数值（读屏可用）；
- 尊重 `prefers-reduced-motion`（不闪、不脉冲）。

实测（390×844 与 1280×880 两种视口）：环形 `stroke-dashoffset` 与百分比一致（5% → 143.3/150.8），
已用 5%/46% 时两环分别显示剩余 95%/54%，已用 75%/20% 时外环转橙（剩 25%），已用 95%/92% 时两环转红，已用 100% 时加 `is-blocked` 脉冲；点击面板后会用面板的实时数据回写球体，两边永远同一个数。

### 采用的动效（其余一律不做）

| 效果 | 用在哪 | 为什么留 |
|---|---|---|
| 环形进度 + 平滑动过渡 | 用量球 | 一眼看清配额，切换有连续性 |
| 数值变化闪一下 | 用量球 | 让「实时」可感知，而不是数字悄悄变 |
| 骨架屏 shimmer | 面板加载 | 首开不再是一片空白 |
| 交错入场 `msg-in` | 新消息（已备好样式） | 消息出现有落点，不突兀 |
| 悬浮抬升 | 用量球、卡片 | 可点击的暗示 |
| 焦点软光 | 输入框 | 键盘操作时知道焦点在哪 |
| 启动画面 | 首屏 | 白屏 → 品牌过渡 |

刻意没做：光标跟随高光、粒子背景、3D 倾斜、视差滚动、打字机——它们在工具类产品里只会增加
渲染成本与干扰。
## 5.35 按 Interaction Atlas 清单落地的交互（只做有用的）

对着 24 个交互清单逐条过了一遍，只挑了**在对话工具里真有收益**的四个，其余明确不做。

### 落地

| 编号 | 交互 | 用在哪 | 收益 |
|---|---|---|---|
| #09 | 命令面板 | `Ctrl/Cmd + K` | 会话一多，点侧栏找会话很慢；键盘直达 + 模糊过滤 |
| #20 | 堆叠通知 | 取代原来的单条 toast | 多条同时发生时不互相覆盖，带成功/失败/信息图标和「重试」按钮 |
| #08/#22 | 可调整面板 | 右侧文件预览的左边框 | 看 PPT/PDF 时要更宽，宽度记进 localStorage |
| #17 | 轻量动效 | 环形进度、数字变化闪烁 | 用在真正表达「状态变了」的地方 |

命令面板内容来自四个来源，按分组显示：

```text
动作   新会话 / 切换主题 / 刷新会话列表
面板   技能与 MCP / 最近文件 / 用量 / 网络 / 微信 / 新建项目
项目   每个项目（回车切目标项目）
会话   每个会话（回车直接打开）
技能   每个 skill（回车挂到输入框）
```

键盘：`↑ ↓` 选择、`Enter` 打开、`Esc` 关闭、`Ctrl/Cmd + K` 呼出或收起；点击遮罩也关闭。

通知的类型是按文案判定的（含「失败/错误/无法/超时」→ 红色，含「已/成功/完成」→ 绿色），
所以现有几十处 `toast(...)` 调用**不用改**就自动分色；需要按钮时传第三个参数：

```js
toast('发送失败：网络中断', 5000, { action: { label: '重试', onSelect: () => send() } });
```

面板宽度：默认 `clamp(320px, 34vw, 420px)`，拖动后写 `--dock-w`，刷新恢复；
窗口变化会重新夹取（最小 320px，最大 72vw）；手机上面板本来就全宽，拖拽手柄自动隐藏。

### 明确不做

放大镜坞栏、3D 倾斜卡片、视差滚动、拖拽排序、多选、图片对比滑块、悬停放大预览——
这些在展示型站点很出彩，但放进一个每天用几小时的对话工具里只会分散注意力，还拖性能。

## 5.36 多端布局校验

六种视口逐个测量：横向溢出、栅格结构、输入框是否越界、悬浮球是否压住输入框、文本截断。

| 视口 | 布局 | 结果 |
|---|---|---|
| Windows 1600×900 | 侧栏 332 + 主区 | OK |
| Windows 1440×810 | 侧栏 332 + 主区 | OK |
| 手机竖屏 390×844 | 底部 tab 栏 + 全宽面板 | OK |
| 手机横屏 844×390 | 底部 tab 栏 + 全宽面板 | OK |
| iPad 竖屏 820×1180 | 底部 tab 栏 | OK |
| iPad 横屏 1180×820 | 桌面式三栏（rail + 侧栏 + 主区） | OK |

统一判据（全部满足才算 OK）：`scrollWidth - clientWidth <= 0`、输入框完整在视口内、
悬浮球在输入框上方且完整可见、无元素内容被自身裁切。

这一轮修掉的两个真问题：

1. 手机端堆叠通知**压在输入框上**——改成跟悬浮球共用 `--ball-bottom`（输入框顶部之上）；
2. 面板拖宽后刷新**不恢复**——`restoreDockWidth()` 没被调用，补上并在 resize 时重新夹取。
## 5.37 平板/手机上「发微信」Load failed 与扫码后无反馈

现场（iPad 截图）：`正在发到微信…` 之后一条 `发送失败：Load failed`。

### Load failed 的原因：请求被挂住太久

`POST /api/wechat/send` 以前要**等整份文件上传完**才返回 JSON。60MB 的 pptx 上传要十几秒，
iOS Safari 会把这种长时间挂起的 fetch 判成网络错误（`Load failed` / `NetworkError`），
甚至在人切到别的 App 时直接中止。我们这边其实在上传，用户却看到失败。

改成**后台任务 + 轮询**：

```text
POST /api/wechat/send     -> 立刻返回 { jobId, name, size }（实测 17-65ms）
GET  /api/wechat/job?id=  -> { state: running | done | error, result, elapsedMs }
```

上传在服务端继续跑，客户端每 0.9 秒查一次状态，最多等 5 分钟；
单次轮询失败（锁屏、隧道抖动）不会立即失败，只累计超时。
失败时通知里带「重试」按钮，网络类错误显示为「网络中断或请求超时」而不是原文 `Load failed`。

### 扫码后没有反馈

二维码页没有回调，以前只能靠面板里 4 秒一次的轮询悄悄切换卡片，用户不知道成了没有。

现在补了三处：

1. **桥接侧的登录监视器**：每 5 秒比对一次登录状态，一旦从未登录变成已登录，
   通过已有的 SSE 通道（`/api/wechat-watch`）推一条 `event: login`，带账号名；
   退出登录则推 `event: logout`；
2. **客户端收到就提示**：`微信已登录：xxx，现在可以发文件了`，同时强制刷新二维码状态；
3. **兜底**：面板轮询发现状态翻转也会提示一次（SSE 被代理缓冲时仍有效）。

（登录监视器只读页面状态，不改动会话；实测 SSE 首帧 `event: ready` 正常。）

### 顺带

- 发送前先校验文件存在与大小（≤200MB），错误在 20ms 内返回，不再让用户等；
- 未登录时立刻返回「需要先在「微信文件传输」里扫码登录」，并自动打开扫码面板。
## 5.38 扫码不生效的真凶：二维码恢复逻辑会重载页面

前两轮修的都是「发文件」，但**扫码一直不成功**的根因其实在二维码那一侧。

为了兜底「二维码无法加载」，`qrImage()` 里写了这样一段：先点页面上的「刷新」，
还不行就 `Page.navigate` 整页重载。问题是——扫码之后页面会进入
**「已扫描，请在手机上确认」** 状态，此时页面上没有 `img.qrcode-img`，文字里又带着「点击刷新」，
于是每次取二维码都会**点一下刷新 / 重载一次**，把刚扫上的登录会话直接作废。
表现就是：手机扫码 → 手机显示已确认 → 网页这边毫无反应。

修复：**二维码读取路径改成完全只读**——不点、不跳、不刷新。
取不到图就返回 503，由用户点「刷新二维码」（那才是显式的 `/api/wechat/reset`）。

### 扫码后的反馈（三路保证）

1. 桥接每 5 秒只读探测一次登录态（日志 `[wechat] login watcher started (5s)` 可确认它在跑）；
2. 状态翻转时通过 SSE 推 `login` 事件（带账号名），客户端立刻弹「微信已登录：xxx」并刷新卡片；
3. 兜底：面板轮询也会发现翻转并提示一次。

### 登录后自动发一条提示（这次新增）

检测到登录成功后，桥接会主动往你的文件传输助手发一条：

```text
✅ Codex 远程已连接
账号：少年的玉蝴蝶的文件传输助手
时间：2026-11-06 10:41:07
之后在网页里保存的文件会发到这里。
```

发送结果会通过 SSE `greeting` 事件回报，客户端提示「已向你的微信文件传输助手发送登录提示」；
发失败也不影响收文件，只是少一条提示。

### 扫码入口挪到「网络连接」

二维码原来只在回形针菜单里，而「手机能不能收到文件」本质是连接问题，所以放进网络面板，并且**放在最上面**：

```text
网络与连通性
  微信文件传输        [未登录]
    二维码 + 刷新二维码
  --- 或 ---
  微信文件传输        [已连接]
    账号：xxx   [发一条测试消息] [退出登录]
  ─────────────────────────
  良心云 · rule · 44 个节点 …（原有内容）
```

细节：区块挂在 `panelBody` 而不是清空重绘的 `host` 里（否则自动切换的 8 秒轮询会把它冲掉）；
5 秒轮询只在登录态变化时才重绘，避免二维码在手指底下闪。

实测（三种视口）：区块存在、二维码加载成功（`naturalWidth > 0`）、badge 显示「未登录」、刷新按钮在。
## 5.39 传输反馈：保存/发微信都看得见进度

问题：「保存文件」「传到微信」点完没有任何反馈，不知道是不是在传。
尤其平板上没有浏览器的下载条，60MB 的文件点完就像没反应。

### 传输中心

每一次保存/发微信都登记成一条传输记录（`state.transfers`），三处同时反馈：

1. **点下去立刻有提示**：`开始保存：xxx` / `请选择发送方式（12.0MB 的文件走链接更快）`；
2. **文件侧边栏顶部**列出 `正在传输 N 个文件`，每行：类型标签、文件名、`百分比 · 大小 · 已用时间`、细进度条；
3. **侧栏/底栏图标角标**显示进行中的数量（手机底部 tab 上的小蓝点）。

完成后行变绿显示 `完成 · 4s`，4 秒后自动消失；失败变红并写明原因。

### 保存现在的实现

不再是裸的 `<a download>`（点了没任何反馈），改成 `fetch` + 流式读取：

```js
const res = await fetch(fileUrl(target));
const reader = res.body.getReader();     // 每块都 patchTransfer({loaded})
// 读完转 Blob -> a[download] 交给浏览器
```

- 超过 80MB 的文件不进内存，直接交给浏览器下载（避免平板 Safari 崩标签页），并提示「已交给浏览器下载」；
- fetch 失败时同样回退到直链下载，不让用户卡住。

实测（把网络限速到 1.2Mbps 抓中间态）：

```text
t=1.5s  running  3% · 12.0 MB · 2s   bar 2.9%   badge 1
t=4s    running  8% · 12.0 MB · 4s   bar 8.3%   badge 1
done    100% · 12.0 MB · 完成 · 4s   行变绿，4s 后移除
```

### 发微信的菜单也要有反馈

大文件会先弹「发链接 / 发文件 / 复制链接」三选一——菜单以前弹在按钮上方，容易看不见，
现在弹在按钮下方，并且**点击的同时就给一条提示**，不再像「点了没反应」。
选「发文件」后会立刻出现一条 `微信` 传输记录，轮询到完成后变绿。

### 扫码登录确认（真的发出去了）

桥接每 5 秒只读探测登录态；**首次观察到已登录也算**（扫码可能发生在桥接重启期间）。
确认后：

- SSE 推 `login`，界面弹「微信已登录：xxx」；
- 自动往文件传输助手发一条确认消息，并回报 `greeting` 事件；
- 去重记录写在 `bridge/wechat-greeted.json`，30 分钟内不重复发，重启也不会刷屏。

实测日志：

```text
[wechat] already logged in as 少年的玉蝴蝶的文件传输助手, greeting once
[wechat] login greeting sent
```
## 5.40 发微信只走文件；保存进度自动出现在「最近文件」

### 去掉「选择发送方式」

大文件原来会弹「发下载链接 / 发文件 / 复制链接」三选一。多一次选择就是多一次卡顿感，
而且「发送到微信」本来就是发文件。现在点一下直接上传，没有菜单。

实测：`menu open? false` → `wechat:running` → 2 秒后 `已发到微信文件传输助手：wx-note.bin`。

### 保存进度为什么之前看不到，以及现在怎么修

两个原因叠在一起：

1. **进度只画在「最近文件」面板里**，而保存按钮在文件预览的 dock 上——点了之后面板根本没开，自然什么都看不到；
2. 就算打开了，`openFilesPanel()` 末尾用的是 `dom.panelBody.replaceChildren(frag)`，
   把刚插入的传输列表**一起清掉**了（只有列表为空、提前 return 时才看得见）。

修复：

- 点保存 → **先打开「最近文件」**，再开始下载，进度行立刻出现在列表顶部；
- 末尾改成 `append(frag)`，传输列表不再被清掉；
- 保存的文件同时写进最近文件列表，完成行保留 20 秒（绿框 + `完成 · 5s`）；
- 侧栏/底栏图标角标显示进行中的数量。

实测（限速 1.5Mbps 抓中间态）：

```text
点击保存 0.3s  title 变成「最近文件」，head「正在传输 1 个文件」
         1.2s  保存 big-report.bin · 2% · 10.0 MB · 1s   bar 2%   badge 1
         4s    保存 big-report.bin · 8% · 10.0 MB · 4s   bar 8%
完成      保存 big-report.bin · 100% · 10.0 MB · 完成 · 5s（绿框，保留 20s）
```

微信上传我们拿不到字节数，所以那条显示**不确定进度条**（来回滑动），完成时补成 100%，
不会出现假的 `0%`。
## 5.41 计划模式 / 目标模式（原生，不是 skill）

Codex 协议里本来就有这两个能力，只是网页端没接：

| 模式 | 协议能力 | 用法 |
|---|---|---|
| 计划模式 | `turn/start.collaborationMode = { mode: "plan", settings }` | `/plan` |
| 目标模式 | `thread/goal/set` / `thread/goal/get` / `thread/goal/clear` | `/target [目标内容]` |

### 和 skill / MCP 的区别（做在三个地方）

1. **菜单分组**：斜杠菜单里单独一组「模式」，蓝色 + ⚡ 图标；技能在「技能与 MCP」组，灰色 + ✦ 图标；
2. **语义**：模式是**开关**（点亮后作用于后续每一轮），skill 是**附件**（只作用于下一条消息）；
3. **芯片外观**：计划模式是蓝色描边芯片，目标是琥珀色描边芯片，skill 芯片保持中性灰。

### 两种启用方式都支持

```text
/plan                     -> 直接开启计划模式（不发送、不建会话）
/target 整理测试文件      -> 开启目标模式并设定目标
/target                   -> 开启目标模式，下一条消息内容作为目标
```

菜单点选和直接键入命令等价（`send()` 里先解析 `^/(plan|target)\b`）。

### 实际发出去的参数（抓 rpc 验证）

```json
{"mode":"plan","settings":{"model":"gpt-6.1-sol","reasoning_effort":"xhigh","developer_instructions":null}}
{ "objective": "整理 <workspace> 测试文件", "status": "active" }
```

注意：`collaborationMode` 会**覆盖** model 与 effort，所以 settings 里必须带上当前的型号与强度，
否则模型会被悄悄回退到默认值。

### 同步

- 服务端 `thread/goal/updated` / `thread/goal/cleared` 通知 → 芯片实时更新（状态、tokens 用量在 tooltip）；
- 切换会话时读该会话自己的目标（`thread/goal/get`），目标不会串到别的会话；
- 芯片上的 × 直接关闭模式，目标模式关闭时清空目标。

实测：`/plan` 后芯片出现、`turn/start` 带 plan；`/target …` 后 `thread/goal/set` 成功且服务端状态 `active`；
关闭后两个芯片都消失、状态归零。
## 5.42 MCP 面板「全部 unsupported」的真相 + 调用前自动开应用

### 为什么每个服务都显示 unsupported

面板把 `srv.runtimeStatus?.type ?? srv.authStatus` 当作状态显示。这台机器上
`mcpServerStatus/list` 返回的 `runtimeStatus` **全是 null**，于是回落到 `authStatus`，
而它对绝大多数服务就是字面量 `"unsupported"`（含义是「不需要授权」，不是「不可用」）。

结果：8 个服务明明加载了 3~238 个工具，界面却全部写着 unsupported。

改成按**实际可用性**推断：

| 情况 | 显示 |
|---|---|
| `runtimeStatus.type` 存在且不是 ready | 原样显示（红色） |
| 有工具 | `就绪 · N 个工具`（绿色） |
| `toolsError` | `工具不可用`（红色） |
| 什么都没有 | `未连接` |
| `authStatus` 是 bearerToken/oauth | 追加 `· 需授权` |

顺带解决了两个可用性问题：238 个工具一次性铺开没法用，现在有**全局搜索**，
每个服务默认显示 20 个 + 「显示全部 N 个」；冷启动时要等 MCP 服务拉起（约 6 秒），
期间显示「正在连接 MCP 服务… Ns」而不是干等骨架。

实测状态行：

```text
codex_app     未连接
codex_apps    就绪 · 238 个工具 · 需授权
context-mode  就绪 · 9 个工具
cua_repl      就绪 · 3 个工具
node_repl     就绪 · 4 个工具
photoshop     就绪 · 127 个工具
qgis          就绪 · 125 个工具
sketchup      就绪 · 10 个工具
```

### 调用 QGIS / Photoshop 前自动打开本机应用

这两个 MCP 都要求桌面程序已经在跑，否则报的是「连不上」这类难懂的错误。

新增 `POST /api/app/ensure { app, waitMs }`：

- `tasklist` 查进程；没有就找可执行文件（Photoshop 扫 `Program Files\Adobe\Adobe Photoshop *`，
  QGIS 扫 `QGIS *\bin\qgis-ltr-bin.exe`）并 `start` 起来；
- 轮询等进程出现（默认 90 秒上限），再留 2.5 秒给 UI 初始化；
- 返回 `{ok, already|launched, process, exe, waitedMs}`。

前端在 `mcpServer/tool/call` 之前调用它，结果面板显示「正在启动 Photoshop…」→「已打开（6s），正在调用…」。

实测：

```text
qgis       -> {"ok":true,"already":true,"process":"qgis-ltr-bin.exe"}            1.8s
photoshop  -> {"ok":true,"launched":true,"process":"Photoshop.exe","waitedMs":5598}  7.3s
```

### 实际调用过的 MCP（不是只看列表）

| 服务 | 工具 | 结果 |
|---|---|---|
| context-mode | `ctx_doctor` | OK，返回环境自检表 |
| qgis | `get_qgis_info` | OK，`qgis_version: 3.44.15-Solothurn` |
| qgis | `get_project_info` | OK，当前工程 4 个图层、EPSG:4326 |
| photoshop | `photoshop_ping` | OK，「Successfully connected to Photoshop」 |
| photoshop | `photoshop_get_version` / `get_capabilities` | OK，2022 + 功能开关 |
| photoshop | `photoshop_get_state` | OK，`hasDocument:false` |
| node_repl | `js` | OK |
| sketchup | `create_finger_joint` | 参数校验错误（缺必填参数），服务本身可达 |

注意：Photoshop 在**没有打开文档**时，`photoshop_get_document_info` 会返回
`Photoshop info not available. Please detect Photoshop first.` —— 这是该 MCP 自己的措辞，
不是连接失败；先 `photoshop_ping` 或打开一个文档即可。
## 5.43 退出登录后二维码不显示：微信标签页的渲染进程卡死了

现象：点「退出登录」之后，二维码位置一直空着 / 一直「正在生成」。

实测抓到的现场（不是二维码逻辑的问题）：

```text
GET /api/wechat/state   -> {"ok":false,"error":"cdp timeout: Runtime.evaluate"}
POST /api/wechat/reset  -> {"ok":false,"error":"cdp timeout: Page.enable"}   8023ms
GET /api/wechat/qr      -> 503（每次 8s 超时，一直重试都一样）
```

同一个浏览器里另开一个标签做对比：

```text
微信文件传输助手网页版 -> TIMEOUT (6023ms)   ← 渲染进程僵死
下载 (edge://downloads-hub) -> OK (30ms)     ← 浏览器本身正常
```

也就是说：**微信那个标签的渲染进程卡住了**，CDP 连得上但命令永不返回。
之前 `reset()` 只会 `Page.navigate` 重新加载——对一个僵死的渲染进程毫无作用，
所以二维码永远出不来。

修复分三步：

1. **健康检查**：`ensureWindow()` 拿到标签后先做一次 4 秒的 `Runtime.evaluate("1")`，
   超时就判定僵死；
2. **重建标签**：`recreatePage()` 用 `GET /json/close/<id>` 关掉僵死标签，
   再 `PUT /json/new?<url>` 开一个全新的（两种 URL 形式都试，兼容不同 Edge 版本）；
3. **reset 也走重建**：先探活，活的话照旧 `navigate`，不活或 navigate 失败就重建整个标签。

前端也补了一层：二维码图片加载失败时自动重试 6 次（每次 2 秒，带「第 N 次重试」提示），
不再停在「暂时取不到」等用户手点。

实测（连续两轮退出）：

```text
reset#1 {"ok":true} 2684ms -> QR 1.5s 37074B
reset#2 {"ok":true} 2583ms -> QR 1.5s 38267B
```

UI 侧同样验证：退出后面板立刻切回二维码视图，`img.complete && naturalWidth > 0` 为真。
## 5.44 计划模式的提问卡片 + 思考卡不再自己收起

### 提问卡片（`item/tool/requestUserInput`）

计划模式会停下来问「先做哪一部分？」这类问题。查了协议，它不是 allow/deny 审批：

```ts
params:  { questions: [{ id, header, question, isOther, isSecret, options: [{label, description}] }], isBlocking }
response: { answers: { [questionId]: { answers: string[] } } }
```

但前端把它和命令审批放在同一个分支里，渲染成「允许 / 本会话都允许 / 拒绝」，
回包还是 `{decision}` —— 服务端拿到的不是答案，问题等于没法回答。

现在有专门的卡片：

- 每个问题：小标题（header）+ 问题正文 + 选项列表（label + 说明，可多选）；
- `options` 为空或 `isOther` 时附带自由输入框，`isSecret` 用密码框；
- 「提交回答」在至少答了一题后才可点，另有「跳过」；
- 回包严格按协议：`{ answers: { q1: { answers: ["先做数据"] }, q2: { answers: ["这周内"] } } }`。

实测（注入两题：一个带选项+自定义，一个纯填空）：

```text
card: {has:true, title:"Codex 想问 2 个问题", questions:2, options:2, inputs:2, submitDisabled:true}
reply: {"answers":{"q1":{"answers":["先做数据"]},"q2":{"answers":["这周内"]}}}
```

### 思考卡点开后又自己收起

原因不在卡片本身：`refreshItem()` 更新 reasoning 时是**原地改文本**，不会塌；
塌的是 `renderStream()` —— 只要这一轮有新的 item 到达或这一轮结束，整个消息列表会重建，
`is-open` 类自然就丢了。

修复：用一个模块级的 `openSteps` 集合按 item id 记住展开状态，
`stepCard({ key })` 创建时读取、点击时写入。重建多少次都保持展开。

实测：点开 → `is-open:true` → 触发一次 `renderStream()` → 仍然 `is-open:true`，正文还在。
## 5.45 只有老账号能登微信：退出登录没清会话

现象：之前登录过的账号（少年的玉蝴蝶）一直能用，换个微信号扫码就登不上。

查了浏览器的实际存储，问题很清楚——「退出登录」只是**刷新页面**，凭据全留着：

```text
cookies:
  webwx_auth_ticket@.szfilehelper.weixin.qq.com   expires 1828514094 ← 2027 年
  webwxuvid@.szfilehelper.weixin.qq.com           expires 1828369982
  wxuin@.szfilehelper.weixin.qq.com               expires 1794215436
  wxsid@… / wxloadtime@… / wxpluginkey@… / last_wxuin@…
localStorage: AEGIS_ID, fileTotalSize, userAvatar, webUin
```

页面一打开，看到 `webwx_auth_ticket` + `wxuin` 就直接恢复成上个账号，于是：

- 界面上要么直接回到列表，要么出现二维码但扫了没反应；
- 换号扫码时微信认为「当前浏览器已登录其他账号」，静默失败。

### 修复：硬退出

`reset()` 现在按这个顺序来：

```js
await cdp("Storage.clearDataForOrigin", { origin: "https://szfilehelper.weixin.qq.com", storageTypes: "all" });
await cdp("Storage.clearDataForOrigin", { origin: "https://login.weixin.qq.com",     storageTypes: "all" });
await cdp("Network.clearBrowserCookies", {});          // 这个 profile 只跑文件助手，清全部是安全的
await cdp("Page.navigate", { url: URL_TRANSFER });
// 登录页加载后还会写回 webUin/AEGIS_ID，再清一次
await cdp("Runtime.evaluate", { expression: "localStorage.removeItem('webUin')…" });
```

标签页僵死时走的重建分支也会先清会话再关标签（cookie 是跟着 profile 走的，关标签不解决）。

前端提示也改成了「已退出登录：已清除上一个账号的会话，请用要使用的账号扫码」。

### 验证（连续调用 reset 后检查浏览器实际存储）

改前：13 个 cookie（含 2027 年到期的 auth ticket）+ `webUin`。

改后：

```text
cookies: none
localStorage: ["AEGIS_ID"]        ← 只剩腾讯设备指纹，不含任何账号身份
page body: "使用手机微信扫码传输文件"
state: {"loggedIn":false,"hasQr":true}
GET /api/wechat/qr -> 200 37614B image/jpeg
```

日志同时出现 `[wechat-web] session cleared (cookies + storage)` 与 `[wechat] logged out`。

之后用任意微信号扫码都能登录；再切换回原来的账号也是同样一次「退出登录」。
## 5.46 计划模式退不掉（以及一次回退）

原因：`collaborationMode` 不是「本轮参数」，它会**存进 thread settings**
（`ThreadSettings.collaborationMode`）。之前只在开启时发送：

```js
if (state.planMode) params.collaborationMode = { mode: "plan", … };  // 只有开启分支
```

关掉芯片后下一轮不带这个字段，服务端沿用上次保存的 `plan` —— 芯片没了，模型继续规划。

### 第一次尝试（已回退）

当时改成「每轮都显式带模式」（`state.planMode ? "plan" : "default"`）。
服务端接受这个值，但把**所有**普通发送的请求体都改了形状，导致对话不再正常显示。
已经整段回退：普通发送与之前完全一致（`turn/start` 不再带 `collaborationMode`）。

### 现在的做法

只在**关闭计划模式的那一刻**用一次独立的设置更新，不碰正常发送：

```js
if (!state.planMode && state.currentThreadId) {
  rpc.send('thread/settings/update', {
    threadId: state.currentThreadId,
    collaborationMode: { mode: "default", settings: { model, reasoning_effort, developer_instructions: null } },
  });
}
```

同时监听 `thread/settings/updated` 把服务端保存的模式回同步到芯片，
这样桌面端或另一个标签切换模式时，网页端也不会显示错。

### 验证

服务端通知（直接抓 app-server）：

```text
set plan    -> {}
set default -> {}
notifications: thread/settings/updated:plan, thread/settings/updated:default
```

UI 全流程（抓页面发出的 rpc）：

```text
calls:  turn(mode=plan)  →  thread/settings/update  →  turn(mode=null)
plan chip now: {"planMode":false,"chips":0}
last reply: "收到"        ← 关闭后是正常回答，不是计划
```

## 5.47 冷启动时「对话全部不显示」

同一个现象还有第二个来源：启动顺序。原来先等 `projects / quota / models / skills`
**全部完成**才去拉会话列表，冷启动要 10 秒以上；这段时间侧栏是空的，看起来就像对话全没了。
而且四个读取用 `Promise.all`，任何一个失败都会让会话列表根本不加载。

改成：

1. `initialize` → **立刻拉会话列表**（空则 1.2 秒后重试一次）；
2. 其余读取用 `Promise.allSettled` **并行**跑，失败也不影响列表；
3. projects 到达后 `renderThreadList()` 自动分组。

实测：会话列表出现时间 **10s+ → 1.6s**（`first rows: 34 at 1.6s`），
并且模拟一个读取失败后仍然 `threads:38 / rows:34`。

## 5.48 本机正在跑的会话，网页端实时跟着看

### 先确认了协议的限制

用两个独立客户端做对照实验：A 起了一轮任务，B 只收到 **1 条** `thread/status/changed`，
没有任何 `turn/started` / `item/*` / `*delta`。也就是说：

> app-server 只把这一轮的事件流推给**发起它的那个客户端**，其他客户端什么也收不到。

所以桌面端在跑任务时，网页端原本只能看到「空」或者更早的历史。

### 能不能靠轮询补救？可以

`thread/turns/list` 支持 `itemsView: "full"`，实测在一轮进行中会**逐步**放出条目：

```text
+2.5s  inProgress items=0
+7.5s  inProgress items=1  userMessage
+27.5s inProgress items=2  userMessage reasoning
+42.5s inProgress items=3  userMessage reasoning reasoning
```

思考步骤是随生成陆续出现的，所以轮询足够撑起「实时看到思考过程」。

### 实现

- 打开会话、或收到当前会话的 `thread/status/changed(active)` 时，启动 **live follow**；
- 每 1.8 秒拉一次 `thread/turns/list { limit:6, itemsView:"full" }`；
- 用「条目 id 拼接」做签名去重，只有变化时才 `renderStream()`，避免闪烁；
- 按**服务端顺序**重建该轮的 `itemIds`，这样后到的思考步骤仍排在答案上方；
- 轮次结束后再补一次读取，确保最终答案落地，然后自动停止；
- 自己发消息时（`_send` 里）先停止跟随，改用原生 delta 流；切会话、新建会话也会停。

### 实测（另一个客户端起任务，网页端零操作）

```text
+2.5s  busy:true                        ← 自动识别到「有人在这台机器上跑」
+5s    items:1  用户消息渲染出来
+10s   items:3  答案开始增长（"正在处理…我会先算…"）
+22.5s items:4  思考卡片出现（parts:1）
+30s   busy:false  Worked for 27秒
```

顺带修掉两个连带问题：

1. 刚创建、还没落盘的会话会报「历史读取失败：thread … is not materialized yet」，
   现在识别为「空历史」不报警，交给 live follow 填充；
2. 轮询快照里条目顺序可能与先到的不一致，现在按快照顺序重排，思考不会跑到答案下面。

> 已知限制：协议里没有「别人这一轮正在生成什么」的增量接口，所以这里的粒度是最快
> 1.8 秒一次的快照（自己发起的轮次仍是毫秒级 delta 流）。
## 5.49 表格与公式渲染（KaTeX 本地内置）

原来 `md()` 只把 `| a | b |` 当成普通段落输出（`<p class="table-line">`），公式完全不处理，
所以模型给出的推导会原样显示成 `\(a<b<c\)`、`\boxed{...}` 和一堆竖线。

### 表格

按 GFM 解析：表头行 + 分隔行（`|---|:--:|`）→ `<table>`；
从分隔行解析对齐（`:--` / `:--:` / `--:`），单元格内容仍走 `inlineMd`（所以单元格里的公式照样渲染）。
外层套 `overflow-x: auto`，窄屏横向滚动而不是撑破布局。

### 公式

- KaTeX **本地内置**：`web/vendor/katex/`（269KB js + 23KB css + 20 个 woff2 共 254KB），
  不依赖 CDN，断网也能用；
- **懒加载**：只有真的出现公式时才注入 `<link>` 与 `<script>`，首屏不受影响；
- 支持的写法：行内 `\( … \)` 与 `$ … # Codex Remote — 用 iPad / 另一台电脑操作本机 Codex

把本机（KLV-WX9）上的 Codex 变成一个**固定地址的 Web 界面**：iPad、另一台 Windows 电脑打开浏览器就能接管本机的 Codex 会话，任务仍然跑在这台机器上。

不需要梯子、不需要公网 IP、不需要端口映射。

---

## 0. 先说三件事实

1. **`npx codex-xremote` 不存在。** npm 上没有 `codex-xremote`，也没有 `codex_xremote`（GitHub 上有个同名仓库，但没发包），所以那条命令必然 404。本方案不依赖它。
2. **本机 Codex 0.166.0 自带官方远程能力**，这套东西就建在它上面：
   - `codex app-server --listen ws://127.0.0.1:8791` — 官方的 WebSocket 服务端（实测可直接跑，且只绑本机回环）
   - 协议是官方生成的 TypeScript 绑定（`protocol/`，760 个类型文件），请求形如 `{method, id, params}` → `{id, result}`
3. **界面是从 Codex 桌面端本身提取出来对齐的**：配色直接取自桌面端窗口截图的像素采样，字体/圆角/间距取自它自己的 CSS 变量（`web/tokens.css` 由 `desktop-webview/` 里的真实样式表合并而成）。

---

## 1. 现在怎么用

```text
这台电脑（被控）                         你的 iPad / 笔记本
┌──────────────────────────┐            ┌─────────────────┐
│ Codex app-server :8791   │            │                 │
│   ↑ 只绑 127.0.0.1       │            │  浏览器          │
│ bridge (Node) :8787      │◄──HTTP/WS──│  http://…:8787  │
│   · 静态页面 + WS 代理    │            │                 │
│   · 口令登录 + 签名 Cookie│            │                 │
└──────────────────────────┘            └─────────────────┘
```

| 场景 | 地址 |
|---|---|
| 本机 | <http://127.0.0.1:8787/> |
| 同一 Wi-Fi / 局域网 | <http://<lan-ip>:8787/> （IP 变了以 `bridge/logs/bridge.log` 启动那几行为准） |
| 任何网络（Tailscale，已配好） | <http://<tailnet-ip>:8787/> |

**访问密码**在 `bridge/config.json` 的 `passcode` 字段里，当前是：

```powershell
(Get-Content .\bridge\config.json -Raw | ConvertFrom-Json).passcode
```

打开页面输入一次，之后 30 天内不用再输（HttpOnly 签名 Cookie）。

**iPad 上建议「添加到主屏幕」**：Safari 打开 → 分享 → 添加到主屏幕，之后就是一个全屏 App 的样子，没有浏览器地址栏。

---

## 2. 外网访问

### 2.1 Tailscale（已配置，当前方案）

不给域名、不花钱、不用公网 IP。本机已加入 tailnet，节点信息：

| 项 | 值 |
|---|---|
| 节点 IP | `<tailnet-ip>` |
| MagicDNS | `pc-20261014odxq.taild17e9c.ts.net` |
| 访问地址 | <http://<tailnet-ip>:8787/> |
| 配对链接 | <http://<tailnet-ip>:8787/?t=`<你的 passcode>`> |

链路是 WireGuard 端到端加密的，所以 HTTP 也是加密的（浏览器只会提示"不安全"是因为没证书，不影响保密性）。

**iPad 上四步：** App Store 装 `Tailscale`（厂商 Tailscale Inc.）→ 同一个账号登录 → 打开 VPN 开关 → Safari 打开上面的地址，输一次密码，然后「分享 → 添加到主屏幕」。

**新设备想加入**：在那个设备上装 Tailscale 并用同一账号登录即可，不需要改本机任何配置。

常用命令：

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" status      # 看谁在线
& "C:\Program Files\Tailscale\tailscale.exe" ip -4       # 本机 tailnet IP
```

**可选：换成 HTTPS 地址**（去掉"不安全"提示，iOS 的 PWA 体验也更完整）

1. 打开 <https://login.tailscale.com/f/serve?node=nyzbRqQvef11CNTRL> 启用 Serve（一次性）
2. 然后执行 `& "C:\Program Files\Tailscale\tailscale.exe" serve --bg http://127.0.0.1:8787`
3. 地址变成 `https://pc-20261014odxq.taild17e9c.ts.net/`

### 2.2 Cloudflare Tunnel（备选，需要自己的域名）

本机也装了 `cloudflared`（2026.10.7）。这条路需要**你自己的域名并托管到 Cloudflare**，好处是域名更好记、可以叠 Cloudflare Access 做邮箱验证码二次验证。**实测注意**：免账号的临时隧道（`-Quick`）从这条网络现在返回 `429`，不要指望它。

```powershell
# 1) 登录（会打开浏览器，选你的域名授权）
& "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe" tunnel login

# 2) 建命名隧道 + 绑域名 + 注册登录自启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-tunnel.ps1 -Hostname codex.example.com
```

跑完就有固定入口 `https://codex.example.com/`，且重启后自动带起来。

- 只想先试试、没有域名：`scripts\setup-tunnel.ps1 -Quick` 会给一个随机 `*.trycloudflare.com` 地址，**重启就变**，不建议长期用。
- 移除隧道入口：`scripts\setup-tunnel.ps1 -Uninstall`（Cloudflare 面板里的隧道和 DNS 记录要手动删）。

> 为什么不推荐 frp / DDNS：都要一台公网服务器或路由器端口映射；Cloudflare Tunnel 是纯出站连接，CGNAT 后面也能用，而且免费额度对单人够用。

---

## 3. 开机自启与日常操作

已经注册好计划任务 `CodexRemoteBridge`（登录时启动，无窗口，失败每分钟重试）：

```powershell
# 看状态
Get-ScheduledTask -TaskName CodexRemoteBridge | Select TaskName,State
# 立即启动 / 停止
Start-ScheduledTask -TaskName CodexRemoteBridge
Stop-ScheduledTask  -TaskName CodexRemoteBridge
# 健康检查
Invoke-WebRequest http://127.0.0.1:8787/healthz -UseBasicParsing | Select -Expand Content
# 卸载自启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
```

日志：`bridge/logs/bridge.log`（含 app-server 的 stderr，超过 4 MB 自动轮转一次）。

---

## 4. 安全边界（重要）

- app-server **只监听 127.0.0.1:8791**，局域网上任何人都摸不到它；对外只有 bridge 的 8787。
- 8787 需要口令登录，Cookie 是 HMAC-SHA256 签名 + 30 天过期 + HttpOnly + SameSite=Lax；同一个 IP 5 分钟内错 8 次会被限流。
- 口令等同于这台电脑的 Codex 操作权（Codex 会执行命令、改文件）。**别把带 `?t=` 的配对链接发到群里**，用完可以改 `config.json` 的 `passcode` 再重启 bridge。
- 本机三个防火墙配置文件目前都是关闭的，所以局域网能直连。**如果你以后开了防火墙**，需要放行 8787（管理员权限）：

  ```powershell
  New-NetFirewallRule -DisplayName 'Codex Remote 8787' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Domain,Private
  ```

---

## 5. 界面与桌面端对齐到什么程度

已经对齐的：三栏骨架（图标栏 / 会话列表 / 对话区）、#F6F6F6 顶栏与图标栏、#FCFCFC 侧栏、纯白画布、近黑色用户气泡、`Worked for …` 分隔行 + 细分隔线、13.5px 侧栏字与 15px 正文、20px 气泡圆角、胶囊形模型/思考强度选择器、暗色主题、iPad 双栏与手机抽屉式布局。

**尚未逐像素复刻的**：它不是 Electron 渲染的那份前端（那份要逆向主进程通信协议，见第 7 节）；命令卡片、diff、审批卡是按同一套设计语言重写的，不是桌面端原组件。想再逼近，可以直接对着 `docs/ui-*.png` 和 `docs/ref-desktop.png` 提具体差异点，我按截图逐屏修。

截图（都是真机数据，不是假数据）：

| 文件 | 说明 |
|---|---|
| `docs/ref-desktop.png` | Codex 桌面端原件（颜色采样来源） |
| `docs/ui-desktop.png` | 本方案 · 桌面尺寸 |
| `docs/ui-thread.png` | 本方案 · 打开真实会话 |
| `docs/ui-ipad.png` | 本方案 · iPad 横屏 1180×820 |
| `docs/ui-phone.png` | 本方案 · 手机 390×844 |
| `docs/ui-dark.png` | 本方案 · 暗色 |
| `docs/ui-home.png` | 本方案 · 新会话首页 |

---

## 5.5 实现状态（哪些是真跑通的，哪些没有）

这一节按**实测**写，不按"看起来像"写。验证手段在 `tools/`：`flow-test.mjs`、`held-test.mjs`、`cdp-diag.mjs`。

### 已实现且实测通过

| 能力 | 验证方式 |
|---|---|
| 浏览器 ↔ app-server 全双工 JSON-RPC | `cdp-diag.mjs`：零未捕获异常，`已连接` |
| 会话列表（含 Pinned/Recents 分组、置顶顺序） | 11 条真实会话 |
| **打开桌面端正在编辑的会话**（只读） | 实测 4 轮 / **224 个 item**、16 消息 / **161 个步骤卡片**全部渲染 |
| 分页历史 + 上滑加载更早 | `thread/turns/list` + cursor |
| 新建会话并发送 | `flow-test.mjs`：气泡单条、标题同步、RPC 往返成功 |
| 失败原因常驻展示 | 额度错误以内联红条留在正文里（不再一闪而过的 toast） |
| **桌面端占用检测与逃生** | `held-test.mjs`：出现只读横幅 +「复制为新会话 / 再试一次接管」，草稿保留；`thread/fork` 实测成功（复制 2 轮）|
| 协议内部消息折叠 | `<send_user_message_question_reply>` 等不再冒充用户气泡 |
| 路径 / 图片引用 | `[文字](C:\...)`、`![图](C:\x.png)` 渲染成 chip，不再显示原始 Markdown |
| 明暗主题、iPad 双栏、手机抽屉 | 截图见 `docs/ui-*.png` |
| 登录鉴权、限流、签名 Cookie | 8 次/5 分钟限流、HMAC 签名、30 天 |

### 已实现但没能实测（被账号额度挡住）

| 能力 | 状态 |
|---|---|
| 流式输出（`item/*/delta`） | 代码路径完整，e2e 里收到过 `turn/started`→`item/started`→`error`→`turn/completed` 全序列，但没跑完一轮真实回答 |
| 审批弹窗（`item/commandExecution/requestApproval` 等） | 响应体按协议实现（`{decision:"accept"}`），额度恢复后需真跑一次 |
| 停止（`turn/interrupt`） | 同上 |
| 命令卡片展开、diff 着色 | 已按 161 个真实 item 渲染，输出内容为空是因为历史里 `aggregatedOutput` 本就为空 |

### 明确没做

- **页面刷新会丢掉未决审批**：`codex_xremote` 用 `GET /pending` 补这个洞，我们的连接是「每个浏览器 WS 一条上游」，刷新即断。下一步应把上游连接提升为按会话常驻（见参考文档建议 1）。
- ~~文件/图片不能在本机之外打开~~ → 已实现 `/api/upload` + `/api/file`，见 5.6。
- ~~会话重命名 / 归档 / 删除没有 UI~~ → 已实现，右键/长按会话行。
- `approval_policy` 与 `sandbox_mode` **保持 Codex 自己的配置**，不像 codex_xremote 那样硬塞 `never` + `danger-full-access`。


## 5.6 附件 / 技能 / MCP / 会话管理（已实现）

### 加文件（三条入口）

| 入口 | 说明 |
|---|---|
| 点回形针 | 弹出系统文件选择器。**iPad 上会给出「照片图库 / 拍照 / 选择文件」**，可以直接从相册或相机加图 |
| 拖拽 | 把文件拖到页面上，出现虚线遮罩，松手即上传 |
| 粘贴 | 在输入框里直接粘贴截图或复制的文件 |

文件**不是传到浏览器**，而是落到被控机：`%TEMP%\codex-remote\<时间戳>-<原名>`。发送时按类型组进消息：

- 图片（png/jpg/gif/webp/heic/svg…）→ `{type:"localImage", path}`，Codex 能直接看图
- 其它文件 → `{type:"mention", name, path}`

上限 512 MB。实测：`text + localImage + mention + skill` 四种混合输入被 `turn/start` 正常接受。

### 看文件 / 下载

附件 chip、正文里的路径 chip、`imageView` 卡片都可以点开查看器：

- 图片 → 直接渲染（走 `/api/file`，支持 Range 所以 Safari 能流式播放视频/PDF）
- 文本 / 代码 / markdown → 拉前 512 KB 显示
- 视频 / 音频 → 原生播放器
- 其它 → 右上角「下载」

### 技能（`/` 快捷调用）

输入框打 `/` 弹出已装技能（本机实测 **197 个**，来自 `skills/list`）。↑↓ 选择，Enter/点击确认，技能会作为 chip 挂在消息上（`{type:"skill", name, path}`）。

### ⚡ Fast 加速档（实测生效）

输入框右侧的 ⚡ 按钮就是 Codex 桌面端的那个"闪电"。点一下变成蓝色 **Fast**，再点关闭。

实测请求体里真的带上了：

```json
{ "method": "turn/start", "params": { "serviceTier": "priority", ... } }
```

取值来自 `model/list` 的 `serviceTiers[0].id`（本机是 `priority`，名字 Fast，说明"2x speed, increased usage"）。模型不支持时按钮自动隐藏；换模型时若新模型没有加速档会自动关闭。

### 插件（新增页签）

「技能与 MCP」面板现在是三个页签：**技能 / 插件 / MCP**。

插件页签实测读到 4 个市场：`openai-primary-runtime`、`openai-bundled`、`context-mode`、`openai-curated-remote`，每个插件显示名字、版本、启用状态和**可直接挂载的技能 chip**：

```text
documents        26.1026.10807  1 个技能   /documents:documents
pdf              26.1026.10807  1 个技能   /pdf:pdf
spreadsheets     26.1026.10807  2 个技能   /spreadsheets:Spreadsheets  /spreadsheets:excel-live-control
presentations    26.1026.10807  1 个技能   /presentations:Presentations
template-creator 26.1026.10807  1 个技能   /template-creator:template-creator
codex-app-tools  26.1027.30824  （只有 MCP 工具，没有技能）
browser / unified-computer-use / computer-use / chrome / visualize  （同上）
```

> 澄清一点：Codex 的"插件"不是一个可以直接调用的函数，它是**技能 + MCP 工具 + app 工具**的集合。所以"调用插件"拆成两条路：它的技能走技能页签（挂到消息上），它的工具走 MCP 页签（直接调）。两条现在都通了。

### MCP 实测调用（context-mode）

不是"列出来"，是真的调了。面板里点 `ctx_stats` → 调用 → 返回：

```text
context-mode  < 1 min  0 calls
No tool calls yet. Use batch_execute or execute to start saving tokens.
  Skipped (1): Codex CLI
$0.00 this session  ·  $0.00 lifetime
v1.0.169
```

另外 `ctx_search` 也调通了（返回"知识库为空"的正常提示）。**没有会话也能调**：会自动开一个临时会话（`ephemeral: true`）承载 MCP 连接，不污染会话列表。

### `/` 检索：修了三个真 bug

| 问题 | 现象 | 修法 |
|---|---|---|
| 命名空间重复拼接 | 显示 `humanizer:humanizer:humanizer` | `skills/list` 返回的 name 本身已带命名空间，不再二次拼接 |
| 描述级匹配污染 | 打 `/hum` 出来一堆不相干的 | 有名字命中时直接丢弃"只在描述里出现"的结果；前缀命中排最前 |
| token 被吃掉 | 选完技能输入框变空，看不出挂了什么 | 保留可见的 `/名称` token；删掉 token 时 chip 自动取消 |

也可以不经过菜单：直接输入 `/名称` 再按空格，效果一样。

### 项目（Projects）

**先纠正一个我自己先前的错误结论**：我一开始查 109 个客户端方法没找到 `project/*`，就断言"协议里没有"。实际上**有 7 个**：

```text
project/list   project/read   project/create   project/import
project/update  project/move  project/delete
```

它们全都标了 `#[experimental]`，而 `codex app-server generate-ts` **默认 `experimental_api: false`，会把实验性请求从产出里过滤掉**（通知不过滤，所以 `project/changed` 一直在）。这是我那份绑定里只有通知、没有请求的原因。

修复用了两步：

```powershell
# 1) 重新生成绑定（767 → 915 个类型文件）
codex app-server generate-ts --experimental --out codex-remote\protocol
# 2) 客户端 initialize 时声明能力（我们本来就带）
{ capabilities: { experimentalApi: true, requestAttestation: false } }
```

本机实测：

```text
project/list -> OK   1 个项目 "Remote"
  roots = C:\Users\…\Codex_Migration_20261031T104701Z
  position = 0    recencyAt = null
```

**项目的真实位置是 app-server 的 SQLite 线程库，不是 config.toml。** `config.toml` 里的 `[projects.'C:\…']` 只有一个 `trust_level` 字段，是 `thread/start` 在写时顺手落下的信任标记，和"项目"列表无关。SQLite 存储不可用时 `project/list` 会返回 `-32601`，所以要按"可选能力"处理。

#### 归属：绝不按 cwd 推断

上一版我用"cwd 落在项目 root 下"来猜归属，**这是错的**。真实来源只有三处：

| 来源 | 说明 |
|---|---|
| `thread/start { cwd, projectId }` | 新建时指定，**两个字段都要发**，互不影响 |
| `thread/metadata/update { projectId }` | 事后改归属（没有 `thread/projectUpdate` 这个方法） |
| fork 继承 | 分叉时继承父线程的项目 |

现在客户端实测发出的参数：

```json
{ "method": "thread/start", "params": {
    "cwd": "<outputs>\\Codex_Migration_20261031T104701Z",
    "projectId": "01a1920c-cfcc-7f83-9028-17f04339287a" } }
```

#### 两套 id 空间的现实

这台机器上同时存在两份项目数据，**id 不同**：

- app-server（SQLite）：`project/list` 给的 `01a1920c-…`，其中 **0 条线程**
- 桌面端（`~/.codex/.codex-global-state.json`）：`b3076195-…`，其中有 **2 条线程归属**

桌面端界面显示的是后者。所以现在的做法是：**以 `project/list` 为准**，再把桌面端注册表按 **root 路径相同** 做一次 id 映射（`b3076195 → 01a1920c`），这样两边的线程都能落到同一个项目分组里；匹配不上的桌面项目作为附加项保留。

界面表现与之前一致：侧栏「项目」分组、文件夹图标 + 名称 + 会话数、点子会话缩进、输入框项目 chip（决定新会话的 `cwd` 与 `projectId`）、标题栏 + 按钮。

### 额度预检 + 空会话回收（解决"新建对话同时存在多个"）

根因有两层，实测确认：

1. 额度用完时 `turn/start` **依然会成功返回**，然后这一轮才失败——这种"已受理后失败"的线程是**持久化且不会回滚**的，于是就留下一个只有一条用户消息的空会话。
2. 但 **`thread/start` 本身不落盘**（代码注释："Fresh threads have no rollout until their first turn"）。所以光点"新建对话"不会产生任何孤儿——真正产生垃圾的是第 1 条。

现在的处理：

1. 连上就 `account/rateLimits/read`，5 小时窗口 `usedPercent >= 100` 或 `ordinaryUsageAllowed === false` 视为耗尽
2. 耗尽时输入框上方直接显示横幅（和桌面端同款）：
   ```text
   Codex 和工作使用额度已用完
   5 小时窗口已用 100% · 将于 11/4 03:37 重置            [查看用量]
   ```
3. **发送直接被拦下**，不入队、不建会话（实测拦下后请求列表为空、侧栏条数不变）
4. 万一仍然发生（比如额度中途耗尽），`turn/completed` 为 `failed` 且这一轮**零助手产出**时，自动 `thread/archive` 收起该会话（用 archive 而不是 delete：这一轮已经写过 rollout，archive 可逆），并把草稿放回输入框

### 左侧栏（只有 4 个入口）

| 图标 | 作用 |
|---|---|
| 首页 | 回到新会话 |
| 技能与 MCP | 两个页签：**技能**（197 个，可搜索，点一下挂到下一条消息，等同输入 `/名称`）；**MCP**（8 个服务器、实测 507 个工具，点工具填 JSON 直接调 `mcpServer/tool/call`）|
| 最近文件 | 上传过的 + 会话里出现过的文件（实测 29 条），每行「查看 / 下载」 |
| 用量 | 套餐、5 小时 / 7 天窗口已用百分比与重置时间、剩余 credits、累计 tokens 与连击天数 |

底部保留一个明暗主题切换（iPad 上确实需要）。

### 用量面板实测输出

```text
PLUS
5 小时窗口   100% 已用   重置 11/4 03:37   <- 就是它挡住了任务执行
7 天窗口      34% 已用   重置 11/8 19:20
剩余 credits  0
累计 tokens   1,015,696,789（单日峰值 83,770,069 · 连续 9 天 · 最长 18 天）
```

### 会话管理

在会话行上**右键**（iPad 上**长按**）→ 重命名 / 归档 / 删除，对应 `thread/name/set`、`thread/archive`、`thread/delete`。

> **列表重复的修复**：`thread/list` 默认会扫 JSONL 做元数据修复，同一条线程可能返回两次。现在改用 `useStateDbOnly: true`，并在客户端按 id 再去重一次：实测 12 条 → **10 条、0 重复**。

## 5.7 排版体检与修复（数据驱动）

用 CDP 在真实浏览器里量，不靠眼睛：`tools/layout-audit.mjs` 会在 1440×920 / 1180×820 / 390×844 三个尺寸下检查
横向溢出、越界元素、固定层相互遮挡，并落三张截图到 `docs/audit-*.png`。

第一次审计结果：

| 尺寸 | 横向溢出 | 越界 | 遮挡 |
|---|---|---|---|
| 1440×920 | 无 | 无 | 无 |
| 1180×820（iPad） | 无 | 无 | 无 |
| 390×844（手机） | 无 | 抽屉左移（正常） | **模型 chip 换行成 3 行并溢出输入框边框** |
| 侧面板打开 | — | — | **面板压住输入框**（panel.left 1008 < composer.right 1278） |

修的三处：

1. **输入框 chip 行禁止换行 + 横向滚动**（`.composer-row { flex-wrap: nowrap; overflow-x: auto }`，隐藏滚动条），窄屏进一步缩小 chip 内边距与字号；`.chip` 加 `white-space: nowrap`
2. **窄屏用短占位文字**：`window.innerWidth < 520` 时改成「描述任务，Enter 发送」，并在 resize 时同步（原来是长句被截断）
3. **侧面板加遮罩**：作为 sheet 出现（`#panelBackdrop`，点击关闭），不再"静默盖住输入框"；手机上面板改为左右各留 8px 的全宽

修复后复测：三尺寸 `overflowX` 全为空，手机截图里 chip 单行、占位文字完整。

### 关于 dsh-pilot

想装 `dsh-pilot`（浏览器操控插件）时遇到的是**架构限制**，不是网络问题：

```text
$ npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile desktop add dsh-pilot
error: profile "desktop" is managed exclusively by the Electron application
```

- 本机用的是 `desktop` profile（`~/.dsh/profiles/desktop`），由 Electron 独占管理，CLI 拒绝写入
- 该 profile 目录里**没有 node_modules**，而 dsh-pilot 的 peer 依赖（`@deepseek-ai/cordis`、`dsh-tools`、`schemastery`）都在应用包内，手工 `npm i` 解析不到
- GUI 的 19387 端口有 401 鉴权，token 只在内存里
- 应用内确实有插件管理页（包名 `@deepseek-ai/dsh-client-ui-settings-plugins`）

正确装法（入口在**左侧栏第二行**，不是设置里）：

1. 左侧栏点 **插件**（「新会话」正下方，插头图标）
2. 点 **添加插件**
3. 包名填 `dsh-pilot`（可选版本后缀），按 Enter 或点 **安装**
4. 装完点 **立即启用**
5. 若提示需要重载，重启应用

那个页面就是插件管理器（包名 `dsh-client-ui-plugin-manager`），支持包名 / Git 地址 / 压缩包 / 本地绝对路径，还能选 npm 官方源或中国大陆镜像源。装好后 agent 的工具里会出现
`pilot_navigate / pilot_snapshot / pilot_act / pilot_wait / pilot_screenshot / pilot_close`。

## 5.8 右侧 Dock：面板与文件预览共用一块区域

以前侧栏面板是浮层、文件预览是模态框，两套东西会互相盖住。现在只有**一块右侧 Dock**：

- 侧栏四个入口（技能与 MCP / 最近文件 / 用量）打开的都是它
- 点会话里的路径 chip、附件 chip、`imageView` 卡片、最近文件的「查看」，**也开在同一个位置**
- 宽度 `--dock-w: 420px`，从顶部到底部整列；≥1000px 时对话区自动让位（`main { margin-right: 420px }`），不再压住输入框；<1000px 时占满宽度
- 模态遮罩已删除——它是真正的布局列，不是弹窗

### 文件预览支持

| 类型 | 行为 |
|---|---|
| `.md` / `.markdown` / `.mdx` | **渲染成 markdown**（标题/列表/代码块/链接），带「预览 / 源码」切换 |
| `.html` | 「预览 / 源码」切换；预览跑在 `<iframe sandbox="">` 里（脚本与本站存储隔离） |
| 代码 / 文本 / json / toml … | 源码视图（等宽、换行、上限 512 KB） |
| 图片 | 直接显示 |
| 视频 / 音频 | 原生播放器 |
| 其它 | 只给「下载」 |

> HTML 预览的边界：因为沙箱禁脚本，**依赖外部 JS 的页面（例如 Vite 打包出来的 SPA 壳）会显示为空白**，Dock 里会显示一行说明提示切到「源码」。自包含的 HTML（报告、表格、静态页）能正常渲染。

### 顺带的两处调整

- **侧栏文本单行 + 左对齐**：会话名、项目名都是 `white-space: nowrap` + 省略号，不再折成两行
- **去掉侧栏的「Codex」品牌按钮**（它点了只弹 toast，是个假控件）
- **首屏加载并行化**：`project/list`、`account/rateLimits/read`、`model/list`、`skills/list` 一起发，再取线程列表——实测首屏从 15 秒降到 **3.5 秒**

## 5.9 对话标题栏的实时用量条

每个对话的标题栏右侧现在是四个胶囊：

```text
上下文 35%   tokens 412.0k   命中率 82%   5h 额度 100%
```

| 指标 | 算法 | 数据来源 |
|---|---|---|
| 上下文 | 本轮 `last.totalTokens / modelContextWindow` | `thread/tokenUsage/updated` 或 `rawResponse/completed` |
| tokens | 本会话累计 `total.totalTokens` | 同上 |
| 命中率 | 本轮 `cachedInputTokens / inputTokens` | 同上 |
| 5h 额度 | `primary.usedPercent` | `account/rateLimits/read`（全局，一直有）|

颜色：≥65% 变黄、≥85%（额度是 ≥70% / ≥90%）变红，一眼能看出快满。

窄屏自适应：<1100px 隐去文字标签只留数值，<700px 整条隐藏。

### 一个必须说清的限制

**历史对话拿不到用量。** 我查过所有可能的口径：

- `Turn` 没有 usage 字段
- `account/usage/read { threadId }` 在本机返回空对象（SQLite 里没有 per-thread 用量）
- `model/list` 与 `modelProvider/capabilities/read` 都不给上下文窗口大小

用量只存在于两条**实时通知**里（`thread/tokenUsage/updated`、`rawResponse/completed`），也就是只有这个会话在本机跑过至少一轮之后才有数。所以刚打开一个历史会话时，前三个胶囊显示 `—`（悬停有说明），跑起来就会自动填充。

上下文窗口会按模型记在 `localStorage`（`codex-remote-ctx`），下次同一模型开新会话时，第一轮就能直接算出百分比，不用等第二次通知。

## 5.10 会话常驻上游：关页、刷新、断网都不丢

以前每个浏览器 socket 独占一条上游连接，关页就等于把 app-server 那条连接掐了。现在改成**会话级常驻上游**：

- 会话 id 由登录 cookie 派生（`sha256(cookie).slice(0,24)`），所以刷新、关页、锁屏、网络抖动都回到**同一条** app-server 连接
- 浏览器 socket 只是这条会话的**订阅者**；断一个订阅者不影响会话，也不影响里面正在跑的轮次
- 重连时把仍待人工决定的请求（审批卡片）**原样重放**给新订阅者
- 重复的 `initialize` 由桥接**用缓存应答**，不会去重初始化上游（协议不允许）

### 实测（真实任务，非桩）

```
client A: turn/start 后 1.2s 收到 16 条通知，断开
client B: 1.5s 后重连同一会话
        → 又收到 118 条通知（其中 98 条 item/agentMessage/delta）
        → turn/completed，最终 status=completed
```

也就是说断线期间任务在跑，重连后流式输出继续接到新页面上。

### 看门狗：常驻带来的新风险及兜底

常驻的代价是「上游一卡，刷新也救不回来」（同 cookie 同会话）。所以补了两层：

| 机制 | 行为 |
|---|---|
| 看门狗 | 每条客户端请求登记；**20 秒没有应答**就判定上游僵死，拆掉重建 |
| `POST /api/session/reset` | 手动重置该 cookie 的会话，返回 `{ok, found}` |
| 重置动作 | 终止上游 + 关闭订阅者 socket；浏览器自动重连、重新初始化、重跑启动读取 |

实测：`A 正常 → reset(200, found:true) → A 的 socket 被关闭 → B 重连 initialize ok、thread/list 5 条`。

## 5.11 手机上传：三个真实入口 + 微信引导

回形针不再是一个通用选择器，而是一个菜单（桌面端同样走这个菜单）：

| 入口 | `accept` / 属性 | 用途 |
|---|---|---|
| 照片 / 视频 | `image/*,video/*` | iOS 直接进照片图库 |
| 拍照 / 录像 | `image/*,video/*` + `capture=environment` | 直接开相机 |
| 任意文件（微信下载/文件 App） | `*/*` | 走到系统「文件」App，能进微信目录 |
| 从微信取文件…… | — | 打开右侧 Dock 的分平台步骤说明 |

**为什么需要说明页**：微信聊天文件在微信自己的沙盒里，网页（包括微信内置浏览器）**拿不到**——这是平台限制，不是实现问题。所以：

- 内置浏览器检测（UA `MicroMessenger`）→ 顶部提示「点右上角 ⋯ → 在浏览器打开」
- 说明页给出精确路径：iOS 走「存储到文件 → 我的 iPhone/微信」；Android 走「内部存储 → tencent → MicroMsg → Download」

> 理论上能做得更进一步的是 Android PWA 的 `share_target`（从微信「分享」直接进本应用），但它要求 HTTPS + 已安装 PWA，当前是 tailnet 上的 http，所以没做。

## 5.12 顺手修掉的启动崩溃

指标条上线后引入了一个真实 bug：`renderMetrics` 里只判断了「已知上下文窗口」，没判断「本轮用量」——

```js
ctxTotal ? '本次请求占用 ' + fmtTokens(last.totalTokens) ...   // last 可能是 null
```

凡是 localStorage 里**记住过窗口**的浏览器（也就是跑过至少一轮的），一启动就 `TypeError: Cannot read properties of null (reading 'totalTokens')`，`loadQuota` 抛出 → `Promise.all` 全挂 → `loadThreads` 根本不执行 → **侧栏永远空着**。干净浏览器（没有缓存窗口）反而不触发，所以很容易漏。

已修：区分「有窗口无用量」和「两者都有」两种文案。同时给 `onConnected` 的每一步加了 `console.error` 上报，同类问题以后会直接出现在控制台。

## 5.13 移动端布局修复

「手机上侧边栏没了」的根因不是侧栏本身，而是小于 900px 时 `rail` 被 `display: none` 隐藏——顺带把**技能与 MCP / 最近文件 / 用量**的唯一入口也一起藏了。这一轮把整条移动端链路重做了一遍。

| 问题 | 以前 | 现在 |
|---|---|---|
| 导航入口 | 窄屏直接 `display:none`，四个面板无处可达 | **底部标签栏**（首页/技能/最近文件/用量/主题），`52px + safe-area` |
| Dock 宽度 | `width:100vw` 实测右移出屏 **8px** | `left:0; right:0; width:auto`，实测 `x=0 w=390` |
| 发送按钮 | 在横向滚动的 chip 行里，窄屏被**裁出视野** | 移出滚动区，`.composer-line` 里固定右侧，永远可见 |
| 标题栏指标 | 媒体查询只看视口，Dock 一开对话区变窄就**竖排**（「上 下 文」） | 改用 `@container convo`，按对话列宽降级：<820px 去标签，<520px 整条隐藏 |
| 技能/工具行 | 长 id（`app-<uuid>:name`）撑破面板，描述折三行 | 名字与描述各占一行、超长省略；手机上名字一行 + 描述一行 |
| 首页输入框 | 底部留 `16vh`，手机上近 1/5 屏是空的 | 窄屏降到 `5vh` |
| 抽屉 | 层级与遮罩未对齐 | 抽屉 46 / 遮罩 44 / 标签栏 45，点遮罩关闭 |

### 实测数据（390×844）

```
rail        : flex, {x:0, y:792, w:390, h:52}
composer    : {y:669, bottom:792}
overlap     : clear（输入框底边正好贴标签栏顶边，不重叠）
技能/MCP   : dock 390×792, title=技能与 MCP
最近文件    : dock 390×792
用量        : dock 390×792
drawer      : open → 点遮罩 → closed
JS errors   : []
```

iPad 横屏（1180×820）也复测过：导轨恢复竖排 64px、侧栏常驻、Dock 401px 且对话区仍有 423px，标题栏不再竖排。

### 顺带：本地回环不再被登录限流

测试中被「8 次失败 / 5 分钟」挡住（脚本反复登录）。改成 **来自 `127.0.0.1`/`::1` 的登录请求不限流**——本机就是主人，限流只为挡局域网暴力尝试。

## 5.14 思考强度：Codex 风格滑块弹层

原来点「低/中/高」是一个普通菜单列表。现在换成和桌面端一致的弹层：

- 顶部：⚡ 图标 · 当前档位（蓝色加粗）· 重置按钮
- 中间：模型名（点一下切模型）
- 滑块：蓝色已选段带白点、灰色未选段带灰点、白色圆形滑块；下面一排档位文字，当前档高亮
- 键盘可用（方向键）、Esc 关闭、点外部关闭；宽度 <520px 时铺满

档位来自 model.supportedReasoningEfforts，只显示模型真实支持的级别（当前 6 档：低/中/高/极高/最大/极限）。

### 闪电 = Fast 加速档开关

和桌面端一致：弹层左上角那个 ⚡ 本身就是 Fast（priority service tier）开关，输入框下方原来的 `⚡ Fast` chip 已删除。

- 关：灰色描边图标；开：蓝色填充 + 淡蓝底，标题旁出现 `Fast` 徽标
- `aria-pressed` 同步，键盘可操作；切换有 toast 说明「2x speed, increased usage」
- 选择记在 `localStorage`（`codex-remote-fast`），刷新后保持
- 发送时作为 `turn/start` 的 `serviceTier` 传给 app-server（沿用原有链路，未改动）
- 当前模型没有 serviceTiers 时，这个按钮会自动隐藏并把状态归零

实测：

```text
fast chip gone : true
composer chips : [projectBtn, modelBtn, effortBtn]
bolt click     : state.fast=true, aria-pressed=true, Fast 徽标出现
再点一次       : state.fast=false, 徽标消失
```
## 5.15 微信文件：先说做不到的，再说做到的

### 做不到：网页唤起微信「选择聊天文件」

这是平台限制，不是实现问题：

- wx.chooseMessageFile 只能在微信内置浏览器里用，且必须先过 **公众号 AppID + JS-SDK 签名**（后端换 jsapi_ticket），还要求页面在公众号的「JS 接口安全域名」里、域名已备案、走 HTTPS。
- 顺带的坏消息：这台机器所在的 tailnet **不支持签发 TLS 证书**——实测 tailscale serve --https 与 tailscale cert 都返回 "your Tailscale account does not support getting TLS certs"。没有 HTTPS 就没有安全上下文，Android 的 **PWA 分享目标**（从微信「分享 → 保存到本应用」）也一并装不上。

### 做到了：微信文件落到本机后，一键挂载

微信 4.x 把收到的文档**保留原文件名**存在：

```text
%USERPROFILE%\Documents\xwechat_files\<账号>\msg\file\<YYYY-MM>\<原始文件名>
```

（图片进的是哈希命名的 msg\attach\*.dat 缓存，拿不到原名，所以只列文档类。）

桥接新增 GET /api/wechat-files?days=60&limit=60，扫描上述目录（3.x 的 WeChat Files\<账号>\FileStorage\File 也兼容），按修改时间倒序返回。

前端在回形针菜单里加了「**微信收到的文件（本机）**」：列出最近文件，点「挂载」直接把它作为附件塞进下一条消息——**不重新上传**，因为 Codex 的附件本来就是本机路径（localPath / mention），app-server 自己读盘。

实测（390×844，iPhone UA）：

```text
菜单     : 照片/视频 · 拍照/录像 · 任意文件 · 微信收到的文件（本机） · 从微信取文件……
面板     : 「微信收到的文件」1 行
文件     : Codex_Migration_20261031T104701Z(1).zip  52.6 MB · 10/31 19:47 · 微信
点挂载后 : 输入框出现 1 个附件 chip，面板自动关闭，JS 报错 0
```

### 手机上的实际用法（3 步）

1. 手机微信里长按文件 → **转发 → 文件传输助手**
2. 网页点回形针 → **微信收到的文件（本机）**
3. 点 **挂载** → 文件随下一条消息发出

比走系统文件管理器进 tencent/MicroMsg/Download 找文件要快，也不会因为微信重命名或清缓存而找不到。
## 5.17 仅传输文件（网页版）怎么挂载

`szfilehelper.weixin.qq.com` 是**网页版**文件传输助手：文件不经过微信客户端的存储目录，而是走浏览器的下载通道。所以盯 `xwechat_files` 永远看不到它。

### 做法：盯下载目录 + 用浏览器自己的下载记录判定来源

- 桥接新增 `/api/inbox`，把两个来源合并：微信客户端的文档 + 浏览器下载目录（默认 `~/Downloads`、`~/下载`）
- 来源判定读 Edge / Chrome / Brave 的 `History`（**先复制再以只读方式打开**，用内置 `node:sqlite`），查 `downloads` 表 + `downloads_url_chains`，看 referrer / URL 链里是否含 `weixin.qq.com` 或 `szfilehelper`
- 判定为微信来源的文件标记 `origin: weixin`，**自动挂载**；其它下载标记 `origin: other/unknown`，默认不动
- 面板里两行开关：「新收到的微信文件自动挂载」（默认开）、「其他浏览器下载也挂载」（默认关）

### 实测

```text
/api/inbox 分类: 7z2605-x64.exe → download/other（bing 来源）
                 ChatGPT Installer.exe → download/other
                 Codex_Migration_...zip → wechat

门控测试: 未知来源下载 + 开关关 → 0 chips（不打扰）
          打开「其他浏览器下载也挂载」+ 再下载 → 1 chip（自动挂上）
```

### 用法

1. 在 `szfilehelper.weixin.qq.com` 页面里点文件的**下载**
2. 文件落进 `~/Downloads`，4 秒内自动挂到输入框

如果微信页面用的是「另存为」让你选目录，选到 `Downloads` 就行；如果下载后**没有**自动挂上，说明浏览器的下载记录没能把来源判成微信（比如用了 File System Access API 或隐私模式），把面板里第二个开关「其他浏览器下载也挂载」打开即可。

### 边界

- 只认文档类扩展名（pdf/docx/xlsx/zip/md/txt…），图片仍排除（微信客户端里是哈希 `.dat`）
- 浏览器 History 每 15 秒缓存一次；刚下载的文件最多等 15 秒才被判定为微信来源
- History 被浏览器独占时复制可能失败，这时全部按 unknown 处理（需要第二个开关）
## 5.16 微信文件自动挂载

目标：本机微信登录（含「仅传输文件」模式）后，其他设备发给「文件传输助手」的文件，**到达即自动挂到输入框**，不用点任何按钮。

### 实现

- 桥接新增 `GET /api/wechat-watch`（SSE）。启动时先给磁盘上的历史文件打基线，之后每 4 秒扫一次 `msg\file`，按 `path + mtime` 判断新文件并推送 `file` 事件。
- 前端用 `EventSource` 订阅；收到新文件就 `state.attachments.push(...)` + 重绘附件区 + toast，**零上传**（附件本来就是本机路径）。
- 已挂载的文件记在 `localStorage`（`codex-remote-wx-seen`，上限 300 条），刷新页面不会重复挂；同一路径已在输入框里也会跳过。
- 面板里有「新收到的文件自动挂载」开关（`codex-remote-wx-auto`），默认开。

### 实测

在真实微信目录 `xwechat_files\wxid_...\msg\file\2026-11\` 落一个文件模拟手机转发：

```text
before : 0 chips
dropped: 自动挂载测试_报告.txt
after  : 1 chip  → 自动挂载测试_报告.txt  70 B
console: wechat watcher connected
```

页面没有任何点击操作，chip 自己出现。

### 为什么「其他账号（仅传输文件）」发的文件不出现

实测结论：**微信没把它写到磁盘**。

- 全盘只有 `wxid_t488viizdxam22_d018` 一个账号目录（另一个账号登录后并没有生成新的 `wxid_*` 目录）
- `msg\file` 里仍然只有 10/31 那个 zip
- 最近 45 分钟用户目录里唯一的文档就是那张 jpg（在 `temp\RWTemp`）

微信在文件是「未下载」状态时只留消息记录、不落盘，于是扫描器看不到。对策：

1. 在电脑版微信里**点开那个文件一次**，它才开始下载到 `msg\file`，随后 4 秒内自动挂载
2. 或者把微信设置里的「自动下载」打开

扫描器本身已经放宽：不再只看 `msg\file`，而是遍历整个账号目录（排除 db/cache/temp 等），按扩展名白名单收文档，深度 5 层；面板上有「刷新」和「扫描 N 个账号目录 · M 个文档」的诊断行，空列表时还会直接提示「未下载的文件不会落盘」。
### 行为边界

- **实时**：文件落地后 4 秒内挂上。
- **不补挂历史**：桥接启动时已在磁盘上的文件只做基线，不会开机刷出一堆旧文件；它们仍在「微信收到的文件」列表里可手动挂载。
- **图片不进列表**：微信把图片存成哈希命名的 `msg\attach\*.dat`，拿不到原名，所以只处理文档类（pdf/zip/docx/xlsx/txt 等）。
- 关掉网页期间到达的文件不会在重开后自动挂，需要开页后再发一次，或在列表里手动挂。
## 5.18 微信文件传输：扫码登录接进网页

微信「仅传输文件」窗口是一个网页应用 `szfilehelper.weixin.qq.com`，它的会话只在**页面内存**里，而且登录二维码图片接口对普通 HTTP 客户端返回 0 字节（风控）。所以桥接的做法是：

- 维护一个**专用调试窗口**（独立配置 `%LOCALAPPDATA%\codex-remote-webtransfer`，端口 9333）
- 通过 CDP 把窗口里的二维码**截成 PNG**，由 `GET /api/wechat/qr` 交给我们的网页显示
- `GET /api/wechat/state` 报登录态与账号名；`POST /api/wechat/reset` 换一张新码（切换账号）
- `GET /api/wechat/messages` 从页面 DOM 解析文件消息（`a.msg-file` / `.msg-file__title` / `.msg-file__desc`）
- `POST /api/wechat/download {index}` 用 CDP 派发**可信鼠标事件**点击 `a.icon__download`

面板入口：回形针 → **微信文件传输（扫码登录）**。未登录显示二维码（每 4 秒刷新），登录后显示账号名 + 文件消息列表 + 「下载并挂载」+「切换账号」。

### 协议（抓包所得，供后续做纯服务端实现）

```text
GET  login.wx2.qq.com/jslogin?appid=wx_webfilehelper  → window.QRLogin.uuid
GET  login.wx2.qq.com/cgi-bin/mmwebwx-bin/login?...   → window.code=200 + redirect_uri
GET  .../webwxnewloginpage?ticket=&uuid=              → skey / wxsid / wxuin / pass_ticket
POST .../webwxinit   {BaseRequest:{Uin,Sid,Skey,DeviceID}}
GET  .../synccheck   → 长轮询
POST .../webwxsync   → AddMsgList[]；文件消息 MsgType=49，
     Content 里是 XML：<title>文件名</title><totallen>字节</totallen><attachid>@cdn_…</attachid>
GET  file.wx2.qq.com/cgi-bin/mmwebwx-bin/webwxgetmedia → 加密字节（页面负责解密）
```

### 当前状态与已知问题

已验证：扫码 → 登录 → 网页显示账号名 → 列出文件消息（实测 `中国国有企业改革…pptx / 59.74MB`）→ 点击触发 `webwxgetmedia` 请求。

未完成：页面在点击后进入 `progress` 状态且长时间不落盘（`fetch → 解密 → blob → 保存`，所以没有 `.crdownload` 可观察）。需要确认是页面自身在该状态下卡住，还是合成点击的问题；备选方案是解析 `MsgId`+`attachid` 后**在服务端下载并解密**，绕开页面。
## 5.19 微信文件传输：全链路已跑通

**入口**：回形针 → **微信文件传输（扫码登录）**。

| 环节 | 实现 |
|---|---|
| 扫码登录 | 桥接维护一个专用调试窗口（独立配置，端口 9333），把窗口里的二维码**截成 PNG** 给网页显示（微信的图片接口对普通 HTTP 客户端返回 0 字节） |
| 切换账号 | 面板「切换账号」→ `POST /api/wechat/reset` 让窗口回到新二维码 |
| 列文件 | `GET /api/wechat/messages` 解析页面 DOM（`.msg-file__title` / `.msg-file__desc`） |
| 触发下载 | `POST /api/wechat/download {index}` 用 CDP 派发**可信鼠标事件**点 `a.icon__download` |
| 挂载 | 文件落到 `~/Downloads` → inbox 监听按浏览器下载记录识别来源 `weixin` → SSE 推送 → 自动挂到输入框 |

**实测（390×844）**

```
[12s] Downloads 出现 中国国有企业改革…(7).pptx
[27s] 输入框出现 chip：中国国有企业改革_30分钟_35页… 59.7 MB
      toast：下载完成 中国国有企业改革…(7).pptx，已自动挂载
```

### 过程中修掉的两个真 bug

1. **来源判定漏了专用窗口**：`downloadOrigins()` 只读默认 Edge 配置的 `History`，而从调试窗口触发的下载记在 `%LOCALAPPDATA%\codex-remote-webtransfer\Default\History`。加上这个 profile 后，所有微信窗口下载都被正确标成 `weixin`。
2. **`unknown` 被当成已处理**：文件刚落盘时浏览器还没写下载记录，来源是 `unknown`；监听第一次看到就标记为已处理，之后来源变成 `weixin` 也不会再广播。改成「来源 unknown 时不标记，下一轮再看」。
3. **source 名字不一致**：桥接广播 `source: 'weixin'`，客户端只认 `'wechat'`/`'download'`，策略直接返回 false。两边统一。

### 说明

- 大文件（60MB）在页面里下载约需 2~3 分钟，期间行内图标显示进度；没有 `.crdownload` 可观察（页面是 fetch → 解密 → blob → 保存）
- 服务端直接下载+解密（`bridge/wechat-fetch.mjs`）已写好但**默认关闭**（`config.json` 里 `wechatServerFetch: true` 可启用）：CDN 对跨域 fetch 返回 CORS 错误或 0 字节，目前只有页面这条路可用
- 那个调试窗口**不能关**（会话只在内存里），最小化即可
## 5.20 附件真的被读到了 + 两处渲染修复

### 问题一：附件只发了个路径，agent 读的是当前目录

现象：消息里能看到文件名，但 agent 去 `ls` 当前目录、总结的是目录里的东西。

原因：`mention` 传的是**工作区之外的绝对路径**（`C:\Users\...\Downloads\xxx.pdf`），模型只把它当成一个名字。

修复：发送前通过 `POST /api/attach/import` 把文件**复制进当前会话的 cwd**（`.attachments/<name>`，重名自动加序号），然后：

- `mention` 的 `name` 用**相对路径**（`.attachments/xxx.pdf`）
- 文本里再补一行 `@.attachments/xxx.pdf`，双保险

关键点：cwd 必须取**当前会话的** `thread.cwd`（`state.currentCwd`），不能用 `defaultCwd`——两者经常不同，用错就会复制到别的项目里。

实测：

```
mention name = .attachments/Zhang+等+-+2025+-+JailGuard+….compare-1.pdf
path         = <workspace>/….attachments/…-1.pdf
agent 回答    = 该文研究大语言模型及多模态大语言模型中的文本和图像越狱攻击检测问题…
```

### 问题二：命令卡片的「退出码」竖排成一列

`.status-pill` 是 flex 子项，默认会被压缩；`.step-sub`（命令文本）没有 `flex-shrink` 限制，把 pill 挤到接近 0 宽，中文逐字换行就竖过来了。

修复：`.status-pill { flex: none; white-space: nowrap }`、`.step-title { flex: none }`、`.step-sub { flex: 1 1 auto; min-width: 0 }`。

### 问题三：`:codex-file-citation{…}` 原样显示

模型输出里的来源标记被当成普通文本渲染。现在 `md()` 会把它换成「（来源：文件名）」。
## 5.21 context-mode：网页端与本地 Codex 都真正生效

### 做了什么（四个缺一不可）

| 步骤 | 内容 | 为什么 |
|---|---|---|
| 1. 打开 hooks 特性 | `~/.codex/config.toml` 里加 `[features] plugin_hooks = true` / `hooks = true` | 不打开，插件 hooks 一律不执行 |
| 2. 升级插件 | 1.0.169 → **2.0.0**（从本地 marketplace 目录换成 npm 2.0.0 包，零依赖） | v2 修了 Codex 适配，且不再需要 36 MB 的 node_modules |
| 3. 修 v2 清单 | `mcp.json` 里 `node` 与 `server.mjs` 改**绝对路径**、`cwd` 固定 `<workspace>` | Codex 不把会话 cwd 传给 MCP，`./server.mjs` 会解析到错误目录导致握手失败 |
| 4. 建立可信 hooks | `context-mode setup --agents codex -y`（`CM_HOOK_OVERHEAD_BUDGET_MS=150`） | 插件自带 hooks 的哈希与旧信任记录对不上 → Codex 视为 untrusted、不执行 |

### 第 4 步的坑

setup 默认要求 hook 开销 p95 ≤ 15 ms，Windows 上 node 冷启动就 20 ms，会被回滚（`hook overhead p95 20 ms > 15 ms (rolled back)`）。
用 `CM_HOOK_OVERHEAD_BUDGET_MS=150` 放宽后 PASS。

setup 生成/修改：`~/.codex/hooks.json`（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse）、
`config.toml` 的 `[mcp_servers.context-mode]` 与四条 `[hooks.state."...hooks.json:..."]` 信任记录、以及三个技能 `ctx-doctor` / `ctx-stats` / `ctx-upgrade`。

### 让模型真的去用它

`~/.codex/AGENTS.md` 增加了一节规则（大文件/日志用 `ctx_execute`、多命令用 `ctx_batch`、反复查先 `ctx_index`、被拒不要重试）。
全局文件，桌面端与网页端共用。

### 实测

网页会话（390×844，cwd=<workspace>）：

```text
问题：统计 314KB 日志里 status=500 的数量 + 前 3 个 route
command items: 0        ← 一条 shell 都没走
mcp calls    : 5        ← ctx_resume, ctx_execute ×3, ctx_doctor
答案         : 572      ← 正确，且在本地算完
hook runs    : 12
enforcement  : deny-reason（D10 PASS）
```

本地 CLI（同一套配置）：`codex exec --cd <workspace> ...` 同样返回 `572`，`ctx_stats` 里 `By agent: codex` 计数随之增加。

### 仍然存在的两条 warning（不影响使用）

- `D3/D5`：`ctx_doctor` 报「plugin hooks untrusted」——实际生效的是 setup 写入的**全局 hooks.json**（已验证 pre-tool-use 在跑、拦截模式 deny-reason），插件自带那份没被信任只是冗余。
- `D11`：没装 Git Bash。`ctx_execute` 用 `powershell` / `javascript` 都正常，装 Git for Windows 可以消除这条提示。
## 5.22 QGIS MCP 端到端：上传 → 处理 → 返回文件

测试用例：上传 5 个点的 GeoJSON → 让 agent 用 QGIS MCP 做 10 km 缓冲区 → 返回 GeoJSON。

### 结果

```text
upload    /api/upload  -> %TEMP%\codex-remote\mw2gjmn7-points.geojson
import    /api/attach/import -> <工作区>\.attachments\mw2gjmn7-points.geojson
agent 调用 qgis MCP 7 次：
  add_vector_layer    -> 5 features
  get_algorithm_help  -> native:buffer
  get_layer_extent    -> 117.16..117.3 / 31.79..31.9
  execute_processing  -> native:reprojectlayer (EPSG:4326 → EPSG:32650)
  execute_processing  -> native:buffer (10 km)
  export_layer        -> buffer.geojson（30,330 字节）
  add_vector_layer    -> 复核 5 features
耗时 39 秒，输出 5 个 MultiPolygon，EPSG:4326
```

文件在网页端可直接预览（右侧 dock）并下载（`/api/file?path=…&download=1`），点开后也会进入「最近文件」。

### 修掉的三个问题

| # | 问题 | 原因 | 修复 |
|---|---|---|---|
| 1 | 任务卡住不动，5 分钟没有任何 qgis 调用 | MCP 工具调用要审批，客户端没应答 → 一直等 | `[mcp_servers.qgis]` 加 `default_tools_approval_mode = "approve"` |
| 2 | `qgis/add_vector_layer -> failed: user rejected MCP tool call` | 网页端把 elicitation 当普通审批，回 `{decision}`；MCP 要 `{action, content, _meta}` | `app.js` 的审批卡片按方法分支；elicitation 回 `{action:"accept"\|"decline", content, _meta}`，标题/正文/按钮也改成 MCP 专用 |
| 3 | 返回的 `.geojson` 只能下载、不能预览 | 桥接 MIME 表没有地理格式 | 补 `.geojson/.topojson/.gpx/.kml/.csv`，并把它们加进前端的文本预览列表 |

### 排查经验

- **QGIS MCP 只是代理**：真正干活的是 `localhost:9876` 上的 QGIS 实例（本次为 QGIS 3.44.15，插件监听）。
  判断 server 是否健康，别用 `mcpServerStatus/list + threadId`（会卡 >180 s），直接用 stdio 起 server 走一遍 MCP 握手（`tools/qgis-stdio-probe.mjs`）：initialize 2 s、125 个工具、单次调用 35 ms 即为正常。
- 有 tool call 在等审批时，桥接日志里能看到 `pending request item/commandExecution/requestApproval id=…` 且没有对应的 `answered`。
- QGIS 打开过的目录会被占用，测试目录要每次换新（`EPERM` 就是它）。

### 已知限制

「最近文件」只记录**你打开过的**文件；agent 新生成的文件要等你点一次它的链接才会进列表。
## 5.23 审批方式选择器（对齐 Codex 三档）

composer 里新增一枚盾牌 chip（默认「请求批准」），点开是三档，与 Codex 桌面端一一对应：

| 档位 | approvalPolicy | approvalsReviewer | sandboxPolicy | 实测行为 |
|---|---|---|---|---|
| 请求批准 | `on-request` | `user` | `workspaceWrite`，roots=[会话 cwd]，`networkAccess:false` | 写工作区外文件 → **弹出审批卡片** |
| 帮我批准 | `on-request` | `auto_review` | 同上 | 同样的写入 → **自动审查放行，不打扰用户** |
| 完全访问 | `never` | `user` | `dangerFullAccess` | 同样的写入 → 直接成功，无审批 |

选择存在 `localStorage['codex-remote-access']`，切到「完全访问」时 chip 变红并弹提示。
发送时同时作用于 `thread/start`（`approvalPolicy` / `approvalsReviewer` / `sandbox`）和 `turn/start`（`approvalPolicy` / `approvalsReviewer` / `sandboxPolicy`），所以老会话改档也立即生效。

### 踩到的坑

`SandboxPolicy.workspaceWrite.networkAccess` 是 **boolean**，不是 `"restricted"` 字符串：
写成字符串会让 `turn/start` 直接报 `Invalid request: invalid type: string "restricted", expected a boolean`，
也就是「请求批准 / 帮我批准」两档完全发不出去。`NetworkAccess` 枚举只用于 `externalSandbox`。

另外：chip 的事件绑定最初被我放进了 `wireModePop()`（只有打开思考弹层才执行），导致点击无反应；已移到启动绑定段。
## 5.24 选择器收放、重复发送、网络面板

### 修掉的两个问题

| 问题 | 原因 | 修复 |
|---|---|---|
| 模型 / 项目 / 思考 chip 点第二下收不回去（只能点空白处关） | `openMenu()` 每次都先 `closeMenu()` 再重新展开，没有 toggle | 记录 `menuAnchorEl`，同 chip 第二次点击直接关闭 |
| 连点两次发送会开两个会话 / 跑两轮 | `send()` 只在 `state.busy` 为真时返回，而 `busy` 要等 `loadQuota` / `thread/start` 之后才置位 | 入口处立刻置 `state.sending`，`finally` 复位；真正的发送体拆到 `_send()` |

实测：三个 chip 都是 `closed-on-second-click=true`；并发调用两次 `app.send()` 只发出 1 个 `thread/start` + 1 个 `turn/start`。

### 网络面板（导航栏第 5 项 · 地球图标）

桥接新增三个接口，全部走 Clash 的外部控制器（默认 `http://127.0.0.1:9097`）：

| 接口 | 作用 |
|---|---|
| `GET /api/clash` | 模式、混合端口、4 个策略组及其节点（含上次测速延迟） |
| `POST /api/clash/select` `{group,node}` | 切换指定策略组的节点 |
| `POST /api/clash/test` `{group?,node?}` | 节点延迟（`/proxies/{name}/delay`）+ **Codex 连通性**（新建 app-server 连接跑 `account/rateLimits/read`，返回毫秒数、已用额度或失败原因） |

面板内容：模式/端口/组数 → 策略组 tab（GLOBAL / 故障转移 / 自动选择 / 良心云）→ 当前节点 → 节点列表（延迟按 <300 / <800 / 更慢着色，`0` 视为未知显示 `—`）→ 测试按钮。

实测一轮（节点 🇯🇵日本高速04）：

```text
节点延迟：141ms
Codex：连通 · 834ms
```

同一分钟里换到被墙的节点会变成 `Codex：失败（failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)）`，这正是这个面板要暴露的信息。

切换验证：`良心云` 组 🇯🇵日本高速04 → 🇸🇬新加坡高速01（`ok:true`）→ 再切回 🇯🇵日本高速04，`matches original: true`。

### 移动端适配

- 底部 tab 现在是 6 项（首页 / 技能 / 文件 / 用量 / 网络 / 主题），390px 宽度下仍是一行。
- 面板：节点列表限高 `34vh` 独立滚动，行内文字省略号截断，测试按钮整宽。
### 为什么「网页里切的节点和 Clash Verge 显示的不一样」

一度以为面板连到了别的 Clash，实际排查结论：**确实是本机同一个核心**——只有 `127.0.0.1:9097` 一个控制器在线（9090/9091/9099/6170 全部 ECONNREFUSED），`/configs` 显示 `mode: rule`、`mixed-port: 7897`、`tun: true`。

真正的原因是**切错了组**：面板默认落在 `GLOBAL`，而规则模式下 `GLOBAL` 不参与路由。
`/connections` 里真实流量走的是：

```text
26x  DIRECT
 8x  良心云 > 🇯🇵日本高速04|BGP|CUCM
 4x  良心云 > 🇸🇬新加坡高速01|BGP|CTCUCM
```

所以在 GLOBAL 里改节点，Clash Verge 当然「看起来没变」。

修复后 `/api/clash` 会带回 `liveChains` / `inUse` / `defaultGroup`：

- 面板**默认打开实际在用的组**（当前为 `良心云 ·在用`）
- 顶部列出「当前生效链路」，直接显示 组 → 节点（N 条连接）
- 规则模式下 `GLOBAL` 标为虚线 idle，点开会提示「GLOBAL 不会影响实际流量，实际生效的是：良心云」
- 嵌套组（`自动选择` / `故障转移`）带 `›` 可下钻，`剩余流量 / 套餐到期` 这类订阅信息行置灰不可点
- 「重新读取」按钮刷新状态与实时链路
- 切换提示改为「已切换到 X（新连接生效，旧连接保持原节点）」，避免误以为立刻全量生效
### 顺手修的安全问题（重要）

排查节点问题时发现：除了 `/healthz`、`/api/me`、`/api/login`、`/api/logout`，**其余 API 全都没有鉴权**，
局域网 / Tailscale 内任何设备不带密码就能调用：

```
/api/session/reset     杀掉上游会话
/api/wechat/download   触发下载并落盘
/api/wechat/qr         拿登录二维码
/api/inbox             读微信消息
/api/clash/select      改你的代理节点
/api/attach/import     把任意文件复制进工作区
```

现在全部走 `requireAuth()`，未登录一律 401；登录后功能不变。实测：

```
/api/projects -> 401   /api/clash -> 401   /api/wechat/state -> 401
/api/inbox    -> 401   /api/wechat-files -> 401
（带 cookie 后全部 200）
```
### 简化后的网络面板 + 一键切换

面板只剩一屏：

```text
良心云 · rule · 44 个节点
当前节点  🇯🇵日本专线01|BGP|流媒体
[ 一键切换（Codex 最快） ]  [ 刷新 ]
已切到 🇯🇵日本专线01|BGP|流媒体（Codex 726ms）
🇯🇵日本专线01|BGP|流媒体   59ms   Codex 726ms   [测]
🇸🇬新加坡专线03|BGP|流媒体 100ms   Codex 1062ms  [测]
…
```

- **只列当前在用组**的节点（`defaultGroup` 来自实时连接），不再有 GLOBAL / 其它组的 tab。
- 每行：Clash 延迟 + **Codex 实测**（未测 / 连通 xxx ms / 失败）+ 单行「测」按钮。
- 列表按 Codex 实测延迟升序排，未测的排在后面按 Clash 延迟排。

### 一键切换怎么测的

`POST /api/clash/autopick` 起一个后台任务：

1. 取在用组里 Clash 延迟最低的 N 个真实节点（默认 8，上限 20；跳过嵌套组和「剩余流量」这类订阅信息行）
2. 逐个：切到该节点 → 等 700ms → 用新建的 app-server 连接跑 `account/rateLimits/read` 测真实 Codex 延迟
3. 全部测完，切到 Codex 最快的那个；**一个都不通就恢复原节点**
4. 结果缓存在前端 `netState.codex`，行内直接显示

前端轮询 `GET /api/clash/autopick?id=`，按钮实时显示 `测速中 3/8…`。

实测：8 个节点约 25 秒，选出 `🇯🇵日本专线01（Codex 726ms）` 并自动切换，弹 toast 确认。

> 注意：测速过程会真的在节点之间来回切，正在使用的连接会受影响；旧连接保持原节点，新连接才走新节点。

### 同一轮里修掉的 bug

轮询函数里把清理逻辑写在了 `finally`，导致**第一次轮询就清空任务状态**、按钮立刻复原（表现为点了一键切换没反应）。改为只在任务真正结束时清理。
### 模型选择并入强度 chip

输入框那排从 4 枚 chip 变成 3 枚：

```
Remote | GPT-6.1-Sol · 低 | 请求批准
```

- `#modelBtn` 删除，`#effortBtn` 变成合并 chip（`#modelLabel` + `·` + `#effortLabel`），点开就是原来的强度弹层。
- 弹层里的「GPT-6.1-Sol ›」那一行仍然可以换模型，换完合并 chip 立刻更新（实测 `GPT-6.1-Sol·低 → GPT-6-Astra·低`）。
- `title` 提示同时给出模型与强度全文。

**顺手修的两个 bug：**

1. **在弹层里点模型，菜单一闪就消失**。根因是全局 `click` 监听「非 `.chip` 的点击就关菜单」，而 `#modeModel` 不是 chip，于是同一次点击既打开又立刻关闭。现在把 `.mode-model` 排除。
2. **菜单飘到屏幕左上角**。原来锚定 `#modeModel`，而它在关掉的弹层里（尺寸为 0）。改为锚定合并 chip。

移动端：≤430px 时 chip 缩到 10.5px 字号、合并 chip 上限 44vw；≤380px 时项目 chip 只留文件夹图标。实测 360/390/430px 三档 `scrollWidth == width`，三个 chip 全部露出，回形针与发送按钮不再被压到。
## 5.25 全节点测速 · 自动切换 · 二维码 · 文件预览

### 一键测速改成测「所有节点」

原来的 `limit=8` 只测 Clash 延迟最低的 8 个；现在默认测整组（`limit` 省略或 0 = 全部）。

速度靠两步优化：

1. **复用一条 app-server 连接**做 Codex 探测。原来每个节点都新建连接、重跑 `initialize`（1-2 秒），现在握手一次，之后每个节点只发 `account/rateLimits/read`。
2. **先用 Clash 自己的 `/proxies/{node}/delay` 并行预筛**（8 并发、不切换），把连不通的节点剔掉再串行实测。死节点每个要等满超时，这一步省掉一大半时间。

实测（48 个节点的组）：44 个真实节点 → 预筛剩 30 个 → 串行实测 **105 秒**，全部测完。
结果里会写明「测了 N 个节点，跳过 M 个不通节点」。

### 自动切换守护

面板里新增开关：**自动切换（断线时选 Codex 最快节点）**。

- 每 180 秒用共享连接探一次 Codex；正常就记一笔 `最近检查正常 1180ms（节点名）`。
- 探测失败才触发全节点扫描，切到最快节点；一个都不通就保持原样。
- 开关状态存 `bridge/autoswitch.json`，重启桥接后自动恢复。

接口：`GET/POST /api/clash/autoswitch`（`{enabled, intervalSec}`，间隔 30-3600 秒）。

### 微信二维码「显示不稳定」

根因有两个，都不是网络问题：

1. **每次取二维码要 10-25 秒**。原实现是 `Page.captureScreenshot` 截后台 Edge 窗口，后台窗口合成被节流。现在改成：页内读出二维码 `<img>` 的 URL（约 10ms）→ **Node 直接下载该 URL**（带浏览器 UA/Referer，约 200ms）。截图只作兜底，并先开 `Emulation.setFocusEmulationEnabled` 解节流。
2. **前端每 4 秒重建 `<img>`** 并带 `?t=时间戳`，等于反复重新下载 → 看着就是闪。现在登录态不变时不重建 DOM。

实测：`24 852ms → 305 / 154 / 150 / 176ms`；连续 6 秒轮询，`<img src>` 完全不变。

### 文件预览补全 + 保存图标

| 类型 | 预览方式 |
|---|---|
| 图片 png/jpg/gif/webp/avif/bmp/svg | `<img>` |
| **PDF** | 浏览器原生 PDF 查看器（`<iframe src=… #view=FitH>`，支持翻页、缩放） |
| **Word / Excel / PowerPoint**（docx/xlsx/pptx，含 odt/ods/odp/rtf） | 服务端解 zip 抽 XML 文本（不依赖 LibreOffice），带「第 N 页」分页与页数提示 |
| 音视频 mp4/webm/mov/m4v · mp3/wav/m4a/ogg/flac/aac | `<video>` / `<audio>` |
| 文本/代码/md/html/json/geojson/gpx/kml | 现有预览 + 源码切换 |
| 其它（zip 等） | 文件卡片：文件名、扩展名、说明 + 保存按钮 |

新增接口 `GET /api/office-text?path=`：docx 取 `word/document.xml`、pptx 按 `slideN.xml` 分页、
xlsx 取 sharedStrings + 第一张工作表，正文截断到 4 万字符。实测那份 35 页 pptx：`ok, slides: 35, 4786 chars`。

右上角的「下载」文字按钮换成了**保存图标**（`#i-save`，向下箭头 + 托盘），`aria-label="保存到本机"`。
### 五个收尾修正

**1. 前端还在传 `limit: 8`**
服务端默认已是「全部节点」，但 `runAutopick()` 里写死了 `limit: 8`，把默认值覆盖了。已删掉，按钮文案也改成「一键测速并切换（全组节点）」。

**2. 自动切换的实战验证**
手工切到被墙的 `🇭🇰香港高速01`，再打开开关：

```text
3s    last={node:香港高速01, ok:false, ms:2665, error:…403 Forbidden}
96s   switch={from:香港高速01, to:🇸🇬新加坡专线03, ms:800}
final node: 🇸🇬新加坡专线03 | codex on final node: 812ms   ← 恢复成功
```

**3. 错误信息里塞了整页 HTML**
Codex 的 403 会把 chatgpt.com 的 HTML 错误页带进 `error` 字段（约 15 KB），整个塞进 API 响应和 tooltip。
新增 `shortErr()`，压到 181 字符以内。

**4. Office 预览在手机上**
390px 下 docx 正文、xlsx 表格（制表符分列，列能对齐）、保存图标都正常，`codeWidth 337 / panelH 741`。

**5. 预览接口补测**
docx：标题 + 两段正文 + 表格单元格（`姓名	分数` / `张三	95`）全部抽出，11 ms；
xlsx：`月份 销量 备注 / 1月 120 开门红 / 2月 98 春节`，5 ms。
## 5.26 文件名 / 保存 / 发到微信

### 文件名与保存名的问题（已修）

三个地方都用了整条路径：

| 位置 | 原来 | 现在 |
|---|---|---|
| 会话里的路径 chip | 显示 `<workspace>\qgis-run-…\.attachments\mw2gjmn7-points.geojson` | 显示 `mw2gjmn7-points.geojson`，完整路径留在 tooltip |
| dock 标题 | 整条路径 | `buffer.geojson` |
| `<a download>` | `download="<workspace>\…\buffer.geojson"` → 浏览器消毒成 `C__CHAT_…` | `download="buffer.geojson"` |

新增 `baseName()`，chip / 标题 / 下载名统一用它；服务端 `content-disposition` 本来就用 basename，所以直链下载也一直是对的。

### 发到微信

dock 右上角现在有两个图标：**发送到微信**（气泡）和 **保存**（下箭头）。

```
POST /api/wechat/send { path }
  -> { ok: true, name, how: "input" | "chooser", ms }
  -> { ok: false, error: "需要先在「微信文件传输」里扫码登录" }
```

实现（`wechat-web.mjs` 的 `sendFile()`）：

1. 先确认页面已登录（没有输入框/消息列表就直接返回 `not-logged-in`）。
2. 页面里已有 `input[type=file]` 就 `DOM.setFileInputFiles` 直接塞进去。
3. 否则 `Page.setInterceptFileChooserDialog` 拦截文件选择器，按文本/类名挑最像「上传」的按钮点一下，
   等 `Page.fileChooserOpened` 拿到 `backendNodeId` 再塞文件。
4. 之后轮询页面文本，直到文件名出现，才算发送成功（最多等 20 秒，超时标记 `unconfirmed`）。

「微信文件传输」面板顶部新增开关 **在会话里保存文件后，自动发到微信**（存 `localStorage["codex-remote-wx-autosend"]`）。
打开后，dock 里点保存会同时推一份到文件传输助手，手机微信立刻能收到。

发送失败且原因是未登录时，会自动弹出扫码面板，不用自己找入口。

> 限制：网页版文件传输助手要求先扫码登录（内存态，重开窗口就要重扫）；单文件上限 200MB。
### 结果文件点不开 / 存下来没扩展名（已修）

模型输出的是 CommonMark 的尖括号链接（路径里有 `(1)` 这类括号时必须这么写）：

```md
[打开优化版 PPTX](<C:/…/Codex_Migration_20261031T104701Z(1)/…/中国国有企业改革_前三页优化版.pptx>)
```

三个连环 bug：

| # | 问题 | 后果 |
|---|---|---|
| 1 | `inlineMd()` **先 escapeHtml 再解析链接**，`<` 已变成 `&lt;`，尖括号正则永不命中 | 退回普通正则，`[^)\s]+` 在路径里的 `(1)` 处截断 → 路径残缺 |
| 2 | 残缺路径以 `<C:` 开头，`path.resolve` 当相对路径处理 | 拼成 `…\codex-remote\bridge\<C:\…` → `ENOENT`（就是截图里那条报错） |
| 3 | dock 的 `download` 取的是 chip 文字 | 存成「打开优化版 PPTX」，没有扩展名，双击打不开 |

修复：

- 链接正则同时接受 `<…>` 与 `&lt;…&gt;` 两种形式，并把捕获到的目标反转义后再用；
- 普通链接正则加 `(?!&lt;|<)` 负向前瞻，避免把尖括号目标当普通链接再切一刀；
- `openFilePanel()` 入口统一清洗目标（去 `<>`/引号、`file://`、`&lt;` 实体）；
- dock 标题与保存名**一律用真实文件名**（`baseName(target)`），chip 文字只当展示用。

实测（就是坏掉的那条消息）：

```text
chip 打开优化版 PPTX -> title 完整 .pptx 路径
dock 标题  中国国有企业改革_前三页优化版.pptx
预览       文本预览（35 页幻灯片），4931 字符
保存       download=中国国有企业改革_前三页优化版.pptx
           GET /api/file?…&download=1 -> 200, 62,639,777 B, 正确 MIME + UTF-8 文件名
```

同一条消息里的 `查看三页预览`（.jpg）也正常走图片预览。

### 「挂载」和「保存」是一套路径吗

不是同一套，但都落在本机同一个文件上：

| 动作 | 链路 |
|---|---|
| 上传/微信挂载 | `/api/upload` → `%TEMP%\codex-remote\…` → `/api/attach/import` → `<工作区>\.attachments\<文件名>` → 作为 `mention` 交给模型 |
| 结果文件保存 | 消息里链接的**原始路径**（如 `outputs/xxx.pptx`）→ `/api/file?path=…&download=1` |

所以「挂载」负责把文件送进工作区给模型读，「保存」负责把结果取回本机；
这次的问题全在保存/预览一侧的路径解析，与挂载无关。
### Office 文件现在渲染真实排版（PPT / Word / Excel → PDF）

之前 pptx/xlsx/docx 只做「解 zip 抽文本」，能看到字但看不到版式 —— 用户看到的就是「没有实际内容」。
这台机器没装 LibreOffice，但 **Office 的 COM 服务是注册过的**，所以直接用 PowerPoint / Word / Excel 导出 PDF。

新增 `GET /api/office-pdf?path=…`（另有 `&probe=1` 只做转换并返回 JSON）：

```text
pptx/ppt/ppsx/odp  -> PowerPoint  Presentation.SaveAs(dst, 32)   # ppSaveAsPDF
docx/doc/rtf/odt   -> Word        Document.SaveAs(dst, 17)       # wdFormatPDF
xlsx/xls/ods       -> Excel       Workbook.ExportAsFixedFormat(0, dst)
```

要点：

- 转换脚本 `bridge/office-to-pdf.ps1`，桥接用 `powershell.exe -NoProfile -File` 调它；
- **串行队列**：Office COM 是单实例，并发打开会互相打架；
- **按 路径+大小+mtime 缓存**到 `%TEMP%\codex-remote-office\<hash>.pdf`，二次打开 60ms 级；
- 前端先 `&probe=1` 触发转换（首次 3-15 秒，显示「正在转成 PDF…」），成功后把 iframe 指向 PDF；
- 转换失败时**自动退回文本抽取**，不会白屏。

实测：

| 文件 | 首次 | 缓存 | 产物 |
|---|---|---|---|
| 35 页 pptx（61 MB） | 14.4 s | 67 ms | 10.4 MB PDF，封面版式完整 |
| test.docx | 3.1 s | 12 ms | 80 KB PDF |
| test.xlsx | 3.4 s | 12 ms | 29 KB PDF |

PDF 仍然走浏览器原生查看器（可翻页/缩放），手机上的 dock 同样铺满。

> 已知限制：iOS Safari 的内联 PDF 只显示第一页，需要翻页时用保存按钮导出后用系统「文件」打开；Android Chrome 正常。
### 移动端看不了 PDF/Office —— 改成逐页图片

桌面端把 PDF 塞进 `<iframe>` 能看，但 **手机浏览器根本不内联渲染 PDF**：
Android Chrome 直接显示一个「PDF / 打开」的下载卡片，iOS Safari 只给第一页。
这是浏览器行为，不是我们的 bug，所以换方案：**服务端把每页渲染成 JPEG，前端当图片流滚动**。

链路：

```text
pdf              ──┐
pptx/docx/xlsx   ──┴─> Office COM 转 PDF（缓存）─> PyMuPDF 逐页转 JPEG（缓存）─> <img> 列表
```

接口：

| 接口 | 作用 |
|---|---|
| `GET /api/office-images?path=` | 返回 `{ok, count, pages:[url…]}`，首次触发转换+光栅化 |
| `GET /api/office-page?k=<key>&i=<n>` | 返回第 n 页 JPEG（`cache-control: max-age=86400`） |

细节：

- 光栅化用 `bridge/pdf-to-images.py`（PyMuPDF），按页宽 1400px、JPEG q82，一页约 100-180KB；
- 缓存键是 `路径+大小+mtime` 的 sha1，第二次打开 4ms 返回页数，图片走浏览器缓存；
- 转 PDF 和光栅化各自串行排队（Office COM 单实例、CPU 密集）；
- 前端 `loading="lazy"`，只有前两页 eager，长文档不会一次拉完；
- 每页右下角有 `n / 总数` 角标。

实测（移动视口 390×844）：

| 文件 | 页数 | 首屏 |
|---|---|---|
| 35 页 pptx | 35 页 | 1.2s 出现图片，页图 1440×810 |
| 12 页 PDF | 12 页 | 1400×906 |
| test.docx | 1 页 | 1400×1812 |
| test.xlsx | 1 页 | 1400×1980 |

首次打开 35 页 pptx 约 10 秒（转 PDF 14s 只在第一次 + 光栅化 7s），之后秒开。
### 测速为什么不能真并行，以及把它压到 24 秒

先验证了两个假设，结论都是「不行」：

```text
1) Clash 的 /proxies/<node>/delay 能不能代替 Codex 探测？
   被墙的 🇭🇰香港高速01 测 https://chatgpt.com/ 照样返回 delay=118ms ——
   mihomo 只当 HTTP 通了就记成功，看不到 OpenAI 的 403。

2) 那能不能并发测？
   12 个并发里 7 个直接 503/504（An error occurred in the delay test）——
   mihomo 自己会限流。
```

而且切换节点是**全局**的，同一时刻只能有一个节点在承流量，真并行测 Codex 必然互相污染。
所以保留串行确认，但把每节点开销砍掉 + 提前收敛：

| 改动 | 之前 | 现在 |
|---|---|---|
| 每节点前的 settle 等待 | 250 ms | **0**（Clash 对新连接立即生效） |
| 每节点重复的 Clash 延迟测试 | 有（≈300ms） | 用预筛结果，去掉 |
| 失败节点超时 | 6 s | 4 s |
| 预筛并发 | 8（会 503） | 4 |
| 提前停止 | 无 | 已确认 ≤800ms 的节点且测满 6 个就停 |

结果：同样的组，**105 秒 → 24 秒**（测了 6 个就锁定 🇯🇵日本专线02，Codex 677ms）。
自动切换守护走的也是这条路径，所以“断线后重选”同样变快。

### 上传菜单精简

原来 5 项（照片/视频、拍照/录像、任意文件、微信文件传输、从微信取文件），现在 2 项：

```text
添加文件
  拍照 / 选文件        <- 一个 input[type=file] 不设 capture，手机系统面板里同时给相机和文件
  微信文件传输         <- 扫码 + 取微信文件
```

`accept="*/*"` 且不设 `capture`：iOS 会弹「照片图库 / 拍照 / 选取文件」，Android 弹「相机 / 文件」，
一个入口覆盖原来的三项。
## 5.27 全功能实测（35 项）

用 CDP 驱动真实浏览器把页面上**所有可见功能**跑了一遍，三套脚本：`tools/qa-suite2.mjs`（17 项）、
`qa-suite3.mjs`（12 项）、`qa-suite4.mjs`（6 项）。结果 **35/35 通过**，无 console 异常、无 4xx/5xx。

### 覆盖范围

| 区域 | 检查项 |
|---|---|
| 登录 | 表单显示、错误密码被拒、正确密码进入、配对链接 `?t=` |
| 导航 | 6 个 rail 按钮、主题切换与持久化、面板开关 |
| 侧栏 | 会话列表、搜索过滤、项目分组折叠/展开、新会话 |
| 输入区 | 合并 chip（模型·强度）、强度弹层、权限弹层（3 档）、附件菜单（2 项）、斜杠菜单（12 项技能）|
| 会话 | 打开历史会话、指标条、拖拽上传、停止按钮中断 |
| 预览 | md / html / 图片 / 代码 / PDF（12 页）/ Office（35 页）/ 未知类型卡片，保存名 = 文件名 |
| 面板 | 技能与 MCP、最近文件、用量、网络（测速 + 自动切换开关）、微信（二维码 + 刷新）|
| 移动端 | 底部 6 tab、每个 tab 都能开面板、dock 全宽、chip 不溢出、主题跨刷新保持 |

### 测出并修掉的 4 个问题

**1. 微信自动挂载一直失效**
`/api/wechat-watch`（SSE）在**登录之前**就被订阅了 → 401。现在改成 `boot()` 认证成功后、以及表单登录成功后
才启动，并加了「出错就 5 秒后重试」的保护。实测 `http failures: none`。

**2. 拖拽浮层会卡住挡住整个界面**
`dragleave` 在两种情况下不会触发收尾：事件里没有 `dataTransfer`，或鼠标快速移出窗口。
加了 `relatedTarget === null` 判定 + 2 秒看门狗 + `dragend`/`blur` 兜底。

**3. `#fileInput` 是死代码**
页面里那个 `<input type="file" id="fileInput">` 从来没绑过事件（真正的选择器是 `pickFiles()` 动态创建的），
已删除，避免以后误以为能用。

**4. 只挂文件不写文字时无法发送**
`updateSendState()` 只看输入框文字，附件不计入；而且 `renderAttachments()` 之后没刷新按钮状态。
现在「有附件」也算内容，挂上文件后发送按钮立刻可用，发出去的是 `mention` + 空文本。
## 5.28 本机 Codex 会话同步 · 大文件走直链

### 网页端删除/归档后，本机 Codex 还显示（已修）

现象：网页里删掉的会话在桌面 App 里还在，点开报 `继续聊天未成功 no rollout found for thread id …`。

根因不在 app-server，而在桌面端自己的目录表 `~/.codex/sqlite/codex.db` 里的 `local_thread_catalog`：
桌面列表来自这张表（扫描 rollout 文件生成）。`thread/archive` 只把文件移到 `archived_sessions/`、
`thread/delete` 只删掉文件 —— 表里的行没人清理，于是桌面照旧列出，点开才发现 rollout 不在了。

实测确认（真实坏条目）：

```text
catalog row: {thread_id: 01a1a4ac..., display_title: "111", missing_candidate: 0}
rollout on disk: 没有（sessions / archived_sessions 都没有）
```

修复：新增 `POST /api/threads/prune`，扫描 `~/.codex/sessions` 里真实存在的 rollout，
把 `host_id` 为 local 且文件已消失的目录行删掉（连带 `scan_entries`），首次运行把 `codex.db` 备份成 `codex.db.bak-prune`。

调用时机：桥接启动、网页端归档后、网页端删除后、每次进页面 boot 一次。

实测：

```text
调用前  local rows: 20, without rollout: 2   <- "111" 和 "test"
POST /api/threads/prune -> {"ok":true,"removed":2,"titles":["111","test"]}
调用后  local rows: 18, without rollout: 0
```

UI 侧确认：`boot requests: [POST /api/threads/prune]`，归档一次后变成两条。

### 微信里的大文件下载慢（改用直链）

先量了上传侧：5MB 只需 934ms（约 5.4MB/s），所以慢的不是我们上传，而是手机从微信 CDN 拉取
（60MB 的 pptx 尤其明显）。而手机通常就在同一个 tailnet/LAN 里，直接从桥接下载快得多（实测 60MB / 0.4s）。

新增接口：

| 接口 | 作用 |
|---|---|
| `POST /api/share {path}` | 生成 24 小时有效的直链（HMAC 签名，含路径+过期），返回 tailnet/LAN 优先的 URL |
| `GET /s/<token>` | 免登录下载（token 本身是凭证），`Content-Disposition` 带正确文件名 |
| `POST /api/wechat/send-text {text}` | 往文件传输助手发文字（用于发链接） |

前端：dock 的「发送到微信」先查文件大小，超过 5MB 弹三选一：

```text
59.7MB · 选择方式
  发送下载链接（推荐，手机直连）
  发送文件（59.7MB，微信下载较慢）
  复制链接
```

小文件保持直接发送。实测：59.7MB 弹菜单、200KB 图片直接发；选「发送下载链接」后 1.2 秒内文字就进了微信
（页面里能读到 `http://<tailnet-ip>:8787/s/...`）。
## 5.29 新建项目（在本机选目录）

手机/远程端没法用系统的文件夹对话框（它弹在主机上），所以做了一个**网页内的目录浏览器**：

```text
项目 chip -> ＋ 新建项目…
  面包屑 C:\ › CHAT         [↑ 上一级]
  快捷: 主目录 / 桌面 / 文档 / 下载
  [文件夹列表，点一下就进去]
  项目名称 [CHAT]            [用这个文件夹]
```

接口：`GET /api/fs/dirs?path=`（需登录）

- 不带 `path` 时返回驱动器列表（`C:\`、`D:\`…）和常用位置；
- 带 `path` 时返回该目录下的子目录、上级目录、面包屑；
- 跳过 `node_modules` / `.git`，单目录最多 400 项，按中文排序。

创建走 app-server 的官方 `project/create`（而不是直接改 `~/.codex/.codex-global-state.json`），
所以桌面 App 也会立刻看到这个项目：

```js
rpc.send('project/create', { name, roots: [{ path }], idempotencyKey })
```

创建成功后自动 `project/list` 刷新、把新项目设为当前目标并更新 chip 文案。

实测（浏览器自动化）：菜单里出现「＋ 新建项目…」→ 面板打开在默认目录 → 建出
`{"name":"CHAT","roots":["<workspace>"]}` → chip 变成「CHAT」；测试项目随后已删除。
## 5.30 新建项目：从「此电脑」开始 + 就地新建文件夹

之前对话框固定从当前工作目录开始，只能往下钻，够不到别的盘。现在：

```text
新建项目
  此电脑                      <- 起始视图：C:\ D:\ + 常用位置
  [↑ 上一级] [＋ 新建文件夹]
  主目录 / 桌面 / 文档 / 下载 / 当前工作目录   <- 快捷位置
  [文件夹列表]
  项目名称 [..]              [用这个文件夹]
```

改动：

- 打开时 `paint('')`，直接进「此电脑」（驱动器列表），面包屑可以从任意层级点回 `此电脑`；
- 快捷位置里补了「当前工作目录」，从根视图一步回到平时用的目录；
- 新增 `POST /api/fs/mkdir {path, name}`，对话框里「＋ 新建文件夹」创建后**自动进入**该文件夹；
- 名称校验：拒绝 `\ / : * ? " < > |`、`.`、`..`、超长、同名已存在。

实测：

```text
根视图   crumbs=此电脑  dirs=C:\,D:\  quick=主目录,桌面,文档,下载,当前工作目录
进入     C:\ -> <workspace> -> 新建文件夹 qa-folder-…（磁盘上真的建出来了）
创建     project/list -> ["Remote","qa-folder-…"]，chip 同步更新
非法名   {"ok":false,"error":"名称不能包含 \\ / : * ? " < > |"}
```

（测试用的项目与文件夹已删除。）
## 5.31 切换账号后二维码不出来（已修）

现象：iPad 上点「切换账号」，二维码区域不更新 / 扫了没用。

定位过程：

```text
接口侧   POST /api/wechat/reset -> 2.6s；之后 4s 内 /api/wechat/qr 就返回 37KB 真图（150ms）
页面侧   重置后 WeChat 登录页没有 <img>，只有 .login-scan__panel；日志里是 qr download empty (200)
前端侧   <img src> 的 ?t= 一直是同一个值（1793899268801），说明根本没重新取图
```

根因：为了防闪烁加的那行早退

```js
if (mode === 'login' && host.dataset.mode === 'login' && host.querySelector('.wx-qr')) return;
```

它把「已经有一个 img 就不再重建」当成了通用规则——于是换账号后仍然显示**上一个账号的旧码**
（那个码已经失效，扫了自然没反应）。二维码本身有有效期，这条规则也让过期码永远不刷新。

修复分三层：

1. **前端按新鲜度重建**：记录 `state.wxQrStamp`，只有「模式没变 + 图片存在 + 不到 2 分钟 + 没有强制刷新」才早退；
   「切换账号」「刷新二维码」两个按钮都会置 `wxQrStamp = 0; wxQrRefresh = true`，强制换新图；
   图片加载失败时把 `wxQrStamp` 清零，下一个轮询周期自动重试（而不是永远停在提示文字上）。
2. **桥接在 reset 时清空二维码缓存**，避免把上一个账号的图继续发 2 秒。
3. **下载失败且页面显示「二维码无法加载，点击刷新」时**，先点它的刷新链接（或 reload），等 2.5s 再取一次，
   全部失败才退回截图——否则截图会把错误提示拍下来当二维码发出去。

实测（820×1180 平板视口，真实点击「刷新二维码」）：

```text
before: {"hasImg":true,"loaded":true,"w":430,"t":"1793899456744"}
  +2s  {"t":"1793899456744"}                       ← 还没换
  +4s  {"t":"1793899464594","loaded":true} NEW-IMAGE  ← 新码已加载
```
## 5.32 网页操作后本机 Codex 立刻一致（双向同步）

状态分散在三个地方，必须先弄清谁读谁：

```text
app-server (codex.exe, :8791)   会话/项目的真实索引 + 广播通知
~/.codex/sessions/, archived_sessions/   rollout 文件
~/.codex/sqlite/codex.db -> local_thread_catalog   桌面端侧栏的会话列表
~/.codex/.codex-global-state.json -> local-projects  桌面端的项目注册表
```

实测 app-server 的广播是齐全的：

```text
thread/archive  -> thread/archived {"threadId": ...}
thread/delete   -> thread/deleted  {"threadId": ...}
project/create  -> project/changed {"projectId": ..., "changeType": "created"}
```

### 网页 -> 本机（持久化状态）

| 操作 | 之前 | 现在 |
|---|---|---|
| 删除会话 | 只删 rollout，目录表留行 → 桌面显示、点开报 no rollout found | 桥接收到 `thread/deleted` 后 **1.2s 防抖清理**，行消失（实测 1.4s） |
| 归档会话 | 只把文件挪到 `archived_sessions/`，行还在 | 目录表现在**只认 `sessions/` 里的 rollout**，归档即从桌面列表消失 |
| 新建项目 | 只写 app-server SQLite，`global-state.json` 没有 → 桌面侧栏看不到 | 镜像写入 `local-projects` + `project-order`（Windows 反斜杠路径，写前备份 `.bak`） |

另外每分钟兜底扫一次目录表，桌面端自己的增删也能被纠正。

### 本机 -> 网页（实时通知）

网页端以前只处理 `thread/started`，桌面删/归档后网页纹丝不动。现在补上：

```js
case 'thread/archived':          // 从列表移除 + toast「该会话已在别处归档」
case 'thread/deleted':           // 同上 + toast「该会话已在别处删除」
case 'thread/unarchived':        // 静默 loadThreads()
case 'project/changed':          // loadProjects() 后重绘项目分组
```

### 实测（两次独立客户端，模拟桌面 vs 网页）

```text
网页归档  -> 目录表 0.7s 仍在, 1.4s 已删除        ✓
网页删除  -> 目录表 1.4s 已删除                  ✓
别的客户端归档 -> 网页 1.2s 内从列表消失，27 -> 26，toast 正确   ✓
别的客户端建项目 -> 网页 1.2s 内出现，无需刷新                 ✓
网页建项目 -> global-state 立刻有，rootPaths=["<workspace>"]      ✓
```

去重注意：legacy 项目 id 与 app-server 项目 id 不同，镜像时**按路径判重**，否则每个迁移过的项目都会被复制一份。
## 5.33 上线前的审计与优化（商用目标）

按「安全 / 性能 / 鲁棒性 / 可访问性」四项做了一轮实测，改完再验一遍。全部脚本在 `tools/`：
`prelaunch-audit.mjs`、`latency-profile2.mjs`、`stress-test.mjs`、`ux-audit.mjs`、`reconnect-test.mjs`、`launch-checklist.mjs`。

### 安全（都实测过）

| 项目 | 改前 | 改后 |
|---|---|---|
| 任意路径读文件 | `/api/file?path=C:/Windows/win.ini` 直接返回内容 | **403**（允许根 = 主目录 + 工作目录 + 项目根；`fileScope:"home"`，可改 `"any"`） |
| 安全响应头 | 全无 | `nosniff` `X-Frame-Options: DENY` `Referrer-Policy` `Permissions-Policy` 和一套 CSP |
| CSRF | 跨站 POST 返回 200 | 校验 Origin/Referer，跨站 **403** |
| 登录暴力破解 | 已有按 IP 限流（回环豁免） | 保持，并把英文错误映射成中文 |
| Cookie | `HttpOnly; SameSite=Lax; 30d` | 不变（HTTPS 下自动加 `Secure`） |

CSP 刻意保留了 `style-src unsafe-inline`（页面用 JS 设内联样式），但 `script-src` 只允许同源，
页面本身也没有内联脚本，所以 XSS 里最危险的一类被挡住。

### 性能

| 指标 | 改前 | 改后 |
|---|---|---|
| 首屏传输 | 238 KB | **65 KB**（gzip：app.js 166→47KB，css 57→11KB，html 15→4.7KB） |
| FCP（手机 390×844，4× CPU 降速） | 736 ms | **408 ms**（新增纯 CSS 启动画面，首帧不再是白屏） |
| 点击发送 → 自己的气泡出现 | 426 ms | **5 ms**（乐观渲染，服务端回显后对齐） |
| 面板首开（网络面板） | 583 ms 白屏 | 先画骨架，再填数据 |
| 500 个会话渲染 | — | 47 ms |
| 21k 字消息渲染 | — | 10 ms |
| 面板连点帧时间 | — | p50 17 ms / p95 59 ms |

启动画面是纯 CSS 的，并带 `6s` 自动淡出兜底——即使 JS 挂了也不会把用户卡在启动页。

### 鲁棒性

| 场景 | 结果 |
|---|---|
| 桥接进程被杀 | UI 立刻显示「已断开，正在重连…」+ `body.is-offline` 横幅 |
| 桥接恢复 | **8 秒内自动重连**，RPC 恢复正常，不需要刷新页面 |
| 会话过期（cookie 被清） | 任一 API 返回 401 → 自动回到登录页并提示「登录已过期」 |
| 未捕获异常 | 统一 toast + 控制台，不再静默白屏 |
| 二维码卡死 | 每个 CDP 调用 8s 超时 + 路由 8s 兜底，返回 503 而不是挂住连接 |

### 可访问性 / 移动端

- 图标按钮 100% 有 `aria-label`，输入框 100% 有 placeholder 或 label，图片都有 alt；
- 手机端会话行 / 菜单项 ≥ 44px（原来 30-32px），符合触控建议；
- 加了 `:focus-visible` 焦点环（键盘可见、鼠标不可见）；
- 尊重 `prefers-reduced-motion`；
- `lang="zh-CN"`、`viewport-fit=cover`、`theme-color` 随主题切换；
- 无横向溢出（390px 视口实测）。

### 上线清单（15 项，全过）

```text
security: CSP / nosniff / DENY / referrer-policy       PASS
security: 拦截系统目录，放行项目文件                     PASS
security: 跨站 POST 403，同源 POST 200                  PASS
weight:   gzip 全开，首屏 65.3KB < 80KB                 PASS
ui:       启动画面正常消失、无横向溢出                   PASS
a11y:     触控目标 ≥ 40px、焦点环存在                    PASS
robust:   401 自动回登录                                PASS
console:  无错误                                        PASS
```
## 5.34 对话页用量悬浮球 + 动效克制化

小红书那篇「24 个高级 UI 交互」的链接在这台机器上打不开（`xhslink.cn` / `xiaohongshu.com`
解析到非公网地址，被网络策略拦了），所以按这类清单里**适合生产级对话工具**的部分来做：
能用、不喧哗、不拖性能。

### 用量悬浮球（对话页实时显示）

```text
   ╭──────────╮
   │  ╭────╮  │   外环 蓝 = 5 小时窗口**还剩**（满环 = 全新，越用越短；≤30% 橙，≤10% 红，0% 脉冲）
   │  │4h27│  │   内环 灰 = 每周窗口**还剩**（同样有橙/红两级）
   │  ╰────╯  │   中心   = 距 5 小时重置的倒计时
   ╰──────────╯
```

细节：

- 倒计时格式：离得远显示 `4h27`（分钟级），进入 1 小时内显示 `27:13`（逐秒跳）；
- **实时**：订阅 app-server 的 `account/rateLimits/updated` 通知（每一轮对话都会推），
  再叠加 60 秒兜底轮询，数字变化时球体会闪一下光圈，让「更新了」看得见；
- 位置跟着输入框走：`ResizeObserver` 监测 composer 高度，写进 `--ball-bottom`，
  输入框长高（多行草稿）也不会被挡住；
- 打开右侧面板时球自动淡出（`.dock-open`），关闭后恢复；
- 点击打开「用量」详情面板，`aria-label` 带完整数值（读屏可用）；
- 尊重 `prefers-reduced-motion`（不闪、不脉冲）。

实测（390×844 与 1280×880 两种视口）：环形 `stroke-dashoffset` 与百分比一致（5% → 143.3/150.8），
已用 5%/46% 时两环分别显示剩余 95%/54%，已用 75%/20% 时外环转橙（剩 25%），已用 95%/92% 时两环转红，已用 100% 时加 `is-blocked` 脉冲；点击面板后会用面板的实时数据回写球体，两边永远同一个数。

### 采用的动效（其余一律不做）

| 效果 | 用在哪 | 为什么留 |
|---|---|---|
| 环形进度 + 平滑动过渡 | 用量球 | 一眼看清配额，切换有连续性 |
| 数值变化闪一下 | 用量球 | 让「实时」可感知，而不是数字悄悄变 |
| 骨架屏 shimmer | 面板加载 | 首开不再是一片空白 |
| 交错入场 `msg-in` | 新消息（已备好样式） | 消息出现有落点，不突兀 |
| 悬浮抬升 | 用量球、卡片 | 可点击的暗示 |
| 焦点软光 | 输入框 | 键盘操作时知道焦点在哪 |
| 启动画面 | 首屏 | 白屏 → 品牌过渡 |

刻意没做：光标跟随高光、粒子背景、3D 倾斜、视差滚动、打字机——它们在工具类产品里只会增加
渲染成本与干扰。
## 5.35 按 Interaction Atlas 清单落地的交互（只做有用的）

对着 24 个交互清单逐条过了一遍，只挑了**在对话工具里真有收益**的四个，其余明确不做。

### 落地

| 编号 | 交互 | 用在哪 | 收益 |
|---|---|---|---|
| #09 | 命令面板 | `Ctrl/Cmd + K` | 会话一多，点侧栏找会话很慢；键盘直达 + 模糊过滤 |
| #20 | 堆叠通知 | 取代原来的单条 toast | 多条同时发生时不互相覆盖，带成功/失败/信息图标和「重试」按钮 |
| #08/#22 | 可调整面板 | 右侧文件预览的左边框 | 看 PPT/PDF 时要更宽，宽度记进 localStorage |
| #17 | 轻量动效 | 环形进度、数字变化闪烁 | 用在真正表达「状态变了」的地方 |

命令面板内容来自四个来源，按分组显示：

```text
动作   新会话 / 切换主题 / 刷新会话列表
面板   技能与 MCP / 最近文件 / 用量 / 网络 / 微信 / 新建项目
项目   每个项目（回车切目标项目）
会话   每个会话（回车直接打开）
技能   每个 skill（回车挂到输入框）
```

键盘：`↑ ↓` 选择、`Enter` 打开、`Esc` 关闭、`Ctrl/Cmd + K` 呼出或收起；点击遮罩也关闭。

通知的类型是按文案判定的（含「失败/错误/无法/超时」→ 红色，含「已/成功/完成」→ 绿色），
所以现有几十处 `toast(...)` 调用**不用改**就自动分色；需要按钮时传第三个参数：

```js
toast('发送失败：网络中断', 5000, { action: { label: '重试', onSelect: () => send() } });
```

面板宽度：默认 `clamp(320px, 34vw, 420px)`，拖动后写 `--dock-w`，刷新恢复；
窗口变化会重新夹取（最小 320px，最大 72vw）；手机上面板本来就全宽，拖拽手柄自动隐藏。

### 明确不做

放大镜坞栏、3D 倾斜卡片、视差滚动、拖拽排序、多选、图片对比滑块、悬停放大预览——
这些在展示型站点很出彩，但放进一个每天用几小时的对话工具里只会分散注意力，还拖性能。

## 5.36 多端布局校验

六种视口逐个测量：横向溢出、栅格结构、输入框是否越界、悬浮球是否压住输入框、文本截断。

| 视口 | 布局 | 结果 |
|---|---|---|
| Windows 1600×900 | 侧栏 332 + 主区 | OK |
| Windows 1440×810 | 侧栏 332 + 主区 | OK |
| 手机竖屏 390×844 | 底部 tab 栏 + 全宽面板 | OK |
| 手机横屏 844×390 | 底部 tab 栏 + 全宽面板 | OK |
| iPad 竖屏 820×1180 | 底部 tab 栏 | OK |
| iPad 横屏 1180×820 | 桌面式三栏（rail + 侧栏 + 主区） | OK |

统一判据（全部满足才算 OK）：`scrollWidth - clientWidth <= 0`、输入框完整在视口内、
悬浮球在输入框上方且完整可见、无元素内容被自身裁切。

这一轮修掉的两个真问题：

1. 手机端堆叠通知**压在输入框上**——改成跟悬浮球共用 `--ball-bottom`（输入框顶部之上）；
2. 面板拖宽后刷新**不恢复**——`restoreDockWidth()` 没被调用，补上并在 resize 时重新夹取。
## 5.37 平板/手机上「发微信」Load failed 与扫码后无反馈

现场（iPad 截图）：`正在发到微信…` 之后一条 `发送失败：Load failed`。

### Load failed 的原因：请求被挂住太久

`POST /api/wechat/send` 以前要**等整份文件上传完**才返回 JSON。60MB 的 pptx 上传要十几秒，
iOS Safari 会把这种长时间挂起的 fetch 判成网络错误（`Load failed` / `NetworkError`），
甚至在人切到别的 App 时直接中止。我们这边其实在上传，用户却看到失败。

改成**后台任务 + 轮询**：

```text
POST /api/wechat/send     -> 立刻返回 { jobId, name, size }（实测 17-65ms）
GET  /api/wechat/job?id=  -> { state: running | done | error, result, elapsedMs }
```

上传在服务端继续跑，客户端每 0.9 秒查一次状态，最多等 5 分钟；
单次轮询失败（锁屏、隧道抖动）不会立即失败，只累计超时。
失败时通知里带「重试」按钮，网络类错误显示为「网络中断或请求超时」而不是原文 `Load failed`。

### 扫码后没有反馈

二维码页没有回调，以前只能靠面板里 4 秒一次的轮询悄悄切换卡片，用户不知道成了没有。

现在补了三处：

1. **桥接侧的登录监视器**：每 5 秒比对一次登录状态，一旦从未登录变成已登录，
   通过已有的 SSE 通道（`/api/wechat-watch`）推一条 `event: login`，带账号名；
   退出登录则推 `event: logout`；
2. **客户端收到就提示**：`微信已登录：xxx，现在可以发文件了`，同时强制刷新二维码状态；
3. **兜底**：面板轮询发现状态翻转也会提示一次（SSE 被代理缓冲时仍有效）。

（登录监视器只读页面状态，不改动会话；实测 SSE 首帧 `event: ready` 正常。）

### 顺带

- 发送前先校验文件存在与大小（≤200MB），错误在 20ms 内返回，不再让用户等；
- 未登录时立刻返回「需要先在「微信文件传输」里扫码登录」，并自动打开扫码面板。
## 5.38 扫码不生效的真凶：二维码恢复逻辑会重载页面

前两轮修的都是「发文件」，但**扫码一直不成功**的根因其实在二维码那一侧。

为了兜底「二维码无法加载」，`qrImage()` 里写了这样一段：先点页面上的「刷新」，
还不行就 `Page.navigate` 整页重载。问题是——扫码之后页面会进入
**「已扫描，请在手机上确认」** 状态，此时页面上没有 `img.qrcode-img`，文字里又带着「点击刷新」，
于是每次取二维码都会**点一下刷新 / 重载一次**，把刚扫上的登录会话直接作废。
表现就是：手机扫码 → 手机显示已确认 → 网页这边毫无反应。

修复：**二维码读取路径改成完全只读**——不点、不跳、不刷新。
取不到图就返回 503，由用户点「刷新二维码」（那才是显式的 `/api/wechat/reset`）。

### 扫码后的反馈（三路保证）

1. 桥接每 5 秒只读探测一次登录态（日志 `[wechat] login watcher started (5s)` 可确认它在跑）；
2. 状态翻转时通过 SSE 推 `login` 事件（带账号名），客户端立刻弹「微信已登录：xxx」并刷新卡片；
3. 兜底：面板轮询也会发现翻转并提示一次。

### 登录后自动发一条提示（这次新增）

检测到登录成功后，桥接会主动往你的文件传输助手发一条：

```text
✅ Codex 远程已连接
账号：少年的玉蝴蝶的文件传输助手
时间：2026-11-06 10:41:07
之后在网页里保存的文件会发到这里。
```

发送结果会通过 SSE `greeting` 事件回报，客户端提示「已向你的微信文件传输助手发送登录提示」；
发失败也不影响收文件，只是少一条提示。

### 扫码入口挪到「网络连接」

二维码原来只在回形针菜单里，而「手机能不能收到文件」本质是连接问题，所以放进网络面板，并且**放在最上面**：

```text
网络与连通性
  微信文件传输        [未登录]
    二维码 + 刷新二维码
  --- 或 ---
  微信文件传输        [已连接]
    账号：xxx   [发一条测试消息] [退出登录]
  ─────────────────────────
  良心云 · rule · 44 个节点 …（原有内容）
```

细节：区块挂在 `panelBody` 而不是清空重绘的 `host` 里（否则自动切换的 8 秒轮询会把它冲掉）；
5 秒轮询只在登录态变化时才重绘，避免二维码在手指底下闪。

实测（三种视口）：区块存在、二维码加载成功（`naturalWidth > 0`）、badge 显示「未登录」、刷新按钮在。
## 5.39 传输反馈：保存/发微信都看得见进度

问题：「保存文件」「传到微信」点完没有任何反馈，不知道是不是在传。
尤其平板上没有浏览器的下载条，60MB 的文件点完就像没反应。

### 传输中心

每一次保存/发微信都登记成一条传输记录（`state.transfers`），三处同时反馈：

1. **点下去立刻有提示**：`开始保存：xxx` / `请选择发送方式（12.0MB 的文件走链接更快）`；
2. **文件侧边栏顶部**列出 `正在传输 N 个文件`，每行：类型标签、文件名、`百分比 · 大小 · 已用时间`、细进度条；
3. **侧栏/底栏图标角标**显示进行中的数量（手机底部 tab 上的小蓝点）。

完成后行变绿显示 `完成 · 4s`，4 秒后自动消失；失败变红并写明原因。

### 保存现在的实现

不再是裸的 `<a download>`（点了没任何反馈），改成 `fetch` + 流式读取：

```js
const res = await fetch(fileUrl(target));
const reader = res.body.getReader();     // 每块都 patchTransfer({loaded})
// 读完转 Blob -> a[download] 交给浏览器
```

- 超过 80MB 的文件不进内存，直接交给浏览器下载（避免平板 Safari 崩标签页），并提示「已交给浏览器下载」；
- fetch 失败时同样回退到直链下载，不让用户卡住。

实测（把网络限速到 1.2Mbps 抓中间态）：

```text
t=1.5s  running  3% · 12.0 MB · 2s   bar 2.9%   badge 1
t=4s    running  8% · 12.0 MB · 4s   bar 8.3%   badge 1
done    100% · 12.0 MB · 完成 · 4s   行变绿，4s 后移除
```

### 发微信的菜单也要有反馈

大文件会先弹「发链接 / 发文件 / 复制链接」三选一——菜单以前弹在按钮上方，容易看不见，
现在弹在按钮下方，并且**点击的同时就给一条提示**，不再像「点了没反应」。
选「发文件」后会立刻出现一条 `微信` 传输记录，轮询到完成后变绿。

### 扫码登录确认（真的发出去了）

桥接每 5 秒只读探测登录态；**首次观察到已登录也算**（扫码可能发生在桥接重启期间）。
确认后：

- SSE 推 `login`，界面弹「微信已登录：xxx」；
- 自动往文件传输助手发一条确认消息，并回报 `greeting` 事件；
- 去重记录写在 `bridge/wechat-greeted.json`，30 分钟内不重复发，重启也不会刷屏。

实测日志：

```text
[wechat] already logged in as 少年的玉蝴蝶的文件传输助手, greeting once
[wechat] login greeting sent
```
## 5.40 发微信只走文件；保存进度自动出现在「最近文件」

### 去掉「选择发送方式」

大文件原来会弹「发下载链接 / 发文件 / 复制链接」三选一。多一次选择就是多一次卡顿感，
而且「发送到微信」本来就是发文件。现在点一下直接上传，没有菜单。

实测：`menu open? false` → `wechat:running` → 2 秒后 `已发到微信文件传输助手：wx-note.bin`。

### 保存进度为什么之前看不到，以及现在怎么修

两个原因叠在一起：

1. **进度只画在「最近文件」面板里**，而保存按钮在文件预览的 dock 上——点了之后面板根本没开，自然什么都看不到；
2. 就算打开了，`openFilesPanel()` 末尾用的是 `dom.panelBody.replaceChildren(frag)`，
   把刚插入的传输列表**一起清掉**了（只有列表为空、提前 return 时才看得见）。

修复：

- 点保存 → **先打开「最近文件」**，再开始下载，进度行立刻出现在列表顶部；
- 末尾改成 `append(frag)`，传输列表不再被清掉；
- 保存的文件同时写进最近文件列表，完成行保留 20 秒（绿框 + `完成 · 5s`）；
- 侧栏/底栏图标角标显示进行中的数量。

实测（限速 1.5Mbps 抓中间态）：

```text
点击保存 0.3s  title 变成「最近文件」，head「正在传输 1 个文件」
         1.2s  保存 big-report.bin · 2% · 10.0 MB · 1s   bar 2%   badge 1
         4s    保存 big-report.bin · 8% · 10.0 MB · 4s   bar 8%
完成      保存 big-report.bin · 100% · 10.0 MB · 完成 · 5s（绿框，保留 20s）
```

微信上传我们拿不到字节数，所以那条显示**不确定进度条**（来回滑动），完成时补成 100%，
不会出现假的 `0%`。
## 5.41 计划模式 / 目标模式（原生，不是 skill）

Codex 协议里本来就有这两个能力，只是网页端没接：

| 模式 | 协议能力 | 用法 |
|---|---|---|
| 计划模式 | `turn/start.collaborationMode = { mode: "plan", settings }` | `/plan` |
| 目标模式 | `thread/goal/set` / `thread/goal/get` / `thread/goal/clear` | `/target [目标内容]` |

### 和 skill / MCP 的区别（做在三个地方）

1. **菜单分组**：斜杠菜单里单独一组「模式」，蓝色 + ⚡ 图标；技能在「技能与 MCP」组，灰色 + ✦ 图标；
2. **语义**：模式是**开关**（点亮后作用于后续每一轮），skill 是**附件**（只作用于下一条消息）；
3. **芯片外观**：计划模式是蓝色描边芯片，目标是琥珀色描边芯片，skill 芯片保持中性灰。

### 两种启用方式都支持

```text
/plan                     -> 直接开启计划模式（不发送、不建会话）
/target 整理测试文件      -> 开启目标模式并设定目标
/target                   -> 开启目标模式，下一条消息内容作为目标
```

菜单点选和直接键入命令等价（`send()` 里先解析 `^/(plan|target)\b`）。

### 实际发出去的参数（抓 rpc 验证）

```json
{"mode":"plan","settings":{"model":"gpt-6.1-sol","reasoning_effort":"xhigh","developer_instructions":null}}
{ "objective": "整理 <workspace> 测试文件", "status": "active" }
```

注意：`collaborationMode` 会**覆盖** model 与 effort，所以 settings 里必须带上当前的型号与强度，
否则模型会被悄悄回退到默认值。

### 同步

- 服务端 `thread/goal/updated` / `thread/goal/cleared` 通知 → 芯片实时更新（状态、tokens 用量在 tooltip）；
- 切换会话时读该会话自己的目标（`thread/goal/get`），目标不会串到别的会话；
- 芯片上的 × 直接关闭模式，目标模式关闭时清空目标。

实测：`/plan` 后芯片出现、`turn/start` 带 plan；`/target …` 后 `thread/goal/set` 成功且服务端状态 `active`；
关闭后两个芯片都消失、状态归零。
## 5.42 MCP 面板「全部 unsupported」的真相 + 调用前自动开应用

### 为什么每个服务都显示 unsupported

面板把 `srv.runtimeStatus?.type ?? srv.authStatus` 当作状态显示。这台机器上
`mcpServerStatus/list` 返回的 `runtimeStatus` **全是 null**，于是回落到 `authStatus`，
而它对绝大多数服务就是字面量 `"unsupported"`（含义是「不需要授权」，不是「不可用」）。

结果：8 个服务明明加载了 3~238 个工具，界面却全部写着 unsupported。

改成按**实际可用性**推断：

| 情况 | 显示 |
|---|---|
| `runtimeStatus.type` 存在且不是 ready | 原样显示（红色） |
| 有工具 | `就绪 · N 个工具`（绿色） |
| `toolsError` | `工具不可用`（红色） |
| 什么都没有 | `未连接` |
| `authStatus` 是 bearerToken/oauth | 追加 `· 需授权` |

顺带解决了两个可用性问题：238 个工具一次性铺开没法用，现在有**全局搜索**，
每个服务默认显示 20 个 + 「显示全部 N 个」；冷启动时要等 MCP 服务拉起（约 6 秒），
期间显示「正在连接 MCP 服务… Ns」而不是干等骨架。

实测状态行：

```text
codex_app     未连接
codex_apps    就绪 · 238 个工具 · 需授权
context-mode  就绪 · 9 个工具
cua_repl      就绪 · 3 个工具
node_repl     就绪 · 4 个工具
photoshop     就绪 · 127 个工具
qgis          就绪 · 125 个工具
sketchup      就绪 · 10 个工具
```

### 调用 QGIS / Photoshop 前自动打开本机应用

这两个 MCP 都要求桌面程序已经在跑，否则报的是「连不上」这类难懂的错误。

新增 `POST /api/app/ensure { app, waitMs }`：

- `tasklist` 查进程；没有就找可执行文件（Photoshop 扫 `Program Files\Adobe\Adobe Photoshop *`，
  QGIS 扫 `QGIS *\bin\qgis-ltr-bin.exe`）并 `start` 起来；
- 轮询等进程出现（默认 90 秒上限），再留 2.5 秒给 UI 初始化；
- 返回 `{ok, already|launched, process, exe, waitedMs}`。

前端在 `mcpServer/tool/call` 之前调用它，结果面板显示「正在启动 Photoshop…」→「已打开（6s），正在调用…」。

实测：

```text
qgis       -> {"ok":true,"already":true,"process":"qgis-ltr-bin.exe"}            1.8s
photoshop  -> {"ok":true,"launched":true,"process":"Photoshop.exe","waitedMs":5598}  7.3s
```

### 实际调用过的 MCP（不是只看列表）

| 服务 | 工具 | 结果 |
|---|---|---|
| context-mode | `ctx_doctor` | OK，返回环境自检表 |
| qgis | `get_qgis_info` | OK，`qgis_version: 3.44.15-Solothurn` |
| qgis | `get_project_info` | OK，当前工程 4 个图层、EPSG:4326 |
| photoshop | `photoshop_ping` | OK，「Successfully connected to Photoshop」 |
| photoshop | `photoshop_get_version` / `get_capabilities` | OK，2022 + 功能开关 |
| photoshop | `photoshop_get_state` | OK，`hasDocument:false` |
| node_repl | `js` | OK |
| sketchup | `create_finger_joint` | 参数校验错误（缺必填参数），服务本身可达 |

注意：Photoshop 在**没有打开文档**时，`photoshop_get_document_info` 会返回
`Photoshop info not available. Please detect Photoshop first.` —— 这是该 MCP 自己的措辞，
不是连接失败；先 `photoshop_ping` 或打开一个文档即可。
## 5.43 退出登录后二维码不显示：微信标签页的渲染进程卡死了

现象：点「退出登录」之后，二维码位置一直空着 / 一直「正在生成」。

实测抓到的现场（不是二维码逻辑的问题）：

```text
GET /api/wechat/state   -> {"ok":false,"error":"cdp timeout: Runtime.evaluate"}
POST /api/wechat/reset  -> {"ok":false,"error":"cdp timeout: Page.enable"}   8023ms
GET /api/wechat/qr      -> 503（每次 8s 超时，一直重试都一样）
```

同一个浏览器里另开一个标签做对比：

```text
微信文件传输助手网页版 -> TIMEOUT (6023ms)   ← 渲染进程僵死
下载 (edge://downloads-hub) -> OK (30ms)     ← 浏览器本身正常
```

也就是说：**微信那个标签的渲染进程卡住了**，CDP 连得上但命令永不返回。
之前 `reset()` 只会 `Page.navigate` 重新加载——对一个僵死的渲染进程毫无作用，
所以二维码永远出不来。

修复分三步：

1. **健康检查**：`ensureWindow()` 拿到标签后先做一次 4 秒的 `Runtime.evaluate("1")`，
   超时就判定僵死；
2. **重建标签**：`recreatePage()` 用 `GET /json/close/<id>` 关掉僵死标签，
   再 `PUT /json/new?<url>` 开一个全新的（两种 URL 形式都试，兼容不同 Edge 版本）；
3. **reset 也走重建**：先探活，活的话照旧 `navigate`，不活或 navigate 失败就重建整个标签。

前端也补了一层：二维码图片加载失败时自动重试 6 次（每次 2 秒，带「第 N 次重试」提示），
不再停在「暂时取不到」等用户手点。

实测（连续两轮退出）：

```text
reset#1 {"ok":true} 2684ms -> QR 1.5s 37074B
reset#2 {"ok":true} 2583ms -> QR 1.5s 38267B
```

UI 侧同样验证：退出后面板立刻切回二维码视图，`img.complete && naturalWidth > 0` 为真。
## 5.44 计划模式的提问卡片 + 思考卡不再自己收起

### 提问卡片（`item/tool/requestUserInput`）

计划模式会停下来问「先做哪一部分？」这类问题。查了协议，它不是 allow/deny 审批：

```ts
params:  { questions: [{ id, header, question, isOther, isSecret, options: [{label, description}] }], isBlocking }
response: { answers: { [questionId]: { answers: string[] } } }
```

但前端把它和命令审批放在同一个分支里，渲染成「允许 / 本会话都允许 / 拒绝」，
回包还是 `{decision}` —— 服务端拿到的不是答案，问题等于没法回答。

现在有专门的卡片：

- 每个问题：小标题（header）+ 问题正文 + 选项列表（label + 说明，可多选）；
- `options` 为空或 `isOther` 时附带自由输入框，`isSecret` 用密码框；
- 「提交回答」在至少答了一题后才可点，另有「跳过」；
- 回包严格按协议：`{ answers: { q1: { answers: ["先做数据"] }, q2: { answers: ["这周内"] } } }`。

实测（注入两题：一个带选项+自定义，一个纯填空）：

```text
card: {has:true, title:"Codex 想问 2 个问题", questions:2, options:2, inputs:2, submitDisabled:true}
reply: {"answers":{"q1":{"answers":["先做数据"]},"q2":{"answers":["这周内"]}}}
```

### 思考卡点开后又自己收起

原因不在卡片本身：`refreshItem()` 更新 reasoning 时是**原地改文本**，不会塌；
塌的是 `renderStream()` —— 只要这一轮有新的 item 到达或这一轮结束，整个消息列表会重建，
`is-open` 类自然就丢了。

修复：用一个模块级的 `openSteps` 集合按 item id 记住展开状态，
`stepCard({ key })` 创建时读取、点击时写入。重建多少次都保持展开。

实测：点开 → `is-open:true` → 触发一次 `renderStream()` → 仍然 `is-open:true`，正文还在。
## 5.45 只有老账号能登微信：退出登录没清会话

现象：之前登录过的账号（少年的玉蝴蝶）一直能用，换个微信号扫码就登不上。

查了浏览器的实际存储，问题很清楚——「退出登录」只是**刷新页面**，凭据全留着：

```text
cookies:
  webwx_auth_ticket@.szfilehelper.weixin.qq.com   expires 1828514094 ← 2027 年
  webwxuvid@.szfilehelper.weixin.qq.com           expires 1828369982
  wxuin@.szfilehelper.weixin.qq.com               expires 1794215436
  wxsid@… / wxloadtime@… / wxpluginkey@… / last_wxuin@…
localStorage: AEGIS_ID, fileTotalSize, userAvatar, webUin
```

页面一打开，看到 `webwx_auth_ticket` + `wxuin` 就直接恢复成上个账号，于是：

- 界面上要么直接回到列表，要么出现二维码但扫了没反应；
- 换号扫码时微信认为「当前浏览器已登录其他账号」，静默失败。

### 修复：硬退出

`reset()` 现在按这个顺序来：

```js
await cdp("Storage.clearDataForOrigin", { origin: "https://szfilehelper.weixin.qq.com", storageTypes: "all" });
await cdp("Storage.clearDataForOrigin", { origin: "https://login.weixin.qq.com",     storageTypes: "all" });
await cdp("Network.clearBrowserCookies", {});          // 这个 profile 只跑文件助手，清全部是安全的
await cdp("Page.navigate", { url: URL_TRANSFER });
// 登录页加载后还会写回 webUin/AEGIS_ID，再清一次
await cdp("Runtime.evaluate", { expression: "localStorage.removeItem('webUin')…" });
```

标签页僵死时走的重建分支也会先清会话再关标签（cookie 是跟着 profile 走的，关标签不解决）。

前端提示也改成了「已退出登录：已清除上一个账号的会话，请用要使用的账号扫码」。

### 验证（连续调用 reset 后检查浏览器实际存储）

改前：13 个 cookie（含 2027 年到期的 auth ticket）+ `webUin`。

改后：

```text
cookies: none
localStorage: ["AEGIS_ID"]        ← 只剩腾讯设备指纹，不含任何账号身份
page body: "使用手机微信扫码传输文件"
state: {"loggedIn":false,"hasQr":true}
GET /api/wechat/qr -> 200 37614B image/jpeg
```

日志同时出现 `[wechat-web] session cleared (cookies + storage)` 与 `[wechat] logged out`。

之后用任意微信号扫码都能登录；再切换回原来的账号也是同样一次「退出登录」。
## 5.46 计划模式退不掉（以及一次回退）

原因：`collaborationMode` 不是「本轮参数」，它会**存进 thread settings**
（`ThreadSettings.collaborationMode`）。之前只在开启时发送：

```js
if (state.planMode) params.collaborationMode = { mode: "plan", … };  // 只有开启分支
```

关掉芯片后下一轮不带这个字段，服务端沿用上次保存的 `plan` —— 芯片没了，模型继续规划。

### 第一次尝试（已回退）

当时改成「每轮都显式带模式」（`state.planMode ? "plan" : "default"`）。
服务端接受这个值，但把**所有**普通发送的请求体都改了形状，导致对话不再正常显示。
已经整段回退：普通发送与之前完全一致（`turn/start` 不再带 `collaborationMode`）。

### 现在的做法

只在**关闭计划模式的那一刻**用一次独立的设置更新，不碰正常发送：

```js
if (!state.planMode && state.currentThreadId) {
  rpc.send('thread/settings/update', {
    threadId: state.currentThreadId,
    collaborationMode: { mode: "default", settings: { model, reasoning_effort, developer_instructions: null } },
  });
}
```

同时监听 `thread/settings/updated` 把服务端保存的模式回同步到芯片，
这样桌面端或另一个标签切换模式时，网页端也不会显示错。

### 验证

服务端通知（直接抓 app-server）：

```text
set plan    -> {}
set default -> {}
notifications: thread/settings/updated:plan, thread/settings/updated:default
```

UI 全流程（抓页面发出的 rpc）：

```text
calls:  turn(mode=plan)  →  thread/settings/update  →  turn(mode=null)
plan chip now: {"planMode":false,"chips":0}
last reply: "收到"        ← 关闭后是正常回答，不是计划
```

## 5.47 冷启动时「对话全部不显示」

同一个现象还有第二个来源：启动顺序。原来先等 `projects / quota / models / skills`
**全部完成**才去拉会话列表，冷启动要 10 秒以上；这段时间侧栏是空的，看起来就像对话全没了。
而且四个读取用 `Promise.all`，任何一个失败都会让会话列表根本不加载。

改成：

1. `initialize` → **立刻拉会话列表**（空则 1.2 秒后重试一次）；
2. 其余读取用 `Promise.allSettled` **并行**跑，失败也不影响列表；
3. projects 到达后 `renderThreadList()` 自动分组。

实测：会话列表出现时间 **10s+ → 1.6s**（`first rows: 34 at 1.6s`），
并且模拟一个读取失败后仍然 `threads:38 / rows:34`。

## 5.48 本机正在跑的会话，网页端实时跟着看

### 先确认了协议的限制

用两个独立客户端做对照实验：A 起了一轮任务，B 只收到 **1 条** `thread/status/changed`，
没有任何 `turn/started` / `item/*` / `*delta`。也就是说：

> app-server 只把这一轮的事件流推给**发起它的那个客户端**，其他客户端什么也收不到。

所以桌面端在跑任务时，网页端原本只能看到「空」或者更早的历史。

### 能不能靠轮询补救？可以

`thread/turns/list` 支持 `itemsView: "full"`，实测在一轮进行中会**逐步**放出条目：

```text
+2.5s  inProgress items=0
+7.5s  inProgress items=1  userMessage
+27.5s inProgress items=2  userMessage reasoning
+42.5s inProgress items=3  userMessage reasoning reasoning
```

思考步骤是随生成陆续出现的，所以轮询足够撑起「实时看到思考过程」。

### 实现

- 打开会话、或收到当前会话的 `thread/status/changed(active)` 时，启动 **live follow**；
- 每 1.8 秒拉一次 `thread/turns/list { limit:6, itemsView:"full" }`；
- 用「条目 id 拼接」做签名去重，只有变化时才 `renderStream()`，避免闪烁；
- 按**服务端顺序**重建该轮的 `itemIds`，这样后到的思考步骤仍排在答案上方；
- 轮次结束后再补一次读取，确保最终答案落地，然后自动停止；
- 自己发消息时（`_send` 里）先停止跟随，改用原生 delta 流；切会话、新建会话也会停。

### 实测（另一个客户端起任务，网页端零操作）

```text
+2.5s  busy:true                        ← 自动识别到「有人在这台机器上跑」
+5s    items:1  用户消息渲染出来
+10s   items:3  答案开始增长（"正在处理…我会先算…"）
+22.5s items:4  思考卡片出现（parts:1）
+30s   busy:false  Worked for 27秒
```

顺带修掉两个连带问题：

1. 刚创建、还没落盘的会话会报「历史读取失败：thread … is not materialized yet」，
   现在识别为「空历史」不报警，交给 live follow 填充；
2. 轮询快照里条目顺序可能与先到的不一致，现在按快照顺序重排，思考不会跑到答案下面。

> 已知限制：协议里没有「别人这一轮正在生成什么」的增量接口，所以这里的粒度是最快
> 1.8 秒一次的快照（自己发起的轮次仍是毫秒级 delta 流）。
，块级 `\[ … \]` 与 `$ … $`（可跨行）；
- `$5` 这类金额不会被误判（要求有闭合 `# Codex Remote — 用 iPad / 另一台电脑操作本机 Codex

把本机（KLV-WX9）上的 Codex 变成一个**固定地址的 Web 界面**：iPad、另一台 Windows 电脑打开浏览器就能接管本机的 Codex 会话，任务仍然跑在这台机器上。

不需要梯子、不需要公网 IP、不需要端口映射。

---

## 0. 先说三件事实

1. **`npx codex-xremote` 不存在。** npm 上没有 `codex-xremote`，也没有 `codex_xremote`（GitHub 上有个同名仓库，但没发包），所以那条命令必然 404。本方案不依赖它。
2. **本机 Codex 0.166.0 自带官方远程能力**，这套东西就建在它上面：
   - `codex app-server --listen ws://127.0.0.1:8791` — 官方的 WebSocket 服务端（实测可直接跑，且只绑本机回环）
   - 协议是官方生成的 TypeScript 绑定（`protocol/`，760 个类型文件），请求形如 `{method, id, params}` → `{id, result}`
3. **界面是从 Codex 桌面端本身提取出来对齐的**：配色直接取自桌面端窗口截图的像素采样，字体/圆角/间距取自它自己的 CSS 变量（`web/tokens.css` 由 `desktop-webview/` 里的真实样式表合并而成）。

---

## 1. 现在怎么用

```text
这台电脑（被控）                         你的 iPad / 笔记本
┌──────────────────────────┐            ┌─────────────────┐
│ Codex app-server :8791   │            │                 │
│   ↑ 只绑 127.0.0.1       │            │  浏览器          │
│ bridge (Node) :8787      │◄──HTTP/WS──│  http://…:8787  │
│   · 静态页面 + WS 代理    │            │                 │
│   · 口令登录 + 签名 Cookie│            │                 │
└──────────────────────────┘            └─────────────────┘
```

| 场景 | 地址 |
|---|---|
| 本机 | <http://127.0.0.1:8787/> |
| 同一 Wi-Fi / 局域网 | <http://<lan-ip>:8787/> （IP 变了以 `bridge/logs/bridge.log` 启动那几行为准） |
| 任何网络（Tailscale，已配好） | <http://<tailnet-ip>:8787/> |

**访问密码**在 `bridge/config.json` 的 `passcode` 字段里，当前是：

```powershell
(Get-Content .\bridge\config.json -Raw | ConvertFrom-Json).passcode
```

打开页面输入一次，之后 30 天内不用再输（HttpOnly 签名 Cookie）。

**iPad 上建议「添加到主屏幕」**：Safari 打开 → 分享 → 添加到主屏幕，之后就是一个全屏 App 的样子，没有浏览器地址栏。

---

## 2. 外网访问

### 2.1 Tailscale（已配置，当前方案）

不给域名、不花钱、不用公网 IP。本机已加入 tailnet，节点信息：

| 项 | 值 |
|---|---|
| 节点 IP | `<tailnet-ip>` |
| MagicDNS | `pc-20261014odxq.taild17e9c.ts.net` |
| 访问地址 | <http://<tailnet-ip>:8787/> |
| 配对链接 | <http://<tailnet-ip>:8787/?t=`<你的 passcode>`> |

链路是 WireGuard 端到端加密的，所以 HTTP 也是加密的（浏览器只会提示"不安全"是因为没证书，不影响保密性）。

**iPad 上四步：** App Store 装 `Tailscale`（厂商 Tailscale Inc.）→ 同一个账号登录 → 打开 VPN 开关 → Safari 打开上面的地址，输一次密码，然后「分享 → 添加到主屏幕」。

**新设备想加入**：在那个设备上装 Tailscale 并用同一账号登录即可，不需要改本机任何配置。

常用命令：

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" status      # 看谁在线
& "C:\Program Files\Tailscale\tailscale.exe" ip -4       # 本机 tailnet IP
```

**可选：换成 HTTPS 地址**（去掉"不安全"提示，iOS 的 PWA 体验也更完整）

1. 打开 <https://login.tailscale.com/f/serve?node=nyzbRqQvef11CNTRL> 启用 Serve（一次性）
2. 然后执行 `& "C:\Program Files\Tailscale\tailscale.exe" serve --bg http://127.0.0.1:8787`
3. 地址变成 `https://pc-20261014odxq.taild17e9c.ts.net/`

### 2.2 Cloudflare Tunnel（备选，需要自己的域名）

本机也装了 `cloudflared`（2026.10.7）。这条路需要**你自己的域名并托管到 Cloudflare**，好处是域名更好记、可以叠 Cloudflare Access 做邮箱验证码二次验证。**实测注意**：免账号的临时隧道（`-Quick`）从这条网络现在返回 `429`，不要指望它。

```powershell
# 1) 登录（会打开浏览器，选你的域名授权）
& "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe" tunnel login

# 2) 建命名隧道 + 绑域名 + 注册登录自启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-tunnel.ps1 -Hostname codex.example.com
```

跑完就有固定入口 `https://codex.example.com/`，且重启后自动带起来。

- 只想先试试、没有域名：`scripts\setup-tunnel.ps1 -Quick` 会给一个随机 `*.trycloudflare.com` 地址，**重启就变**，不建议长期用。
- 移除隧道入口：`scripts\setup-tunnel.ps1 -Uninstall`（Cloudflare 面板里的隧道和 DNS 记录要手动删）。

> 为什么不推荐 frp / DDNS：都要一台公网服务器或路由器端口映射；Cloudflare Tunnel 是纯出站连接，CGNAT 后面也能用，而且免费额度对单人够用。

---

## 3. 开机自启与日常操作

已经注册好计划任务 `CodexRemoteBridge`（登录时启动，无窗口，失败每分钟重试）：

```powershell
# 看状态
Get-ScheduledTask -TaskName CodexRemoteBridge | Select TaskName,State
# 立即启动 / 停止
Start-ScheduledTask -TaskName CodexRemoteBridge
Stop-ScheduledTask  -TaskName CodexRemoteBridge
# 健康检查
Invoke-WebRequest http://127.0.0.1:8787/healthz -UseBasicParsing | Select -Expand Content
# 卸载自启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
```

日志：`bridge/logs/bridge.log`（含 app-server 的 stderr，超过 4 MB 自动轮转一次）。

---

## 4. 安全边界（重要）

- app-server **只监听 127.0.0.1:8791**，局域网上任何人都摸不到它；对外只有 bridge 的 8787。
- 8787 需要口令登录，Cookie 是 HMAC-SHA256 签名 + 30 天过期 + HttpOnly + SameSite=Lax；同一个 IP 5 分钟内错 8 次会被限流。
- 口令等同于这台电脑的 Codex 操作权（Codex 会执行命令、改文件）。**别把带 `?t=` 的配对链接发到群里**，用完可以改 `config.json` 的 `passcode` 再重启 bridge。
- 本机三个防火墙配置文件目前都是关闭的，所以局域网能直连。**如果你以后开了防火墙**，需要放行 8787（管理员权限）：

  ```powershell
  New-NetFirewallRule -DisplayName 'Codex Remote 8787' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Domain,Private
  ```

---

## 5. 界面与桌面端对齐到什么程度

已经对齐的：三栏骨架（图标栏 / 会话列表 / 对话区）、#F6F6F6 顶栏与图标栏、#FCFCFC 侧栏、纯白画布、近黑色用户气泡、`Worked for …` 分隔行 + 细分隔线、13.5px 侧栏字与 15px 正文、20px 气泡圆角、胶囊形模型/思考强度选择器、暗色主题、iPad 双栏与手机抽屉式布局。

**尚未逐像素复刻的**：它不是 Electron 渲染的那份前端（那份要逆向主进程通信协议，见第 7 节）；命令卡片、diff、审批卡是按同一套设计语言重写的，不是桌面端原组件。想再逼近，可以直接对着 `docs/ui-*.png` 和 `docs/ref-desktop.png` 提具体差异点，我按截图逐屏修。

截图（都是真机数据，不是假数据）：

| 文件 | 说明 |
|---|---|
| `docs/ref-desktop.png` | Codex 桌面端原件（颜色采样来源） |
| `docs/ui-desktop.png` | 本方案 · 桌面尺寸 |
| `docs/ui-thread.png` | 本方案 · 打开真实会话 |
| `docs/ui-ipad.png` | 本方案 · iPad 横屏 1180×820 |
| `docs/ui-phone.png` | 本方案 · 手机 390×844 |
| `docs/ui-dark.png` | 本方案 · 暗色 |
| `docs/ui-home.png` | 本方案 · 新会话首页 |

---

## 5.5 实现状态（哪些是真跑通的，哪些没有）

这一节按**实测**写，不按"看起来像"写。验证手段在 `tools/`：`flow-test.mjs`、`held-test.mjs`、`cdp-diag.mjs`。

### 已实现且实测通过

| 能力 | 验证方式 |
|---|---|
| 浏览器 ↔ app-server 全双工 JSON-RPC | `cdp-diag.mjs`：零未捕获异常，`已连接` |
| 会话列表（含 Pinned/Recents 分组、置顶顺序） | 11 条真实会话 |
| **打开桌面端正在编辑的会话**（只读） | 实测 4 轮 / **224 个 item**、16 消息 / **161 个步骤卡片**全部渲染 |
| 分页历史 + 上滑加载更早 | `thread/turns/list` + cursor |
| 新建会话并发送 | `flow-test.mjs`：气泡单条、标题同步、RPC 往返成功 |
| 失败原因常驻展示 | 额度错误以内联红条留在正文里（不再一闪而过的 toast） |
| **桌面端占用检测与逃生** | `held-test.mjs`：出现只读横幅 +「复制为新会话 / 再试一次接管」，草稿保留；`thread/fork` 实测成功（复制 2 轮）|
| 协议内部消息折叠 | `<send_user_message_question_reply>` 等不再冒充用户气泡 |
| 路径 / 图片引用 | `[文字](C:\...)`、`![图](C:\x.png)` 渲染成 chip，不再显示原始 Markdown |
| 明暗主题、iPad 双栏、手机抽屉 | 截图见 `docs/ui-*.png` |
| 登录鉴权、限流、签名 Cookie | 8 次/5 分钟限流、HMAC 签名、30 天 |

### 已实现但没能实测（被账号额度挡住）

| 能力 | 状态 |
|---|---|
| 流式输出（`item/*/delta`） | 代码路径完整，e2e 里收到过 `turn/started`→`item/started`→`error`→`turn/completed` 全序列，但没跑完一轮真实回答 |
| 审批弹窗（`item/commandExecution/requestApproval` 等） | 响应体按协议实现（`{decision:"accept"}`），额度恢复后需真跑一次 |
| 停止（`turn/interrupt`） | 同上 |
| 命令卡片展开、diff 着色 | 已按 161 个真实 item 渲染，输出内容为空是因为历史里 `aggregatedOutput` 本就为空 |

### 明确没做

- **页面刷新会丢掉未决审批**：`codex_xremote` 用 `GET /pending` 补这个洞，我们的连接是「每个浏览器 WS 一条上游」，刷新即断。下一步应把上游连接提升为按会话常驻（见参考文档建议 1）。
- ~~文件/图片不能在本机之外打开~~ → 已实现 `/api/upload` + `/api/file`，见 5.6。
- ~~会话重命名 / 归档 / 删除没有 UI~~ → 已实现，右键/长按会话行。
- `approval_policy` 与 `sandbox_mode` **保持 Codex 自己的配置**，不像 codex_xremote 那样硬塞 `never` + `danger-full-access`。


## 5.6 附件 / 技能 / MCP / 会话管理（已实现）

### 加文件（三条入口）

| 入口 | 说明 |
|---|---|
| 点回形针 | 弹出系统文件选择器。**iPad 上会给出「照片图库 / 拍照 / 选择文件」**，可以直接从相册或相机加图 |
| 拖拽 | 把文件拖到页面上，出现虚线遮罩，松手即上传 |
| 粘贴 | 在输入框里直接粘贴截图或复制的文件 |

文件**不是传到浏览器**，而是落到被控机：`%TEMP%\codex-remote\<时间戳>-<原名>`。发送时按类型组进消息：

- 图片（png/jpg/gif/webp/heic/svg…）→ `{type:"localImage", path}`，Codex 能直接看图
- 其它文件 → `{type:"mention", name, path}`

上限 512 MB。实测：`text + localImage + mention + skill` 四种混合输入被 `turn/start` 正常接受。

### 看文件 / 下载

附件 chip、正文里的路径 chip、`imageView` 卡片都可以点开查看器：

- 图片 → 直接渲染（走 `/api/file`，支持 Range 所以 Safari 能流式播放视频/PDF）
- 文本 / 代码 / markdown → 拉前 512 KB 显示
- 视频 / 音频 → 原生播放器
- 其它 → 右上角「下载」

### 技能（`/` 快捷调用）

输入框打 `/` 弹出已装技能（本机实测 **197 个**，来自 `skills/list`）。↑↓ 选择，Enter/点击确认，技能会作为 chip 挂在消息上（`{type:"skill", name, path}`）。

### ⚡ Fast 加速档（实测生效）

输入框右侧的 ⚡ 按钮就是 Codex 桌面端的那个"闪电"。点一下变成蓝色 **Fast**，再点关闭。

实测请求体里真的带上了：

```json
{ "method": "turn/start", "params": { "serviceTier": "priority", ... } }
```

取值来自 `model/list` 的 `serviceTiers[0].id`（本机是 `priority`，名字 Fast，说明"2x speed, increased usage"）。模型不支持时按钮自动隐藏；换模型时若新模型没有加速档会自动关闭。

### 插件（新增页签）

「技能与 MCP」面板现在是三个页签：**技能 / 插件 / MCP**。

插件页签实测读到 4 个市场：`openai-primary-runtime`、`openai-bundled`、`context-mode`、`openai-curated-remote`，每个插件显示名字、版本、启用状态和**可直接挂载的技能 chip**：

```text
documents        26.1026.10807  1 个技能   /documents:documents
pdf              26.1026.10807  1 个技能   /pdf:pdf
spreadsheets     26.1026.10807  2 个技能   /spreadsheets:Spreadsheets  /spreadsheets:excel-live-control
presentations    26.1026.10807  1 个技能   /presentations:Presentations
template-creator 26.1026.10807  1 个技能   /template-creator:template-creator
codex-app-tools  26.1027.30824  （只有 MCP 工具，没有技能）
browser / unified-computer-use / computer-use / chrome / visualize  （同上）
```

> 澄清一点：Codex 的"插件"不是一个可以直接调用的函数，它是**技能 + MCP 工具 + app 工具**的集合。所以"调用插件"拆成两条路：它的技能走技能页签（挂到消息上），它的工具走 MCP 页签（直接调）。两条现在都通了。

### MCP 实测调用（context-mode）

不是"列出来"，是真的调了。面板里点 `ctx_stats` → 调用 → 返回：

```text
context-mode  < 1 min  0 calls
No tool calls yet. Use batch_execute or execute to start saving tokens.
  Skipped (1): Codex CLI
$0.00 this session  ·  $0.00 lifetime
v1.0.169
```

另外 `ctx_search` 也调通了（返回"知识库为空"的正常提示）。**没有会话也能调**：会自动开一个临时会话（`ephemeral: true`）承载 MCP 连接，不污染会话列表。

### `/` 检索：修了三个真 bug

| 问题 | 现象 | 修法 |
|---|---|---|
| 命名空间重复拼接 | 显示 `humanizer:humanizer:humanizer` | `skills/list` 返回的 name 本身已带命名空间，不再二次拼接 |
| 描述级匹配污染 | 打 `/hum` 出来一堆不相干的 | 有名字命中时直接丢弃"只在描述里出现"的结果；前缀命中排最前 |
| token 被吃掉 | 选完技能输入框变空，看不出挂了什么 | 保留可见的 `/名称` token；删掉 token 时 chip 自动取消 |

也可以不经过菜单：直接输入 `/名称` 再按空格，效果一样。

### 项目（Projects）

**先纠正一个我自己先前的错误结论**：我一开始查 109 个客户端方法没找到 `project/*`，就断言"协议里没有"。实际上**有 7 个**：

```text
project/list   project/read   project/create   project/import
project/update  project/move  project/delete
```

它们全都标了 `#[experimental]`，而 `codex app-server generate-ts` **默认 `experimental_api: false`，会把实验性请求从产出里过滤掉**（通知不过滤，所以 `project/changed` 一直在）。这是我那份绑定里只有通知、没有请求的原因。

修复用了两步：

```powershell
# 1) 重新生成绑定（767 → 915 个类型文件）
codex app-server generate-ts --experimental --out codex-remote\protocol
# 2) 客户端 initialize 时声明能力（我们本来就带）
{ capabilities: { experimentalApi: true, requestAttestation: false } }
```

本机实测：

```text
project/list -> OK   1 个项目 "Remote"
  roots = C:\Users\…\Codex_Migration_20261031T104701Z
  position = 0    recencyAt = null
```

**项目的真实位置是 app-server 的 SQLite 线程库，不是 config.toml。** `config.toml` 里的 `[projects.'C:\…']` 只有一个 `trust_level` 字段，是 `thread/start` 在写时顺手落下的信任标记，和"项目"列表无关。SQLite 存储不可用时 `project/list` 会返回 `-32601`，所以要按"可选能力"处理。

#### 归属：绝不按 cwd 推断

上一版我用"cwd 落在项目 root 下"来猜归属，**这是错的**。真实来源只有三处：

| 来源 | 说明 |
|---|---|
| `thread/start { cwd, projectId }` | 新建时指定，**两个字段都要发**，互不影响 |
| `thread/metadata/update { projectId }` | 事后改归属（没有 `thread/projectUpdate` 这个方法） |
| fork 继承 | 分叉时继承父线程的项目 |

现在客户端实测发出的参数：

```json
{ "method": "thread/start", "params": {
    "cwd": "<outputs>\\Codex_Migration_20261031T104701Z",
    "projectId": "01a1920c-cfcc-7f83-9028-17f04339287a" } }
```

#### 两套 id 空间的现实

这台机器上同时存在两份项目数据，**id 不同**：

- app-server（SQLite）：`project/list` 给的 `01a1920c-…`，其中 **0 条线程**
- 桌面端（`~/.codex/.codex-global-state.json`）：`b3076195-…`，其中有 **2 条线程归属**

桌面端界面显示的是后者。所以现在的做法是：**以 `project/list` 为准**，再把桌面端注册表按 **root 路径相同** 做一次 id 映射（`b3076195 → 01a1920c`），这样两边的线程都能落到同一个项目分组里；匹配不上的桌面项目作为附加项保留。

界面表现与之前一致：侧栏「项目」分组、文件夹图标 + 名称 + 会话数、点子会话缩进、输入框项目 chip（决定新会话的 `cwd` 与 `projectId`）、标题栏 + 按钮。

### 额度预检 + 空会话回收（解决"新建对话同时存在多个"）

根因有两层，实测确认：

1. 额度用完时 `turn/start` **依然会成功返回**，然后这一轮才失败——这种"已受理后失败"的线程是**持久化且不会回滚**的，于是就留下一个只有一条用户消息的空会话。
2. 但 **`thread/start` 本身不落盘**（代码注释："Fresh threads have no rollout until their first turn"）。所以光点"新建对话"不会产生任何孤儿——真正产生垃圾的是第 1 条。

现在的处理：

1. 连上就 `account/rateLimits/read`，5 小时窗口 `usedPercent >= 100` 或 `ordinaryUsageAllowed === false` 视为耗尽
2. 耗尽时输入框上方直接显示横幅（和桌面端同款）：
   ```text
   Codex 和工作使用额度已用完
   5 小时窗口已用 100% · 将于 11/4 03:37 重置            [查看用量]
   ```
3. **发送直接被拦下**，不入队、不建会话（实测拦下后请求列表为空、侧栏条数不变）
4. 万一仍然发生（比如额度中途耗尽），`turn/completed` 为 `failed` 且这一轮**零助手产出**时，自动 `thread/archive` 收起该会话（用 archive 而不是 delete：这一轮已经写过 rollout，archive 可逆），并把草稿放回输入框

### 左侧栏（只有 4 个入口）

| 图标 | 作用 |
|---|---|
| 首页 | 回到新会话 |
| 技能与 MCP | 两个页签：**技能**（197 个，可搜索，点一下挂到下一条消息，等同输入 `/名称`）；**MCP**（8 个服务器、实测 507 个工具，点工具填 JSON 直接调 `mcpServer/tool/call`）|
| 最近文件 | 上传过的 + 会话里出现过的文件（实测 29 条），每行「查看 / 下载」 |
| 用量 | 套餐、5 小时 / 7 天窗口已用百分比与重置时间、剩余 credits、累计 tokens 与连击天数 |

底部保留一个明暗主题切换（iPad 上确实需要）。

### 用量面板实测输出

```text
PLUS
5 小时窗口   100% 已用   重置 11/4 03:37   <- 就是它挡住了任务执行
7 天窗口      34% 已用   重置 11/8 19:20
剩余 credits  0
累计 tokens   1,015,696,789（单日峰值 83,770,069 · 连续 9 天 · 最长 18 天）
```

### 会话管理

在会话行上**右键**（iPad 上**长按**）→ 重命名 / 归档 / 删除，对应 `thread/name/set`、`thread/archive`、`thread/delete`。

> **列表重复的修复**：`thread/list` 默认会扫 JSONL 做元数据修复，同一条线程可能返回两次。现在改用 `useStateDbOnly: true`，并在客户端按 id 再去重一次：实测 12 条 → **10 条、0 重复**。

## 5.7 排版体检与修复（数据驱动）

用 CDP 在真实浏览器里量，不靠眼睛：`tools/layout-audit.mjs` 会在 1440×920 / 1180×820 / 390×844 三个尺寸下检查
横向溢出、越界元素、固定层相互遮挡，并落三张截图到 `docs/audit-*.png`。

第一次审计结果：

| 尺寸 | 横向溢出 | 越界 | 遮挡 |
|---|---|---|---|
| 1440×920 | 无 | 无 | 无 |
| 1180×820（iPad） | 无 | 无 | 无 |
| 390×844（手机） | 无 | 抽屉左移（正常） | **模型 chip 换行成 3 行并溢出输入框边框** |
| 侧面板打开 | — | — | **面板压住输入框**（panel.left 1008 < composer.right 1278） |

修的三处：

1. **输入框 chip 行禁止换行 + 横向滚动**（`.composer-row { flex-wrap: nowrap; overflow-x: auto }`，隐藏滚动条），窄屏进一步缩小 chip 内边距与字号；`.chip` 加 `white-space: nowrap`
2. **窄屏用短占位文字**：`window.innerWidth < 520` 时改成「描述任务，Enter 发送」，并在 resize 时同步（原来是长句被截断）
3. **侧面板加遮罩**：作为 sheet 出现（`#panelBackdrop`，点击关闭），不再"静默盖住输入框"；手机上面板改为左右各留 8px 的全宽

修复后复测：三尺寸 `overflowX` 全为空，手机截图里 chip 单行、占位文字完整。

### 关于 dsh-pilot

想装 `dsh-pilot`（浏览器操控插件）时遇到的是**架构限制**，不是网络问题：

```text
$ npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile desktop add dsh-pilot
error: profile "desktop" is managed exclusively by the Electron application
```

- 本机用的是 `desktop` profile（`~/.dsh/profiles/desktop`），由 Electron 独占管理，CLI 拒绝写入
- 该 profile 目录里**没有 node_modules**，而 dsh-pilot 的 peer 依赖（`@deepseek-ai/cordis`、`dsh-tools`、`schemastery`）都在应用包内，手工 `npm i` 解析不到
- GUI 的 19387 端口有 401 鉴权，token 只在内存里
- 应用内确实有插件管理页（包名 `@deepseek-ai/dsh-client-ui-settings-plugins`）

正确装法（入口在**左侧栏第二行**，不是设置里）：

1. 左侧栏点 **插件**（「新会话」正下方，插头图标）
2. 点 **添加插件**
3. 包名填 `dsh-pilot`（可选版本后缀），按 Enter 或点 **安装**
4. 装完点 **立即启用**
5. 若提示需要重载，重启应用

那个页面就是插件管理器（包名 `dsh-client-ui-plugin-manager`），支持包名 / Git 地址 / 压缩包 / 本地绝对路径，还能选 npm 官方源或中国大陆镜像源。装好后 agent 的工具里会出现
`pilot_navigate / pilot_snapshot / pilot_act / pilot_wait / pilot_screenshot / pilot_close`。

## 5.8 右侧 Dock：面板与文件预览共用一块区域

以前侧栏面板是浮层、文件预览是模态框，两套东西会互相盖住。现在只有**一块右侧 Dock**：

- 侧栏四个入口（技能与 MCP / 最近文件 / 用量）打开的都是它
- 点会话里的路径 chip、附件 chip、`imageView` 卡片、最近文件的「查看」，**也开在同一个位置**
- 宽度 `--dock-w: 420px`，从顶部到底部整列；≥1000px 时对话区自动让位（`main { margin-right: 420px }`），不再压住输入框；<1000px 时占满宽度
- 模态遮罩已删除——它是真正的布局列，不是弹窗

### 文件预览支持

| 类型 | 行为 |
|---|---|
| `.md` / `.markdown` / `.mdx` | **渲染成 markdown**（标题/列表/代码块/链接），带「预览 / 源码」切换 |
| `.html` | 「预览 / 源码」切换；预览跑在 `<iframe sandbox="">` 里（脚本与本站存储隔离） |
| 代码 / 文本 / json / toml … | 源码视图（等宽、换行、上限 512 KB） |
| 图片 | 直接显示 |
| 视频 / 音频 | 原生播放器 |
| 其它 | 只给「下载」 |

> HTML 预览的边界：因为沙箱禁脚本，**依赖外部 JS 的页面（例如 Vite 打包出来的 SPA 壳）会显示为空白**，Dock 里会显示一行说明提示切到「源码」。自包含的 HTML（报告、表格、静态页）能正常渲染。

### 顺带的两处调整

- **侧栏文本单行 + 左对齐**：会话名、项目名都是 `white-space: nowrap` + 省略号，不再折成两行
- **去掉侧栏的「Codex」品牌按钮**（它点了只弹 toast，是个假控件）
- **首屏加载并行化**：`project/list`、`account/rateLimits/read`、`model/list`、`skills/list` 一起发，再取线程列表——实测首屏从 15 秒降到 **3.5 秒**

## 5.9 对话标题栏的实时用量条

每个对话的标题栏右侧现在是四个胶囊：

```text
上下文 35%   tokens 412.0k   命中率 82%   5h 额度 100%
```

| 指标 | 算法 | 数据来源 |
|---|---|---|
| 上下文 | 本轮 `last.totalTokens / modelContextWindow` | `thread/tokenUsage/updated` 或 `rawResponse/completed` |
| tokens | 本会话累计 `total.totalTokens` | 同上 |
| 命中率 | 本轮 `cachedInputTokens / inputTokens` | 同上 |
| 5h 额度 | `primary.usedPercent` | `account/rateLimits/read`（全局，一直有）|

颜色：≥65% 变黄、≥85%（额度是 ≥70% / ≥90%）变红，一眼能看出快满。

窄屏自适应：<1100px 隐去文字标签只留数值，<700px 整条隐藏。

### 一个必须说清的限制

**历史对话拿不到用量。** 我查过所有可能的口径：

- `Turn` 没有 usage 字段
- `account/usage/read { threadId }` 在本机返回空对象（SQLite 里没有 per-thread 用量）
- `model/list` 与 `modelProvider/capabilities/read` 都不给上下文窗口大小

用量只存在于两条**实时通知**里（`thread/tokenUsage/updated`、`rawResponse/completed`），也就是只有这个会话在本机跑过至少一轮之后才有数。所以刚打开一个历史会话时，前三个胶囊显示 `—`（悬停有说明），跑起来就会自动填充。

上下文窗口会按模型记在 `localStorage`（`codex-remote-ctx`），下次同一模型开新会话时，第一轮就能直接算出百分比，不用等第二次通知。

## 5.10 会话常驻上游：关页、刷新、断网都不丢

以前每个浏览器 socket 独占一条上游连接，关页就等于把 app-server 那条连接掐了。现在改成**会话级常驻上游**：

- 会话 id 由登录 cookie 派生（`sha256(cookie).slice(0,24)`），所以刷新、关页、锁屏、网络抖动都回到**同一条** app-server 连接
- 浏览器 socket 只是这条会话的**订阅者**；断一个订阅者不影响会话，也不影响里面正在跑的轮次
- 重连时把仍待人工决定的请求（审批卡片）**原样重放**给新订阅者
- 重复的 `initialize` 由桥接**用缓存应答**，不会去重初始化上游（协议不允许）

### 实测（真实任务，非桩）

```
client A: turn/start 后 1.2s 收到 16 条通知，断开
client B: 1.5s 后重连同一会话
        → 又收到 118 条通知（其中 98 条 item/agentMessage/delta）
        → turn/completed，最终 status=completed
```

也就是说断线期间任务在跑，重连后流式输出继续接到新页面上。

### 看门狗：常驻带来的新风险及兜底

常驻的代价是「上游一卡，刷新也救不回来」（同 cookie 同会话）。所以补了两层：

| 机制 | 行为 |
|---|---|
| 看门狗 | 每条客户端请求登记；**20 秒没有应答**就判定上游僵死，拆掉重建 |
| `POST /api/session/reset` | 手动重置该 cookie 的会话，返回 `{ok, found}` |
| 重置动作 | 终止上游 + 关闭订阅者 socket；浏览器自动重连、重新初始化、重跑启动读取 |

实测：`A 正常 → reset(200, found:true) → A 的 socket 被关闭 → B 重连 initialize ok、thread/list 5 条`。

## 5.11 手机上传：三个真实入口 + 微信引导

回形针不再是一个通用选择器，而是一个菜单（桌面端同样走这个菜单）：

| 入口 | `accept` / 属性 | 用途 |
|---|---|---|
| 照片 / 视频 | `image/*,video/*` | iOS 直接进照片图库 |
| 拍照 / 录像 | `image/*,video/*` + `capture=environment` | 直接开相机 |
| 任意文件（微信下载/文件 App） | `*/*` | 走到系统「文件」App，能进微信目录 |
| 从微信取文件…… | — | 打开右侧 Dock 的分平台步骤说明 |

**为什么需要说明页**：微信聊天文件在微信自己的沙盒里，网页（包括微信内置浏览器）**拿不到**——这是平台限制，不是实现问题。所以：

- 内置浏览器检测（UA `MicroMessenger`）→ 顶部提示「点右上角 ⋯ → 在浏览器打开」
- 说明页给出精确路径：iOS 走「存储到文件 → 我的 iPhone/微信」；Android 走「内部存储 → tencent → MicroMsg → Download」

> 理论上能做得更进一步的是 Android PWA 的 `share_target`（从微信「分享」直接进本应用），但它要求 HTTPS + 已安装 PWA，当前是 tailnet 上的 http，所以没做。

## 5.12 顺手修掉的启动崩溃

指标条上线后引入了一个真实 bug：`renderMetrics` 里只判断了「已知上下文窗口」，没判断「本轮用量」——

```js
ctxTotal ? '本次请求占用 ' + fmtTokens(last.totalTokens) ...   // last 可能是 null
```

凡是 localStorage 里**记住过窗口**的浏览器（也就是跑过至少一轮的），一启动就 `TypeError: Cannot read properties of null (reading 'totalTokens')`，`loadQuota` 抛出 → `Promise.all` 全挂 → `loadThreads` 根本不执行 → **侧栏永远空着**。干净浏览器（没有缓存窗口）反而不触发，所以很容易漏。

已修：区分「有窗口无用量」和「两者都有」两种文案。同时给 `onConnected` 的每一步加了 `console.error` 上报，同类问题以后会直接出现在控制台。

## 5.13 移动端布局修复

「手机上侧边栏没了」的根因不是侧栏本身，而是小于 900px 时 `rail` 被 `display: none` 隐藏——顺带把**技能与 MCP / 最近文件 / 用量**的唯一入口也一起藏了。这一轮把整条移动端链路重做了一遍。

| 问题 | 以前 | 现在 |
|---|---|---|
| 导航入口 | 窄屏直接 `display:none`，四个面板无处可达 | **底部标签栏**（首页/技能/最近文件/用量/主题），`52px + safe-area` |
| Dock 宽度 | `width:100vw` 实测右移出屏 **8px** | `left:0; right:0; width:auto`，实测 `x=0 w=390` |
| 发送按钮 | 在横向滚动的 chip 行里，窄屏被**裁出视野** | 移出滚动区，`.composer-line` 里固定右侧，永远可见 |
| 标题栏指标 | 媒体查询只看视口，Dock 一开对话区变窄就**竖排**（「上 下 文」） | 改用 `@container convo`，按对话列宽降级：<820px 去标签，<520px 整条隐藏 |
| 技能/工具行 | 长 id（`app-<uuid>:name`）撑破面板，描述折三行 | 名字与描述各占一行、超长省略；手机上名字一行 + 描述一行 |
| 首页输入框 | 底部留 `16vh`，手机上近 1/5 屏是空的 | 窄屏降到 `5vh` |
| 抽屉 | 层级与遮罩未对齐 | 抽屉 46 / 遮罩 44 / 标签栏 45，点遮罩关闭 |

### 实测数据（390×844）

```
rail        : flex, {x:0, y:792, w:390, h:52}
composer    : {y:669, bottom:792}
overlap     : clear（输入框底边正好贴标签栏顶边，不重叠）
技能/MCP   : dock 390×792, title=技能与 MCP
最近文件    : dock 390×792
用量        : dock 390×792
drawer      : open → 点遮罩 → closed
JS errors   : []
```

iPad 横屏（1180×820）也复测过：导轨恢复竖排 64px、侧栏常驻、Dock 401px 且对话区仍有 423px，标题栏不再竖排。

### 顺带：本地回环不再被登录限流

测试中被「8 次失败 / 5 分钟」挡住（脚本反复登录）。改成 **来自 `127.0.0.1`/`::1` 的登录请求不限流**——本机就是主人，限流只为挡局域网暴力尝试。

## 5.14 思考强度：Codex 风格滑块弹层

原来点「低/中/高」是一个普通菜单列表。现在换成和桌面端一致的弹层：

- 顶部：⚡ 图标 · 当前档位（蓝色加粗）· 重置按钮
- 中间：模型名（点一下切模型）
- 滑块：蓝色已选段带白点、灰色未选段带灰点、白色圆形滑块；下面一排档位文字，当前档高亮
- 键盘可用（方向键）、Esc 关闭、点外部关闭；宽度 <520px 时铺满

档位来自 model.supportedReasoningEfforts，只显示模型真实支持的级别（当前 6 档：低/中/高/极高/最大/极限）。

### 闪电 = Fast 加速档开关

和桌面端一致：弹层左上角那个 ⚡ 本身就是 Fast（priority service tier）开关，输入框下方原来的 `⚡ Fast` chip 已删除。

- 关：灰色描边图标；开：蓝色填充 + 淡蓝底，标题旁出现 `Fast` 徽标
- `aria-pressed` 同步，键盘可操作；切换有 toast 说明「2x speed, increased usage」
- 选择记在 `localStorage`（`codex-remote-fast`），刷新后保持
- 发送时作为 `turn/start` 的 `serviceTier` 传给 app-server（沿用原有链路，未改动）
- 当前模型没有 serviceTiers 时，这个按钮会自动隐藏并把状态归零

实测：

```text
fast chip gone : true
composer chips : [projectBtn, modelBtn, effortBtn]
bolt click     : state.fast=true, aria-pressed=true, Fast 徽标出现
再点一次       : state.fast=false, 徽标消失
```
## 5.15 微信文件：先说做不到的，再说做到的

### 做不到：网页唤起微信「选择聊天文件」

这是平台限制，不是实现问题：

- wx.chooseMessageFile 只能在微信内置浏览器里用，且必须先过 **公众号 AppID + JS-SDK 签名**（后端换 jsapi_ticket），还要求页面在公众号的「JS 接口安全域名」里、域名已备案、走 HTTPS。
- 顺带的坏消息：这台机器所在的 tailnet **不支持签发 TLS 证书**——实测 tailscale serve --https 与 tailscale cert 都返回 "your Tailscale account does not support getting TLS certs"。没有 HTTPS 就没有安全上下文，Android 的 **PWA 分享目标**（从微信「分享 → 保存到本应用」）也一并装不上。

### 做到了：微信文件落到本机后，一键挂载

微信 4.x 把收到的文档**保留原文件名**存在：

```text
%USERPROFILE%\Documents\xwechat_files\<账号>\msg\file\<YYYY-MM>\<原始文件名>
```

（图片进的是哈希命名的 msg\attach\*.dat 缓存，拿不到原名，所以只列文档类。）

桥接新增 GET /api/wechat-files?days=60&limit=60，扫描上述目录（3.x 的 WeChat Files\<账号>\FileStorage\File 也兼容），按修改时间倒序返回。

前端在回形针菜单里加了「**微信收到的文件（本机）**」：列出最近文件，点「挂载」直接把它作为附件塞进下一条消息——**不重新上传**，因为 Codex 的附件本来就是本机路径（localPath / mention），app-server 自己读盘。

实测（390×844，iPhone UA）：

```text
菜单     : 照片/视频 · 拍照/录像 · 任意文件 · 微信收到的文件（本机） · 从微信取文件……
面板     : 「微信收到的文件」1 行
文件     : Codex_Migration_20261031T104701Z(1).zip  52.6 MB · 10/31 19:47 · 微信
点挂载后 : 输入框出现 1 个附件 chip，面板自动关闭，JS 报错 0
```

### 手机上的实际用法（3 步）

1. 手机微信里长按文件 → **转发 → 文件传输助手**
2. 网页点回形针 → **微信收到的文件（本机）**
3. 点 **挂载** → 文件随下一条消息发出

比走系统文件管理器进 tencent/MicroMsg/Download 找文件要快，也不会因为微信重命名或清缓存而找不到。
## 5.17 仅传输文件（网页版）怎么挂载

`szfilehelper.weixin.qq.com` 是**网页版**文件传输助手：文件不经过微信客户端的存储目录，而是走浏览器的下载通道。所以盯 `xwechat_files` 永远看不到它。

### 做法：盯下载目录 + 用浏览器自己的下载记录判定来源

- 桥接新增 `/api/inbox`，把两个来源合并：微信客户端的文档 + 浏览器下载目录（默认 `~/Downloads`、`~/下载`）
- 来源判定读 Edge / Chrome / Brave 的 `History`（**先复制再以只读方式打开**，用内置 `node:sqlite`），查 `downloads` 表 + `downloads_url_chains`，看 referrer / URL 链里是否含 `weixin.qq.com` 或 `szfilehelper`
- 判定为微信来源的文件标记 `origin: weixin`，**自动挂载**；其它下载标记 `origin: other/unknown`，默认不动
- 面板里两行开关：「新收到的微信文件自动挂载」（默认开）、「其他浏览器下载也挂载」（默认关）

### 实测

```text
/api/inbox 分类: 7z2605-x64.exe → download/other（bing 来源）
                 ChatGPT Installer.exe → download/other
                 Codex_Migration_...zip → wechat

门控测试: 未知来源下载 + 开关关 → 0 chips（不打扰）
          打开「其他浏览器下载也挂载」+ 再下载 → 1 chip（自动挂上）
```

### 用法

1. 在 `szfilehelper.weixin.qq.com` 页面里点文件的**下载**
2. 文件落进 `~/Downloads`，4 秒内自动挂到输入框

如果微信页面用的是「另存为」让你选目录，选到 `Downloads` 就行；如果下载后**没有**自动挂上，说明浏览器的下载记录没能把来源判成微信（比如用了 File System Access API 或隐私模式），把面板里第二个开关「其他浏览器下载也挂载」打开即可。

### 边界

- 只认文档类扩展名（pdf/docx/xlsx/zip/md/txt…），图片仍排除（微信客户端里是哈希 `.dat`）
- 浏览器 History 每 15 秒缓存一次；刚下载的文件最多等 15 秒才被判定为微信来源
- History 被浏览器独占时复制可能失败，这时全部按 unknown 处理（需要第二个开关）
## 5.16 微信文件自动挂载

目标：本机微信登录（含「仅传输文件」模式）后，其他设备发给「文件传输助手」的文件，**到达即自动挂到输入框**，不用点任何按钮。

### 实现

- 桥接新增 `GET /api/wechat-watch`（SSE）。启动时先给磁盘上的历史文件打基线，之后每 4 秒扫一次 `msg\file`，按 `path + mtime` 判断新文件并推送 `file` 事件。
- 前端用 `EventSource` 订阅；收到新文件就 `state.attachments.push(...)` + 重绘附件区 + toast，**零上传**（附件本来就是本机路径）。
- 已挂载的文件记在 `localStorage`（`codex-remote-wx-seen`，上限 300 条），刷新页面不会重复挂；同一路径已在输入框里也会跳过。
- 面板里有「新收到的文件自动挂载」开关（`codex-remote-wx-auto`），默认开。

### 实测

在真实微信目录 `xwechat_files\wxid_...\msg\file\2026-11\` 落一个文件模拟手机转发：

```text
before : 0 chips
dropped: 自动挂载测试_报告.txt
after  : 1 chip  → 自动挂载测试_报告.txt  70 B
console: wechat watcher connected
```

页面没有任何点击操作，chip 自己出现。

### 为什么「其他账号（仅传输文件）」发的文件不出现

实测结论：**微信没把它写到磁盘**。

- 全盘只有 `wxid_t488viizdxam22_d018` 一个账号目录（另一个账号登录后并没有生成新的 `wxid_*` 目录）
- `msg\file` 里仍然只有 10/31 那个 zip
- 最近 45 分钟用户目录里唯一的文档就是那张 jpg（在 `temp\RWTemp`）

微信在文件是「未下载」状态时只留消息记录、不落盘，于是扫描器看不到。对策：

1. 在电脑版微信里**点开那个文件一次**，它才开始下载到 `msg\file`，随后 4 秒内自动挂载
2. 或者把微信设置里的「自动下载」打开

扫描器本身已经放宽：不再只看 `msg\file`，而是遍历整个账号目录（排除 db/cache/temp 等），按扩展名白名单收文档，深度 5 层；面板上有「刷新」和「扫描 N 个账号目录 · M 个文档」的诊断行，空列表时还会直接提示「未下载的文件不会落盘」。
### 行为边界

- **实时**：文件落地后 4 秒内挂上。
- **不补挂历史**：桥接启动时已在磁盘上的文件只做基线，不会开机刷出一堆旧文件；它们仍在「微信收到的文件」列表里可手动挂载。
- **图片不进列表**：微信把图片存成哈希命名的 `msg\attach\*.dat`，拿不到原名，所以只处理文档类（pdf/zip/docx/xlsx/txt 等）。
- 关掉网页期间到达的文件不会在重开后自动挂，需要开页后再发一次，或在列表里手动挂。
## 5.18 微信文件传输：扫码登录接进网页

微信「仅传输文件」窗口是一个网页应用 `szfilehelper.weixin.qq.com`，它的会话只在**页面内存**里，而且登录二维码图片接口对普通 HTTP 客户端返回 0 字节（风控）。所以桥接的做法是：

- 维护一个**专用调试窗口**（独立配置 `%LOCALAPPDATA%\codex-remote-webtransfer`，端口 9333）
- 通过 CDP 把窗口里的二维码**截成 PNG**，由 `GET /api/wechat/qr` 交给我们的网页显示
- `GET /api/wechat/state` 报登录态与账号名；`POST /api/wechat/reset` 换一张新码（切换账号）
- `GET /api/wechat/messages` 从页面 DOM 解析文件消息（`a.msg-file` / `.msg-file__title` / `.msg-file__desc`）
- `POST /api/wechat/download {index}` 用 CDP 派发**可信鼠标事件**点击 `a.icon__download`

面板入口：回形针 → **微信文件传输（扫码登录）**。未登录显示二维码（每 4 秒刷新），登录后显示账号名 + 文件消息列表 + 「下载并挂载」+「切换账号」。

### 协议（抓包所得，供后续做纯服务端实现）

```text
GET  login.wx2.qq.com/jslogin?appid=wx_webfilehelper  → window.QRLogin.uuid
GET  login.wx2.qq.com/cgi-bin/mmwebwx-bin/login?...   → window.code=200 + redirect_uri
GET  .../webwxnewloginpage?ticket=&uuid=              → skey / wxsid / wxuin / pass_ticket
POST .../webwxinit   {BaseRequest:{Uin,Sid,Skey,DeviceID}}
GET  .../synccheck   → 长轮询
POST .../webwxsync   → AddMsgList[]；文件消息 MsgType=49，
     Content 里是 XML：<title>文件名</title><totallen>字节</totallen><attachid>@cdn_…</attachid>
GET  file.wx2.qq.com/cgi-bin/mmwebwx-bin/webwxgetmedia → 加密字节（页面负责解密）
```

### 当前状态与已知问题

已验证：扫码 → 登录 → 网页显示账号名 → 列出文件消息（实测 `中国国有企业改革…pptx / 59.74MB`）→ 点击触发 `webwxgetmedia` 请求。

未完成：页面在点击后进入 `progress` 状态且长时间不落盘（`fetch → 解密 → blob → 保存`，所以没有 `.crdownload` 可观察）。需要确认是页面自身在该状态下卡住，还是合成点击的问题；备选方案是解析 `MsgId`+`attachid` 后**在服务端下载并解密**，绕开页面。
## 5.19 微信文件传输：全链路已跑通

**入口**：回形针 → **微信文件传输（扫码登录）**。

| 环节 | 实现 |
|---|---|
| 扫码登录 | 桥接维护一个专用调试窗口（独立配置，端口 9333），把窗口里的二维码**截成 PNG** 给网页显示（微信的图片接口对普通 HTTP 客户端返回 0 字节） |
| 切换账号 | 面板「切换账号」→ `POST /api/wechat/reset` 让窗口回到新二维码 |
| 列文件 | `GET /api/wechat/messages` 解析页面 DOM（`.msg-file__title` / `.msg-file__desc`） |
| 触发下载 | `POST /api/wechat/download {index}` 用 CDP 派发**可信鼠标事件**点 `a.icon__download` |
| 挂载 | 文件落到 `~/Downloads` → inbox 监听按浏览器下载记录识别来源 `weixin` → SSE 推送 → 自动挂到输入框 |

**实测（390×844）**

```
[12s] Downloads 出现 中国国有企业改革…(7).pptx
[27s] 输入框出现 chip：中国国有企业改革_30分钟_35页… 59.7 MB
      toast：下载完成 中国国有企业改革…(7).pptx，已自动挂载
```

### 过程中修掉的两个真 bug

1. **来源判定漏了专用窗口**：`downloadOrigins()` 只读默认 Edge 配置的 `History`，而从调试窗口触发的下载记在 `%LOCALAPPDATA%\codex-remote-webtransfer\Default\History`。加上这个 profile 后，所有微信窗口下载都被正确标成 `weixin`。
2. **`unknown` 被当成已处理**：文件刚落盘时浏览器还没写下载记录，来源是 `unknown`；监听第一次看到就标记为已处理，之后来源变成 `weixin` 也不会再广播。改成「来源 unknown 时不标记，下一轮再看」。
3. **source 名字不一致**：桥接广播 `source: 'weixin'`，客户端只认 `'wechat'`/`'download'`，策略直接返回 false。两边统一。

### 说明

- 大文件（60MB）在页面里下载约需 2~3 分钟，期间行内图标显示进度；没有 `.crdownload` 可观察（页面是 fetch → 解密 → blob → 保存）
- 服务端直接下载+解密（`bridge/wechat-fetch.mjs`）已写好但**默认关闭**（`config.json` 里 `wechatServerFetch: true` 可启用）：CDN 对跨域 fetch 返回 CORS 错误或 0 字节，目前只有页面这条路可用
- 那个调试窗口**不能关**（会话只在内存里），最小化即可
## 5.20 附件真的被读到了 + 两处渲染修复

### 问题一：附件只发了个路径，agent 读的是当前目录

现象：消息里能看到文件名，但 agent 去 `ls` 当前目录、总结的是目录里的东西。

原因：`mention` 传的是**工作区之外的绝对路径**（`C:\Users\...\Downloads\xxx.pdf`），模型只把它当成一个名字。

修复：发送前通过 `POST /api/attach/import` 把文件**复制进当前会话的 cwd**（`.attachments/<name>`，重名自动加序号），然后：

- `mention` 的 `name` 用**相对路径**（`.attachments/xxx.pdf`）
- 文本里再补一行 `@.attachments/xxx.pdf`，双保险

关键点：cwd 必须取**当前会话的** `thread.cwd`（`state.currentCwd`），不能用 `defaultCwd`——两者经常不同，用错就会复制到别的项目里。

实测：

```
mention name = .attachments/Zhang+等+-+2025+-+JailGuard+….compare-1.pdf
path         = <workspace>/….attachments/…-1.pdf
agent 回答    = 该文研究大语言模型及多模态大语言模型中的文本和图像越狱攻击检测问题…
```

### 问题二：命令卡片的「退出码」竖排成一列

`.status-pill` 是 flex 子项，默认会被压缩；`.step-sub`（命令文本）没有 `flex-shrink` 限制，把 pill 挤到接近 0 宽，中文逐字换行就竖过来了。

修复：`.status-pill { flex: none; white-space: nowrap }`、`.step-title { flex: none }`、`.step-sub { flex: 1 1 auto; min-width: 0 }`。

### 问题三：`:codex-file-citation{…}` 原样显示

模型输出里的来源标记被当成普通文本渲染。现在 `md()` 会把它换成「（来源：文件名）」。
## 5.21 context-mode：网页端与本地 Codex 都真正生效

### 做了什么（四个缺一不可）

| 步骤 | 内容 | 为什么 |
|---|---|---|
| 1. 打开 hooks 特性 | `~/.codex/config.toml` 里加 `[features] plugin_hooks = true` / `hooks = true` | 不打开，插件 hooks 一律不执行 |
| 2. 升级插件 | 1.0.169 → **2.0.0**（从本地 marketplace 目录换成 npm 2.0.0 包，零依赖） | v2 修了 Codex 适配，且不再需要 36 MB 的 node_modules |
| 3. 修 v2 清单 | `mcp.json` 里 `node` 与 `server.mjs` 改**绝对路径**、`cwd` 固定 `<workspace>` | Codex 不把会话 cwd 传给 MCP，`./server.mjs` 会解析到错误目录导致握手失败 |
| 4. 建立可信 hooks | `context-mode setup --agents codex -y`（`CM_HOOK_OVERHEAD_BUDGET_MS=150`） | 插件自带 hooks 的哈希与旧信任记录对不上 → Codex 视为 untrusted、不执行 |

### 第 4 步的坑

setup 默认要求 hook 开销 p95 ≤ 15 ms，Windows 上 node 冷启动就 20 ms，会被回滚（`hook overhead p95 20 ms > 15 ms (rolled back)`）。
用 `CM_HOOK_OVERHEAD_BUDGET_MS=150` 放宽后 PASS。

setup 生成/修改：`~/.codex/hooks.json`（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse）、
`config.toml` 的 `[mcp_servers.context-mode]` 与四条 `[hooks.state."...hooks.json:..."]` 信任记录、以及三个技能 `ctx-doctor` / `ctx-stats` / `ctx-upgrade`。

### 让模型真的去用它

`~/.codex/AGENTS.md` 增加了一节规则（大文件/日志用 `ctx_execute`、多命令用 `ctx_batch`、反复查先 `ctx_index`、被拒不要重试）。
全局文件，桌面端与网页端共用。

### 实测

网页会话（390×844，cwd=<workspace>）：

```text
问题：统计 314KB 日志里 status=500 的数量 + 前 3 个 route
command items: 0        ← 一条 shell 都没走
mcp calls    : 5        ← ctx_resume, ctx_execute ×3, ctx_doctor
答案         : 572      ← 正确，且在本地算完
hook runs    : 12
enforcement  : deny-reason（D10 PASS）
```

本地 CLI（同一套配置）：`codex exec --cd <workspace> ...` 同样返回 `572`，`ctx_stats` 里 `By agent: codex` 计数随之增加。

### 仍然存在的两条 warning（不影响使用）

- `D3/D5`：`ctx_doctor` 报「plugin hooks untrusted」——实际生效的是 setup 写入的**全局 hooks.json**（已验证 pre-tool-use 在跑、拦截模式 deny-reason），插件自带那份没被信任只是冗余。
- `D11`：没装 Git Bash。`ctx_execute` 用 `powershell` / `javascript` 都正常，装 Git for Windows 可以消除这条提示。
## 5.22 QGIS MCP 端到端：上传 → 处理 → 返回文件

测试用例：上传 5 个点的 GeoJSON → 让 agent 用 QGIS MCP 做 10 km 缓冲区 → 返回 GeoJSON。

### 结果

```text
upload    /api/upload  -> %TEMP%\codex-remote\mw2gjmn7-points.geojson
import    /api/attach/import -> <工作区>\.attachments\mw2gjmn7-points.geojson
agent 调用 qgis MCP 7 次：
  add_vector_layer    -> 5 features
  get_algorithm_help  -> native:buffer
  get_layer_extent    -> 117.16..117.3 / 31.79..31.9
  execute_processing  -> native:reprojectlayer (EPSG:4326 → EPSG:32650)
  execute_processing  -> native:buffer (10 km)
  export_layer        -> buffer.geojson（30,330 字节）
  add_vector_layer    -> 复核 5 features
耗时 39 秒，输出 5 个 MultiPolygon，EPSG:4326
```

文件在网页端可直接预览（右侧 dock）并下载（`/api/file?path=…&download=1`），点开后也会进入「最近文件」。

### 修掉的三个问题

| # | 问题 | 原因 | 修复 |
|---|---|---|---|
| 1 | 任务卡住不动，5 分钟没有任何 qgis 调用 | MCP 工具调用要审批，客户端没应答 → 一直等 | `[mcp_servers.qgis]` 加 `default_tools_approval_mode = "approve"` |
| 2 | `qgis/add_vector_layer -> failed: user rejected MCP tool call` | 网页端把 elicitation 当普通审批，回 `{decision}`；MCP 要 `{action, content, _meta}` | `app.js` 的审批卡片按方法分支；elicitation 回 `{action:"accept"\|"decline", content, _meta}`，标题/正文/按钮也改成 MCP 专用 |
| 3 | 返回的 `.geojson` 只能下载、不能预览 | 桥接 MIME 表没有地理格式 | 补 `.geojson/.topojson/.gpx/.kml/.csv`，并把它们加进前端的文本预览列表 |

### 排查经验

- **QGIS MCP 只是代理**：真正干活的是 `localhost:9876` 上的 QGIS 实例（本次为 QGIS 3.44.15，插件监听）。
  判断 server 是否健康，别用 `mcpServerStatus/list + threadId`（会卡 >180 s），直接用 stdio 起 server 走一遍 MCP 握手（`tools/qgis-stdio-probe.mjs`）：initialize 2 s、125 个工具、单次调用 35 ms 即为正常。
- 有 tool call 在等审批时，桥接日志里能看到 `pending request item/commandExecution/requestApproval id=…` 且没有对应的 `answered`。
- QGIS 打开过的目录会被占用，测试目录要每次换新（`EPERM` 就是它）。

### 已知限制

「最近文件」只记录**你打开过的**文件；agent 新生成的文件要等你点一次它的链接才会进列表。
## 5.23 审批方式选择器（对齐 Codex 三档）

composer 里新增一枚盾牌 chip（默认「请求批准」），点开是三档，与 Codex 桌面端一一对应：

| 档位 | approvalPolicy | approvalsReviewer | sandboxPolicy | 实测行为 |
|---|---|---|---|---|
| 请求批准 | `on-request` | `user` | `workspaceWrite`，roots=[会话 cwd]，`networkAccess:false` | 写工作区外文件 → **弹出审批卡片** |
| 帮我批准 | `on-request` | `auto_review` | 同上 | 同样的写入 → **自动审查放行，不打扰用户** |
| 完全访问 | `never` | `user` | `dangerFullAccess` | 同样的写入 → 直接成功，无审批 |

选择存在 `localStorage['codex-remote-access']`，切到「完全访问」时 chip 变红并弹提示。
发送时同时作用于 `thread/start`（`approvalPolicy` / `approvalsReviewer` / `sandbox`）和 `turn/start`（`approvalPolicy` / `approvalsReviewer` / `sandboxPolicy`），所以老会话改档也立即生效。

### 踩到的坑

`SandboxPolicy.workspaceWrite.networkAccess` 是 **boolean**，不是 `"restricted"` 字符串：
写成字符串会让 `turn/start` 直接报 `Invalid request: invalid type: string "restricted", expected a boolean`，
也就是「请求批准 / 帮我批准」两档完全发不出去。`NetworkAccess` 枚举只用于 `externalSandbox`。

另外：chip 的事件绑定最初被我放进了 `wireModePop()`（只有打开思考弹层才执行），导致点击无反应；已移到启动绑定段。
## 5.24 选择器收放、重复发送、网络面板

### 修掉的两个问题

| 问题 | 原因 | 修复 |
|---|---|---|
| 模型 / 项目 / 思考 chip 点第二下收不回去（只能点空白处关） | `openMenu()` 每次都先 `closeMenu()` 再重新展开，没有 toggle | 记录 `menuAnchorEl`，同 chip 第二次点击直接关闭 |
| 连点两次发送会开两个会话 / 跑两轮 | `send()` 只在 `state.busy` 为真时返回，而 `busy` 要等 `loadQuota` / `thread/start` 之后才置位 | 入口处立刻置 `state.sending`，`finally` 复位；真正的发送体拆到 `_send()` |

实测：三个 chip 都是 `closed-on-second-click=true`；并发调用两次 `app.send()` 只发出 1 个 `thread/start` + 1 个 `turn/start`。

### 网络面板（导航栏第 5 项 · 地球图标）

桥接新增三个接口，全部走 Clash 的外部控制器（默认 `http://127.0.0.1:9097`）：

| 接口 | 作用 |
|---|---|
| `GET /api/clash` | 模式、混合端口、4 个策略组及其节点（含上次测速延迟） |
| `POST /api/clash/select` `{group,node}` | 切换指定策略组的节点 |
| `POST /api/clash/test` `{group?,node?}` | 节点延迟（`/proxies/{name}/delay`）+ **Codex 连通性**（新建 app-server 连接跑 `account/rateLimits/read`，返回毫秒数、已用额度或失败原因） |

面板内容：模式/端口/组数 → 策略组 tab（GLOBAL / 故障转移 / 自动选择 / 良心云）→ 当前节点 → 节点列表（延迟按 <300 / <800 / 更慢着色，`0` 视为未知显示 `—`）→ 测试按钮。

实测一轮（节点 🇯🇵日本高速04）：

```text
节点延迟：141ms
Codex：连通 · 834ms
```

同一分钟里换到被墙的节点会变成 `Codex：失败（failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)）`，这正是这个面板要暴露的信息。

切换验证：`良心云` 组 🇯🇵日本高速04 → 🇸🇬新加坡高速01（`ok:true`）→ 再切回 🇯🇵日本高速04，`matches original: true`。

### 移动端适配

- 底部 tab 现在是 6 项（首页 / 技能 / 文件 / 用量 / 网络 / 主题），390px 宽度下仍是一行。
- 面板：节点列表限高 `34vh` 独立滚动，行内文字省略号截断，测试按钮整宽。
### 为什么「网页里切的节点和 Clash Verge 显示的不一样」

一度以为面板连到了别的 Clash，实际排查结论：**确实是本机同一个核心**——只有 `127.0.0.1:9097` 一个控制器在线（9090/9091/9099/6170 全部 ECONNREFUSED），`/configs` 显示 `mode: rule`、`mixed-port: 7897`、`tun: true`。

真正的原因是**切错了组**：面板默认落在 `GLOBAL`，而规则模式下 `GLOBAL` 不参与路由。
`/connections` 里真实流量走的是：

```text
26x  DIRECT
 8x  良心云 > 🇯🇵日本高速04|BGP|CUCM
 4x  良心云 > 🇸🇬新加坡高速01|BGP|CTCUCM
```

所以在 GLOBAL 里改节点，Clash Verge 当然「看起来没变」。

修复后 `/api/clash` 会带回 `liveChains` / `inUse` / `defaultGroup`：

- 面板**默认打开实际在用的组**（当前为 `良心云 ·在用`）
- 顶部列出「当前生效链路」，直接显示 组 → 节点（N 条连接）
- 规则模式下 `GLOBAL` 标为虚线 idle，点开会提示「GLOBAL 不会影响实际流量，实际生效的是：良心云」
- 嵌套组（`自动选择` / `故障转移`）带 `›` 可下钻，`剩余流量 / 套餐到期` 这类订阅信息行置灰不可点
- 「重新读取」按钮刷新状态与实时链路
- 切换提示改为「已切换到 X（新连接生效，旧连接保持原节点）」，避免误以为立刻全量生效
### 顺手修的安全问题（重要）

排查节点问题时发现：除了 `/healthz`、`/api/me`、`/api/login`、`/api/logout`，**其余 API 全都没有鉴权**，
局域网 / Tailscale 内任何设备不带密码就能调用：

```
/api/session/reset     杀掉上游会话
/api/wechat/download   触发下载并落盘
/api/wechat/qr         拿登录二维码
/api/inbox             读微信消息
/api/clash/select      改你的代理节点
/api/attach/import     把任意文件复制进工作区
```

现在全部走 `requireAuth()`，未登录一律 401；登录后功能不变。实测：

```
/api/projects -> 401   /api/clash -> 401   /api/wechat/state -> 401
/api/inbox    -> 401   /api/wechat-files -> 401
（带 cookie 后全部 200）
```
### 简化后的网络面板 + 一键切换

面板只剩一屏：

```text
良心云 · rule · 44 个节点
当前节点  🇯🇵日本专线01|BGP|流媒体
[ 一键切换（Codex 最快） ]  [ 刷新 ]
已切到 🇯🇵日本专线01|BGP|流媒体（Codex 726ms）
🇯🇵日本专线01|BGP|流媒体   59ms   Codex 726ms   [测]
🇸🇬新加坡专线03|BGP|流媒体 100ms   Codex 1062ms  [测]
…
```

- **只列当前在用组**的节点（`defaultGroup` 来自实时连接），不再有 GLOBAL / 其它组的 tab。
- 每行：Clash 延迟 + **Codex 实测**（未测 / 连通 xxx ms / 失败）+ 单行「测」按钮。
- 列表按 Codex 实测延迟升序排，未测的排在后面按 Clash 延迟排。

### 一键切换怎么测的

`POST /api/clash/autopick` 起一个后台任务：

1. 取在用组里 Clash 延迟最低的 N 个真实节点（默认 8，上限 20；跳过嵌套组和「剩余流量」这类订阅信息行）
2. 逐个：切到该节点 → 等 700ms → 用新建的 app-server 连接跑 `account/rateLimits/read` 测真实 Codex 延迟
3. 全部测完，切到 Codex 最快的那个；**一个都不通就恢复原节点**
4. 结果缓存在前端 `netState.codex`，行内直接显示

前端轮询 `GET /api/clash/autopick?id=`，按钮实时显示 `测速中 3/8…`。

实测：8 个节点约 25 秒，选出 `🇯🇵日本专线01（Codex 726ms）` 并自动切换，弹 toast 确认。

> 注意：测速过程会真的在节点之间来回切，正在使用的连接会受影响；旧连接保持原节点，新连接才走新节点。

### 同一轮里修掉的 bug

轮询函数里把清理逻辑写在了 `finally`，导致**第一次轮询就清空任务状态**、按钮立刻复原（表现为点了一键切换没反应）。改为只在任务真正结束时清理。
### 模型选择并入强度 chip

输入框那排从 4 枚 chip 变成 3 枚：

```
Remote | GPT-6.1-Sol · 低 | 请求批准
```

- `#modelBtn` 删除，`#effortBtn` 变成合并 chip（`#modelLabel` + `·` + `#effortLabel`），点开就是原来的强度弹层。
- 弹层里的「GPT-6.1-Sol ›」那一行仍然可以换模型，换完合并 chip 立刻更新（实测 `GPT-6.1-Sol·低 → GPT-6-Astra·低`）。
- `title` 提示同时给出模型与强度全文。

**顺手修的两个 bug：**

1. **在弹层里点模型，菜单一闪就消失**。根因是全局 `click` 监听「非 `.chip` 的点击就关菜单」，而 `#modeModel` 不是 chip，于是同一次点击既打开又立刻关闭。现在把 `.mode-model` 排除。
2. **菜单飘到屏幕左上角**。原来锚定 `#modeModel`，而它在关掉的弹层里（尺寸为 0）。改为锚定合并 chip。

移动端：≤430px 时 chip 缩到 10.5px 字号、合并 chip 上限 44vw；≤380px 时项目 chip 只留文件夹图标。实测 360/390/430px 三档 `scrollWidth == width`，三个 chip 全部露出，回形针与发送按钮不再被压到。
## 5.25 全节点测速 · 自动切换 · 二维码 · 文件预览

### 一键测速改成测「所有节点」

原来的 `limit=8` 只测 Clash 延迟最低的 8 个；现在默认测整组（`limit` 省略或 0 = 全部）。

速度靠两步优化：

1. **复用一条 app-server 连接**做 Codex 探测。原来每个节点都新建连接、重跑 `initialize`（1-2 秒），现在握手一次，之后每个节点只发 `account/rateLimits/read`。
2. **先用 Clash 自己的 `/proxies/{node}/delay` 并行预筛**（8 并发、不切换），把连不通的节点剔掉再串行实测。死节点每个要等满超时，这一步省掉一大半时间。

实测（48 个节点的组）：44 个真实节点 → 预筛剩 30 个 → 串行实测 **105 秒**，全部测完。
结果里会写明「测了 N 个节点，跳过 M 个不通节点」。

### 自动切换守护

面板里新增开关：**自动切换（断线时选 Codex 最快节点）**。

- 每 180 秒用共享连接探一次 Codex；正常就记一笔 `最近检查正常 1180ms（节点名）`。
- 探测失败才触发全节点扫描，切到最快节点；一个都不通就保持原样。
- 开关状态存 `bridge/autoswitch.json`，重启桥接后自动恢复。

接口：`GET/POST /api/clash/autoswitch`（`{enabled, intervalSec}`，间隔 30-3600 秒）。

### 微信二维码「显示不稳定」

根因有两个，都不是网络问题：

1. **每次取二维码要 10-25 秒**。原实现是 `Page.captureScreenshot` 截后台 Edge 窗口，后台窗口合成被节流。现在改成：页内读出二维码 `<img>` 的 URL（约 10ms）→ **Node 直接下载该 URL**（带浏览器 UA/Referer，约 200ms）。截图只作兜底，并先开 `Emulation.setFocusEmulationEnabled` 解节流。
2. **前端每 4 秒重建 `<img>`** 并带 `?t=时间戳`，等于反复重新下载 → 看着就是闪。现在登录态不变时不重建 DOM。

实测：`24 852ms → 305 / 154 / 150 / 176ms`；连续 6 秒轮询，`<img src>` 完全不变。

### 文件预览补全 + 保存图标

| 类型 | 预览方式 |
|---|---|
| 图片 png/jpg/gif/webp/avif/bmp/svg | `<img>` |
| **PDF** | 浏览器原生 PDF 查看器（`<iframe src=… #view=FitH>`，支持翻页、缩放） |
| **Word / Excel / PowerPoint**（docx/xlsx/pptx，含 odt/ods/odp/rtf） | 服务端解 zip 抽 XML 文本（不依赖 LibreOffice），带「第 N 页」分页与页数提示 |
| 音视频 mp4/webm/mov/m4v · mp3/wav/m4a/ogg/flac/aac | `<video>` / `<audio>` |
| 文本/代码/md/html/json/geojson/gpx/kml | 现有预览 + 源码切换 |
| 其它（zip 等） | 文件卡片：文件名、扩展名、说明 + 保存按钮 |

新增接口 `GET /api/office-text?path=`：docx 取 `word/document.xml`、pptx 按 `slideN.xml` 分页、
xlsx 取 sharedStrings + 第一张工作表，正文截断到 4 万字符。实测那份 35 页 pptx：`ok, slides: 35, 4786 chars`。

右上角的「下载」文字按钮换成了**保存图标**（`#i-save`，向下箭头 + 托盘），`aria-label="保存到本机"`。
### 五个收尾修正

**1. 前端还在传 `limit: 8`**
服务端默认已是「全部节点」，但 `runAutopick()` 里写死了 `limit: 8`，把默认值覆盖了。已删掉，按钮文案也改成「一键测速并切换（全组节点）」。

**2. 自动切换的实战验证**
手工切到被墙的 `🇭🇰香港高速01`，再打开开关：

```text
3s    last={node:香港高速01, ok:false, ms:2665, error:…403 Forbidden}
96s   switch={from:香港高速01, to:🇸🇬新加坡专线03, ms:800}
final node: 🇸🇬新加坡专线03 | codex on final node: 812ms   ← 恢复成功
```

**3. 错误信息里塞了整页 HTML**
Codex 的 403 会把 chatgpt.com 的 HTML 错误页带进 `error` 字段（约 15 KB），整个塞进 API 响应和 tooltip。
新增 `shortErr()`，压到 181 字符以内。

**4. Office 预览在手机上**
390px 下 docx 正文、xlsx 表格（制表符分列，列能对齐）、保存图标都正常，`codeWidth 337 / panelH 741`。

**5. 预览接口补测**
docx：标题 + 两段正文 + 表格单元格（`姓名	分数` / `张三	95`）全部抽出，11 ms；
xlsx：`月份 销量 备注 / 1月 120 开门红 / 2月 98 春节`，5 ms。
## 5.26 文件名 / 保存 / 发到微信

### 文件名与保存名的问题（已修）

三个地方都用了整条路径：

| 位置 | 原来 | 现在 |
|---|---|---|
| 会话里的路径 chip | 显示 `<workspace>\qgis-run-…\.attachments\mw2gjmn7-points.geojson` | 显示 `mw2gjmn7-points.geojson`，完整路径留在 tooltip |
| dock 标题 | 整条路径 | `buffer.geojson` |
| `<a download>` | `download="<workspace>\…\buffer.geojson"` → 浏览器消毒成 `C__CHAT_…` | `download="buffer.geojson"` |

新增 `baseName()`，chip / 标题 / 下载名统一用它；服务端 `content-disposition` 本来就用 basename，所以直链下载也一直是对的。

### 发到微信

dock 右上角现在有两个图标：**发送到微信**（气泡）和 **保存**（下箭头）。

```
POST /api/wechat/send { path }
  -> { ok: true, name, how: "input" | "chooser", ms }
  -> { ok: false, error: "需要先在「微信文件传输」里扫码登录" }
```

实现（`wechat-web.mjs` 的 `sendFile()`）：

1. 先确认页面已登录（没有输入框/消息列表就直接返回 `not-logged-in`）。
2. 页面里已有 `input[type=file]` 就 `DOM.setFileInputFiles` 直接塞进去。
3. 否则 `Page.setInterceptFileChooserDialog` 拦截文件选择器，按文本/类名挑最像「上传」的按钮点一下，
   等 `Page.fileChooserOpened` 拿到 `backendNodeId` 再塞文件。
4. 之后轮询页面文本，直到文件名出现，才算发送成功（最多等 20 秒，超时标记 `unconfirmed`）。

「微信文件传输」面板顶部新增开关 **在会话里保存文件后，自动发到微信**（存 `localStorage["codex-remote-wx-autosend"]`）。
打开后，dock 里点保存会同时推一份到文件传输助手，手机微信立刻能收到。

发送失败且原因是未登录时，会自动弹出扫码面板，不用自己找入口。

> 限制：网页版文件传输助手要求先扫码登录（内存态，重开窗口就要重扫）；单文件上限 200MB。
### 结果文件点不开 / 存下来没扩展名（已修）

模型输出的是 CommonMark 的尖括号链接（路径里有 `(1)` 这类括号时必须这么写）：

```md
[打开优化版 PPTX](<C:/…/Codex_Migration_20261031T104701Z(1)/…/中国国有企业改革_前三页优化版.pptx>)
```

三个连环 bug：

| # | 问题 | 后果 |
|---|---|---|
| 1 | `inlineMd()` **先 escapeHtml 再解析链接**，`<` 已变成 `&lt;`，尖括号正则永不命中 | 退回普通正则，`[^)\s]+` 在路径里的 `(1)` 处截断 → 路径残缺 |
| 2 | 残缺路径以 `<C:` 开头，`path.resolve` 当相对路径处理 | 拼成 `…\codex-remote\bridge\<C:\…` → `ENOENT`（就是截图里那条报错） |
| 3 | dock 的 `download` 取的是 chip 文字 | 存成「打开优化版 PPTX」，没有扩展名，双击打不开 |

修复：

- 链接正则同时接受 `<…>` 与 `&lt;…&gt;` 两种形式，并把捕获到的目标反转义后再用；
- 普通链接正则加 `(?!&lt;|<)` 负向前瞻，避免把尖括号目标当普通链接再切一刀；
- `openFilePanel()` 入口统一清洗目标（去 `<>`/引号、`file://`、`&lt;` 实体）；
- dock 标题与保存名**一律用真实文件名**（`baseName(target)`），chip 文字只当展示用。

实测（就是坏掉的那条消息）：

```text
chip 打开优化版 PPTX -> title 完整 .pptx 路径
dock 标题  中国国有企业改革_前三页优化版.pptx
预览       文本预览（35 页幻灯片），4931 字符
保存       download=中国国有企业改革_前三页优化版.pptx
           GET /api/file?…&download=1 -> 200, 62,639,777 B, 正确 MIME + UTF-8 文件名
```

同一条消息里的 `查看三页预览`（.jpg）也正常走图片预览。

### 「挂载」和「保存」是一套路径吗

不是同一套，但都落在本机同一个文件上：

| 动作 | 链路 |
|---|---|
| 上传/微信挂载 | `/api/upload` → `%TEMP%\codex-remote\…` → `/api/attach/import` → `<工作区>\.attachments\<文件名>` → 作为 `mention` 交给模型 |
| 结果文件保存 | 消息里链接的**原始路径**（如 `outputs/xxx.pptx`）→ `/api/file?path=…&download=1` |

所以「挂载」负责把文件送进工作区给模型读，「保存」负责把结果取回本机；
这次的问题全在保存/预览一侧的路径解析，与挂载无关。
### Office 文件现在渲染真实排版（PPT / Word / Excel → PDF）

之前 pptx/xlsx/docx 只做「解 zip 抽文本」，能看到字但看不到版式 —— 用户看到的就是「没有实际内容」。
这台机器没装 LibreOffice，但 **Office 的 COM 服务是注册过的**，所以直接用 PowerPoint / Word / Excel 导出 PDF。

新增 `GET /api/office-pdf?path=…`（另有 `&probe=1` 只做转换并返回 JSON）：

```text
pptx/ppt/ppsx/odp  -> PowerPoint  Presentation.SaveAs(dst, 32)   # ppSaveAsPDF
docx/doc/rtf/odt   -> Word        Document.SaveAs(dst, 17)       # wdFormatPDF
xlsx/xls/ods       -> Excel       Workbook.ExportAsFixedFormat(0, dst)
```

要点：

- 转换脚本 `bridge/office-to-pdf.ps1`，桥接用 `powershell.exe -NoProfile -File` 调它；
- **串行队列**：Office COM 是单实例，并发打开会互相打架；
- **按 路径+大小+mtime 缓存**到 `%TEMP%\codex-remote-office\<hash>.pdf`，二次打开 60ms 级；
- 前端先 `&probe=1` 触发转换（首次 3-15 秒，显示「正在转成 PDF…」），成功后把 iframe 指向 PDF；
- 转换失败时**自动退回文本抽取**，不会白屏。

实测：

| 文件 | 首次 | 缓存 | 产物 |
|---|---|---|---|
| 35 页 pptx（61 MB） | 14.4 s | 67 ms | 10.4 MB PDF，封面版式完整 |
| test.docx | 3.1 s | 12 ms | 80 KB PDF |
| test.xlsx | 3.4 s | 12 ms | 29 KB PDF |

PDF 仍然走浏览器原生查看器（可翻页/缩放），手机上的 dock 同样铺满。

> 已知限制：iOS Safari 的内联 PDF 只显示第一页，需要翻页时用保存按钮导出后用系统「文件」打开；Android Chrome 正常。
### 移动端看不了 PDF/Office —— 改成逐页图片

桌面端把 PDF 塞进 `<iframe>` 能看，但 **手机浏览器根本不内联渲染 PDF**：
Android Chrome 直接显示一个「PDF / 打开」的下载卡片，iOS Safari 只给第一页。
这是浏览器行为，不是我们的 bug，所以换方案：**服务端把每页渲染成 JPEG，前端当图片流滚动**。

链路：

```text
pdf              ──┐
pptx/docx/xlsx   ──┴─> Office COM 转 PDF（缓存）─> PyMuPDF 逐页转 JPEG（缓存）─> <img> 列表
```

接口：

| 接口 | 作用 |
|---|---|
| `GET /api/office-images?path=` | 返回 `{ok, count, pages:[url…]}`，首次触发转换+光栅化 |
| `GET /api/office-page?k=<key>&i=<n>` | 返回第 n 页 JPEG（`cache-control: max-age=86400`） |

细节：

- 光栅化用 `bridge/pdf-to-images.py`（PyMuPDF），按页宽 1400px、JPEG q82，一页约 100-180KB；
- 缓存键是 `路径+大小+mtime` 的 sha1，第二次打开 4ms 返回页数，图片走浏览器缓存；
- 转 PDF 和光栅化各自串行排队（Office COM 单实例、CPU 密集）；
- 前端 `loading="lazy"`，只有前两页 eager，长文档不会一次拉完；
- 每页右下角有 `n / 总数` 角标。

实测（移动视口 390×844）：

| 文件 | 页数 | 首屏 |
|---|---|---|
| 35 页 pptx | 35 页 | 1.2s 出现图片，页图 1440×810 |
| 12 页 PDF | 12 页 | 1400×906 |
| test.docx | 1 页 | 1400×1812 |
| test.xlsx | 1 页 | 1400×1980 |

首次打开 35 页 pptx 约 10 秒（转 PDF 14s 只在第一次 + 光栅化 7s），之后秒开。
### 测速为什么不能真并行，以及把它压到 24 秒

先验证了两个假设，结论都是「不行」：

```text
1) Clash 的 /proxies/<node>/delay 能不能代替 Codex 探测？
   被墙的 🇭🇰香港高速01 测 https://chatgpt.com/ 照样返回 delay=118ms ——
   mihomo 只当 HTTP 通了就记成功，看不到 OpenAI 的 403。

2) 那能不能并发测？
   12 个并发里 7 个直接 503/504（An error occurred in the delay test）——
   mihomo 自己会限流。
```

而且切换节点是**全局**的，同一时刻只能有一个节点在承流量，真并行测 Codex 必然互相污染。
所以保留串行确认，但把每节点开销砍掉 + 提前收敛：

| 改动 | 之前 | 现在 |
|---|---|---|
| 每节点前的 settle 等待 | 250 ms | **0**（Clash 对新连接立即生效） |
| 每节点重复的 Clash 延迟测试 | 有（≈300ms） | 用预筛结果，去掉 |
| 失败节点超时 | 6 s | 4 s |
| 预筛并发 | 8（会 503） | 4 |
| 提前停止 | 无 | 已确认 ≤800ms 的节点且测满 6 个就停 |

结果：同样的组，**105 秒 → 24 秒**（测了 6 个就锁定 🇯🇵日本专线02，Codex 677ms）。
自动切换守护走的也是这条路径，所以“断线后重选”同样变快。

### 上传菜单精简

原来 5 项（照片/视频、拍照/录像、任意文件、微信文件传输、从微信取文件），现在 2 项：

```text
添加文件
  拍照 / 选文件        <- 一个 input[type=file] 不设 capture，手机系统面板里同时给相机和文件
  微信文件传输         <- 扫码 + 取微信文件
```

`accept="*/*"` 且不设 `capture`：iOS 会弹「照片图库 / 拍照 / 选取文件」，Android 弹「相机 / 文件」，
一个入口覆盖原来的三项。
## 5.27 全功能实测（35 项）

用 CDP 驱动真实浏览器把页面上**所有可见功能**跑了一遍，三套脚本：`tools/qa-suite2.mjs`（17 项）、
`qa-suite3.mjs`（12 项）、`qa-suite4.mjs`（6 项）。结果 **35/35 通过**，无 console 异常、无 4xx/5xx。

### 覆盖范围

| 区域 | 检查项 |
|---|---|
| 登录 | 表单显示、错误密码被拒、正确密码进入、配对链接 `?t=` |
| 导航 | 6 个 rail 按钮、主题切换与持久化、面板开关 |
| 侧栏 | 会话列表、搜索过滤、项目分组折叠/展开、新会话 |
| 输入区 | 合并 chip（模型·强度）、强度弹层、权限弹层（3 档）、附件菜单（2 项）、斜杠菜单（12 项技能）|
| 会话 | 打开历史会话、指标条、拖拽上传、停止按钮中断 |
| 预览 | md / html / 图片 / 代码 / PDF（12 页）/ Office（35 页）/ 未知类型卡片，保存名 = 文件名 |
| 面板 | 技能与 MCP、最近文件、用量、网络（测速 + 自动切换开关）、微信（二维码 + 刷新）|
| 移动端 | 底部 6 tab、每个 tab 都能开面板、dock 全宽、chip 不溢出、主题跨刷新保持 |

### 测出并修掉的 4 个问题

**1. 微信自动挂载一直失效**
`/api/wechat-watch`（SSE）在**登录之前**就被订阅了 → 401。现在改成 `boot()` 认证成功后、以及表单登录成功后
才启动，并加了「出错就 5 秒后重试」的保护。实测 `http failures: none`。

**2. 拖拽浮层会卡住挡住整个界面**
`dragleave` 在两种情况下不会触发收尾：事件里没有 `dataTransfer`，或鼠标快速移出窗口。
加了 `relatedTarget === null` 判定 + 2 秒看门狗 + `dragend`/`blur` 兜底。

**3. `#fileInput` 是死代码**
页面里那个 `<input type="file" id="fileInput">` 从来没绑过事件（真正的选择器是 `pickFiles()` 动态创建的），
已删除，避免以后误以为能用。

**4. 只挂文件不写文字时无法发送**
`updateSendState()` 只看输入框文字，附件不计入；而且 `renderAttachments()` 之后没刷新按钮状态。
现在「有附件」也算内容，挂上文件后发送按钮立刻可用，发出去的是 `mention` + 空文本。
## 5.28 本机 Codex 会话同步 · 大文件走直链

### 网页端删除/归档后，本机 Codex 还显示（已修）

现象：网页里删掉的会话在桌面 App 里还在，点开报 `继续聊天未成功 no rollout found for thread id …`。

根因不在 app-server，而在桌面端自己的目录表 `~/.codex/sqlite/codex.db` 里的 `local_thread_catalog`：
桌面列表来自这张表（扫描 rollout 文件生成）。`thread/archive` 只把文件移到 `archived_sessions/`、
`thread/delete` 只删掉文件 —— 表里的行没人清理，于是桌面照旧列出，点开才发现 rollout 不在了。

实测确认（真实坏条目）：

```text
catalog row: {thread_id: 01a1a4ac..., display_title: "111", missing_candidate: 0}
rollout on disk: 没有（sessions / archived_sessions 都没有）
```

修复：新增 `POST /api/threads/prune`，扫描 `~/.codex/sessions` 里真实存在的 rollout，
把 `host_id` 为 local 且文件已消失的目录行删掉（连带 `scan_entries`），首次运行把 `codex.db` 备份成 `codex.db.bak-prune`。

调用时机：桥接启动、网页端归档后、网页端删除后、每次进页面 boot 一次。

实测：

```text
调用前  local rows: 20, without rollout: 2   <- "111" 和 "test"
POST /api/threads/prune -> {"ok":true,"removed":2,"titles":["111","test"]}
调用后  local rows: 18, without rollout: 0
```

UI 侧确认：`boot requests: [POST /api/threads/prune]`，归档一次后变成两条。

### 微信里的大文件下载慢（改用直链）

先量了上传侧：5MB 只需 934ms（约 5.4MB/s），所以慢的不是我们上传，而是手机从微信 CDN 拉取
（60MB 的 pptx 尤其明显）。而手机通常就在同一个 tailnet/LAN 里，直接从桥接下载快得多（实测 60MB / 0.4s）。

新增接口：

| 接口 | 作用 |
|---|---|
| `POST /api/share {path}` | 生成 24 小时有效的直链（HMAC 签名，含路径+过期），返回 tailnet/LAN 优先的 URL |
| `GET /s/<token>` | 免登录下载（token 本身是凭证），`Content-Disposition` 带正确文件名 |
| `POST /api/wechat/send-text {text}` | 往文件传输助手发文字（用于发链接） |

前端：dock 的「发送到微信」先查文件大小，超过 5MB 弹三选一：

```text
59.7MB · 选择方式
  发送下载链接（推荐，手机直连）
  发送文件（59.7MB，微信下载较慢）
  复制链接
```

小文件保持直接发送。实测：59.7MB 弹菜单、200KB 图片直接发；选「发送下载链接」后 1.2 秒内文字就进了微信
（页面里能读到 `http://<tailnet-ip>:8787/s/...`）。
## 5.29 新建项目（在本机选目录）

手机/远程端没法用系统的文件夹对话框（它弹在主机上），所以做了一个**网页内的目录浏览器**：

```text
项目 chip -> ＋ 新建项目…
  面包屑 C:\ › CHAT         [↑ 上一级]
  快捷: 主目录 / 桌面 / 文档 / 下载
  [文件夹列表，点一下就进去]
  项目名称 [CHAT]            [用这个文件夹]
```

接口：`GET /api/fs/dirs?path=`（需登录）

- 不带 `path` 时返回驱动器列表（`C:\`、`D:\`…）和常用位置；
- 带 `path` 时返回该目录下的子目录、上级目录、面包屑；
- 跳过 `node_modules` / `.git`，单目录最多 400 项，按中文排序。

创建走 app-server 的官方 `project/create`（而不是直接改 `~/.codex/.codex-global-state.json`），
所以桌面 App 也会立刻看到这个项目：

```js
rpc.send('project/create', { name, roots: [{ path }], idempotencyKey })
```

创建成功后自动 `project/list` 刷新、把新项目设为当前目标并更新 chip 文案。

实测（浏览器自动化）：菜单里出现「＋ 新建项目…」→ 面板打开在默认目录 → 建出
`{"name":"CHAT","roots":["<workspace>"]}` → chip 变成「CHAT」；测试项目随后已删除。
## 5.30 新建项目：从「此电脑」开始 + 就地新建文件夹

之前对话框固定从当前工作目录开始，只能往下钻，够不到别的盘。现在：

```text
新建项目
  此电脑                      <- 起始视图：C:\ D:\ + 常用位置
  [↑ 上一级] [＋ 新建文件夹]
  主目录 / 桌面 / 文档 / 下载 / 当前工作目录   <- 快捷位置
  [文件夹列表]
  项目名称 [..]              [用这个文件夹]
```

改动：

- 打开时 `paint('')`，直接进「此电脑」（驱动器列表），面包屑可以从任意层级点回 `此电脑`；
- 快捷位置里补了「当前工作目录」，从根视图一步回到平时用的目录；
- 新增 `POST /api/fs/mkdir {path, name}`，对话框里「＋ 新建文件夹」创建后**自动进入**该文件夹；
- 名称校验：拒绝 `\ / : * ? " < > |`、`.`、`..`、超长、同名已存在。

实测：

```text
根视图   crumbs=此电脑  dirs=C:\,D:\  quick=主目录,桌面,文档,下载,当前工作目录
进入     C:\ -> <workspace> -> 新建文件夹 qa-folder-…（磁盘上真的建出来了）
创建     project/list -> ["Remote","qa-folder-…"]，chip 同步更新
非法名   {"ok":false,"error":"名称不能包含 \\ / : * ? " < > |"}
```

（测试用的项目与文件夹已删除。）
## 5.31 切换账号后二维码不出来（已修）

现象：iPad 上点「切换账号」，二维码区域不更新 / 扫了没用。

定位过程：

```text
接口侧   POST /api/wechat/reset -> 2.6s；之后 4s 内 /api/wechat/qr 就返回 37KB 真图（150ms）
页面侧   重置后 WeChat 登录页没有 <img>，只有 .login-scan__panel；日志里是 qr download empty (200)
前端侧   <img src> 的 ?t= 一直是同一个值（1793899268801），说明根本没重新取图
```

根因：为了防闪烁加的那行早退

```js
if (mode === 'login' && host.dataset.mode === 'login' && host.querySelector('.wx-qr')) return;
```

它把「已经有一个 img 就不再重建」当成了通用规则——于是换账号后仍然显示**上一个账号的旧码**
（那个码已经失效，扫了自然没反应）。二维码本身有有效期，这条规则也让过期码永远不刷新。

修复分三层：

1. **前端按新鲜度重建**：记录 `state.wxQrStamp`，只有「模式没变 + 图片存在 + 不到 2 分钟 + 没有强制刷新」才早退；
   「切换账号」「刷新二维码」两个按钮都会置 `wxQrStamp = 0; wxQrRefresh = true`，强制换新图；
   图片加载失败时把 `wxQrStamp` 清零，下一个轮询周期自动重试（而不是永远停在提示文字上）。
2. **桥接在 reset 时清空二维码缓存**，避免把上一个账号的图继续发 2 秒。
3. **下载失败且页面显示「二维码无法加载，点击刷新」时**，先点它的刷新链接（或 reload），等 2.5s 再取一次，
   全部失败才退回截图——否则截图会把错误提示拍下来当二维码发出去。

实测（820×1180 平板视口，真实点击「刷新二维码」）：

```text
before: {"hasImg":true,"loaded":true,"w":430,"t":"1793899456744"}
  +2s  {"t":"1793899456744"}                       ← 还没换
  +4s  {"t":"1793899464594","loaded":true} NEW-IMAGE  ← 新码已加载
```
## 5.32 网页操作后本机 Codex 立刻一致（双向同步）

状态分散在三个地方，必须先弄清谁读谁：

```text
app-server (codex.exe, :8791)   会话/项目的真实索引 + 广播通知
~/.codex/sessions/, archived_sessions/   rollout 文件
~/.codex/sqlite/codex.db -> local_thread_catalog   桌面端侧栏的会话列表
~/.codex/.codex-global-state.json -> local-projects  桌面端的项目注册表
```

实测 app-server 的广播是齐全的：

```text
thread/archive  -> thread/archived {"threadId": ...}
thread/delete   -> thread/deleted  {"threadId": ...}
project/create  -> project/changed {"projectId": ..., "changeType": "created"}
```

### 网页 -> 本机（持久化状态）

| 操作 | 之前 | 现在 |
|---|---|---|
| 删除会话 | 只删 rollout，目录表留行 → 桌面显示、点开报 no rollout found | 桥接收到 `thread/deleted` 后 **1.2s 防抖清理**，行消失（实测 1.4s） |
| 归档会话 | 只把文件挪到 `archived_sessions/`，行还在 | 目录表现在**只认 `sessions/` 里的 rollout**，归档即从桌面列表消失 |
| 新建项目 | 只写 app-server SQLite，`global-state.json` 没有 → 桌面侧栏看不到 | 镜像写入 `local-projects` + `project-order`（Windows 反斜杠路径，写前备份 `.bak`） |

另外每分钟兜底扫一次目录表，桌面端自己的增删也能被纠正。

### 本机 -> 网页（实时通知）

网页端以前只处理 `thread/started`，桌面删/归档后网页纹丝不动。现在补上：

```js
case 'thread/archived':          // 从列表移除 + toast「该会话已在别处归档」
case 'thread/deleted':           // 同上 + toast「该会话已在别处删除」
case 'thread/unarchived':        // 静默 loadThreads()
case 'project/changed':          // loadProjects() 后重绘项目分组
```

### 实测（两次独立客户端，模拟桌面 vs 网页）

```text
网页归档  -> 目录表 0.7s 仍在, 1.4s 已删除        ✓
网页删除  -> 目录表 1.4s 已删除                  ✓
别的客户端归档 -> 网页 1.2s 内从列表消失，27 -> 26，toast 正确   ✓
别的客户端建项目 -> 网页 1.2s 内出现，无需刷新                 ✓
网页建项目 -> global-state 立刻有，rootPaths=["<workspace>"]      ✓
```

去重注意：legacy 项目 id 与 app-server 项目 id 不同，镜像时**按路径判重**，否则每个迁移过的项目都会被复制一份。
## 5.33 上线前的审计与优化（商用目标）

按「安全 / 性能 / 鲁棒性 / 可访问性」四项做了一轮实测，改完再验一遍。全部脚本在 `tools/`：
`prelaunch-audit.mjs`、`latency-profile2.mjs`、`stress-test.mjs`、`ux-audit.mjs`、`reconnect-test.mjs`、`launch-checklist.mjs`。

### 安全（都实测过）

| 项目 | 改前 | 改后 |
|---|---|---|
| 任意路径读文件 | `/api/file?path=C:/Windows/win.ini` 直接返回内容 | **403**（允许根 = 主目录 + 工作目录 + 项目根；`fileScope:"home"`，可改 `"any"`） |
| 安全响应头 | 全无 | `nosniff` `X-Frame-Options: DENY` `Referrer-Policy` `Permissions-Policy` 和一套 CSP |
| CSRF | 跨站 POST 返回 200 | 校验 Origin/Referer，跨站 **403** |
| 登录暴力破解 | 已有按 IP 限流（回环豁免） | 保持，并把英文错误映射成中文 |
| Cookie | `HttpOnly; SameSite=Lax; 30d` | 不变（HTTPS 下自动加 `Secure`） |

CSP 刻意保留了 `style-src unsafe-inline`（页面用 JS 设内联样式），但 `script-src` 只允许同源，
页面本身也没有内联脚本，所以 XSS 里最危险的一类被挡住。

### 性能

| 指标 | 改前 | 改后 |
|---|---|---|
| 首屏传输 | 238 KB | **65 KB**（gzip：app.js 166→47KB，css 57→11KB，html 15→4.7KB） |
| FCP（手机 390×844，4× CPU 降速） | 736 ms | **408 ms**（新增纯 CSS 启动画面，首帧不再是白屏） |
| 点击发送 → 自己的气泡出现 | 426 ms | **5 ms**（乐观渲染，服务端回显后对齐） |
| 面板首开（网络面板） | 583 ms 白屏 | 先画骨架，再填数据 |
| 500 个会话渲染 | — | 47 ms |
| 21k 字消息渲染 | — | 10 ms |
| 面板连点帧时间 | — | p50 17 ms / p95 59 ms |

启动画面是纯 CSS 的，并带 `6s` 自动淡出兜底——即使 JS 挂了也不会把用户卡在启动页。

### 鲁棒性

| 场景 | 结果 |
|---|---|
| 桥接进程被杀 | UI 立刻显示「已断开，正在重连…」+ `body.is-offline` 横幅 |
| 桥接恢复 | **8 秒内自动重连**，RPC 恢复正常，不需要刷新页面 |
| 会话过期（cookie 被清） | 任一 API 返回 401 → 自动回到登录页并提示「登录已过期」 |
| 未捕获异常 | 统一 toast + 控制台，不再静默白屏 |
| 二维码卡死 | 每个 CDP 调用 8s 超时 + 路由 8s 兜底，返回 503 而不是挂住连接 |

### 可访问性 / 移动端

- 图标按钮 100% 有 `aria-label`，输入框 100% 有 placeholder 或 label，图片都有 alt；
- 手机端会话行 / 菜单项 ≥ 44px（原来 30-32px），符合触控建议；
- 加了 `:focus-visible` 焦点环（键盘可见、鼠标不可见）；
- 尊重 `prefers-reduced-motion`；
- `lang="zh-CN"`、`viewport-fit=cover`、`theme-color` 随主题切换；
- 无横向溢出（390px 视口实测）。

### 上线清单（15 项，全过）

```text
security: CSP / nosniff / DENY / referrer-policy       PASS
security: 拦截系统目录，放行项目文件                     PASS
security: 跨站 POST 403，同源 POST 200                  PASS
weight:   gzip 全开，首屏 65.3KB < 80KB                 PASS
ui:       启动画面正常消失、无横向溢出                   PASS
a11y:     触控目标 ≥ 40px、焦点环存在                    PASS
robust:   401 自动回登录                                PASS
console:  无错误                                        PASS
```
## 5.34 对话页用量悬浮球 + 动效克制化

小红书那篇「24 个高级 UI 交互」的链接在这台机器上打不开（`xhslink.cn` / `xiaohongshu.com`
解析到非公网地址，被网络策略拦了），所以按这类清单里**适合生产级对话工具**的部分来做：
能用、不喧哗、不拖性能。

### 用量悬浮球（对话页实时显示）

```text
   ╭──────────╮
   │  ╭────╮  │   外环 蓝 = 5 小时窗口**还剩**（满环 = 全新，越用越短；≤30% 橙，≤10% 红，0% 脉冲）
   │  │4h27│  │   内环 灰 = 每周窗口**还剩**（同样有橙/红两级）
   │  ╰────╯  │   中心   = 距 5 小时重置的倒计时
   ╰──────────╯
```

细节：

- 倒计时格式：离得远显示 `4h27`（分钟级），进入 1 小时内显示 `27:13`（逐秒跳）；
- **实时**：订阅 app-server 的 `account/rateLimits/updated` 通知（每一轮对话都会推），
  再叠加 60 秒兜底轮询，数字变化时球体会闪一下光圈，让「更新了」看得见；
- 位置跟着输入框走：`ResizeObserver` 监测 composer 高度，写进 `--ball-bottom`，
  输入框长高（多行草稿）也不会被挡住；
- 打开右侧面板时球自动淡出（`.dock-open`），关闭后恢复；
- 点击打开「用量」详情面板，`aria-label` 带完整数值（读屏可用）；
- 尊重 `prefers-reduced-motion`（不闪、不脉冲）。

实测（390×844 与 1280×880 两种视口）：环形 `stroke-dashoffset` 与百分比一致（5% → 143.3/150.8），
已用 5%/46% 时两环分别显示剩余 95%/54%，已用 75%/20% 时外环转橙（剩 25%），已用 95%/92% 时两环转红，已用 100% 时加 `is-blocked` 脉冲；点击面板后会用面板的实时数据回写球体，两边永远同一个数。

### 采用的动效（其余一律不做）

| 效果 | 用在哪 | 为什么留 |
|---|---|---|
| 环形进度 + 平滑动过渡 | 用量球 | 一眼看清配额，切换有连续性 |
| 数值变化闪一下 | 用量球 | 让「实时」可感知，而不是数字悄悄变 |
| 骨架屏 shimmer | 面板加载 | 首开不再是一片空白 |
| 交错入场 `msg-in` | 新消息（已备好样式） | 消息出现有落点，不突兀 |
| 悬浮抬升 | 用量球、卡片 | 可点击的暗示 |
| 焦点软光 | 输入框 | 键盘操作时知道焦点在哪 |
| 启动画面 | 首屏 | 白屏 → 品牌过渡 |

刻意没做：光标跟随高光、粒子背景、3D 倾斜、视差滚动、打字机——它们在工具类产品里只会增加
渲染成本与干扰。
## 5.35 按 Interaction Atlas 清单落地的交互（只做有用的）

对着 24 个交互清单逐条过了一遍，只挑了**在对话工具里真有收益**的四个，其余明确不做。

### 落地

| 编号 | 交互 | 用在哪 | 收益 |
|---|---|---|---|
| #09 | 命令面板 | `Ctrl/Cmd + K` | 会话一多，点侧栏找会话很慢；键盘直达 + 模糊过滤 |
| #20 | 堆叠通知 | 取代原来的单条 toast | 多条同时发生时不互相覆盖，带成功/失败/信息图标和「重试」按钮 |
| #08/#22 | 可调整面板 | 右侧文件预览的左边框 | 看 PPT/PDF 时要更宽，宽度记进 localStorage |
| #17 | 轻量动效 | 环形进度、数字变化闪烁 | 用在真正表达「状态变了」的地方 |

命令面板内容来自四个来源，按分组显示：

```text
动作   新会话 / 切换主题 / 刷新会话列表
面板   技能与 MCP / 最近文件 / 用量 / 网络 / 微信 / 新建项目
项目   每个项目（回车切目标项目）
会话   每个会话（回车直接打开）
技能   每个 skill（回车挂到输入框）
```

键盘：`↑ ↓` 选择、`Enter` 打开、`Esc` 关闭、`Ctrl/Cmd + K` 呼出或收起；点击遮罩也关闭。

通知的类型是按文案判定的（含「失败/错误/无法/超时」→ 红色，含「已/成功/完成」→ 绿色），
所以现有几十处 `toast(...)` 调用**不用改**就自动分色；需要按钮时传第三个参数：

```js
toast('发送失败：网络中断', 5000, { action: { label: '重试', onSelect: () => send() } });
```

面板宽度：默认 `clamp(320px, 34vw, 420px)`，拖动后写 `--dock-w`，刷新恢复；
窗口变化会重新夹取（最小 320px，最大 72vw）；手机上面板本来就全宽，拖拽手柄自动隐藏。

### 明确不做

放大镜坞栏、3D 倾斜卡片、视差滚动、拖拽排序、多选、图片对比滑块、悬停放大预览——
这些在展示型站点很出彩，但放进一个每天用几小时的对话工具里只会分散注意力，还拖性能。

## 5.36 多端布局校验

六种视口逐个测量：横向溢出、栅格结构、输入框是否越界、悬浮球是否压住输入框、文本截断。

| 视口 | 布局 | 结果 |
|---|---|---|
| Windows 1600×900 | 侧栏 332 + 主区 | OK |
| Windows 1440×810 | 侧栏 332 + 主区 | OK |
| 手机竖屏 390×844 | 底部 tab 栏 + 全宽面板 | OK |
| 手机横屏 844×390 | 底部 tab 栏 + 全宽面板 | OK |
| iPad 竖屏 820×1180 | 底部 tab 栏 | OK |
| iPad 横屏 1180×820 | 桌面式三栏（rail + 侧栏 + 主区） | OK |

统一判据（全部满足才算 OK）：`scrollWidth - clientWidth <= 0`、输入框完整在视口内、
悬浮球在输入框上方且完整可见、无元素内容被自身裁切。

这一轮修掉的两个真问题：

1. 手机端堆叠通知**压在输入框上**——改成跟悬浮球共用 `--ball-bottom`（输入框顶部之上）；
2. 面板拖宽后刷新**不恢复**——`restoreDockWidth()` 没被调用，补上并在 resize 时重新夹取。
## 5.37 平板/手机上「发微信」Load failed 与扫码后无反馈

现场（iPad 截图）：`正在发到微信…` 之后一条 `发送失败：Load failed`。

### Load failed 的原因：请求被挂住太久

`POST /api/wechat/send` 以前要**等整份文件上传完**才返回 JSON。60MB 的 pptx 上传要十几秒，
iOS Safari 会把这种长时间挂起的 fetch 判成网络错误（`Load failed` / `NetworkError`），
甚至在人切到别的 App 时直接中止。我们这边其实在上传，用户却看到失败。

改成**后台任务 + 轮询**：

```text
POST /api/wechat/send     -> 立刻返回 { jobId, name, size }（实测 17-65ms）
GET  /api/wechat/job?id=  -> { state: running | done | error, result, elapsedMs }
```

上传在服务端继续跑，客户端每 0.9 秒查一次状态，最多等 5 分钟；
单次轮询失败（锁屏、隧道抖动）不会立即失败，只累计超时。
失败时通知里带「重试」按钮，网络类错误显示为「网络中断或请求超时」而不是原文 `Load failed`。

### 扫码后没有反馈

二维码页没有回调，以前只能靠面板里 4 秒一次的轮询悄悄切换卡片，用户不知道成了没有。

现在补了三处：

1. **桥接侧的登录监视器**：每 5 秒比对一次登录状态，一旦从未登录变成已登录，
   通过已有的 SSE 通道（`/api/wechat-watch`）推一条 `event: login`，带账号名；
   退出登录则推 `event: logout`；
2. **客户端收到就提示**：`微信已登录：xxx，现在可以发文件了`，同时强制刷新二维码状态；
3. **兜底**：面板轮询发现状态翻转也会提示一次（SSE 被代理缓冲时仍有效）。

（登录监视器只读页面状态，不改动会话；实测 SSE 首帧 `event: ready` 正常。）

### 顺带

- 发送前先校验文件存在与大小（≤200MB），错误在 20ms 内返回，不再让用户等；
- 未登录时立刻返回「需要先在「微信文件传输」里扫码登录」，并自动打开扫码面板。
## 5.38 扫码不生效的真凶：二维码恢复逻辑会重载页面

前两轮修的都是「发文件」，但**扫码一直不成功**的根因其实在二维码那一侧。

为了兜底「二维码无法加载」，`qrImage()` 里写了这样一段：先点页面上的「刷新」，
还不行就 `Page.navigate` 整页重载。问题是——扫码之后页面会进入
**「已扫描，请在手机上确认」** 状态，此时页面上没有 `img.qrcode-img`，文字里又带着「点击刷新」，
于是每次取二维码都会**点一下刷新 / 重载一次**，把刚扫上的登录会话直接作废。
表现就是：手机扫码 → 手机显示已确认 → 网页这边毫无反应。

修复：**二维码读取路径改成完全只读**——不点、不跳、不刷新。
取不到图就返回 503，由用户点「刷新二维码」（那才是显式的 `/api/wechat/reset`）。

### 扫码后的反馈（三路保证）

1. 桥接每 5 秒只读探测一次登录态（日志 `[wechat] login watcher started (5s)` 可确认它在跑）；
2. 状态翻转时通过 SSE 推 `login` 事件（带账号名），客户端立刻弹「微信已登录：xxx」并刷新卡片；
3. 兜底：面板轮询也会发现翻转并提示一次。

### 登录后自动发一条提示（这次新增）

检测到登录成功后，桥接会主动往你的文件传输助手发一条：

```text
✅ Codex 远程已连接
账号：少年的玉蝴蝶的文件传输助手
时间：2026-11-06 10:41:07
之后在网页里保存的文件会发到这里。
```

发送结果会通过 SSE `greeting` 事件回报，客户端提示「已向你的微信文件传输助手发送登录提示」；
发失败也不影响收文件，只是少一条提示。

### 扫码入口挪到「网络连接」

二维码原来只在回形针菜单里，而「手机能不能收到文件」本质是连接问题，所以放进网络面板，并且**放在最上面**：

```text
网络与连通性
  微信文件传输        [未登录]
    二维码 + 刷新二维码
  --- 或 ---
  微信文件传输        [已连接]
    账号：xxx   [发一条测试消息] [退出登录]
  ─────────────────────────
  良心云 · rule · 44 个节点 …（原有内容）
```

细节：区块挂在 `panelBody` 而不是清空重绘的 `host` 里（否则自动切换的 8 秒轮询会把它冲掉）；
5 秒轮询只在登录态变化时才重绘，避免二维码在手指底下闪。

实测（三种视口）：区块存在、二维码加载成功（`naturalWidth > 0`）、badge 显示「未登录」、刷新按钮在。
## 5.39 传输反馈：保存/发微信都看得见进度

问题：「保存文件」「传到微信」点完没有任何反馈，不知道是不是在传。
尤其平板上没有浏览器的下载条，60MB 的文件点完就像没反应。

### 传输中心

每一次保存/发微信都登记成一条传输记录（`state.transfers`），三处同时反馈：

1. **点下去立刻有提示**：`开始保存：xxx` / `请选择发送方式（12.0MB 的文件走链接更快）`；
2. **文件侧边栏顶部**列出 `正在传输 N 个文件`，每行：类型标签、文件名、`百分比 · 大小 · 已用时间`、细进度条；
3. **侧栏/底栏图标角标**显示进行中的数量（手机底部 tab 上的小蓝点）。

完成后行变绿显示 `完成 · 4s`，4 秒后自动消失；失败变红并写明原因。

### 保存现在的实现

不再是裸的 `<a download>`（点了没任何反馈），改成 `fetch` + 流式读取：

```js
const res = await fetch(fileUrl(target));
const reader = res.body.getReader();     // 每块都 patchTransfer({loaded})
// 读完转 Blob -> a[download] 交给浏览器
```

- 超过 80MB 的文件不进内存，直接交给浏览器下载（避免平板 Safari 崩标签页），并提示「已交给浏览器下载」；
- fetch 失败时同样回退到直链下载，不让用户卡住。

实测（把网络限速到 1.2Mbps 抓中间态）：

```text
t=1.5s  running  3% · 12.0 MB · 2s   bar 2.9%   badge 1
t=4s    running  8% · 12.0 MB · 4s   bar 8.3%   badge 1
done    100% · 12.0 MB · 完成 · 4s   行变绿，4s 后移除
```

### 发微信的菜单也要有反馈

大文件会先弹「发链接 / 发文件 / 复制链接」三选一——菜单以前弹在按钮上方，容易看不见，
现在弹在按钮下方，并且**点击的同时就给一条提示**，不再像「点了没反应」。
选「发文件」后会立刻出现一条 `微信` 传输记录，轮询到完成后变绿。

### 扫码登录确认（真的发出去了）

桥接每 5 秒只读探测登录态；**首次观察到已登录也算**（扫码可能发生在桥接重启期间）。
确认后：

- SSE 推 `login`，界面弹「微信已登录：xxx」；
- 自动往文件传输助手发一条确认消息，并回报 `greeting` 事件；
- 去重记录写在 `bridge/wechat-greeted.json`，30 分钟内不重复发，重启也不会刷屏。

实测日志：

```text
[wechat] already logged in as 少年的玉蝴蝶的文件传输助手, greeting once
[wechat] login greeting sent
```
## 5.40 发微信只走文件；保存进度自动出现在「最近文件」

### 去掉「选择发送方式」

大文件原来会弹「发下载链接 / 发文件 / 复制链接」三选一。多一次选择就是多一次卡顿感，
而且「发送到微信」本来就是发文件。现在点一下直接上传，没有菜单。

实测：`menu open? false` → `wechat:running` → 2 秒后 `已发到微信文件传输助手：wx-note.bin`。

### 保存进度为什么之前看不到，以及现在怎么修

两个原因叠在一起：

1. **进度只画在「最近文件」面板里**，而保存按钮在文件预览的 dock 上——点了之后面板根本没开，自然什么都看不到；
2. 就算打开了，`openFilesPanel()` 末尾用的是 `dom.panelBody.replaceChildren(frag)`，
   把刚插入的传输列表**一起清掉**了（只有列表为空、提前 return 时才看得见）。

修复：

- 点保存 → **先打开「最近文件」**，再开始下载，进度行立刻出现在列表顶部；
- 末尾改成 `append(frag)`，传输列表不再被清掉；
- 保存的文件同时写进最近文件列表，完成行保留 20 秒（绿框 + `完成 · 5s`）；
- 侧栏/底栏图标角标显示进行中的数量。

实测（限速 1.5Mbps 抓中间态）：

```text
点击保存 0.3s  title 变成「最近文件」，head「正在传输 1 个文件」
         1.2s  保存 big-report.bin · 2% · 10.0 MB · 1s   bar 2%   badge 1
         4s    保存 big-report.bin · 8% · 10.0 MB · 4s   bar 8%
完成      保存 big-report.bin · 100% · 10.0 MB · 完成 · 5s（绿框，保留 20s）
```

微信上传我们拿不到字节数，所以那条显示**不确定进度条**（来回滑动），完成时补成 100%，
不会出现假的 `0%`。
## 5.41 计划模式 / 目标模式（原生，不是 skill）

Codex 协议里本来就有这两个能力，只是网页端没接：

| 模式 | 协议能力 | 用法 |
|---|---|---|
| 计划模式 | `turn/start.collaborationMode = { mode: "plan", settings }` | `/plan` |
| 目标模式 | `thread/goal/set` / `thread/goal/get` / `thread/goal/clear` | `/target [目标内容]` |

### 和 skill / MCP 的区别（做在三个地方）

1. **菜单分组**：斜杠菜单里单独一组「模式」，蓝色 + ⚡ 图标；技能在「技能与 MCP」组，灰色 + ✦ 图标；
2. **语义**：模式是**开关**（点亮后作用于后续每一轮），skill 是**附件**（只作用于下一条消息）；
3. **芯片外观**：计划模式是蓝色描边芯片，目标是琥珀色描边芯片，skill 芯片保持中性灰。

### 两种启用方式都支持

```text
/plan                     -> 直接开启计划模式（不发送、不建会话）
/target 整理测试文件      -> 开启目标模式并设定目标
/target                   -> 开启目标模式，下一条消息内容作为目标
```

菜单点选和直接键入命令等价（`send()` 里先解析 `^/(plan|target)\b`）。

### 实际发出去的参数（抓 rpc 验证）

```json
{"mode":"plan","settings":{"model":"gpt-6.1-sol","reasoning_effort":"xhigh","developer_instructions":null}}
{ "objective": "整理 <workspace> 测试文件", "status": "active" }
```

注意：`collaborationMode` 会**覆盖** model 与 effort，所以 settings 里必须带上当前的型号与强度，
否则模型会被悄悄回退到默认值。

### 同步

- 服务端 `thread/goal/updated` / `thread/goal/cleared` 通知 → 芯片实时更新（状态、tokens 用量在 tooltip）；
- 切换会话时读该会话自己的目标（`thread/goal/get`），目标不会串到别的会话；
- 芯片上的 × 直接关闭模式，目标模式关闭时清空目标。

实测：`/plan` 后芯片出现、`turn/start` 带 plan；`/target …` 后 `thread/goal/set` 成功且服务端状态 `active`；
关闭后两个芯片都消失、状态归零。
## 5.42 MCP 面板「全部 unsupported」的真相 + 调用前自动开应用

### 为什么每个服务都显示 unsupported

面板把 `srv.runtimeStatus?.type ?? srv.authStatus` 当作状态显示。这台机器上
`mcpServerStatus/list` 返回的 `runtimeStatus` **全是 null**，于是回落到 `authStatus`，
而它对绝大多数服务就是字面量 `"unsupported"`（含义是「不需要授权」，不是「不可用」）。

结果：8 个服务明明加载了 3~238 个工具，界面却全部写着 unsupported。

改成按**实际可用性**推断：

| 情况 | 显示 |
|---|---|
| `runtimeStatus.type` 存在且不是 ready | 原样显示（红色） |
| 有工具 | `就绪 · N 个工具`（绿色） |
| `toolsError` | `工具不可用`（红色） |
| 什么都没有 | `未连接` |
| `authStatus` 是 bearerToken/oauth | 追加 `· 需授权` |

顺带解决了两个可用性问题：238 个工具一次性铺开没法用，现在有**全局搜索**，
每个服务默认显示 20 个 + 「显示全部 N 个」；冷启动时要等 MCP 服务拉起（约 6 秒），
期间显示「正在连接 MCP 服务… Ns」而不是干等骨架。

实测状态行：

```text
codex_app     未连接
codex_apps    就绪 · 238 个工具 · 需授权
context-mode  就绪 · 9 个工具
cua_repl      就绪 · 3 个工具
node_repl     就绪 · 4 个工具
photoshop     就绪 · 127 个工具
qgis          就绪 · 125 个工具
sketchup      就绪 · 10 个工具
```

### 调用 QGIS / Photoshop 前自动打开本机应用

这两个 MCP 都要求桌面程序已经在跑，否则报的是「连不上」这类难懂的错误。

新增 `POST /api/app/ensure { app, waitMs }`：

- `tasklist` 查进程；没有就找可执行文件（Photoshop 扫 `Program Files\Adobe\Adobe Photoshop *`，
  QGIS 扫 `QGIS *\bin\qgis-ltr-bin.exe`）并 `start` 起来；
- 轮询等进程出现（默认 90 秒上限），再留 2.5 秒给 UI 初始化；
- 返回 `{ok, already|launched, process, exe, waitedMs}`。

前端在 `mcpServer/tool/call` 之前调用它，结果面板显示「正在启动 Photoshop…」→「已打开（6s），正在调用…」。

实测：

```text
qgis       -> {"ok":true,"already":true,"process":"qgis-ltr-bin.exe"}            1.8s
photoshop  -> {"ok":true,"launched":true,"process":"Photoshop.exe","waitedMs":5598}  7.3s
```

### 实际调用过的 MCP（不是只看列表）

| 服务 | 工具 | 结果 |
|---|---|---|
| context-mode | `ctx_doctor` | OK，返回环境自检表 |
| qgis | `get_qgis_info` | OK，`qgis_version: 3.44.15-Solothurn` |
| qgis | `get_project_info` | OK，当前工程 4 个图层、EPSG:4326 |
| photoshop | `photoshop_ping` | OK，「Successfully connected to Photoshop」 |
| photoshop | `photoshop_get_version` / `get_capabilities` | OK，2022 + 功能开关 |
| photoshop | `photoshop_get_state` | OK，`hasDocument:false` |
| node_repl | `js` | OK |
| sketchup | `create_finger_joint` | 参数校验错误（缺必填参数），服务本身可达 |

注意：Photoshop 在**没有打开文档**时，`photoshop_get_document_info` 会返回
`Photoshop info not available. Please detect Photoshop first.` —— 这是该 MCP 自己的措辞，
不是连接失败；先 `photoshop_ping` 或打开一个文档即可。
## 5.43 退出登录后二维码不显示：微信标签页的渲染进程卡死了

现象：点「退出登录」之后，二维码位置一直空着 / 一直「正在生成」。

实测抓到的现场（不是二维码逻辑的问题）：

```text
GET /api/wechat/state   -> {"ok":false,"error":"cdp timeout: Runtime.evaluate"}
POST /api/wechat/reset  -> {"ok":false,"error":"cdp timeout: Page.enable"}   8023ms
GET /api/wechat/qr      -> 503（每次 8s 超时，一直重试都一样）
```

同一个浏览器里另开一个标签做对比：

```text
微信文件传输助手网页版 -> TIMEOUT (6023ms)   ← 渲染进程僵死
下载 (edge://downloads-hub) -> OK (30ms)     ← 浏览器本身正常
```

也就是说：**微信那个标签的渲染进程卡住了**，CDP 连得上但命令永不返回。
之前 `reset()` 只会 `Page.navigate` 重新加载——对一个僵死的渲染进程毫无作用，
所以二维码永远出不来。

修复分三步：

1. **健康检查**：`ensureWindow()` 拿到标签后先做一次 4 秒的 `Runtime.evaluate("1")`，
   超时就判定僵死；
2. **重建标签**：`recreatePage()` 用 `GET /json/close/<id>` 关掉僵死标签，
   再 `PUT /json/new?<url>` 开一个全新的（两种 URL 形式都试，兼容不同 Edge 版本）；
3. **reset 也走重建**：先探活，活的话照旧 `navigate`，不活或 navigate 失败就重建整个标签。

前端也补了一层：二维码图片加载失败时自动重试 6 次（每次 2 秒，带「第 N 次重试」提示），
不再停在「暂时取不到」等用户手点。

实测（连续两轮退出）：

```text
reset#1 {"ok":true} 2684ms -> QR 1.5s 37074B
reset#2 {"ok":true} 2583ms -> QR 1.5s 38267B
```

UI 侧同样验证：退出后面板立刻切回二维码视图，`img.complete && naturalWidth > 0` 为真。
## 5.44 计划模式的提问卡片 + 思考卡不再自己收起

### 提问卡片（`item/tool/requestUserInput`）

计划模式会停下来问「先做哪一部分？」这类问题。查了协议，它不是 allow/deny 审批：

```ts
params:  { questions: [{ id, header, question, isOther, isSecret, options: [{label, description}] }], isBlocking }
response: { answers: { [questionId]: { answers: string[] } } }
```

但前端把它和命令审批放在同一个分支里，渲染成「允许 / 本会话都允许 / 拒绝」，
回包还是 `{decision}` —— 服务端拿到的不是答案，问题等于没法回答。

现在有专门的卡片：

- 每个问题：小标题（header）+ 问题正文 + 选项列表（label + 说明，可多选）；
- `options` 为空或 `isOther` 时附带自由输入框，`isSecret` 用密码框；
- 「提交回答」在至少答了一题后才可点，另有「跳过」；
- 回包严格按协议：`{ answers: { q1: { answers: ["先做数据"] }, q2: { answers: ["这周内"] } } }`。

实测（注入两题：一个带选项+自定义，一个纯填空）：

```text
card: {has:true, title:"Codex 想问 2 个问题", questions:2, options:2, inputs:2, submitDisabled:true}
reply: {"answers":{"q1":{"answers":["先做数据"]},"q2":{"answers":["这周内"]}}}
```

### 思考卡点开后又自己收起

原因不在卡片本身：`refreshItem()` 更新 reasoning 时是**原地改文本**，不会塌；
塌的是 `renderStream()` —— 只要这一轮有新的 item 到达或这一轮结束，整个消息列表会重建，
`is-open` 类自然就丢了。

修复：用一个模块级的 `openSteps` 集合按 item id 记住展开状态，
`stepCard({ key })` 创建时读取、点击时写入。重建多少次都保持展开。

实测：点开 → `is-open:true` → 触发一次 `renderStream()` → 仍然 `is-open:true`，正文还在。
## 5.45 只有老账号能登微信：退出登录没清会话

现象：之前登录过的账号（少年的玉蝴蝶）一直能用，换个微信号扫码就登不上。

查了浏览器的实际存储，问题很清楚——「退出登录」只是**刷新页面**，凭据全留着：

```text
cookies:
  webwx_auth_ticket@.szfilehelper.weixin.qq.com   expires 1828514094 ← 2027 年
  webwxuvid@.szfilehelper.weixin.qq.com           expires 1828369982
  wxuin@.szfilehelper.weixin.qq.com               expires 1794215436
  wxsid@… / wxloadtime@… / wxpluginkey@… / last_wxuin@…
localStorage: AEGIS_ID, fileTotalSize, userAvatar, webUin
```

页面一打开，看到 `webwx_auth_ticket` + `wxuin` 就直接恢复成上个账号，于是：

- 界面上要么直接回到列表，要么出现二维码但扫了没反应；
- 换号扫码时微信认为「当前浏览器已登录其他账号」，静默失败。

### 修复：硬退出

`reset()` 现在按这个顺序来：

```js
await cdp("Storage.clearDataForOrigin", { origin: "https://szfilehelper.weixin.qq.com", storageTypes: "all" });
await cdp("Storage.clearDataForOrigin", { origin: "https://login.weixin.qq.com",     storageTypes: "all" });
await cdp("Network.clearBrowserCookies", {});          // 这个 profile 只跑文件助手，清全部是安全的
await cdp("Page.navigate", { url: URL_TRANSFER });
// 登录页加载后还会写回 webUin/AEGIS_ID，再清一次
await cdp("Runtime.evaluate", { expression: "localStorage.removeItem('webUin')…" });
```

标签页僵死时走的重建分支也会先清会话再关标签（cookie 是跟着 profile 走的，关标签不解决）。

前端提示也改成了「已退出登录：已清除上一个账号的会话，请用要使用的账号扫码」。

### 验证（连续调用 reset 后检查浏览器实际存储）

改前：13 个 cookie（含 2027 年到期的 auth ticket）+ `webUin`。

改后：

```text
cookies: none
localStorage: ["AEGIS_ID"]        ← 只剩腾讯设备指纹，不含任何账号身份
page body: "使用手机微信扫码传输文件"
state: {"loggedIn":false,"hasQr":true}
GET /api/wechat/qr -> 200 37614B image/jpeg
```

日志同时出现 `[wechat-web] session cleared (cookies + storage)` 与 `[wechat] logged out`。

之后用任意微信号扫码都能登录；再切换回原来的账号也是同样一次「退出登录」。
## 5.46 计划模式退不掉（以及一次回退）

原因：`collaborationMode` 不是「本轮参数」，它会**存进 thread settings**
（`ThreadSettings.collaborationMode`）。之前只在开启时发送：

```js
if (state.planMode) params.collaborationMode = { mode: "plan", … };  // 只有开启分支
```

关掉芯片后下一轮不带这个字段，服务端沿用上次保存的 `plan` —— 芯片没了，模型继续规划。

### 第一次尝试（已回退）

当时改成「每轮都显式带模式」（`state.planMode ? "plan" : "default"`）。
服务端接受这个值，但把**所有**普通发送的请求体都改了形状，导致对话不再正常显示。
已经整段回退：普通发送与之前完全一致（`turn/start` 不再带 `collaborationMode`）。

### 现在的做法

只在**关闭计划模式的那一刻**用一次独立的设置更新，不碰正常发送：

```js
if (!state.planMode && state.currentThreadId) {
  rpc.send('thread/settings/update', {
    threadId: state.currentThreadId,
    collaborationMode: { mode: "default", settings: { model, reasoning_effort, developer_instructions: null } },
  });
}
```

同时监听 `thread/settings/updated` 把服务端保存的模式回同步到芯片，
这样桌面端或另一个标签切换模式时，网页端也不会显示错。

### 验证

服务端通知（直接抓 app-server）：

```text
set plan    -> {}
set default -> {}
notifications: thread/settings/updated:plan, thread/settings/updated:default
```

UI 全流程（抓页面发出的 rpc）：

```text
calls:  turn(mode=plan)  →  thread/settings/update  →  turn(mode=null)
plan chip now: {"planMode":false,"chips":0}
last reply: "收到"        ← 关闭后是正常回答，不是计划
```

## 5.47 冷启动时「对话全部不显示」

同一个现象还有第二个来源：启动顺序。原来先等 `projects / quota / models / skills`
**全部完成**才去拉会话列表，冷启动要 10 秒以上；这段时间侧栏是空的，看起来就像对话全没了。
而且四个读取用 `Promise.all`，任何一个失败都会让会话列表根本不加载。

改成：

1. `initialize` → **立刻拉会话列表**（空则 1.2 秒后重试一次）；
2. 其余读取用 `Promise.allSettled` **并行**跑，失败也不影响列表；
3. projects 到达后 `renderThreadList()` 自动分组。

实测：会话列表出现时间 **10s+ → 1.6s**（`first rows: 34 at 1.6s`），
并且模拟一个读取失败后仍然 `threads:38 / rows:34`。

## 5.48 本机正在跑的会话，网页端实时跟着看

### 先确认了协议的限制

用两个独立客户端做对照实验：A 起了一轮任务，B 只收到 **1 条** `thread/status/changed`，
没有任何 `turn/started` / `item/*` / `*delta`。也就是说：

> app-server 只把这一轮的事件流推给**发起它的那个客户端**，其他客户端什么也收不到。

所以桌面端在跑任务时，网页端原本只能看到「空」或者更早的历史。

### 能不能靠轮询补救？可以

`thread/turns/list` 支持 `itemsView: "full"`，实测在一轮进行中会**逐步**放出条目：

```text
+2.5s  inProgress items=0
+7.5s  inProgress items=1  userMessage
+27.5s inProgress items=2  userMessage reasoning
+42.5s inProgress items=3  userMessage reasoning reasoning
```

思考步骤是随生成陆续出现的，所以轮询足够撑起「实时看到思考过程」。

### 实现

- 打开会话、或收到当前会话的 `thread/status/changed(active)` 时，启动 **live follow**；
- 每 1.8 秒拉一次 `thread/turns/list { limit:6, itemsView:"full" }`；
- 用「条目 id 拼接」做签名去重，只有变化时才 `renderStream()`，避免闪烁；
- 按**服务端顺序**重建该轮的 `itemIds`，这样后到的思考步骤仍排在答案上方；
- 轮次结束后再补一次读取，确保最终答案落地，然后自动停止；
- 自己发消息时（`_send` 里）先停止跟随，改用原生 delta 流；切会话、新建会话也会停。

### 实测（另一个客户端起任务，网页端零操作）

```text
+2.5s  busy:true                        ← 自动识别到「有人在这台机器上跑」
+5s    items:1  用户消息渲染出来
+10s   items:3  答案开始增长（"正在处理…我会先算…"）
+22.5s items:4  思考卡片出现（parts:1）
+30s   busy:false  Worked for 27秒
```

顺带修掉两个连带问题：

1. 刚创建、还没落盘的会话会报「历史读取失败：thread … is not materialized yet」，
   现在识别为「空历史」不报警，交给 live follow 填充；
2. 轮询快照里条目顺序可能与先到的不一致，现在按快照顺序重排，思考不会跑到答案下面。

> 已知限制：协议里没有「别人这一轮正在生成什么」的增量接口，所以这里的粒度是最快
> 1.8 秒一次的快照（自己发起的轮次仍是毫秒级 delta 流）。
 且内容不只是数字）；
- 渲染失败时 `throwOnError:false`，公式以可读文本保留，不会出现空白框。

### 踩到的两个坑

1. 行内公式的正则最初用 `[^)]` 取内容，遇到 `\(a+(a+1)+(a+2)\le17\)` 这种**内容里带括号**的就匹配不上，
   整段原样漏出；改成惰性匹配到字面量 `\)`；
2. `typesetMath()` 第一次被插到了 `renderStream()` 的空状态提前 return 分支里，
   导致正常消息永远不排版（`window.katex` 一直是 undefined）；已挪到真正的出口。

### 实测

```text
table: {"tables":1,"rows":3,"headers":["a","b 的可能取值","组合数"]}
math nodes: {"spans":6,"blocks":1,"typeset":6}   // 6 个行内 + 1 个块级，全部排版成功
katex loaded: object
raw tex leaking? false
```

回归 17/17、上线清单 15/15。
## 5.50 装 5 个设计 skill，按 Web Interface Guidelines 过一遍

按小红书那篇《用Codex做网页的5个Skill》装齐，装到 `~/.codex/skills/`：

| skill | 来源 | 本项目是否适用 |
|---|---|---|
| `frontend-design` | anthropics/skills | ✅ 用来定「克制 + 一处记忆点」 |
| `ui-ux-pro-max` | WoolenWang/ui-ux-pro-max-skill | ✅ 备查（50+ 风格库，本项目不换风格） |
| `impeccable` | pbakaus/impeccable | ✅ 精修用（间距/层次/文案） |
| `web-design-guidelines` | vercel-labs/agent-skills | ✅ 逐条对照 |
| `react-best-practices` | vercel-labs/agent-skills | ⛔ 我们是原生 JS，没有 React/Next.js，跳过 |

`web-design-guidelines` 的规则本体不在仓库里，它让你每次去拉
`raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`（192 行），
我拉下来按 Accessibility / Focus / Animation / Typography / Touch / Safe Areas / Dark Mode
这些维度逐条比对了一遍。

### 审计结果与修复

| 规则 | 现状 | 处理 |
|---|---|---|
| 缩放不禁用 | `viewport-fit=cover`，无 `user-scalable=no` | 本来就对 |
| `transition: all` | 0 处 | 本来就对 |
| toast 播报 | `role="status" aria-live="polite"` | 本来就对 |
| `prefers-reduced-motion` | 已处理 | 新增动画也补了降级 |
| safe-area / overscroll / tabular-nums | 已有 | 补了面板的 `overscroll-behavior: contain` |
| **跳过导航链接** | 缺 | 新增 `.skip-link`（Tab 第一站，聚焦才出现） |
| **可见焦点环** | 只有 4 处 `:focus-visible` | 全局 `:focus-visible` 描边，输入框保留边框方案 |
| **`touch-action`** | 缺（平板上有 300ms 点击延迟） | 所有控件 `touch-action: manipulation` |
| **`color-scheme`** | 只有 light | 暗色主题补 `color-scheme: dark`（原生滚动条/输入框跟着变） |
| **标题断行** | 缺 | 标题 `text-wrap: balance`，正文 `pretty` |

### 空状态（frontend-design：一处记忆点，其余克制）

原来首页只有一行「有什么可以做的？」。加了三个**真的能用**的入口，点一下就把话填进输入框：

- 整理一下这个目录 · 列出 <workspace> 里的文件并按类型归类
- 把文件发到微信 · 找一个文件，发到微信文件传输助手
- 看看本机在跑什么 · 现在这台电脑上有哪些任务在跑？

排版：桌面三列、平板两列、手机一列；手机上空状态会**隐藏悬浮额度球**
（顶部「5h 额度」芯片已经显示了，球正好压在卡片上）。

踩到的坑：媒体查询写在文件前面时会被后面的同权重基础规则盖掉
（`.empty { padding: 18vh 0 0 }`），改成 `#messages .empty` 提高权重才生效。

实测：`跳过链接 ✓ / 焦点环 solid 2px / touch-action manipulation / color-scheme light→dark`，
三档布局 6 个视口全 OK，回归 17/17、上线清单 15/15。
## 5.51 项目：原生操作 + 项目栏挪到输入框上方（对齐 Codex）

### 项目栏位置

原来「项目」是输入框里的一颗芯片，跟模型/权限挤在一行。Codex 把它放在**输入框上方**单独一行：
左边「选择项目」，右边直接显示新对话会落在哪里。现在一样：

```text
选择项目 ⌄    Remote
┌───────────────────────────────┐
│ 描述你的任务…                  │
│ GPT-6.1-Sol 低   请求批准      │
└───────────────────────────────┘
```

选择器也照 Codex 做：**搜索框 + 文件夹图标列表 + 这台电脑 + 分隔线 + 新建项目**，
并且固定在触发按钮**上方**弹出（下方就是输入框，往下弹会糊住它）。

### 项目操作（原生 project/* 接口）

右侧栏项目行支持右键、长按、或悬停出现的 ⋯，弹出 Codex 样式的项目卡片：

```text
CodexWork
还没有聊天
D:\CodexWork
────────────────
新建对话
编辑项目
复制路径
删除项目…
```

| 操作 | 调用 |
|---|---|
| 新建对话 | 设 targetProjectId 后 `app.newChat()`，下一轮 `thread/start` 带 `projectId` |
| 编辑项目 | `project/update { projectId, name, roots }` |
| 删除项目 | `project/delete { projectId }`（对话不删，只取消归类） |
| 复制路径 | `navigator.clipboard`，http 下退回 `execCommand` |

编辑项目面板：改名称 + 「更换文件夹…」内嵌目录浏览器（复用 `/api/fs/dirs`，
可以逐级进入、点「用这个文件夹」确认），保存后同时写两处：
`project/update` 写 app-server 的库，`/api/projects/mirror` 写桌面端的
`~/.codex/.codex-global-state.json` —— 两边不同步的话桌面端侧栏就看不到改名。

### 踩到的坑

1. 新芯片不在原来的 `.chip` 类里，文档点击的「点外面关闭」判断把它当成外部点击，
   菜单刚开就被关掉 —— 把 `.proj-pick` / `.proj-target` 加进豁免列表；
2. 新图标 `#i-monitor` 一开始没定义，「这台电脑」那行没有图标；补上 symbol；
3. 空状态的三张快捷卡片用了固定 3 列，面板一打开聊天区变窄就被压成竖排 —— 
   改成 `repeat(auto-fit, minmax(168px, 1fr))`，窄了自动落成一列。

实测：项目栏 `选择项目 / Remote`、选择器 5 项且 `aboveComposer: true`、
卡片头 `CodexWork / 还没有聊天 / D:\CodexWork` + 4 个操作、
「新建对话」后 `targetProjectId` 指向该项目且 `turns: 0`、编辑面板与目录浏览器正常。
## 5.52 模式切换开关：普通 / 计划 / 目标

计划模式和目标模式原来只能靠 `/plan`、`/target`，而且状态显示在输入框里的芯片。
现在项目栏（输入框上方、项目右边）有一个分段开关，一眼能看到当前模式：

```text
选择项目 ⌄   Remote   ┃ 普通 │ 计划 │ 目标 ┃
┌────────────────────────────────────────┐
│ 描述你的任务…                           │
└────────────────────────────────────────┘
```

### 语义

三选一（`role="radiogroup"`）：

| 选项 | 状态 |
|---|---|
| 普通 | `planMode=false, goalMode=false` |
| 计划 | `planMode=true`，下一轮 `turn/start` 带 `collaborationMode.mode="plan"` |
| 目标 | `goalMode=true`，发送时 `thread/goal/set` 把消息设为目标 |

计划和目标原本可以同时开，三档开关只能有一个状态，所以选任一个会**关掉另一个**；
`/plan`、`/target` 命令保留，走同一套 `setMode()`，行为一致。

### 细节

- 关掉计划模式时要让服务端也知道：`thread/settings/update { collaborationMode: { mode: "default" } }`
  （`collaborationMode` 是存在 thread settings 里的，只改本地不生效）；
- 键盘可用：`role="radio"` + 左右方向键切换，`tabIndex` 只给当前项；
- `thread/goal/updated` / `thread/settings/updated` 通知会把开关同步回真实状态（桌面端改了也跟得上）；
- 原来输入框里的两枚模式芯片删掉了，避免和开关重复。

### 实测

```text
initial:            ["普通*","计划","目标"]
placement:          {"rightOfProject":true,"aboveComposer":true}
after 计划:          plan:true  goal:false  chips:0
after 目标:          plan:false goal:true
after 普通:          plan:false goal:false
after ArrowRight:   ["普通","计划*","目标"]
calls after plan send: [{"m":"turn/start","mode":"plan"}]
calls after 普通:      [..., {"m":"thread/settings/update","mode":"default"}]
```

回归 17/17、上线清单 15/15。
## 5.53 对话批量编辑

侧栏顶部新增一个 ✓ 按钮，点开进入多选：

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。

- 每行前面出现复选框，点行 = 选中/取消（不会打开对话）；
- **Shift + 点击** 按当前顺序区间选择，长按任意一行也能进多选；
- 底部工具条：`全选 / 归档 / 移到项目 / 删除 / 取消`，未选中时后三个不可点；
- `Esc` 退出多选。

### 操作走的是原生接口

| 操作 | 调用 |
|---|---|
| 归档 | `thread/archive`（逐个并发） |
| 删除 | `thread/delete`（先确认，删的如果是当前对话就回到空白页） |
| 移到项目 | `thread/metadata/update { threadId, projectId }` |

「移到项目」还额外调用新增的 `POST /api/threads/move`，把 `local_thread_catalog.project_id`
一起改掉 —— 桌面端侧栏读的是它自己的目录表，只走 app-server 的话桌面端看不到归类变化。

### 失败要能读懂

批量操作里最常见的是「这个对话正在别处打开」：

```text
thread 01a1b016-… already has an active writer
```

原来会把原始错误直接甩到 toast 上；现在分类后再提示：

```text
已归档：12 个，3 个正在别处打开（跳过）
```

### 踩到的坑

1. **函数名被按钮 id 抢了**：`function bulkMove()` 和 `<button id="bulkMove">` 同名，
   浏览器把 `window.bulkMove` 指向那个元素，`bulkMove()` 直接 `is not a function`。
   函数改名 `doBulkArchive / doBulkDelete / doBulkMove`；
2. **菜单刚开就被关**：底部工具条不在 `.chip` / `.proj-pick` 豁免列表里，
   文档级的「点外面关菜单」把它当外部点击，`移到项目` 的菜单永远是空的；把 `.bulk-bar` 加进豁免；
3. 忘了给 `dom.selectBtn` 加引用，按钮点击是 `undefined?.addEventListener` 静默跳过。

实测：33 行 → 全选/勾选 2 个 → Shift 扩到 16 个 → 归档成功 15 个（1 个被别处占用）→ 列表剩 21 行；
`移到项目` 菜单 4 项、执行后 `已移到 Remote：1 个`，`/api/threads/move` 返回 `{"ok":true,"updated":1}`，
`local_thread_catalog.project_id` 写入成功。回归 17/17、上线清单 15/15。
## 5.54 项目行 = 名称 + ⋯ + ✎；项目栏合并成一颗芯片

### 侧栏项目行

```text
📁 Remote   5 ⌄   ⋯   ✎
```

- **⋯** 打开项目菜单（新建对话 / 编辑项目 / 复制路径 / 删除项目…）；
- **✎** 直接在这个项目下新建对话（`newChatInProject(pr)`：设 `targetProjectId` → 清空当前视图）；
- 点行本身还是「展开/收起 + 把它设为目标项目」；
- 两个图标常驻显示（悬停加深），触屏同样可见。

### 输入框上方的项目栏

原来是两颗芯片（「选择项目」+ 目标项目），现在合并成**一颗**：

```text
📁 Remote ⌄      ┃ 普通 │ 计划 │ 目标 ┃
┌───────────────────────────────────┐
│ 描述你的任务…                      │
└───────────────────────────────────┘
```

芯片本身就是当前项目：没选时显示「选择项目」，选了就显示项目名（图标变成强调色）。
点它打开选择器（搜索 + 项目列表 + 新建项目），原「此计算机」那颗独立芯片去掉了；
清空项目仍然可以在选择器里选「不使用项目」。

### 踩到的坑

1. `.project-act { opacity: 1 }` 一直被早先那条 `.project-more { opacity: 0 }` 覆盖，
   图标看得见才怪 —— 删掉旧的绝对定位规则，只留 `.project-act`；
2. `updateProjectLabel()` 里还留着写 `#projTargetLabel` 的代码，DOM 删掉后它只是空转，顺手清理；
3. 选择器里「这台电脑」改名「不使用项目」，避免和已经删掉的那颗芯片混淆。

实测：`{"pills":1,"label":"Remote","hasTargetPill":false}`；点 ⋯ 出菜单 4 项；
点 ✎ 后 `target=CodexWork`、`turns:0`、提示「新对话会建在 CodexWork」；
桌面与手机两档截图确认排版；回归 17/17、上线清单 15/15、6 视口 OK。
## 5.55 项目行去掉数量与箭头，菜单只留编辑/删除

```text
📁 CodexWork                      ⋯   ✎
```

- 去掉右侧的会话数量（`2`）和展开箭头（`›`）；
- 展开对话就直接点这一行（`aria-expanded` 仍在，键盘/读屏不受影响）；
- **⋯** 菜单只剩「编辑项目 / 删除项目…」，「新建对话」「复制路径」删掉（新建对话走右边的 ✎）。

### 顺带修掉的真问题：搜索进不了项目

项目里的会话只有在项目展开时才渲染，于是侧栏搜索「qgis」什么都搜不到——
匹配的会话全被折叠隐藏了。现在过滤时强制展开匹配的项目，并隐藏没有命中的项目：

```js
if (q && !threads.length) continue;              // 过滤时跳过空项目
if (q || state.activeProjectId === pr.id) { … }  // 过滤时强制展开
```

同时把 QA 里写死的搜索词（`qgis`）改成从真实会话标题里取，
免得因为某个会话改名就误报。

实测：`{"text":"WebWork","count":false,"caret":false}`；点行 `expanded:true, threads:15`；
菜单 `["编辑项目","删除项目…"]`；回归 17/17、上线清单 15/15。
## 5.56 任务保持与监测（心跳 + 自动续跑）

参考 Kiro Crew 的 Heartbeat 思路：把「会话还活着吗」变成可观测的状态机，
再由守护器按状态自动恢复。全部在客户端实现，没有改协议。

### 心跳

每 2 秒采样一次，活动信号来自通知流（`turn/started`、`item/*`、各种 `*Delta`、
`thread/status/changed`、额度更新）：

| 字段 | 含义 |
|---|---|
| `lastActivityAt` | 最后一次有动静的时间 |
| `step` | 当前步骤（执行命令 / 思考中 / 修改文件 / 调用工具） |
| `startedAt` / `turnId` | 本轮起点 |
| `status` | see below |

状态：`running` / `stalled`（90 秒无活动）/ `disconnected` / `errored` / `blocked`（等额度）
/ `recovering` / `idle`。

### 面板

左侧新增心跳图标「任务监测」：顶部 `N 运行中 / M 保持中`，每一行是
`状态点 · 标题 · 状态 · 已跑 · 最近活动 · 当前步骤`，右侧一颗「保持」开关。
点标题跳到该会话。

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。

### 保持（per-会话开关）

对话页模式开关右边一颗「保持」，选择存 `localStorage`。开启后：

| 触发 | 行为 |
|---|---|
| 连接断开 | 状态转 `disconnected`，重连后先核对 `thread/turns/list`：还在跑就标「仍在运行，无需继续」 |
| 该轮不是活的 | 自动发一条「继续」（带当前 model/effort） |
| 额度用尽 | 状态 `blocked`，按 `resetsAt + 20s` 定时唤醒，刷新额度后继续 |
| 疑似卡住（90s 无活动） | **只提示不动作**（慢思考不能被自动续打断） |

### 安全边界

- 每小时每会话最多自动恢复 **6 次**，冷却 8 秒，超过只提示；
- 发「继续」前一定先查 `thread/turns/list`，有人还在跑就不发；
- 用户点「停止」⇒ 该会话「保持」自动关闭（否则会自己续上）；
- 多标签页用 `localStorage` 选主（10 秒租约），只有一个页签执行恢复。

### 实测

```text
面板:  {"title":"任务监测","rows":1,"status":"task-row is-running | 运行中 · 已跑 6s · 最近活动 0s 前"}
异常结束: turns ["只回复两个字：好的","继续"], note "自动继续（异常结束）"
手动停止: keepOn=false, localStorage=[]
额度:     {"status":"blocked","note":"等额度到 13:36:53"}
断线:     running → note "连接断开，等待重连" → 重连后 note "仍在运行，无需继续"
```

> 说明：`app.js` 是 ES module，模块内函数不是全局的；为了测试和面板调用，
> 末尾把 `window.__keepalive` 上的几个入口暴露出来。
## 5.57 额度耗尽 → 到点自动继续（P3 验证）

真花光额度会把账号锁 5 小时，所以用**协议层桩**验证：页面里替换 `account/rateLimits/read`，
首次返回 `usedPercent:100` + 已过去的 `resetsAt`，第二次返回健康值。其余代码路径都是真的。

### 流程与实测

```text
interrupt while blocked: {"status":"blocked","note":"等额度到 14:08:47"}
+5s   reads:1                       ← 定时器唤醒，重新读额度
+10s  starts:["继续"]  busy:true     ← 自动发「继续」并真的开跑
final {"status":"running","note":"自动继续（额度恢复）"}
```

### 顺带修掉两个真 bug

**① 额度窗口解析**：`resetsAt` 可能是 epoch 秒、epoch 毫秒或 ISO 字符串。
原代码直接 `new Date(resetAt)`，遇到 epoch 秒会得到 1970 年，于是定时器每次都只等 5 秒、
反复空转。现在统一归一化：

```js
const resetMs = typeof resetRaw === "number" ? (resetRaw > 1e12 ? resetRaw : resetRaw * 1000)
                                          : new Date(resetRaw).getTime();
```

**② 额度横幅崩**：`updateQuotaBanner()` 里写死 `q.used.toFixed(0)`，
而有些路径（含保持调度器）只设置 `blocked + resetAt`，`used` 是 undefined，
一点发送就抛 `Cannot read properties of undefined (reading 'toFixed')`。现在缺值就不显示百分比：

```text
改前: 额度已用完，NaN/NaN NaN:NaN 之后才能继续（草稿保留）
改后: 额度已用完，11/7 14:16 之后才能继续（草稿保留）
```

### 额度耗尽时的发送拦截

`state.quota.blocked` 为真时点发送：不发请求、保留草稿、横幅提示 + toast，
实测 `newStarts:0`、`draftKept:"这条不该发出去"`。

回归 17/17、上线清单 15/15。
## 5.58 思考过程不显示：根本没请求过推理摘要

现象：「思考」卡片展开后只有一个 `…`。

### 查到的三层原因

1. **前端从不索取推理摘要**。`turn/start` 里有一个 `summary` 参数
   （`ReasoningSummary = auto | concise | detailed | none`），我们从来没传。
   于是服务端只回一个空的 reasoning item：

   ```json
   {"type":"reasoning","id":"rs_…","summary":[],"content":[]}
   ```

   前端把它渲染成 `text || '…'` → 就是一个省略号。

2. **不是所有模型都会给推理**。实测同一段提问：

   | 模型 | reasoning 事件 | item.summary 长度 |
   |---|---|---|
   | `gpt-6.1-sol`（默认） | 0 | — （连 item 都没有） |
   | `gpt-5.6-terra` | 4 | 1 |
   | `gpt-5.6-luna` | 4 | 1 |

3. **摘要本身是 markdown**（`**Planning step-by-step…**`），原来用 `textContent` 直出，
   展开后是一串星号。

### 修复

```js
params.summary = state.summary || 'auto';          // 1. 每轮都请求摘要
if (!text.trim() && finished) return null;          // 2. 空且已结束的 reasoning 直接不渲染
card.querySelector('.step-body').innerHTML = md(text);   // 3. 按 markdown 渲染
```

### 实测

```text
gpt-5.6-terra: cards:1  text:"**Calculating balls distribution using stars and bars**"
              展开后 bodyH:36.6  → 渲染成粗体一行
gpt-6.1-sol:   cards:0  empties:0   ← 不再出现只有「…」的死卡片
```

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。

> 结论：模型本身不产出推理时（默认的 `gpt-6.1-sol`），谁也变不出思考过程；
> 现在至少不会摆一个空卡片骗人。想看思考，切到 `gpt-5.6-*`。
## 5.59 按 Codex 自测报告修复的 8 个缺陷

报告：`outputs/browser-e2e-20261107/REPORT.md`（7 通过 / 5 失败 / 1 未确认）。
逐条修完并复测：

| # | 报告里的问题 | 修法 |
|---|---|---|
| P1 | 目标状态带入新会话并自动续跑（一条消息跑出 8 轮） | `newChat()` 清 `goal/plan` 状态并对旧会话 `thread/goal/clear`；`thread/goal/updated` **不再**把开关强行打开，只在 `complete/cleared` 时关闭 |
| P1 | 首轮模型与思考强度被默认值覆盖 | 创建线程前先锁住用户选择（`wantModel/wantEffort`），同时传给 `thread/start` 和 `turn/start`，避免 `hydrateThreadMeta()` 用线程默认值覆盖 |
| P2 | Fast 关闭后仍沿用 `priority` | 关掉时显式发 `serviceTier: "default"`（省略字段会继承上一轮） |
| P2 | 退出目标模式只切界面 | 关闭目标模式时调 `thread/goal/clear` 并清本地目标 |
| P2 | 审批重连重放会叠两张卡 | 同一 `request id` 先移除旧卡片再渲染，`state.approvals` 天然去重 |
| 额外 | 多标签页 RPC id 冲突 | `RequestId` 允许字符串：每个页面用 `w<随机>-<n>` 前缀 |
| 额外 | MCP 表单提交空对象 | 按 `inputSchema.required` 校验，缺参直接提示而不是发 `{}` |
| 额外 | 「本会话都允许」只生效一轮 | 该按钮改为 `scope: "session"`（原来一律 `turn`） |

### 复测结果

```text
1) ids are strings: true
2) 目标轮后 newChat: {"goalMode":false,"goal":null,"cleared":true}
3) 首轮参数: thread/start model=gpt-5.6-luna effort=low
             turn/start   model=gpt-5.6-luna effort=low tier=default
4) tiers sent: ["default","default","priority","default"]  ← 关闭后回到 default
5) 退出目标模式 goal/clear 已发送
6) 审批重放后卡片数: 1
双标签并发 15 个请求: A 15/15 B 15/15，前缀 whdaeadz / wu707o9t
```

回归 17/17、上线清单 15/15、6 视口布局 OK。
## 5.60 md 预览打不开：相对路径被解析到桥接目录

现象：点一个 `.md`（或模型给的相对路径）打不开，面板里只有一行错误。

### 定位过程

先用绝对路径试：`C:/…/outputs/browser-e2e-20261107/REPORT.md` → 标题、表格、代码块全部正常。
再逐个换入口复现：

```text
backslash path  -> prose:1  3447 字   ✅
relative path   -> prose:0    13 字   ❌  ← outputs/…/REPORT.md
big file (72KB) -> prose:1 72003 字   ✅
大写 .MD / front-matter / 任务清单 / 表格 -> 全部 ✅
手机视口 390×844 -> ✅（渲染在抽屉里，正常显示）
```

原因：`/api/file` 里只有一句 `path.resolve(target)`，相对路径是按**桥接进程的工作目录**
解析的，而不是会话的工作目录，所以模型写的 `outputs/…/REPORT.md` 一律 404。

### 修复

1. **前端**把相对路径按会话 `cwd` 拼成绝对路径，并处理 `@attachments/…`
   （真正目录是 `<cwd>/.attachments`）；
2. **桥接**新增 `?cwd=` 参数，并在相对路径时回退到 `cfg.defaultCwd`；404 响应带上解析后的路径；
3. 404 的提示改成「找不到这个文件：…（相对路径会按当前会话的工作目录解析）」。

### 复测

```text
md-fixtures/rel.md          -> prose:1 tables:1 切到预览正常
@attachments/rel.md         -> prose:1 正常
C:\…\REPORT.md（反斜杠）   -> prose:1 3447 字
big.md（72KB）              -> prose:1 72003 字
```

### 顺带排掉的端口事故

为验证而重启桥接时发现 `8791` 被一个**已退出进程**的 socket 占着（`netstat` 里的 PID 已不存在），
导致桥接反复 spawn app-server 失败（os error 10048）。处理：

- 桥接的 app-server 改到 `8792`（`config.json` 的 `appServerPort`）；
- 67 个测试脚本里写死的 `ws://127.0.0.1:8791` 改成从 config 读取端口，不再硬编码。

回归 17/17、上线清单 15/15。
## 5.61 接入 ClawBot（dsh-wechat 插件）做文件收发与任务提醒

原来的微信通道是「网页版文件传输助手 + CDP 驱动浏览器」，换账号/换设备就容易掉，
因为会话在浏览器里。`dsh-wechat` 插件走的是腾讯官方 iLink 网关，绑定信息落在
`<DSH_HOME>/wechat/state.json`，和浏览器无关——所以这次把它接成**首选**通道。

### 为什么是「调 CLI」而不是重写协议

插件本身就导出了一个给外部脚本用的命令（源码注释原话：*the command an agent's own script calls
instead of the iLink API*）：

```shell
dsh-wechat-send "消息内容"
dsh-wechat-send "照片来啦" --file C:\path\to\image.png
```

桥接只需要：找到 CLI → 读 `state.json` 判断是否已绑定 → spawn。协议、CDN 上传、额度窗口
全部由插件负责，我们不去复制它的实现。

### 桥接（`bridge/clawbot.mjs` + 三个接口）

| 接口 | 作用 |
|---|---|
| `GET /api/claw/status` | 插件是否安装、是否已扫码（读 `state.json` 的 `accounts`）、botId |
| `POST /api/claw/send` | 发文本和/或一个文件；立即返回 `jobId`，上传在后台跑 |
| `GET /api/claw/job?id=` | 轮询发送结果 |
| `GET /api/claw/inbound?cwd=` | 列出 `<cwd>/媒体/` 里由 ClawBot 收到的文件 |

CLI 解析顺序：`config.clawCliPath` → `dsh-wechat-send`（PATH）→
`<DSH_HOME>/profiles/*/node_modules/dsh-wechat-plugin/cli.js`。

### 前端

- 「发送到微信」优先走 ClawBot：先查 `/api/claw/status`，已绑定就直接发文件，失败再退回旧通道；
- 网络面板微信区下面多了一张 ClawBot 卡片：状态徽章（已绑定/未扫码/未安装）、
  「任务结束提醒」开关、「发测试消息」；
- `turn/completed` 时如果开关打开，推一条 `✅ 任务完成：<会话名>（4 秒）` / `⚠️ 任务失败：…`。

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。

### 实测（用假 CLI 验证链路）

```text
status: {"installed":true,"loggedIn":false,"plugin":"<workspace>/claw-fake/cli.js"}
send:   job done，CLI 收到 ["来自网页","--file","<workspace>/claw-fake/from-ui.txt"]
notify: ["✅ 任务完成：New chat（4 秒）"]
关闭开关后: 不再发送
```

### 要用起来还差一步（需要你操作）

这台机器上**还没装** dsh-wechat 插件（`~/.dsh/wechat/state.json` 不存在），所以卡片显示「未安装」。
在你的 DSH 里装一次并扫码：

```shell
dsh plugin --profile desktop add dsh-wechat-plugin
# 或在 设置 → 插件 → 添加插件 里填 dsh-wechat-plugin
```

启用后打开 **设置 → 微信** 扫码绑定，之后刷新本页面，卡片会变成「已绑定」，
发送与提醒自动切到 ClawBot，不再依赖浏览器会话。
## 5.62 不装 DSH 插件也能绑定 ClawBot（扫码在网页里完成）

上一节把 ClawBot 的发送链路接好了，但绑定还得装插件、重启 DSH。这次把绑定也搬进网页：

**关键发现**：插件打包了 `@dsh-wechat/core`，README 原话是 *zero DSH dependency*，
它导出 `login()` / `StateStore` / `fetchQRCode`，而且写的就是同一份
`<DSH_HOME>/wechat/state.json`。所以桥接可以直接驱动它，不需要 DSH 参与。

### 做法

1. 把插件包**放到仓库里**：`codex-remote/vendor/dsh-wechat-plugin/`（`npm pack` 解出来的原文，
   `cli.js` 的 `@dsh-wechat/core` 说明符已被构建期改写成相对路径，拷过来就能跑）；
2. `bridge/claw-login.mjs` 用 `AsyncGenerator` 驱动登录：
   - `qr` → 用 `qrcode` 包渲染成 PNG data URL；
   - `scanned` / `expired` / `redirected` → 更新文案；
   - `verifycode-required` → 挂住，等网页提交验证码；
   - `confirmed` → `store.update()` 把账号写进 `state.json`；
3. 四个接口：`/api/claw/login`、`/api/claw/login/start`、`/api/claw/login/code`、`/api/claw/login/cancel`；
4. 卡片里点「扫码绑定」直接出二维码，扫完自动变成「已绑定」。

**登录态要跨面板重绘存活**：网络面板会定时重画，第一版把 QR 放在卡片里，一重画就没了。
现在登录状态放在模块级 `clawLogin`，卡片只负责 `paintClawLogin()`。

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。

### 实测

```text
status: installed:true  plugin: codex-remote/vendor/dsh-wechat-plugin/cli.js
login : phase=qr  QR 2474B  「用微信扫一扫，扫完在手机上点确认」
CLI   : node vendor/…/cli.js --help  → exit 0（依赖解析正常）
```

### 现在就能用

打开 **网络与连通性** → ClawBot →「扫码绑定」→ 微信扫 → 手机确认。
绑定后：发送按钮优先走 ClawBot；勾选「任务结束提醒」，每轮结束会推一条摘要到微信。
## 5.63 「还没有绑定的微信对话」的根因：没人收消息

现象：扫码绑定成功，但一发就报「这台电脑上还没有绑定的微信对话。请先在微信里给机器人发一条消息。」
照做也没用。

### 根因

`dsh-wechat-send` 发消息前要先在 `state.json` 里找到一条 **binding**（会话绑定），
而 binding 只有**收消息的长轮询**才会创建：

```text
state.json 里当时是：accounts:1  bindings:{}  contextTokens:{}  syncBufs:{}
                              ↑ 空 —— 因为桥接只调 CLI，从来没有跑过 poll 循环
```

所以用户那条微信消息根本没人收，binding 自然建不出来，CLI 就一直报错。

### 修复：桥接自己跑收消息通道

`bridge/claw-channel.mjs` 用 core 导出的 `ChannelMonitor`，**每个账号一条长轮询**：

| 回调 | 干什么 |
|---|---|
| `onMessage` | 写 `bindings` + `contextTokens`（插件同款结构）、下载附件到 `<workspace>/媒体/`、进收件箱 |
| `onSyncBuf` | 把游标按账号存进 `syncBufs[accountId]` |
| `onStop` | stale-token 停手等重新登录，其余 15 秒后重启 |

绑定成功后（`claw-login` 的 `confirmed`）立刻调用 `startChannel()`，新账号无需重启桥接就会开始收消息。

### 多账号：各自接续

`state.json` 本来就是按账号存的：`accounts` / `bindings` / `syncBufs` / `contextTokens` 全部以
`ilink_bot_id` 为键。所以：

- 每个账号一条 monitor，互不干扰；
- 各自保存轮询游标 → **切回某个账号时从自己上次的位置继续，不重放、不丢消息**；
- 发送按「最近活跃的会话绑定」走，也就是**你最后用哪个账号发消息，回复就回到哪个账号**。

### 实测

```text
收消息: users 发「1」 → bindings 1 条、contextTokens 1 条、syncBufs 1 条、inbox 1
发文本: 已通过微信发送：消息
发文件: 已通过微信发送：消息、文件 claw-send-test.txt
重启桥接后（模拟换设备）：bindings 1 / syncBufs 1 保留，通道 running，再发仍然成功
```

### 现在页面上的样子

ClawBot 卡片会显示：通道运行状态、`n/n 个账号在收消息`、最近收到的消息（带文件的点开就是预览）、
「重启通道」按钮。

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。
## 5.64 主动推送、多账号切换、去掉旧通道、文件自动入挂载列表

### 1. 不先发消息也能收到推送

之前失败在 `ret=-2 prepare failed`：CLI 会把最近一条消息的 `context_token` 一起发上去，
那个 token 带「一条用户消息 = 一个回复窗口」的额度，用完就被拒。

实测发现 iLink **接受不带 context_token 的主动消息**：

```js
await core.sendText({ account, to: peerId, text })   // 不传 contextToken
// → { clientId, serverMessageId } 手机立刻收到
```

所以 `bridge/claw-send.mjs` 自己发，不再依赖 CLI：文本走 `sendText`、文件走
`uploadFile` + `sendFile`。任务完成的提醒因此不需要你先说一句话。

### 2. 切换账号

- `GET /api/claw/accounts` 列出所有绑定账号 + 每个账号的会话与最近活跃时间；
- `POST /api/claw/account/active` 写入 `config.clawAccount`，发送与提醒都走这个账号；
- 卡片里有「发送账号」下拉，多账号时显示 `n 个账号，各自接续`；
- 每个账号在 `state.json` 里各有 `bindings` / `syncBufs` / `contextTokens`，切回去从自己的游标继续。

### 3. 旧「微信文件传输助手」通道整段删除

| 删掉的东西 | 说明 |
|---|---|
| `bridge/wechat-web.mjs` | CDP 驱动网页版的登录/发送 |
| `bridge/wechat-fetch.mjs` | 服务端解密下载循环 |
| `/api/wechat/*` 共 11 个接口 | state / qr / send / job / reset / click / watch … |
| `paintWxCard` `renderWxNetSection` `openWechatFiles` `pollWechatJob` `startWechatAutoMount` | 前端 400+ 行 |

现在只剩 ClawBot 一条通道，`/api/wechat/state` 已不存在（回落到静态页）。

### 4. 微信收到的文件自动进挂载列表

- 通道把附件解密到 `<workspace>/媒体/`（本次实测收到 34.6MB 的 pptx）；
- `GET /api/claw/files?cwd=` 列出这些文件；
- 前端每 20 秒检查一次，新文件**自动挂载**到输入框，并提示「微信收到 X，已挂载」；
- 附件菜单的第二项从「微信文件传输」改成「微信收到的文件（ClawBot）」，点开就是可挂载列表；
- 「最近文件」面板也把 ClawBot 收到的文件并进来源，标注「微信收到（ClawBot）」。

### 实测

```text
proactive send : done | 已通过微信发送：消息        ← 未先发消息
attach menu    : ["拍照 / 选文件","微信收到的文件（ClawBot）"]
claw files     : ["程子函2026171309.pptx"]
mount          : 已挂载 34.6MB pptx，重复点不会重复挂载
auto mount     : 新文件自动加入 attachments
accounts       : 下拉显示 8486c379be23 · 1，可切换
regression     : QA 16/16、上线清单 15/15、6 视口 OK
```

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。
## 5.65 多个微信 bot 同时在线 + 账号名 + 连接状态

### 能不能同时连多个微信 bot

**能，而且是并行收消息，不是二选一。** 依据是数据结构本身就按账号分开：

```json
{ "accounts":     { "<botid>": { token, baseUrl, userId } },
  "bindings":     { "<conversationId>": { accountId, peerId, ... } },
  "syncBufs":     { "<botid>": "<游标>" },
  "contextTokens":{ "<botid>": { "<conversationId>": "<token>" } } }
```

`startChannel()` 给 `accounts` 里**每个**账号各起一条 `ChannelMonitor`，各自一个 `AbortController`、
各自一个游标。所以 A 号在收消息的同时 B 号也在收，互不阻塞；断了各自重启。

扫码登录时会把已持有的 token 作为 `existingTokens` 传给 `login()`，避免「再扫一次把原来的挤掉」。

> 说明：本机只绑了一个微信号，第二个需要你用另一个微信扫；多账号的并行/隔离是按上面的结构实现的，
> 双账号联调需要你这边补一次扫码。

### 账号名

iLink 的入站消息里**没有昵称字段**（`WeixinMessage` 只有 `from_user_id` / `ilink_user_id` 这类不透明 id），
所以名字由我们自己维护：

- 默认 `微信 1` / `微信 2`…，按绑定顺序；
- 每行右侧「改名」写入 `bridge/claw-labels.json`，`listAccounts()` 读回 `displayName`；
- 改名不影响发送，只是显示。

### 连接状态（实时）

`channelSnapshot()` 现在带 `paused` / `remainingPauseMs` / `lastMessageAt` / `messages` / `error`，
`/api/claw/accounts` 把两者按 `accountId` 合并，卡片按账号显示：

| 徽章 | 含义 |
|---|---|
| 已连接 | monitor 在跑且没被限速 |
| 暂停 N 秒 | token 过期冷却中（`monitor.paused`），到期自动恢复 |
| 连接中 | 刚启动、还没收到第一轮响应 |
| 出错 | 循环报错，hover 看原因 |
| 未连接 | monitor 已停止 |

鼠标悬停还会显示「最后收到 X 前」。

### 切换

点账号名前的圆点设为**发送账号**（写 `config.clawAccount`）：文件、测试消息、任务提醒都走它。
注意这只影响「发」，接收永远是多账号同时进行。

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。

### 实测

```text
accounts: [{"n":"微信 1","ch":"running","paused":false}]
改名 → {"ok":true,"name":"主力号"} → displayName: ["主力号"]
卡片: ● 主力号 [已连接] 改名 / + 绑定另一个微信 / 通道：运行中 · 1/1 个账号在收消息
QA 16/16、上线清单 15/15
```
## 5.66 每个微信独立的登录/退出/测试/重连，以及「多个连接」的根因

### 多个连接从哪来

两个来源，都在这次修掉了：

1. **桥接被启动了不止一份**。计划任务重复触发时，旧进程不会自己退，两份桥接各自给同一个 bot
   开一条长轮询 → 消息重复、状态对不上。现在 `main()` 开头先探 `http://127.0.0.1:<port>/healthz`，
   已经有桥接在跑就 `process.exit(0)`（实测再点一次启动，进程数仍是 1）。
2. **同一账号起过两条 monitor**。`startChannel()` 原来只在 `status === running` 时跳过，
   状态是 `error`/`stopped` 时会再起一条而旧的还挂着。现在不管旧的是什么状态，先 `abort()` 再新建，
   保证「一个账号一条长轮询」。

### 每个账号独立的四个动作

卡片里每个账号一行：`● 名字 [状态] 测试 重连 退出`

| 动作 | 接口 | 做什么 |
|---|---|---|
| 测试 | `POST /api/claw/account/test` | 只给这个账号发一条测试消息，走它自己的绑定 |
| 重连 | `POST /api/claw/account/reconnect` | 只 abort + 重启这个账号的 monitor，其他账号不受影响 |
| 退出 | `POST /api/claw/account/logout` | 停 monitor，并从 `state.json` 删掉它的 `accounts`/`bindings`/`contextTokens`/`syncBufs`/`quota`，名字也清掉 |
| 登录 | 卡片「+ 绑定另一个微信」 | 扫码新增一个账号，已绑定的不受影响 |

### 关于「主动推送」的更正

上一节我写「不带 context_token 就能主动推」——**不准确**。core 的注释把话说清楚了：

> 「prepare failed」是**需要一个入站消息**的会话；「rate limited」才是要等一会儿。

所以微信侧的窗口是真实存在的：一条用户消息才开一个会话。现在的处理是——
发不出去就**入队**（同 `pendingNotifications` 结构），用户随口回一句，通道收到入站消息时
自动把队列补发出去。测试按钮会如实显示：

```text
{"ok":false,"queued":true,"error":"微信要等你先给它发一条消息才能推：已排队，你回一句话后自动补发"}
```

### 手机上那张旧二维码

截图里「微信 / 扫码登录 / 仅传输文件」是**旧版残留页面**：现在的静态资源里已经没有这个弹窗
（`app.js` 里搜不到「仅传输文件」，`/api/wechat/*` 也已整个删除）。手机上那个标签页是删除前加载的，
刷新一次即可。`html/js/css` 一直是 `cache-control: no-cache` + ETag，正常刷新就会拿到新代码。

### 实测

```text
重复启动任务 → 进程仍 1 个（PID 21604）
accounts: [{"n":"子函","ch":"running"}]
test    → {"ok":false,"queued":true,...}（窗口未开时入队）
reconnect → {"ok":true,"account":{"status":"running"}}
logout(未知账号) → {"ok":false,"error":"没有这个账号"}（不会误删）
手机 390px：● 子函 [已连接] 测试 重连 退出，无溢出
QA 16/16、上线清单 15/15、6 视口 OK
```

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。
## 5.67 面板重复出现、勾选批量操作、最多三个微信

### 为什么面板会重复

`renderClawCard(host)` 是**追加**一张卡片，而它被 20 秒的定时器反复调用：

```js
wxNetTimer = setInterval(() => { renderClawCard(clawSlot); }, 20000);  // 每次 +1 张
```

所以开一会儿面板就叠出 2 张、3 张。修法是渲染前先清掉同一容器里的旧卡片：

```js
for (const old of host.querySelectorAll(".claw-card")) old.remove();
```

实测：`cards: 1`，等过一次 20 秒重绘后仍然是 `cards after repaint: 1`。

### 勾选任意个账号批量操作

每个账号前面一个复选框，下方一条批量栏：`已选 N 个：测试 重连 退出`，
另外「给选中的账号开提醒」按账号写进 `localStorage`（`claw-notify` 现在是一个 id 数组，不再是全局开关）。

每个账号行右侧还有 `静音 / 提醒` 小开关，单独控制这个号收不收任务提醒。

批量测试是逐个账号调用 `/api/claw/account/test`，所以结果能分开报：

```text
1 个已发出，1 个已排队（等你在微信里回一句话）
```

（窗口开着的那个立刻到，没开窗口的进队列等补发——这正是上一节说的行为。）

### 最多三个微信

两处一起拦：

- 前端：「+ 绑定另一个微信」在 3 个时变成「已满 3 个（先退出一个）」并禁用；
- 桥接：`startLogin()` 在 `accounts >= 3` 时直接返回 `最多绑定 3 个微信，先退出一个再扫`，
  避免有人绕过界面硬扫。

标题也直接写 `账号 · 2 / 3`。

### 再加一个自愈

有的账号会自己掉线（网络抖动、token 冷却）。新增 45 秒一轮的巡检：状态是 `stopped`/`error`
的账号会被重新拉起来，不用等用户点「重连」。

### 实测

```text
cards: 1 → 20 秒后 cards after repaint: 1
账号 · 2 / 3，两行都显示 已连接 / 未连接 + 静音
已选 2 个：测试 重连 退出（退出为红色）
批量测试 → 「1 个已发出，1 个已排队（等你在微信里回一句话）」
QA 16/16、上线清单 15/15
```

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。
## 5.68 账号卡片收敛：昵称、行内提醒开关、底部 + 号

### 昵称这件事得说清楚

iLink 协议**没有昵称字段**。三个相关类型翻遍了：

| 类型 | 字段 |
|---|---|
| `WeixinMessage`（入站消息） | `from_user_id` / `ilink_user_id`，都是 `o9cq…@im.wechat` 这种不透明 id |
| `QRStatusResponse`（扫码结果） | `ilink_bot_id` / `ilink_user_id` / `bot_token`，没有名字 |
| `GetConfigResp` | 只有 `typing_ticket` |

所以昵称只能是**你告诉我**。做法：

- 绑定成功的那一刻弹一次输入框「给这个微信起个名字」；
- 平时点账号名也能改（`claw-labels.json` 持久化）；
- 没起名时默认显示 `微信 1 (e012)`——括号是 bot id 前四位，两个号至少能区分。

### 卡片按你说的收敛

```text
ClawBot                            [已绑定]
任务结束可以推送到勾了「提醒」的微信
账号 · 2 / 3
☑ ● 微信 1 (e012)   已连接  [ 提醒 ]
☐ ● 微信 2 (8486)   已连接  [ 提醒 ]
已选 2 个  [测试] [重连] [退出]
+ 添加微信
通道：2/2 在收消息
```

改了什么：

- **提醒**从底部大按钮变成每行的开关（`role="switch"`，按账号存 `localStorage`）；
- 删掉「给选中的账号开提醒」「发测试消息」「全部重连」三行；
- 删掉「+ 绑定另一个微信」，改成账号列表**最后一行**的 `+ 添加微信`；
- 满 3 个时那一行变成 `已满 3 个（先退出一个）` 并禁用。

### 实测

```text
cards: 1 → 20 秒重绘后仍 1
账号 · 2 / 3；两行都带状态与「提醒」开关
已选 2 个 → 测试/重连/退出 才可用
默认名：微信 1 (e012) / 微信 2 (8486)
QA 16/16、上线清单 15/15
```

> 截图已从仓库移除（含账号信息），本地 `docs/` 里仍有。
## 5.69 微信里直接下任务：消息 ↔ Codex（插件核心功能）

之前只做了「推送」和「收文件」，插件真正的价值是**双向对话**：微信发一句话就是给 Codex 下任务，
跑完把答案发回微信。这次把它实现了，而且不依赖 DSH——桥接自己按 app-server 协议连过去。

### 结构

```text
微信 → 通道长轮询(claw-channel) → handleClawMessage(claw-agent)
                                        │  /指令 ？直接回复
                                        └─ thread/start 或复用 · turn/start · 等 turn/completed
                                            └→ 答文分片回微信（带原消息的 context_token）
```

`claw-agent.mjs` 里有一个极简 RPC 客户端（`initialize` → `initialized` → 带 id 的请求），
只做四件事：开局、发回合、收通知、取最后一条 `agentMessage`。

### 指令

| 指令 | 作用 |
|---|---|
| `/new` | 新建会话并绑定到这个微信 |
| `/list` | 最近 10 个会话（带序号） |
| `/switch N` | 切到第 N 个 |
| `/current` | 当前绑定的是哪个 |
| `/cancel` | `turn/interrupt` |
| `/model` / `/model 名字` | 列模型 / 切模型 |
| `/help` | 指令表 |

**每个微信账号各自绑定一个线程**（`claw-threads.json`），互不打扰；长答文按 1100 字分片，
优先在换行处断开，别让一条消息变成一堵墙。

线程在外边被删掉时会自动新建一个再重试，不会回你一句 `thread not found`。

### 实测

```text
微信消息「只回复两个字：收到」→ 11 秒后微信收到「收到」
/help    -> 0.4s  指令表
/current -> 0.3s  当前会话：只回复两个字：收到
/list    -> 0.4s  1. … 2. … 3. …
pendingNotifications: 0（说明回复是在窗口内直接送达的，没有排队）
```

### 还差一块：审批

插件还能把「需要批准」的请求发到手机、用序号回答。这一块**还没做**——
远程跑长任务时如果卡在审批，目前只能回网页点。下一步要补的是：
审批请求 → 微信发「1 允许 / 2 拒绝」→ 下一条数字消息即回答（而不是被当成新任务）。

QA 16/16、上线清单 15/15。
## 6. 目录结构

```text
codex-remote/
├── bridge/
│   ├── server.mjs         # 桥接服务：静态页 + 口令登录 + WS 代理 + app-server 守护
│   ├── config.json        # 端口 / 口令 / 工作目录 / codex.exe 路径
│   ├── e2e-test.mjs       # 端到端自测（登录→建会话→跑一轮→清理）
│   └── logs/bridge.log
├── web/
│   ├── index.html         # 应用骨架（含 SVG 图标 sprite）
│   ├── style.css          # 桌面端同款视觉规范
│   ├── app.js             # app-server 协议客户端 + 渲染
│   └── tokens.css         # 从桌面端 CSS 合并出的 1806 个设计变量
├── scripts/
│   ├── start-bridge.vbs   # 无窗口启动器
│   ├── install-autostart.ps1
│   └── setup-tunnel.ps1   # Cloudflare Tunnel 一键配置
├── protocol/              # codex app-server 官方 TS 绑定（协议权威来源）
├── docs/                  # 截图 + 协议小抄
└── desktop-webview/       # 从 Codex 桌面端 app.asar 提取的原始前端（620 MB，仅作参考）
```

`desktop-webview/` 只是取证用的参考物，运行时完全不需要，可以删：

```powershell
Remove-Item .\desktop-webview -Recurse -Force
```

---

## 7. 关于「直接搬桌面端前端」这条路

我验证过可行性：桌面端前端（`webview/`，Vite+React）通过 `window.electronBridge` 和一条 `MessageChannel` 跟主进程通信——渲染端 `connect-app-host-*.js` 里就 4 行：

```js
const { port1, port2 } = new MessageChannel();
window.postMessage({ type: 'connect-app-host', port: port2 }, origin, [port2]);
return wrapStream(port1, handler);
```

也就是说，只要在浏览器里注入一个 `electronBridge` 垫片、把 `port2` 接上 WebSocket，**理论上可以把桌面端那份 UI 原样跑起来，像素级一致**。

没这么做的原因（也是这次的取舍）：
- 主进程那一侧的帧格式要逆向（`preload.js` 只是其中一小片），以及 `getInitialSidebarBootstrap`、`getSharedObjectSnapshot` 等启动期状态都得伪造；
- Codex 桌面端更新很频繁（本机从 26.1013 升到 26.1027，`config.toml` 里的哈希路径就全失效了），逆向出来的桥接会跟着碎；
- 文件拖拽、git 面板、嵌入式浏览器这些依赖 Electron 的能力在浏览器里天然没有。

如果你更想要「100% 同款但可能随时碎」，我可以把这条路径做成第二套可切换的前端（`web/desktop-bundle/`），失败就回落到现在这套。

---

## 8. 排错

| 现象 | 处理 |
|---|---|
| 页面一直「已断开，正在重连…」 | `Get-Content bridge\logs\bridge.log -Tail 30` 看 app-server 有没有起来；再看 8791 是否被别的进程占用 |
| 登录一直失败 | 口令从 `config.json` 复制，注意别带空格；连续错 8 次要等 5 分钟 |
| iPad 打不开局域网地址 | 确认 iPad 和电脑在同一个 Wi-Fi（不是访客网络/开了 AP 隔离）；防火墙见第 4 节 |
| 发消息后立刻「执行失败」 | 多半是账号额度（本机 2026-11-03 实测：`usageLimitExceeded`，提示 11-04 03:37 恢复）；换模型或等额度 |
| 会话列表空 | `thread/list` 只列交互式来源；确认这台机器 `~/.codex` 登录态正常（`codex login status`） |

自测一条命令（会新建一个会话、发一句「只回复两个字：收到」、然后删掉）：

```powershell
cd bridge; node e2e-test.mjs
```
