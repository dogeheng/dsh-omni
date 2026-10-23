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

## Runtime dependencies (not bundled)

- **DeepSeek Harness (DSH)** — host application; separate license/terms.
- **SnowLuma** — OneBot v11 gateway; separate license/terms.
- **QQ / Bilibili** — external services; their terms apply.

## Asset note

`packages/bridge/assets/deepseek娘.png` is kept from the upstream qq-bridge
repository for documentation/branding purposes. If you reuse it outside this
project, check the upstream repository's terms first.
