# dsh-omni

**QQ ↔ DeepSeek Harness 的整合包。** 把 QQ（SnowLuma / OneBot v11）接到 DeepSeek Harness，让 DSH agent 以 QQ 会话的形式聊天、发表情、看 B 站卡片、潜水与唤醒，并附带控制台和 DSH 设置页入口。

> 本仓库基于 [qq-bridge](https://github.com/Derpyu520/qq-bridge)（Derpyu520，MIT）做整合与二次开发；B 站能力复用 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（c1overzz，MIT）。署名与许可证见 [NOTICE.md](NOTICE.md)。

[English README](README.en.md)

---

## 特性

- **QQ ↔ DSH 会话桥接**：群聊/私聊消息进入独立 DSH 会话，agent 的回复通过工具发回 QQ。
- **四种模式**：`chat`、`reserved`、`reserved2`（仿真）、`closed-agent`，可在控制台切换。
- **reserved2 仿真**：分条发送、引用、唤醒/潜水、拍一拍、主动机会、回复检查、长期记忆。
- **表情包**：同步 QQ 收藏表情、AI 看图标注、按情绪搜索、按语义自检、可配置发送概率与“发完文字后提醒补一张”。
- **B 站卡片**：解析 QQ 小程序卡（`b23.tv` → `BV...`），把标题/BV 注入消息；AI 可按需调用 `bili_video_info` / `bili_subtitle`，再决定回复还是安静。
- **Web 控制台**：白名单、唤醒参数、人格卡、表情参数、令牌与花费看板。
- **DSH 集成**：两个 agent preset（`qq-chat` / `qq-chat-v2`）、模式控制台 bundle、可选的设置页入口 launcher。
- **可迁移**：从 qq-bridge 的 `state/` + `config.json` 一键复制到本项目的 `data/`。

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
├─ docs/ARCHITECTURE.md
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

打开控制台：<http://127.0.0.1:3100/>（令牌在 `data/console-token`）。

### 6. 重启 DSH

preset / MCP / bundle 安装后需要重启 DSH 才生效。之后在允许的群或私聊里 @ 机器人即可。

## 可选：launcher 与 B 站 MCP

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

**B 站卡片没有解析？**
确认消息是 QQ 小程序卡（`json` 段），且 `b23.tv` 可访问；桥接会缓存短链解析结果 24 小时。

**表情发不出去/变成图片？**
确认走的是 `qq_send_sticker`（OneBot `send_custom_face`），并检查控制台的表情参数与 `sendProbability`。

## 署名

- **qq-bridge** — Derpyu520 与 qq-bridge / QSH contributors，MIT：<https://github.com/Derpyu520/qq-bridge>
- **dsh-bili-scroll** — c1overzz，MIT：<https://github.com/c1overzz/dsh-bili-scroll>
- **bilibili-mcp** — AGI_Ananas，MIT（由 dsh-bili-scroll 内置）

本仓库的整合、改动与文档由 dogeheng 及 dsh-omni contributors 维护。

## License

[MIT](LICENSE)。第三方代码/资源的许可证与署名见 [NOTICE.md](NOTICE.md)。
