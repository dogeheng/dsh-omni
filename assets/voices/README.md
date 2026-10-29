# DSH singing reference

`dsh_reference.wav` is generated once from the current CosyVoice voice (the `yuki`
custom voice) and reused by Seed-VC for every short cover. Do not commit the WAV.

Generate / refresh it after changing the CosyVoice voice:

```bash
npm --prefix packages/bridge run make-ref
```

The file should be about 20–25 seconds of clean Chinese speech, 44.1 kHz mono.
It is not a voice model; Seed-VC uses it as a zero-shot target reference.
