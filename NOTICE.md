# Third-party notices

`dsh-omni` is an integration/derivative work. It is distributed under the MIT
License (see `LICENSE`). The following upstream projects are credited here and
in `README.md`; their licenses remain in effect for their respective portions.

## qq-bridge

- Project: **qq-bridge** — QQ (SnowLuma OneBot v11) ↔ DeepSeek Harness bridge.
- Author: Derpyu520 and qq-bridge / QSH contributors.
- License: MIT.
- Source: https://github.com/Derpyu520/qq-bridge
- Copyright: Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors.

The `packages/bridge` tree is derived from qq-bridge, with local modifications
for this integration (Bilibili card handling, sticker prompting, partial-send
retry, branding, monorepo packaging, and related fixes).

## dsh-bili-scroll

- Project: **dsh-bili-scroll** — DSH plugin for browsing/summarising Bilibili.
- Author: c1overzz.
- License: MIT.
- Source: https://github.com/c1overzz/dsh-bili-scroll
- Copyright: Copyright (c) 2026 c1overzz.

`dsh-bili-scroll` is **not vendored** in this repository. `packages/bili-mcp`
only mounts the read-only Python MCP server that dsh-bili-scroll installs
(`~/.dsh/bili-duty` by default), so users must install dsh-bili-scroll
separately. Its own `NOTICE.md` also covers the third-party code below.

## bilibili-mcp

- Project: **bilibili-mcp** — Python MCP server bundled by dsh-bili-scroll.
- Author: AGI_Ananas.
- License: MIT.
- Copyright: Copyright (c) 2026 AGI_Ananas.

This repository does not copy the bilibili-mcp source; it is referenced through
the dsh-bili-scroll installation. If you redistribute a copy of dsh-bili-scroll
or its vendor directory, keep its `LICENSE` and `NOTICE.md`.

## Voice I/O (ASR / TTS) — ported and referenced projects

`packages/bridge/src/voice-tts.js` and `packages/bridge/src/voice-asr.js` are an
independent JavaScript implementation. The MIT-licensed projects below had parts
of their logic **ported** (text cleaning for speech, trigger defaults, request
formats); their copyright notices are kept here as the MIT License requires.
Details and a per-feature mapping are in `docs/VOICE_IO.md`.

- **maibot-mimotts-voice** — Copyright (c) 2026 Emilia-awa. MIT.
  https://github.com/Emilia-awa/maibot-mimotts-voice (ported via the fork
  https://github.com/Liccsu/maibot-mimotts-voice): `text_processor.py` speech
  text cleaning (short bracket audio tags, style-tag placement, soft breaks,
  terminal punctuation) and the MiMo request shape.
- **maibot-mimo-voice** — Copyright (c) 2026 Ling-LA (upstream), Copyright (c)
  2026 SoulString (modifications). MIT. https://github.com/SoulString-Dev/maibot-mimo-voice :
  random-mode defaults, pitch-stability text rules, default style instruction,
  fixed reference audio for a consistent voice, retryable status codes.
- **ling-tts-bot** — Copyright (c) 2026 Ling-LA. MIT. https://github.com/Ling-LA/ling-tts-bot :
  LLM-trigger / random trigger modes, reference-audio silence trimming, keeping
  code / URLs / tables as text.
- **doubao-tts** — Copyright (c) 2026 昭沧QWQ (ZhaoCang-QWQ). MIT.
  https://github.com/ZhaoCang-QWQ/doubao-tts : Doubao V3 unidirectional request
  and NDJSON response format, emotion mapping, "enums to the model, numbers to
  the human" principle.
- **maibot-sensevoice-stt** — Copyright (c) 2026 StarfallHoshi. MIT.
  https://github.com/DMJXMJ/maibot-sensevoice-stt : local SenseVoice ASR approach.

### FeiyuVoice (optional, external service — not vendored)

[FeiyuVoice](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice)
(CosyVoice3 `cute` / `gentle` TTS + RVC, optional SoulX-Singer SVS) is a
separate Python/GPU service. `packages/bridge/src/voice-tts.js` only implements
an independent HTTP client for it; **no upstream source, model weights or
reference audio are copied into this repository**. `npm run setup:feiyu` may
clone the upstream checkout into the git-ignored `packages/feiyu-voice/` for
local deployment.

Upstream's `NOTICE.md` states that no blanket license is assigned to its
locally authored source; its code, models and runtime dependencies remain under
their own terms. The Feiyu voice material originates from Bilibili creator
**星落落_oi** (https://space.bilibili.com/30584746/); the training authorization
and attribution are recorded in the upstream `COPYRIGHT.md` and are not
relicensed here. Do not redistribute the upstream checkout, model package or
reference audio without checking those terms.

Referenced for design only (no code copied): AstrBot (AGPL-3.0,
https://github.com/AstrBotDevs/AstrBot), MaiBot (GPL-3.0,
https://github.com/Mai-with-u/MaiBot), xuqian13/tts_voice_plugin (AGPL-3.0),
CGl123/gpt-sovits-voice-plugin (AGPL-3.0), A-Dawn/A_TTS_Plugin (GPL),
SengokuCola/aliyun-tts-plugin (MIT).

Optional runtime dependencies (installed by npm, not vendored):
**sherpa-onnx-node** (Apache-2.0, https://github.com/k2-fsa/sherpa-onnx),
**silk-wasm** (MIT). The SenseVoice-Small model
(https://github.com/FunAudioLLM/SenseVoice) is downloaded by
`npm run setup:asr` into the git-ignored `data/models/`; its own model license
applies.

## Runtime dependencies (not bundled)

- **DeepSeek Harness (DSH)** — host application; separate license/terms.
- **SnowLuma** — OneBot v11 gateway; separate license/terms.
- **Speech synthesis providers** (Xiaomi MiMo, Volcengine Doubao, OpenAI-compatible
  endpoints, GPT-SoVITS) — optional external services; their terms apply.
- **QQ / Bilibili** — external services; their terms apply.

## Asset note

`packages/bridge/assets/deepseek娘.png` is kept from the upstream qq-bridge
repository for documentation/branding purposes. If you reuse it outside this
project, check the upstream repository's terms first.
