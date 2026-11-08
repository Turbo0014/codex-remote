# Codex Remote

把本机的 **Codex CLI** 变成一个可以在手机、平板、另一台电脑上用的网页控制台，并且把微信变成远程遥控器。

- 浏览器一端：对话、项目管理、文件预览、审批、批量操作、离线续跑
- 微信一端：发一句话就是给 Codex 下任务，答完回到微信；文件双向传；任务结束推送
- 全程走局域网或你自己的隧道，不经过第三方中转

> 这个仓库是长期迭代的产物，逐条修复记录在 [docs/DEVLOG.md](docs/DEVLOG.md)（非常长，按问题组织，遇到怪现象可以先搜那里）。

---

## 应用场景

**一句话：手机上用的不是「另一个模型」，而是你那台远程主机上的 Codex 环境。**

连上去之后，MCP 服务器、插件、SKILL、项目文件上下文、审批策略，全都和坐在电脑前一样——
跑的是同一套工具链、同一个工作目录、同一个会话历史。所以它更接近「把 Codex 搬进口袋」，
而不是 ChatGPT 移动端那种只能聊天、看不见你仓库、动不了你机器的形态。

具体能干什么：

| 场景 | 在手机上怎么做 |
|---|---|
| **轻量开发** | 改一行、跑个命令、看 diff、过一眼审批。不用开电脑，也不用把仓库同步到别的机器 |
| **MCP / 插件 / SKILL** | 主机上装了哪些 MCP、哪个 SKILL 都照常可用；对话里直接 `/` 唤起 SKILL |
| **文件上下文** | 对话里点开的就是主机上的真实文件：md / 图片 / PDF / 源码都能预览，改完还能发回微信 |
| **长任务托管** | 一次跑十几分钟的任务交给它；断线会重连，异常会自动「继续」，额度用完恢复后自动续跑 |
| **不在电脑前也能批** | 审批、二选一提问都在网页里点；跑完推一条到微信 |
| **纯微信遥控** | 连网页都不想开时，微信发一句话就是下任务，答完回到微信；文件双向传 |

换句话说：**主机负责算力和环境，你负责在哪儿都行。**

---

## 它解决什么问题

Codex CLI 本身很好用，但：

1. 只能在终端里用，锁屏/离开电脑就断了；
2. 一次任务跑十几分钟，人不可能一直盯着；
3. 手机上看不到进度，也没法批准命令。

Codex Remote 在中间放一个桥接进程：

```text
浏览器 / 手机 ──HTTP+WS──┐
                         ├── bridge (node) ──WS── Codex app-server (codex.exe app-server)
微信 ClawBot ──iLink─────┘
```

桥接只做三件事：**转发**（把 app-server 的协议搬给浏览器）、**保活**（断线/额度/异常自动续跑）、
**转接**（把微信消息变成 Codex 回合）。

---

## 功能

### 网页一端

| 能力 | 说明 |
|---|---|
| 对话 | 流式输出、思考卡片、命令卡片、文件变更、Markdown + 数学公式、代码高亮 |
| 项目 | 按项目分组，新建/改名/删除，项目内新开对话，批量归档/移动/删除 |
| 文件 | 右侧抽屉预览（md / html / 图片 / PDF / 源码）、下载、发到微信 |
| 审批 | 命令审批与权限申请，支持「本会话都允许」 |
| 模式 | 普通 / 计划 / 目标，切换同步到服务端 |
| 保活 | 断线重连、异常结束自动「继续」、额度恢复后自动续跑、任务面板 |
| 移动端 | 从手机布局到 iPad 横屏都做过对照检查 |

### 微信一端（ClawBot）

走腾讯官方 iLink 网关（[dsh-wechat](https://github.com/xcisxc29/dsh-wechat) 的协议层），**不需要公网 IP**。

| 能力 | 说明 |
|---|---|
| 收发消息 | 微信发一句话 → Codex 回合 → 答案分片回微信 |
| 指令 | `/new` `/list` `/switch N` `/current` `/cancel` `/model` `/help` |
| 文件 | 微信发来的文件自动落到工作区并挂载；网页里的文件可以发回微信 |
| 通知 | 任务结束推送到勾选了「提醒」的账号 |
| 多账号 | 最多 3 个微信同时在线，各自绑定各自的线程、各自的轮询游标 |

---

## 快速开始

要求：Node 20+、本机已安装 Codex CLI（`codex.exe`）。

```bash
git clone https://github.com/Turbo0014/codex-remote.git
cd codex-remote/bridge
npm install
cp config.example.json config.json   # 填 passcode / codexExe / defaultCwd
node server.mjs
```

打开 `http://127.0.0.1:8787/`，用 `config.json` 里的 `passcode` 登录。

### 配置（`bridge/config.json`）

| 键 | 作用 |
|---|---|
| `passcode` | 网页登录口令（必填，首次启动会自动生成） |
| `secret` | cookie 签名密钥（自动生成） |
| `codexExe` | Codex CLI 路径；留空则自动查找 |
| `defaultCwd` | 默认工作目录 |
| `port` / `appServerPort` | 网页端口 / app-server 端口 |
| `fileScope` | `home`（默认，限制在家目录）或 `any` |
| `officePython` | PDF 转图用的 python；留空自动发现 |
| `appRoots` | Photoshop / QGIS 的安装根目录，用于「未启动时拉起」 |

`bridge/config.json` 已在 `.gitignore` 里，**不会被提交**。

### 微信绑定

1. 网页左侧打开 **网络与连通性**
2. ClawBot 卡片里点 **+ 添加微信**
3. 手机微信扫码 → 确认 → 给它起个名字
4. 在微信里给它发一句话，通道会自动建立会话绑定

最多 3 个微信；每个账号都能单独测试 / 重连 / 退出，也能勾选批量操作。

---

## 目录

```
bridge/         桥接进程
  server.mjs        HTTP + WS，静态资源，Codex 代理
  claw-*.mjs        微信通道：登录、长轮询、发送、回合桥接
  wechat-*.mjs      微信相关的辅助模块
web/            浏览器端（原生 JS，无构建）
vendor/         随仓库携带的 dsh-wechat 插件副本（MIT）
scripts/        Windows 计划任务 / 隧道 / 自启
docs/           开发记录
```

---

## 已知限制

- **微信没有昵称 API**：iLink 只给不透明 id，账号名由你设置一次后保存在本地。
- **主动推送有窗口**：一条用户消息只能开一个回复窗口，窗口关了会排队，等你下次说话自动补发。
- **审批还不能在微信里回答**：需要审批时得回网页处理。
- 只在 Windows 上验证过；Linux/macOS 大概率要改路径与进程发现逻辑。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

`vendor/dsh-wechat-plugin` 来自 [xcisxc29/dsh-wechat](https://github.com/xcisxc29/dsh-wechat)，同样是 MIT。
