# 安装与维护

[返回 README](../README.md) · [English](SETUP.en.md)

首次安装请先按 [README 的快速开始](../README.md#quick-start) 操作。本页补充配置、其他 profile、可选组件和日常维护。除特别说明外，命令都在 `dsh-omni` 仓库根目录执行。

<a id="config"></a>
## 配置文件

配置模板是 [`packages/bridge/config.example.json`](../packages/bridge/config.example.json)，使用时复制为同目录下的 `config.json`。Docker 环境变量模板是 [`packages/bridge/.env.example`](../packages/bridge/.env.example)，复制为同目录下的 `.env`。

| 字段 | 用途 |
| --- | --- |
| `ownerQQ` | 管理员 QQ 号。 |
| `allow.private` / `allow.groups` | 允许工作的私聊与群。空白名单默认不放行。 |
| `snowluma.wsUrl` | OneBot 正向 WebSocket 地址，默认 `ws://127.0.0.1:3001`。 |
| `snowluma.httpUrl` | OneBot HTTP 地址，默认 `http://127.0.0.1:3000`。 |
| `snowluma.accessToken` | 与网关设置一致的访问令牌，如启用。 |
| `dsh.baseUrl` | DSH 地址；macOS 启动脚本会探测桌面版端口并更新此项。 |
| `dsh.authToken` | DSH 启动令牌。自动发现鉴权信息失败时，需要在本机配置中明确填写。 |
| `consolePort` | 控制台端口，默认 `3100`。 |

`VNC_PASSWD` 写在 `packages/bridge/.env` 中。按 README 中的 Compose 命令启动时，会通过 `--env-file` 读入该文件。

桥接首次启动会生成 `packages/bridge/data/console-token`。`data/` 还会保存会话状态、日志和长期记忆数据库；不要上传这些文件。SnowLuma 的三个 Docker 卷保存登录态和配置，也不应在普通重启时删除。

## DSH profile 与启动方式

桌面版使用：

```bash
node packages/bridge/scripts/setup-dsh.mjs desktop
```

脚本注册 `qq-chat` / `qq-chat-v2` 预设、两个项目 bundle，以及 `mcp-snowluma`、`mcp-snowluma-host`、`mcp-web-search-safe` 三个 MCP server。安装后重启 DSH，再启动桥接。

### macOS 桌面版

```bash
bash packages/bridge/start-mac.sh
```

脚本会探测 DSH 端口、更新本地配置、停止当前目录下的旧桥接，再启动新进程。PID 与日志位于：

- `packages/bridge/data/bridge.pid`
- `packages/bridge/data/bridge.log`

桌面版 DSH 每次启动可能更换端口，因此应使用这个脚本重新连接。

### Web profile / Linux

在已有可用 DSH Web profile 的环境中，使用：

```bash
node packages/bridge/scripts/setup-dsh.mjs web
```

不传 profile 时，安装脚本默认使用 `web`；`DSH_HOME` 可指定 DSH 根目录。重启对应 DSH 实例，手动核对 `dsh.baseUrl` 和鉴权配置后运行：

```bash
npm start
```

macOS 的端口探测、LaunchAgent 和电源检测不适用于这条启动路径。

<a id="watchdog"></a>
## 自动跟随 DSH 重启（macOS，可选）

```bash
node packages/bridge/scripts/install-watchdog.mjs
```

它安装用户级 LaunchAgent，无需 sudo。登录后每 20 秒检查一次 Docker、SnowLuma 和桥接；DSH 换端口或桥接退出时，调用 `start-mac.sh` 恢复连接。端口需要连续两次探测一致，桥接重启还有 90 秒冷却。

如果不希望它启动 Docker，设 `stack.docker: false`；关闭整段自动启动逻辑可设 `stack.autoStart: false`。其他参数见 [POWER.md](POWER.md)。

```bash
node packages/bridge/scripts/install-watchdog.mjs --status
node packages/bridge/scripts/install-watchdog.mjs --uninstall
```

LaunchAgent 位于 `~/Library/LaunchAgents/com.dogeheng.dsh-omni-bridge.plist`，日志位于 `packages/bridge/data/watchdog.log`。

## 可选组件

### DSH 设置页入口

先运行一次桥接，让控制台令牌生成，再安装 launcher：

```bash
node packages/launcher/scripts/install.mjs
```

它会读取本机配置、复制 launcher 到 `~/.dsh/plugins/dsh-omni-launcher`，并注册到 profile。之后刷新 DSH 页面。控制台令牌、端口或相关本地凭据改变后，重新执行安装脚本。

### B 站 MCP

先安装 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)，再安装本仓库的 `packages/bili-mcp` 本地 bundle，或把它的 `cordis.patch.yml` 加入目标 profile。

