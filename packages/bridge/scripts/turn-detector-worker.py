#!/usr/bin/env python3
"""Smart Turn v3 端点检测 worker（stdio JSON Lines）。

call-loop 是 Node，模型是 ONNX + Whisper feature extractor，所以单独跑一个常驻
Python 进程：stdin 收 `{"id":..,"pcm":"<base64 s16le 16k mono>"}`，stdout 回
`{"id":..,"probability":0..1}`。模型不可用时 call-loop 会退回标点启发式。

用法（一般由 call-loop 拉起）：
  .turn-venv/bin/python scripts/turn-detector-worker.py \
      data/models/smart-turn/smart-turn-v3.2-cpu.onnx
"""
import base64
import json
import os
import sys

os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import onnxruntime as ort
from transformers import WhisperFeatureExtractor

SAMPLE_RATE = 16000
MAX_SECONDS = 8
MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS


def build_session(model_path):
    so = ort.SessionOptions()
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.inter_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(model_path, sess_options=so)


def predict(session, extractor, input_name, pcm):
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size == 0:
        raise ValueError("empty audio")
    if audio.size > MAX_SAMPLES:
        audio = audio[-MAX_SAMPLES:]
    elif audio.size < MAX_SAMPLES:
        audio = np.pad(audio, (MAX_SAMPLES - audio.size, 0), mode="constant")
    inputs = extractor(
        audio,
        sampling_rate=SAMPLE_RATE,
        return_tensors="np",
        padding="max_length",
        max_length=MAX_SAMPLES,
        truncation=True,
        do_normalize=True,
    )
    features = inputs.input_features.squeeze(0).astype(np.float32)
    features = np.expand_dims(features, axis=0)
    out = session.run(None, {input_name: features})[0]
    return float(np.asarray(out).reshape(-1)[0])


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"type": "fatal", "error": "missing model path"}), flush=True)
        return 1
    model_path = sys.argv[1]
    try:
        extractor = WhisperFeatureExtractor(chunk_length=MAX_SECONDS)
        session = build_session(model_path)
        input_name = session.get_inputs()[0].name
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"type": "fatal", "error": str(error)}), flush=True)
        return 1

    print(json.dumps({"type": "ready"}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = None
        try:
            msg = json.loads(line)
            pcm = base64.b64decode(msg.get("pcm", ""))
            probability = predict(session, extractor, input_name, pcm)
            print(json.dumps({"id": msg.get("id"), "probability": probability}), flush=True)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({
                "id": msg.get("id") if isinstance(msg, dict) else None,
                "error": str(error),
            }), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
