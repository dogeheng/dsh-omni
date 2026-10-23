# Architecture

`dsh-omni` is a monorepo with three independently loadable pieces. Only the
bridge is required for QQ ↔ DSH; the launcher and Bilibili MCP are optional.

## Data flow

```
QQ client
  │  messages / cards / stickers
  ▼
SnowLuma (Docker, OneBot v11)
  │  WebSocket ws://127.0.0.1:3001
  │  HTTP     http://127.0.0.1:3000
  ▼
packages/bridge
  ├─ message normalisation (text, image, sticker, json card)
  ├─ mode/permission/session policy
  ├─ wake/sleep, reserved2 simulation, reply checks
  ├─ sticker library and prompt injection
  ├─ Bilibili card parsing (b23.tv → BV)
  ├─ local console (127.0.0.1:3100)
  └─ DSH API client
        │  cookie auth / slash-RPC / remote.mux
        ▼
DeepSeek Harness agent (preset qq-chat or qq-chat-v2)
        │  MCP tools
        ▼
qq_send_message / qq_send_sticker / qq_reply / qq_wait_for_messages ...
        │
        ▼
QQ
```

## Components

### `packages/bridge`

- `src/bridge.js` — process entry, HTTP console, QQ/DSH event loop, send queue,
  session policy, wake scheduling, sticker/Bilibili handling.
- `src/mcp-snowluma-safe.js` — agent-facing MCP tools for QQ (safe surface).
- `src/mcp-host-server.js` — host-side MCP tools (admin/config).
- `src/mcp-web-search-safe.js` — read-only web search/image search.
- `src/sticker-lib.js` — sticker store, annotation, prompt context/strategy.
- `src/safe-fetch.js` — SSRF-checked HTTP fetch (b23 resolution, image/sticker
  downloads).
- `dsh/agent-presets/*` — preset sources; generated into
  `plugins/dsh-omni-agent-presets/presets/*.patch.yml`.
- `plugins/dsh-omni-agent-presets` — DSH bundle that inserts the presets and
  the shared `qq-tool-restrict` guard.
- `plugins/dsh-omni-mode-console` — DSH settings page for the four modes.
- `scripts/setup-dsh.mjs` — installs presets/MCP rows and bundle links into a
  DSH profile.
- `data/` — runtime state (gitignored): sessions, sticker store, social-v2
  state, console token, mode, logs, pid/lock.

### `packages/launcher` (optional)

A client-side DSH settings section. It opens local SnowLuma/console URLs and
contains **no credentials**; VNC and console tokens are entered by the user.

### `packages/bili-mcp` (optional)

A config-only DSH bundle that mounts the read-only Bilibili Python MCP server
installed by `dsh-bili-scroll` (default `~/.dsh/bili-duty`). It only exposes
`bili_video_info` and `bili_subtitle`.

## State and security boundaries

- The bridge binds the console to `127.0.0.1`; SnowLuma ports are also loopback.
- `config.json` and `data/` are ignored by git and must never be published.
- The bridge hardens `data/` permissions on startup; Windows uses ACLs.
- MCP servers are split by trust level: QQ-safe tools, host/admin tools, and
  read-only web search. Do not merge them into one server.
- Bilibili tools are read-only; write actions (comments, DMs, uploads) are not
  registered.

## Session model

- One QQ conversation (group/private) maps to one DSH session, persisted in
  `data/sessions.json`.
- `reserved2` defaults to a fresh DSH session per turn (`freshEveryTurn`), with
  long-term memory kept in the bridge; this bounds context cost.
- Preset IDs (`qq-chat`, `qq-chat-v2`) and MCP server names (`snowluma`,
  `snowluma-host`, `web-search-safe`) are intentionally kept stable for
  compatibility; only package/repo/display names use the `dsh-omni` brand.
