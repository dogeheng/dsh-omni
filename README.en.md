# dsh-omni

> **I want to give Big Fat Fish a complete life!!!**

**An integrated QQ ↔ DeepSeek Harness package.** Connect QQ (SnowLuma / OneBot v11) to DeepSeek Harness so a DSH agent can chat in QQ, send stickers and voice, read Bilibili cards, search the web, remember the group, nap/wake, and expose a local console plus a DSH settings entry.

This is less a “QQ bot framework” than a long-running experiment: QQ as the body, DSH as the brain, and stickers, voice, memory, slang, Bilibili and web search wired in as senses — to see how much like a specific person an agent can become inside a real group chat.

> Based on [qq-bridge](https://github.com/Derpyu520/qq-bridge) by Derpyu520 (MIT), with Bilibili capabilities from [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) by c1overzz (MIT). See [NOTICE.md](NOTICE.md).

[中文 README](README.md)

## Features

- QQ ↔ DSH session bridge (private chats and groups).
- Four modes: `chat`, `reserved`, `reserved2` (simulation), `closed-agent`.
- Capability switches in Run & Safety, visual/web switches in Senses & Expression, and grouped tool permissions with their own page.
- reserved2: multi-bubble sends, quoting, wake/sleep, pokes, proactive opportunities, reply checks, long-term memory.
- Stickers: sync QQ favourites, AI annotation, emotion search, semantic self-check, configurable send probability and a post-reply nudge.
- Bilibili cards: parse QQ mini-app cards (`b23.tv` → `BV...`), inject title/BV, then let the agent call `bili_video_info` / `bili_subtitle` and decide whether to reply or stay silent.
- Web console: five main categories, contextual parameter help, searchable settings and preserved drafts. The layered companion supports nine gestures and idle blinking; all allowlist, wake, persona, sticker and token/cost controls remain available. See [console documentation](docs/CONSOLE_UI.md).
- DSH integration: `qq-chat` / `qq-chat-v2` presets, mode console bundle, optional settings-page launcher.
- Migration helper from qq-bridge (`state/` + `config.json` → `data/`).

### Feature switches

Run & Safety → Connection & Mode contains the capability switches. Image understanding, Bilibili cards and web search live in Senses & Expression → Vision & Video. Each switch writes the original `config.json` section. Items marked ⚠ need a DSH restart to refresh the tool list or reload MCP code; per-tool switches are grouped under Senses & Expression → Tool Permissions.

## Architecture

```
QQ client
   │
   ▼
SnowLuma (Docker, OneBot v11)
   │  WebSocket / HTTP (127.0.0.1:3001 / 3000)
   ▼
packages/bridge  ── normalisation, modes, wake, stickers, Bilibili cards
   │  DSH API (cookie auth / slash-RPC / remote.mux)
   ▼
DeepSeek Harness agent (preset: qq-chat / qq-chat-v2)
   │  MCP tools
   ▼
qq_send_message / qq_send_sticker / qq_reply / ...  →  QQ
```

The bridge and SnowLuma only listen on loopback. Bilibili tools are read-only and limited to cards shared in QQ.

## Repository layout

```
dsh-omni/
├─ packages/
│  ├─ bridge/      # bridge, console, DSH presets and mode console
│  ├─ launcher/    # optional DSH settings-page entry
│  └─ bili-mcp/    # optional read-only Bilibili MCP for DSH
├─ docs/ARCHITECTURE.md
├─ LICENSE
├─ NOTICE.md
└─ README.md
```

## Requirements

- macOS / Linux; Node.js **>= 22.13**
- DeepSeek Harness **0.2.x**
- Docker for SnowLuma
- Optional: [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) for Bilibili tools

## Quick start

```bash
git clone https://github.com/dogeheng/dsh-omni.git
cd dsh-omni
npm --prefix packages/bridge install
cp packages/bridge/config.example.json packages/bridge/config.json

# edit config.json: allow.private / allow.groups / ownerQQ / snowluma token
cd packages/bridge
cp .env.example .env            # set VNC_PASSWD
docker compose -f docker-compose.snowluma.yml up -d
cd ../..

node packages/bridge/scripts/setup-dsh.mjs desktop
bash packages/bridge/start-mac.sh
```

Restart DSH after installing presets/MCP. The console is at <http://127.0.0.1:3100/>; its token is generated in `packages/bridge/data/console-token`.

`start-mac.sh` discovers the current DSH port, updates `config.json`, stops the old bridge, and starts a new one. Do not replace it with a bare `npm start` if DSH restarts often.

### Auto-follow DSH restarts (optional, recommended)

```bash
node packages/bridge/scripts/install-watchdog.mjs
```

Installs a per-user macOS LaunchAgent that checks the DSH port every 20 seconds and runs `start-mac.sh` when the bridge is missing or points at an old port. It starts at login, needs no sudo, and logs to `packages/bridge/data/watchdog.log`. Use `--status` or `--uninstall` to inspect/remove it.

## Bilibili integration

Install dsh-bili-scroll separately, then mount the optional `packages/bili-mcp` bundle. It points at `~/.dsh/bili-duty` by default; override with `DSH_BILI_HOME`, `DSH_BILI_PYTHON`, or `DSH_BILI_MCP_SERVER`.

The QQ presets only receive `bili_video_info` and `bili_subtitle` (read-only). The bridge parses `b23.tv` links from QQ cards and injects the `BV` id; the agent decides whether to reply or stay silent.

## Migration from qq-bridge

```bash
node packages/bridge/scripts/migrate-from-qq-bridge.mjs --dry-run
node packages/bridge/scripts/migrate-from-qq-bridge.mjs
```

The script copies `config.json`, `state/` → `data/`, `roles/`, and `audio/` from `~/Documents/qq-bridge` (configurable with `--from` / `--to`). It skips `bridge.lock`, `bridge.pid`, and logs. After migrating, run `setup-dsh.mjs desktop`, restart DSH, then start the bridge.

## Clean up test workspaces

One-off probes/tests/sticker jobs leave temporary DSH workspaces. The cleanup script is dry-run by default; add `--apply`:

```bash
node packages/bridge/scripts/cleanup-workspaces.mjs --delete-temp --rename-qq --apply
node packages/bridge/scripts/cleanup-workspaces.mjs --delete-obsolete --apply
```

`workspace.delete` only removes the DSH registration; files and Session logs remain. The old QQ workspace is kept as `QQ 聊天（旧）` until you decide to remove its history.

## Security

- `config.json`, `data/`, `.env`, and `audio/` are gitignored; never commit them.
- `data/` contains the console token, OneBot token, and chat history; the bridge hardens its permissions on startup.
- The repository's launcher contains only URL placeholders. Run `node packages/launcher/scripts/install.mjs` after the bridge has generated `data/console-token`; the script reads the local `.env` and token and injects them into the installed copy, never into git.
- Bilibili MCP is read-only; QQ write actions are not granted.

## Credits

- **qq-bridge** — Derpyu520 and contributors, MIT: <https://github.com/Derpyu520/qq-bridge>
- **dsh-bili-scroll** — c1overzz, MIT: <https://github.com/c1overzz/dsh-bili-scroll>
- **bilibili-mcp** — AGI_Ananas, MIT (bundled by dsh-bili-scroll): <https://github.com/AGI-Ananas/bilibili-mcp>

## Troubleshooting

- **All QQ tools return "未授权：请提供控制台访问令牌"**: the MCP server could not read the console token. Check `packages/bridge/data/console-token` (legacy `state/console-token` is also accepted) and restart DSH after upgrades so the MCP process reloads.
- **Bridge stops after a DSH restart**: run `node packages/bridge/scripts/install-watchdog.mjs`; it checks the current DSH port every 20 seconds and restarts the bridge.
- **Console asks for a token**: read `packages/bridge/data/console-token`, or open the console through the launcher after running its install script.

## License

[MIT](LICENSE). Third-party notices are in [NOTICE.md](NOTICE.md).
