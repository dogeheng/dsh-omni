# Architecture

> *I want to give Big Fat Fish a complete life — gather the best of every world, give him every ability, and see how human he can become.*

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
- `src/memory/` — long-term memory: SQLite (`node:sqlite`) + FTS5 with a CJK
  bigram index, scope/ACL, rule-based capture buffer, dynamic token-budgeted
  injection, legacy `social-v2.json` migration with backup/verify/rollback.
  Design, schema and measured numbers: `docs/MEMORY.md`.
- `src/inbox.js` — full text of messages that exceeded the 200-character window
  preview, kept out of `social-v2.json` and readable through
  `qq_get_message_detail(full=true)`. Short messages never touch the disk.
- `src/outbox.js` — durable queue of prompts the bridge has not handed to DSH
  yet. The in-memory `queued` map is rebuilt from it at startup, so a restart,
  crash or `ensure-bridge` restart no longer drops undelivered replies.
- `src/relay/` — the external-app relay: a local script asks a question over QQ
  and gets the answer back. Each app holds its own token (only the hash is
  stored); answers are matched by quoting the sent message or by `#code`, never
  implicitly. The target is the owner's private chat by default and can be
  switched to one group in the console. State lives in `data/relay/`.
- `src/thread.js` — the conversation-local "this one thing" id. A message
  inherits its thread from the message it replies to, or from the same sender
  within a ten-minute window; nothing else merges. Wake snapshots carry the
  id on every message and re-add the earlier ones the window dropped.
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
  state, console token, mode, logs, pid/lock, and `data/memory/memory.sqlite`
  (long-term memory, WAL; backups under `data/memory/backups/`).

### Delivery problems

`/api/status` carries a `delivery` block: pending outbox entries, consecutive
delivery failures, wake-lease timeouts and turns longer than two minutes. The
console renders it as a 待处理 card that is hidden while the list is empty, and
the agent-token view of `/api/status` never receives it (it names conversations
and error text).

### `packages/launcher` (optional)

A client-side DSH settings section. The repository copy contains only URL
placeholders; `scripts/install.mjs` reads the local `.env` and `data/console-token`
and injects them into the installed copy under `~/.dsh/plugins`, so credentials
never enter git.

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
