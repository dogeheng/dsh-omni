#!/bin/sh
# B-0 观察器：通话前后盯着 PulseAudio 的流，看 QQ 什么时候接上来。
# 用法：  sh 06-watch.sh [间隔秒，默认 2]
# 放在**打电话之前**跑，一直开着，别关。
INT="${1:-2}"

echo "盯着 PA，每 ${INT}s 一行。Ctrl-C 退出。"
echo "（看到 sink-inputs 从 0 变 1，说明 QQ 已经开始往我们的虚拟扬声器播了）"
echo

while true; do
  SINK=$(pactl list short sink-inputs | wc -l | tr -d ' ')
  SRC=$(pactl list short source-outputs | wc -l | tr -d ' ')
  printf '%s  sink-inputs=%s  source-outputs=%s\n' "$(date +%H:%M:%S)" "$SINK" "$SRC"
  if [ "$SINK" -gt 0 ]; then
    pactl list short sink-inputs | sed 's/^/    OUT->/'
  fi
  if [ "$SRC" -gt 0 ]; then
    pactl list short source-outputs | sed 's/^/    IN <-/'
  fi
  sleep "$INT"
done
