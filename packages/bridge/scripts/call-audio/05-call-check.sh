#!/bin/sh
# B-0 第五步：**通话中**在容器里跑，看 QQ 有没有接上我们的虚拟设备、能不能抓到对方声音。
# 用法：  sh 05-call-check.sh [抓几秒，默认 10]
set -eu

SECS="${1:-10}"
CAP=/tmp/b0-call.raw

echo "== 1/3 QQ 的音频流（有 sink-input 说明它在往 qq_out 播）=="
pactl list short sink-inputs || true
pactl list short source-outputs || true

echo "== 2/3 抓 ${SECS} 秒 qq_out.monitor =="
rm -f "$CAP"
timeout "$SECS" parec --device=qq_out.monitor --format=s16le --rate=48000 --channels=1 --raw > "$CAP" || true
echo "   $(wc -c < "$CAP" | tr -d ' ') bytes"

echo "== 3/3 音量 =="
ffmpeg -hide_banner -f s16le -ar 48000 -ac 1 -i "$CAP" -af volumedetect -f null - 2>&1 \
  | grep -E "mean_volume|max_volume" || true

echo
echo "判定："
echo "  mean_volume 明显高于 -91 dB（例如 -30 ~ -15）→ QQ 的声音进得来"
echo "  sink-inputs 为空或抓不到 → QQ 没用上 qq_out，看 /tmp/pa.log 和 pactl list sinks"
