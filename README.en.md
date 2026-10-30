<p align="center">
  <img src="docs/media/mark.svg" width="88" height="88" alt="dsh-omni whale mark">
</p>

<h1 align="center">dsh-omni</h1>

<p align="center">Bring DeepSeek Harness to QQ, with voice, images, memory, and a local console.</p>

<p align="center">
  <a href="packages/bridge/package.json"><img src="docs/media/badge-node.svg" alt="Node.js ≥ 22.13"></a>
  <a href="#quick-start"><img src="docs/media/badge-dsh.svg" alt="DeepSeek Harness 0.2.x"></a>
  <a href="LICENSE"><img src="docs/media/badge-license.svg" alt="MIT License"></a>
</p>

<p align="center">
  <a href="README.md"><img src="docs/media/lang-zh.svg" alt="阅读简体中文版" height="34"></a>
  <a href="README.en.md"><img src="docs/media/lang-en-selected.svg" alt="English · current language" height="34"></a>
</p>

<p align="center">
  <a href="#preview">Preview</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#docs">Docs</a> ·
  <a href="https://github.com/dogeheng/dsh-omni/issues">Report an issue</a>
</p>

I built this for my QQ companion, Big Fat Fish. I wanted her to understand voice messages, look at pictures people share, remember past conversations, and know when to stay quiet.

