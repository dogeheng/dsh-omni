# README media

These files are shared by the Chinese and English READMEs.

- `mark.svg`, `badge-*.svg`, `lang-*.svg`: local vector assets matching the console palette. Language links use separate selected and unselected states.
- `console-overview.png`, `console-overview-dark.png`: the same overview in light and dark themes.
- `console-settings.png`: conversation settings with contextual help.
- `companion-actions.gif`: gestures recorded from the real console renderer, using synthetic fixture data.
- `companion-still.png`: the static alternative for readers who prefer reduced motion.

To recapture the screenshots and GIF from the repository root:

```bash
node packages/bridge/scripts/capture-readme-media.mjs
```

The script requires Playwright, a browser and its video encoder, plus `ffmpeg` for GIF conversion. Existing tool installations can be selected with `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, and `FFMPEG_BIN`. It starts its own offline fixture and makes no production QQ/DSH connections or configuration writes.
