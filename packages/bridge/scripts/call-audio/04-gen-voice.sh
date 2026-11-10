#!/bin/bash
# B-0 第四步（在 Mac 上跑）：生成一句中文测试语音，灌进容器的虚拟麦克风。
# 用法：  ./04-gen-voice.sh ["要说的中文"] [容器名]
set -euo pipefail

TEXT="${1:-喂，能听见吗？我是大肥鱼，我试一下声音。}"
CTN="${2:-snowluma}"
VOICE="Flo (Chinese (China mainland))"
RAW=/tmp/b0-tts.raw

echo "== 1/3 合成语音（${VOICE}）=="
say -v "$VOICE" -o /tmp/b0-tts.aiff "$TEXT"

echo "== 2/3 转成 48k / 单声道 / s16le =="
ffmpeg -hide_banner -loglevel error -y -i /tmp/b0-tts.aiff -ar 48000 -ac 1 -f s16le "${RAW}"
BYTES=$(wc -c < "${RAW}" | tr -d ' ')
echo "   ${BYTES} bytes（约 $((BYTES / 96000)) 秒）"

echo "== 3/3 灌进 ${CTN}:/tmp/qqin.pcm =="
# 没人从 qq_in 录音时，PulseAudio 会让这个 pipe-source 挂起，
# 此时往 FIFO 写会阻塞。先起一个临时的录音流把它唤醒
# （真通话时 QQ 自己就是那个录音的，所以不需要这一步）。
docker exec -d "$CTN" sh -c \
  'timeout 40 parec --device=qq_in --format=s16le --rate=48000 --channels=1 --raw > /dev/null 2>&1'
sleep 1

if timeout 40 docker exec -i "$CTN" sh -c 'cat > /tmp/qqin.pcm' < "${RAW}"; then
  echo "   已写入"
else
  echo "   !! 写入超时：PA 没在跑，或 pipe-source 没建起来"
  echo "      先跑 02-start-pa.sh，再确认 pactl list short sources 里有 qq_in"
  exit 1
fi

echo "   （如果正在通话，对方现在应该听到这句话）"
