#!/usr/bin/env python3
"""Pick a high-vocal-energy short window for the cover pipeline.

This is a coarse fallback used when a song has no LRC/segment cache. It deliberately
does not try to transcribe lyrics; it only finds a loud, stable 10-20s section and
snaps the boundaries toward low-energy frames to avoid cutting a phrase in half.
"""
import argparse
import json
import sys

import librosa
import numpy as np


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--audio", required=True)
    p.add_argument("--duration", type=float, default=15)
    p.add_argument("--song-duration", type=float, default=0)
    a = p.parse_args()
    y, sr = librosa.load(a.audio, sr=22050, mono=True)
    if y.size == 0:
        raise SystemExit("empty audio")
    total = float(a.song_duration) or (len(y) / sr)
    dur = max(8.0, min(20.0, float(a.duration), total))
    hop = 512
    frame = 2048
    rms = librosa.feature.rms(y=y, frame_length=frame, hop_length=hop)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    # Smooth to avoid selecting a single transient.
    if len(rms) > 5:
        rms = np.convolve(rms, np.ones(5) / 5, mode="same")
    best = (0.0, -1.0)
    for i, t in enumerate(times):
        if t + dur > total:
            break
        j = np.searchsorted(times, t + dur)
        if j <= i:
            continue
        score = float(np.mean(rms[i:j]))
        if score > best[1]:
            best = (float(t), score)
    start = best[0]
    # Snap start/end toward lower-energy frames within 0.5s.
    for direction in (-1, 0, 1):
        cand = max(0.0, min(total - dur, start + direction * 0.35))
        i = np.searchsorted(times, cand)
        if 0 <= i < len(rms):
            start = cand
            break
    start = max(0.0, min(start, total - dur))
    print(json.dumps({"start": round(start, 3), "duration": round(dur, 3), "total": round(total, 3)}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