SnowLuma carries messages to and from QQ; DeepSeek Harness (DSH) handles the conversations. The local console controls her persona, permissions, conversation habits, and usage. This project builds on [qq-bridge](https://github.com/Derpyu520/qq-bridge).

<a id="preview"></a>
## Preview

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/console-overview-dark.png">
  <img src="docs/media/console-overview.png" alt="The console home page with connection status, five navigation categories, and the interactive companion" width="1100">
</picture>

The console groups settings into Overview, Chat & Persona, Senses & Expression, Memory & Learning, and Run & Safety. Settings include explanations of what they affect, and search takes you straight to the relevant control. The interface is currently in Chinese; this README is available in both languages.

<details>
<summary>See conversation settings and contextual help</summary>

<img src="docs/media/console-settings.png" alt="Conversation settings showing the idle-chat probability, check interval, and contextual explanation" width="1100">

For example, raising the proactive probability gives her more chances to join a quiet group. Time of day, recent activity, and the agent's own judgment still affect whether she speaks.

</details>

### A companion you can interact with

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/media/companion-still.png">
    <img src="docs/media/companion-actions.gif" alt="Big Fat Fish waving, covering her eyes, moving her ears, and reacting to other interactions" width="480">
  </picture>
</p>

Hover over her eyes and she covers them; touch an ear and it moves. Click to open the related settings. There are nine gestures, with keyboard and touch controls and a pause option. The character uses layered 2D animation; see the [interaction notes](docs/CONSOLE_UI.md) for details.

<sub>All screenshots and animation frames use synthetic data from the offline preview. No real chat history is shown.</sub>

<a id="features"></a>
## Features

| Area | What's included |
| --- | --- |
| Conversations | Separate DSH sessions for groups and private chats; quotes, message bursts, pokes, sleep/wake behavior, and chances to speak when a group is quiet. |
| Voice | Local SenseVoice transcription, optional speech synthesis, an audio library, and probabilistic conversion of short replies to voice. Several TTS providers are supported. |
| Images and links | Image understanding, QQ favorite stickers, Bilibili card information and subtitles, and web search. Bilibili tools are read-only and handle shared content. |
| Persona and memory | Persona and prompt updates on the next wake, long-term memory, and group slang learning. Memory is scoped to keep groups and private conversations separate. |
| Local management | Allowlists, owner permissions, capability and tool switches, and token/cost views. macOS also supports battery-aware capability settings. |

Singing, short covers, and the restricted file workspace need additional setup. Start with text chat, then enable the capabilities you want. Configuration guides are linked [below](#docs).

<details>
<summary>Which conversation mode should I use?</summary>

| Mode | Behavior |
| --- | --- |
| `chat` | Ordinary conversations within the allowlist. |
| `reserved` | First-generation simulation, using trigger probabilities and active periods. |
| `reserved2` | Second-generation simulation, with autonomous reading, replies, waiting, sleep, and wake scheduling. |
| `closed-agent` | Agent mode restricted to the owner's private chat. |

Switch modes under Run & Safety → Connection & Mode (`运行与安全 → 连接与模式`). Second-generation habits live under Chat & Persona → Chat Habits (`聊天与性格 → 聊天习惯`).

</details>

<a id="quick-start"></a>
## Quick start

These steps use **macOS and the DSH desktop app**. Have Node.js ≥ 22.13, a signed-in DSH 0.2.x installation, and Docker running first. See [setup and maintenance](docs/SETUP.en.md) for other profiles, optional components, and troubleshooting.

### 1. Download and configure

```bash
git clone https://github.com/dogeheng/dsh-omni.git
cd dsh-omni
npm --prefix packages/bridge install
cp -n packages/bridge/config.example.json packages/bridge/config.json
cp -n packages/bridge/.env.example packages/bridge/.env
```

Run all remaining commands from the **`dsh-omni` repository root**.

Edit `packages/bridge/config.json`: set `ownerQQ` and your QQ allowlists in `allow.private` / `allow.groups`. Replace `VNC_PASSWD` in `packages/bridge/.env` with your own password. The [configuration reference](docs/SETUP.en.md#config) explains the other fields.

### 2. Start the QQ gateway

```bash
docker compose --env-file packages/bridge/.env -f packages/bridge/docker-compose.snowluma.yml up -d
```

Sign in to QQ through the [remote desktop](http://127.0.0.1:6081). In the [SnowLuma WebUI](http://127.0.0.1:5099), enable OneBot v11 HTTP on `3000` and a forward WebSocket server on `3001`. If you enable an access token, put the same value in `snowluma.accessToken`.

### 3. Connect DSH, then start the bridge

```bash
node packages/bridge/scripts/setup-dsh.mjs desktop
```

When setup finishes, **restart DSH and wait for it to start**, then run:

```bash
bash packages/bridge/start-mac.sh
```

The script detects DSH's current port and starts the bridge. Open the [local console](http://127.0.0.1:3100), use the token in `packages/bridge/data/console-token` when prompted, and try a conversation on your allowlist.

The desktop app may change ports after a restart. Run the startup script again, or install the optional [watchdog](docs/SETUP.en.md#watchdog).

<details>
<summary>Want to try the console first?</summary>

After installing the Node dependencies, run:

```bash
npm --prefix packages/bridge run preview:console
```

Open <http://127.0.0.1:4173>. This is an offline preview: saves affect only in-memory sample data, test sends never reach QQ, and no DSH login is required.

</details>

<a id="docs"></a>
## Documentation

The setup guide is available in English. The detailed capability guides are currently in Chinese.

| Topic | Guide |
| --- | --- |
| Configuration, other profiles, startup, migration, troubleshooting | [Setup and maintenance](docs/SETUP.en.md) |
| Navigation, parameter help, character interactions | [Console UI](docs/CONSOLE_UI.md) |
| How messages move between QQ and DSH | [Architecture](docs/ARCHITECTURE.md) |
| Transcription, voices, synthesis providers, pronunciation | [Voice I/O](docs/VOICE_IO.md) |
| Memory scope, retrieval, and extraction | [Long-term memory](docs/MEMORY.md) |
| Capabilities available on battery power | [Power management](docs/POWER.md) |
| Library-based singing / short song covers | [Singing](docs/SINGING.md) · [Short covers](docs/SHORT_COVER.md) |
| Restricting agent file access | [File workspace](docs/SANDBOX.md) |

### Development and checks

The runtime lives in `packages/bridge`. `packages/launcher` and `packages/bili-mcp` provide optional DSH integrations.

```bash
npm test
npm --prefix packages/bridge run test:console-ui
npm --prefix packages/bridge run test:console-character
```

Browser checks require Playwright and Chromium. The full audit has platform and installation dependencies; known failures and coverage are recorded in the [validation notes](docs/CONSOLE_UI.md#验证). See the [maintenance guide](docs/SETUP.en.md#presets) for rebuilding presets.

## Data and access

`config.json`, `.env`, `data/`, and `audio/` stay on your machine and are covered by `.gitignore`. They can contain tokens and chat history; do not upload them. The console and gateway bind to loopback by default, and allowlists control who can chat.

Account balance queries are restricted to the owner's private chat and do not enter group prompts. Speech synthesis and other connected services may charge for usage; you choose what to enable and set the limits.

## Credits and license

Maintained by [dogeheng](https://github.com/dogeheng), under the [MIT License](LICENSE). Built with the following open-source projects:

- [qq-bridge](https://github.com/Derpyu520/qq-bridge), by Derpyu520 and qq-bridge / QSH contributors, MIT.
- [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll), by c1overzz, MIT. Its bundled bilibili-mcp comes from AGI_Ananas, also under MIT.
- [Seed-VC](https://github.com/Plachtaa/seed-vc), by Plachtaa, GPL-3.0. Optional, invoked as a separate process; its code and weights are not bundled here.

See [NOTICE.md](NOTICE.md) for the full third-party notices.
