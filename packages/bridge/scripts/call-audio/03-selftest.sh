#!/bin/sh
# B-0 第三步：不碰 QQ，只验媒体管道通不通。
#   1) 往 qq_out 放声音 → 从 qq_out.monitor 抓得到
#   2) 往 /tmp/qqin.pcm 写 PCM → 从 qq_in 读得到
# 在容器里以 root 执行：  sh 03-selftest.sh
set -eu

TONE=/tmp/b0-tone.raw
CAP_OUT=/tmp/b0-cap-out.raw
CAP_IN=/tmp/b0-cap-in.raw
FIFO=/tmp/qqin.pcm

measure() {
  # $1=raw 文件  输出平均音量
  ffmpeg -hide_banner -loglevel info -f s16le -ar 48000 -ac 1 -i "$1" \
         -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume" | tr '\n' ' '
}

echo "== 0/3 生成 1 秒 1kHz 测试音 =="
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=1000:duration=3" \
       -ar 48000 -ac 1 -f s16le "$TONE"
ls -l "$TONE" | awk '{print "   tone:", $5, "bytes"}'

echo "== 1/3 播放 → 抓 qq_out.monitor =="
rm -f "$CAP_OUT"
timeout 6 parec --device=qq_out.monitor --format=s16le --rate=48000 --channels=1 > "$CAP_OUT" &
CAP_PID=$!
sleep 0.8
pacat --device=qq_out --format=s16le --rate=48000 --channels=1 < "$TONE"
sleep 1.5
wait $CAP_PID 2>/dev/null || true
echo -n "   cap-out: "; ls -l "$CAP_OUT" | awk '{printf "%s bytes  ", $5}'; measure "$CAP_OUT"; echo

echo "== 2/3 写 FIFO → 抓 qq_in =="
rm -f "$CAP_IN"
timeout 6 parec --device=qq_in --format=s16le --rate=48000 --channels=1 > "$CAP_IN" &
CAP_PID=$!
sleep 0.8
cat "$TONE" > "$FIFO" || echo "   （写 FIFO 返回非零，可能管道已关闭）"
sleep 1.5
wait $CAP_PID 2>/dev/null || true
echo -n "   cap-in : "; ls -l "$CAP_IN" | awk '{printf "%s bytes  ", $5}'; measure "$CAP_IN"; echo

echo
echo "判定：两行 mean_volume 都明显大于 -91 dB（比如 -20 dB 左右）就算通。"