默认使用 `~/.dsh/bili-duty` 下的工具；可用 `DSH_BILI_HOME`、`DSH_BILI_PYTHON`、`DSH_BILI_MCP_SERVER` 覆盖路径。工具提供只读视频信息与字幕，供 QQ 会话处理分享的卡片。

### 语音、唱歌与文件工作区

| 能力 | 配置与要求 |
| --- | --- |
| ASR / TTS | [VOICE_IO.md](VOICE_IO.md)。ASR 可在本地运行；TTS 支持 CosyVoice、MiMo、豆包、OpenAI 兼容接口和 GPT-SoVITS，分别配置对应服务。 |
| 曲库唱歌 | [SINGING.md](SINGING.md)。准备已分离的干声与伴奏，使用 Seed-VC 按需换嗓，通常处理 15～20 秒片段。 |
| 短翻唱 | [SHORT_COVER.md](SHORT_COVER.md)。支持选段、分离、换嗓与回发；需要额外音频环境，只使用有权使用的音源，付费候选默认拒绝。 |
| 文件工作区 | [SANDBOX.md](SANDBOX.md)。把读写限制在指定工作区，不提供 shell 或网络执行能力。 |

短翻唱环境检查命令：

```bash
npm --prefix packages/bridge run setup:cover
```

Seed-VC 通过独立 Python 进程运行，其代码和权重不在本仓库中；其许可证为 GPL-3.0。

## 从 qq-bridge 迁移

先预览，再决定是否复制：

```bash
node packages/bridge/scripts/migrate-from-qq-bridge.mjs --dry-run
node packages/bridge/scripts/migrate-from-qq-bridge.mjs
```

默认从 `~/Documents/qq-bridge` 复制配置、`state/`、角色和音频到本项目，可用 `--from` / `--to` 指定路径。脚本跳过锁文件、PID 和日志。只有明确需要覆盖现有文件时才添加 `--force`。

迁移后检查 `packages/bridge/config.json` 中的绝对路径，重新运行对应 profile 的 `setup-dsh.mjs`，重启 DSH，再启动桥接。

<a id="presets"></a>
## 修改预设与清理临时工作区

修改 `packages/bridge/dsh/agent-presets/` 中的预设源后，重新构建并安装：

```bash
node packages/bridge/scripts/build-agent-preset-patches.mjs
node packages/bridge/scripts/setup-dsh.mjs desktop
```

随后重启对应 DSH 实例。

探测和测试产生的临时工作区可用下面的命令预览清理范围：

```bash
node packages/bridge/scripts/cleanup-workspaces.mjs --delete-temp --rename-qq
node packages/bridge/scripts/cleanup-workspaces.mjs --delete-obsolete
```

确认范围后，在所需命令末尾添加 `--apply`。`workspace.delete` 移除的是 DSH 分组注册，不删除文件或 Session 日志；旧 QQ 工作区可保留为「QQ 聊天（旧）」。

## 常见问题

**DSH 重启后没有回复。** 先在控制台查看 DSH 和 SnowLuma 的连接状态。macOS 上重新运行 `start-mac.sh`，或者检查 watchdog 日志。也要确认测试会话在白名单中、当前模式允许回复。

**控制台打不开或要求令牌。** 检查 `consolePort` 是否被占用，令牌位于 `packages/bridge/data/console-token`。

**QQ 工具返回「未授权：请提供控制台访问令牌」。** 检查 MCP 能否读取上述令牌文件；旧布局 `state/console-token` 也兼容。升级或修改路径后，重启 DSH，让 MCP 重新加载。

**离电后语音、唱歌或搜索不可用。** 检查「运行与安全 → 电源与性能」的离电能力列表。插电后会恢复；控制台也提供模拟插电/离电按钮。见 [POWER.md](POWER.md)。

**Yuki 的名字被读错。** `socialV2.speak.pronunciations` 默认把 `Yuki` 替换为 `优key`（you-key）。可在配置中调整，保存后重启桥接。控制台试听，或 `POST /api/voice/speak` 携带 `dryRun: true` 时，返回的 `text` 会展示实际朗读内容。

**B 站卡片没解析。** 检查消息是否为 QQ 小程序卡（`json` 段），以及本机是否能访问 `b23.tv`。短链解析结果会缓存 24 小时。

**表情发不出，或变成了图片。** 检查是否调用 `qq_send_sticker`（OneBot `send_custom_face`），并核对表情能力、工具权限及 `sendProbability`。

反馈问题时，可以附脱敏日志和复现步骤；不要附 `config.json`、Cookie、token 或完整聊天记录。
