# dsh-omni

> **我想给大肥鱼完整的一生！！！**

**这是QQ ↔ DeepSeek Harness 的整合包。** 把 QQ（SnowLuma / OneBot v11）接到 DeepSeek Harness，让 DSH agent 以 QQ 会话的形式聊天、发表情、发语音、看 B 站卡片、上网查梗、记住群里的事、潜水与唤醒，并附带控制台和 DSH 设置页入口。

这不是一个“QQ 机器人框架”，更像一次长期实验：把 QQ 当身体，把 DSH 当大脑，把表情、语音、记忆、黑话、B 站、联网搜索都接成感官，看一个 agent 能不能在真实的群聊里活得像个具体的人。

> 本仓库基于 [qq-bridge](https://github.com/Derpyu520/qq-bridge)（Derpyu520，MIT）做整合与二次开发；B 站能力复用 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（c1overzz，MIT）。署名与许可证见 [NOTICE.md](NOTICE.md)。

[English README](README.en.md)

---

## 特性

- **QQ ↔ DSH 会话桥接**：群聊/私聊消息进入独立 DSH 会话，agent 的回复通过工具发回 QQ。
- **四种模式**：`chat`、`reserved`、`reserved2`（仿真）、`closed-agent`，可在控制台切换。
- **大功能开关**：控制台「运行总览」一页开关一代/二代仿真、B 站卡片、联网搜索、语音、表情包、黑话学习、主动机会、看图与长期记忆；细粒度工具开关在「二代仿真」页。
- **reserved2 仿真**：分条发送、引用、唤醒/潜水、拍一拍、主动机会、回复检查、长期记忆。
- **表情包**：同步 QQ 收藏表情、AI 看图标注、按情绪搜索、按语义自检、可配置发送概率与“发完文字后提醒补一张”。
- **B 站卡片**：解析 QQ 小程序卡（`b23.tv` → `BV...`），把标题/BV 注入消息；AI 可按需调用 `bili_video_info` / `bili_subtitle`，再决定回复还是安静。
- **听懂语音 / 开口说话**：群友的 QQ 语音用本地 SenseVoice-Small 转写成「[语音 6秒·语气开心] 原话」（免费、单条约 1 秒）；可选让 AI 用自己的声音说话（`qq_speak` 主动说 + 短句随机转语音，默认百炼 CosyVoice 3.5，也支持小米 MiMo / 豆包 / OpenAI 兼容 / GPT-SoVITS）。想唱 15–20 秒短歌时，可以用曲库干声 + [Seed-VC](https://github.com/Plachtaa/seed-vc) 按需换嗓，不常驻、不跑整首。见 [docs/VOICE_IO.md](docs/VOICE_IO.md) 与 [docs/SINGING.md](docs/SINGING.md)。
- **Web 控制台**：白名单、唤醒参数、人格卡、表情参数、令牌与花费看板。
- **受限文件工作区**：`sandbox_*` 工具把 agent 的文件读写限制在 `~/dsh-sandbox/workspace`，拒绝绝对路径、`..`、symlink 和目录删除；不提供 shell/网络，完整命令执行需另接 VM/容器。见 [docs/SANDBOX.md](docs/SANDBOX.md)。
- **群内短翻唱**：群友说「唱15秒雨爱」时，`sing_short_cover` 自动搜索本地授权曲库、QQ 音乐/网易云（可选，付费门禁）或 CC 音源，找副歌、Demucs 分离、Seed-VC 换成 yuki 音色、混音并回发 10–20 秒 QQ 语音；异步队列、缓存、语音失败文件兜底和自动回收。见 [docs/SHORT_COVER.md](docs/SHORT_COVER.md)。

- **DSH 集成**：两个 agent preset（`qq-chat` / `qq-chat-v2`）、模式控制台 bundle、可选的设置页入口 launcher。
- **可迁移**：从 qq-bridge 的 `state/` + `config.json` 一键复制到本项目的 `data/`。

### 功能开关

控制台「运行总览 → 大功能开关」是跨模式总闸：一代/二代仿真、B 站卡片、联网搜索、语音、表情包、黑话学习、主动机会、看图与长期记忆。每个开关都写回 `config.json` 原本的配置段（不是第二份状态）；标 ⚠ 的项要重启 DSH 才会刷新工具清单或重载 MCP 代码，细粒度工具开关在「二代仿真 → 工具开关」。

## 架构

```
QQ 客户端
   │
   ▼
SnowLuma（Docker，OneBot v11）
   │  WebSocket / HTTP（127.0.0.1:3001 / 3000）
   ▼
packages/bridge  ── 消息归一化、模式/权限、唤醒、表情、B 站卡片
   │  DSH API（Cookie 鉴权 / slash-RPC / remote.mux）
   ▼
DeepSeek Harness agent（preset: qq-chat / qq-chat-v2）
   │  MCP 工具
   ▼
qq_send_message / qq_send_sticker / qq_reply / ...  →  QQ
```

- 桥接进程只监听本机；SnowLuma 端口也绑定 `127.0.0.1`。
- 每个 QQ 会话对应一个 DSH 会话；reserved2 默认每轮重建会话，长期记忆放在桥接的 `data/`。
- B 站工具是**只读**的，且只允许看别人分享的卡片，不允许主动刷视频。

## 仓库结构

```
dsh-omni/
├─ packages/
│  ├─ bridge/                 # 桥接本体 + Web 控制台 + DSH presets/模式控制台
│  │  ├─ src/                 # bridge.js、MCP server、安全抓取、表情/语音库
│  │  ├─ dsh/agent-presets/   # preset 源（改完跑 build 脚本）
│  │  ├─ plugins/             # dsh-omni-agent-presets / dsh-omni-mode-console
│  │  ├─ public/console.html  # 本地控制台
│  │  ├─ roles/               # 人格卡示例（傲娇助手、小鲸鱼）
│  │  ├─ scripts/             # 安装、测试、迁移脚本
│  │  ├─ data/                # 运行时数据（gitignore，不提交）
│  │  └─ config.json          # 本地配置（gitignore，不提交）
│  ├─ launcher/               # 可选：DSH 设置页「dsh-omni」入口
│  └─ bili-mcp/               # 可选：把 dsh-bili-scroll 的只读 MCP 挂进 DSH
├─ docs/
│  ├─ ARCHITECTURE.md
│  └─ VOICE_IO.md             # 听懂语音 / 开口说话：配置、策略与致谢
├─ LICENSE
├─ NOTICE.md
└─ README.md
```

## 环境要求

- macOS / Linux；Node.js **>= 22.13**
- DeepSeek Harness **0.2.x**（桌面版或 Web 版）
- Docker（推荐用 SnowLuma 镜像跑 QQ）
- 可选：B 站能力需要先安装 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)

> DSH 桌面版每次启动会换随机端口；`start-mac.sh` 会自动探测并同步到 `config.json`，所以不要用裸 `npm start` 替代它。

## 快速开始

### 1. 安装依赖

```bash
git clone https://github.com/dogeheng/dsh-omni.git
cd dsh-omni
npm --prefix packages/bridge install
```

### 2. 配置

```bash
cp packages/bridge/config.example.json packages/bridge/config.json
```

至少检查：

- `dsh.baseUrl`：通常不用手改，`start-mac.sh` 会写入当前 DSH 端口；
- `snowluma.wsUrl` / `httpUrl`：默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`；
- `allow.private` / `allow.groups`：允许机器人工作的 QQ 白名单；
- `ownerQQ`：管理员 QQ；
- `consolePort`：默认 `3100`。

控制台令牌首次启动会生成到 `packages/bridge/data/console-token`。

### 3. 启动 SnowLuma

```bash
cd packages/bridge
cp .env.example .env        # 改 VNC_PASSWD
docker compose -f docker-compose.snowluma.yml up -d
```

- 扫码桌面：<http://127.0.0.1:6081>
- SnowLuma WebUI：<http://127.0.0.1:5099>
- OneBot HTTP/WS：`127.0.0.1:3000` / `127.0.0.1:3001`

首次需要在 WebUI 里登录 QQ、配置 OneBot v11 反向/正向 WS，并把 access token 填进 `config.json` 的 `snowluma.accessToken`（如启用）。

### 4. 安装 DSH preset / MCP

```bash
node packages/bridge/scripts/setup-dsh.mjs desktop
```

- 注册 `qq-chat` / `qq-chat-v2` 两个 agent preset；
- 注册 `dsh-omni-mode-console`、`dsh-omni-agent-presets` 两个 bundle；
- 挂 `mcp-snowluma`、`mcp-snowluma-host`、`mcp-web-search-safe` 三个 MCP server。

改完 preset 源（`packages/bridge/dsh/agent-presets/`）后要重跑：

```bash
node packages/bridge/scripts/build-agent-preset-patches.mjs
node packages/bridge/scripts/setup-dsh.mjs desktop
```

### 5. 启动桥接

```bash
bash packages/bridge/start-mac.sh
```

它会：探测当前 DSH 端口 → 写回 `config.json` → 停旧进程 → 后台启动并写 `data/bridge.pid`。

### 自动跟随 DSH 重启（可选，推荐）

DSH 每次重启都会换端口并带走桥接进程。装一个 per-user LaunchAgent，让桥接每 20 秒检查一次 DSH 端口，必要时自动重启：

```bash
node packages/bridge/scripts/install-watchdog.mjs
```

- 不需要 sudo；plist 在 `~/Library/LaunchAgents/com.dogeheng.dsh-omni-bridge.plist`；
- 登录时自动运行，之后每 20 秒检查一次；
- DSH 换端口 / 桥接退出时，自动执行 `start-mac.sh`（内部用 detached spawn，不会被 launchd 一起收掉）；
- 日志：`packages/bridge/data/watchdog.log`；
- 查看/卸载：
  ```bash
  node packages/bridge/scripts/install-watchdog.mjs --status
  node packages/bridge/scripts/install-watchdog.mjs --uninstall
  ```

打开控制台：<http://127.0.0.1:3100/>（令牌在 `data/console-token`）。

### 6. 重启 DSH

preset / MCP / bundle 安装后需要重启 DSH 才生效。之后在允许的群或私聊里 @ 机器人即可。

## 可选：launcher、B 站 MCP 与 Seed-VC

`packages/launcher` 和 `packages/bili-mcp` 是标准 DSH bundle，但不是桥接运行的必需项：

- **launcher**：在 DSH 设置页加一个「dsh-omni」入口，一键打开扫码桌面、SnowLuma WebUI、桥接控制台。仓库里的 `client.js` 只有 URL 占位符；安装时由脚本读取本机配置并注入，不会把凭据写进仓库：

  ```bash
  # 先启动一次桥接，确保 data/console-token 已生成
  node packages/launcher/scripts/install.mjs
  ```

  脚本会读取 `packages/bridge/.env` 的 `VNC_PASSWD`、`packages/bridge/data/console-token` 和 `config.json` 的 `consolePort`，把 launcher 复制到 `~/.dsh/plugins/dsh-omni-launcher` 并替换占位符；如果 profile 里还没有，会自动注册。之后刷新 DSH 页面即可。密码/token 改了要重跑一次。
- **bili-mcp**：把 `dsh-bili-scroll` 安装的只读 Python MCP（`bili_video_info` / `bili_subtitle`）挂成全局 MCP，供 QQ 会话使用。
  - 先安装 dsh-bili-scroll；
  - 默认路径是 `~/.dsh/bili-duty`；可用 `DSH_BILI_HOME`、`DSH_BILI_PYTHON`、`DSH_BILI_MCP_SERVER` 覆盖；
  - 通过 DSH 的插件管理安装这个本地 bundle，或在 profile 的 `cordis.patch.yml` 中插入 `packages/bili-mcp/cordis.patch.yml`。

- **[Seed-VC](https://github.com/Plachtaa/seed-vc)**（可选，唱歌）：15–20 秒零样本换嗓，只从曲库取已分离干声，不跑整首、不在 Mac 上做人声分离。按需启动独立 Python 进程，用完退出；峰值 RSS/超时/可用内存都有硬性守卫。安装、曲库格式和内存策略见 [docs/SINGING.md](docs/SINGING.md)。Seed-VC 是 GPL-3.0，本仓库不 vendor 其代码/权重。
- **短翻唱**（可选）：`sing_short_cover` 自然语言点歌，本地授权曲库/QQ 音乐/网易云/CC → 自动选段 → Demucs → Seed-VC → 混音 → QQ 语音（付费候选默认拒绝）。检查环境：`npm --prefix packages/bridge run setup:cover`；详见 [docs/SHORT_COVER.md](docs/SHORT_COVER.md)。

## 从 qq-bridge 迁移

仓库自带迁移脚本（**不会**自动执行，确认后再运行）：

```bash
# 只预览
node packages/bridge/scripts/migrate-from-qq-bridge.mjs --dry-run

# 复制 config.json、state/ → data/、roles/、audio/
node packages/bridge/scripts/migrate-from-qq-bridge.mjs

# 覆盖已有文件（谨慎）
node packages/bridge/scripts/migrate-from-qq-bridge.mjs --force
```

默认从 `~/Documents/qq-bridge` 读取；可用 `--from` / `--to` 指定。脚本会跳过 `bridge.lock`、`bridge.pid`、`*.log`，避免把旧进程状态带过来。

迁移后：

1. 检查 `packages/bridge/config.json` 里的绝对路径（语音库、launcher 等）；
2. 跑一次 `node packages/bridge/scripts/setup-dsh.mjs desktop`；
3. 重启 DSH；
4. 用 `bash packages/bridge/start-mac.sh` 启动新桥接。

## 清理测试/一次性工作区

probe、preset 测试、表情标注这类一次性会话会在 DSH 里留下临时 workspace。清理命令默认 dry-run，加 `--apply` 才会执行：

```bash
# 删除 /tmp 下的 probe/preset/sticker 工作区，并把旧 QQ 工作区改名为 QQ 聊天（旧）
node packages/bridge/scripts/cleanup-workspaces.mjs --delete-temp --rename-qq --apply

# 删除旧 qq-bridge 路径下的 QQ 黑话学习工作区
node packages/bridge/scripts/cleanup-workspaces.mjs --delete-obsolete --apply
```

`workspace.delete` 只移除 DSH 的分组注册，**不会删除文件或 Session 日志**；旧 QQ 工作区默认保留为 `QQ 聊天（旧）`，确认不需要历史后再从 UI 删除。

## 安全与隐私

- `config.json`、`data/`、`.env`、`audio/` 全部在 `.gitignore` 中，**不要提交**。
- `data/` 含控制台令牌、OneBot token、全部聊天记录，桥接启动时会收紧目录权限。
- SnowLuma 的 VNC 密码只放在本地 `.env`；launcher 不会把它写进 URL。
- B 站 MCP 只读；QQ 侧写操作（发评论/私信/上传）没有授权。
- 公开仓库不包含个人 QQ 号、Cookie、token 或个人角色卡。

## 常见问题

**DSH 重启后机器人没反应？**
DSH 端口会变，桥接进程也可能随 DSH 退出。跑 `bash packages/bridge/start-mac.sh` 重新同步端口并拉起。

**控制台打不开？**
确认 `consolePort` 没被占用；令牌在 `data/console-token`。

**QQ 工具全部返回「未授权：请提供控制台访问令牌」？**
MCP 没读到控制台令牌。确认 `packages/bridge/data/console-token` 存在（旧布局 `state/console-token` 也兼容）；升级/改路径后要重启 DSH，让 MCP 进程重新加载。

**B 站卡片没有解析？**
确认消息是 QQ 小程序卡（`json` 段），且 `b23.tv` 可访问；桥接会缓存短链解析结果 24 小时。

**表情发不出去/变成图片？**
确认走的是 `qq_send_sticker`（OneBot `send_custom_face`），并检查控制台的表情参数与 `sendProbability`。

## 署名

- **qq-bridge** — Derpyu520 与 qq-bridge / QSH contributors，MIT：<https://github.com/Derpyu520/qq-bridge>
- **dsh-bili-scroll** — c1overzz，MIT：<https://github.com/c1overzz/dsh-bili-scroll>
- **bilibili-mcp** — AGI_Ananas，MIT（由 dsh-bili-scroll 内置）
- **Seed-VC** — Plachtaa，GPL-3.0，零样本歌声转换引擎（本项目只通过独立进程调用，未 vendor 其代码/权重）：<https://github.com/Plachtaa/seed-vc>

本仓库的整合、改动与文档由 dogeheng 及 dsh-omni contributors 维护。

## License

[MIT](LICENSE)。第三方代码/资源的许可证与署名见 [NOTICE.md](NOTICE.md)。
