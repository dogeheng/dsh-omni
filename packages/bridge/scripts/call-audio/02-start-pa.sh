#!/bin/sh
# B-0 第二步：起 PulseAudio，建两个虚拟设备，设成默认。
# 在容器里以 root 执行：  sh 02-start-pa.sh
#
# 这个脚本要能反复执行：容器重启后 /tmp 里的旧 FIFO 还在，而 module-pipe-source
# 不会覆盖已存在的 FIFO（mkfifo 报 File exists），PA 就会少一个 qq_in。所以每次
# 启动前先清掉旧 FIFO；如果 PA 已经在跑，就只补缺失的 sink/source。
set -eu

SOCK=/tmp/pulse-node/pulse/native
FIFO=/tmp/qqin.pcm

if pactl info >/dev/null 2>&1; then
  echo "== PulseAudio 已在运行，跳过启动 =="
else
  echo "== 启动 PulseAudio（以 QQ 的同一个用户 node 运行）=="
  rm -f "$FIFO"
  cat > /tmp/start-pa-node.sh <<'EOF'
#!/bin/sh
export XDG_RUNTIME_DIR=/tmp/pulse-node
exec pulseaudio -n -D --exit-idle-time=-1 --disallow-exit \
  --log-target=file:/tmp/pa.log \
  --load="module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse-node/pulse/native" \
  --load="module-null-sink sink_name=qq_out rate=48000 channels=2 sink_properties=device.description=QQOut" \
  --load="module-pipe-source source_name=qq_in file=/tmp/qqin.pcm format=s16le rate=48000 channels=1"
EOF
  chmod +x /tmp/start-pa-node.sh
  su -s /bin/sh node -c /tmp/start-pa-node.sh
  # 等 socket 出现
  i=0
  while [ ! -S "$SOCK" ] && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done
  [ -S "$SOCK" ] || { echo "!! PulseAudio 没起来，看 /tmp/pa.log"; tail -20 /tmp/pa.log 2>/dev/null; exit 1; }
fi

# 上面 PA 起不来时模块会缺；这里按需补齐，脚本因此可以重复执行。
if ! pactl list short sinks | grep -q 'qq_out'; then
  echo "== 补 qq_out =="
  pactl load-module module-null-sink sink_name=qq_out rate=48000 channels=2 sink_properties=device.description=QQOut >/dev/null
fi
if ! pactl list short sources | grep -q 'qq_in'; then
  echo "== 补 qq_in =="
  rm -f "$FIFO"
  pactl load-module module-pipe-source source_name=qq_in file="$FIFO" format=s16le rate=48000 channels=1 >/dev/null
fi

echo "== 默认设备 =="
pactl set-default-sink   qq_out
pactl set-default-source qq_in

echo "== 现状 =="
pactl info | sed -n '1,10p'
echo "--- sinks"
pactl list short sinks
echo "--- sources"
pactl list short sources
