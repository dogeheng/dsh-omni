# Setup and maintenance

[Back to README](../README.en.md) · [简体中文](SETUP.md)

For a first installation, follow the [quick start](../README.en.md#quick-start). This guide covers configuration, other profiles, optional components, and maintenance. Run commands from the `dsh-omni` repository root unless stated otherwise.

<a id="config"></a>
## Configuration

Copy [`packages/bridge/config.example.json`](../packages/bridge/config.example.json) to `config.json` in the same directory. Copy [`packages/bridge/.env.example`](../packages/bridge/.env.example) to `.env` alongside it for Docker settings.

| Field | Purpose |
| --- | --- |
| `ownerQQ` | The owner's QQ account ID. |
| `allow.private` / `allow.groups` | Allowed private chats and groups. An empty allowlist does not grant access by default. |
| `snowluma.wsUrl` | Forward OneBot WebSocket address; defaults to `ws://127.0.0.1:3001`. |
| `snowluma.httpUrl` | OneBot HTTP address; defaults to `http://127.0.0.1:3000`. |
| `snowluma.accessToken` | The gateway's access token, if enabled. |
| `dsh.baseUrl` | DSH address. The macOS startup script detects the desktop app's port and updates this field. |
| `dsh.authToken` | DSH launch token. Set it in your local configuration if authentication discovery fails. |
| `consolePort` | Local console port; defaults to `3100`. |

Set `VNC_PASSWD` in `packages/bridge/.env`. The Compose command in the README explicitly loads this file with `--env-file`.

The first bridge start creates `packages/bridge/data/console-token`. The `data/` directory also stores session state, logs, and the memory database; do not upload it. SnowLuma's three Docker volumes hold login state and configuration and should be retained across normal restarts.

## DSH profiles and startup

For the desktop app:

```bash
node packages/bridge/scripts/setup-dsh.mjs desktop
```

This registers the `qq-chat` / `qq-chat-v2` presets, two project bundles, and three MCP servers: `mcp-snowluma`, `mcp-snowluma-host`, and `mcp-web-search-safe`. Restart DSH after installation, then start the bridge.

### macOS desktop app

```bash
bash packages/bridge/start-mac.sh
```

The script detects DSH's port, updates the local configuration, stops an older bridge running from the same directory, and starts a new process. It writes:

- `packages/bridge/data/bridge.pid`
- `packages/bridge/data/bridge.log`

The desktop app may change ports on each start, so use this script to reconnect.

### Web profile / Linux

With an existing, working DSH Web profile:

```bash
node packages/bridge/scripts/setup-dsh.mjs web
```

The installer defaults to `web` when no profile is specified. Set `DSH_HOME` to use a different DSH root directory. Restart the corresponding DSH instance, check `dsh.baseUrl` and authentication settings manually, then run:

```bash
npm start
```

The macOS port discovery, LaunchAgent, and power detection helpers do not apply to this startup path.

<a id="watchdog"></a>
## Follow DSH restarts automatically (macOS, optional)

```bash
node packages/bridge/scripts/install-watchdog.mjs
```

This installs a user-level LaunchAgent without sudo. After login, it checks Docker, SnowLuma, and the bridge every 20 seconds. If DSH changes ports or the bridge exits, it calls `start-mac.sh`. Port changes require two matching observations, and bridge restarts have a 90-second cooldown.

Set `stack.docker: false` to stop it from launching Docker, or `stack.autoStart: false` to disable the stack startup logic. More settings are documented in [POWER.md](POWER.md) (Chinese).

```bash
node packages/bridge/scripts/install-watchdog.mjs --status
node packages/bridge/scripts/install-watchdog.mjs --uninstall
```

The LaunchAgent is `~/Library/LaunchAgents/com.dogeheng.dsh-omni-bridge.plist`. Logs are in `packages/bridge/data/watchdog.log`.

## Optional components

### DSH settings-page launcher

Start the bridge once so its console token exists, then install the launcher:

```bash
node packages/launcher/scripts/install.mjs
```

It reads local configuration, copies the launcher to `~/.dsh/plugins/dsh-omni-launcher`, and registers it in the profile. Refresh the DSH page afterward. Rerun the installer when the console token, port, or relevant local credentials change.

### Bilibili MCP

Install [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) first. Then install this repository's `packages/bili-mcp` local bundle, or include its `cordis.patch.yml` in the target profile.

It uses tools under `~/.dsh/bili-duty` by default. Override the paths with `DSH_BILI_HOME`, `DSH_BILI_PYTHON`, and `DSH_BILI_MCP_SERVER`. These tools expose read-only video information and subtitles for shared QQ cards.

### Voice, singing, and the file workspace

The detailed guides below are currently in Chinese.

| Capability | Setup and requirements |
| --- | --- |
| ASR / TTS | [VOICE_IO.md](VOICE_IO.md). ASR can run locally. TTS supports CosyVoice, MiMo, Doubao, OpenAI-compatible endpoints, and GPT-SoVITS, each with its own service configuration. |
| Library-based singing | [SINGING.md](SINGING.md). Prepare separated vocals and accompaniment. Seed-VC converts short clips on demand, typically 15–20 seconds. |
| Short covers | [SHORT_COVER.md](SHORT_COVER.md). Selection, separation, voice conversion, and delivery require additional audio tools. Use sources you have permission to use; paid candidates are rejected by default. |
| File workspace | [SANDBOX.md](SANDBOX.md). Confines file access to a designated workspace without providing shell or network execution. |

Check the short-cover environment with:

```bash
npm --prefix packages/bridge run setup:cover
```

Seed-VC runs in a separate Python process. Its code and weights are not included in this repository, and its license is GPL-3.0.

## Migrating from qq-bridge

Preview the copy operation first:

```bash
node packages/bridge/scripts/migrate-from-qq-bridge.mjs --dry-run
node packages/bridge/scripts/migrate-from-qq-bridge.mjs
```

The default source is `~/Documents/qq-bridge`. The script copies configuration, `state/`, roles, and audio into this project; `--from` / `--to` override the paths. Lock files, PIDs, and logs are skipped. Add `--force` only when you intend to overwrite existing files.

After migration, check absolute paths in `packages/bridge/config.json`, rerun `setup-dsh.mjs` for your profile, restart DSH, and start the bridge.

<a id="presets"></a>
## Updating presets and cleaning temporary workspaces

After changing preset sources under `packages/bridge/dsh/agent-presets/`, rebuild and reinstall them:

```bash
node packages/bridge/scripts/build-agent-preset-patches.mjs
node packages/bridge/scripts/setup-dsh.mjs desktop
```

Then restart the corresponding DSH instance.

To preview cleanup of workspaces created by probes and tests:

```bash
node packages/bridge/scripts/cleanup-workspaces.mjs --delete-temp --rename-qq
node packages/bridge/scripts/cleanup-workspaces.mjs --delete-obsolete
```

Review the output, then add `--apply` to the command you want to execute. `workspace.delete` removes DSH grouping registrations, not files or Session logs. Old QQ workspaces can be retained under `QQ 聊天（旧）`.

## Troubleshooting

**No replies after a DSH restart.** Check DSH and SnowLuma connection status in the console. On macOS, rerun `start-mac.sh` or inspect the watchdog log. Also check the conversation allowlist and the selected mode.

**The console will not open or asks for a token.** Check whether `consolePort` is occupied. The token is in `packages/bridge/data/console-token`.

**QQ tools return “未授权：请提供控制台访问令牌”.** Check that MCP can read the console token file. The legacy `state/console-token` path is also accepted. Restart DSH after upgrades or path changes so MCP reloads it.

**Voice, singing, or search stops working on battery.** Check the battery capability list under `运行与安全 → 电源与性能`. Plugging in restores the configured capabilities. The console can also simulate AC/battery states. See [POWER.md](POWER.md).

**Yuki's name is mispronounced.** `socialV2.speak.pronunciations` maps `Yuki` to `优key` (you-key) by default. Adjust it in the configuration and restart the bridge. Console previews, or `POST /api/voice/speak` with `dryRun: true`, return the actual spoken text in `text`.

**A Bilibili card is not parsed.** Check that the message is a QQ mini-app card (`json` segment) and that the machine can reach `b23.tv`. Short-link results are cached for 24 hours.

**A sticker fails or arrives as an image.** Check that the agent uses `qq_send_sticker` (OneBot `send_custom_face`), then check the sticker capability, tool permissions, and `sendProbability`.

When reporting issues, include redacted logs and reproduction steps. Do not attach configuration files, cookies, tokens, or complete chat history.
