#!/bin/sh
# B-0 第二步：起 PulseAudio，建两个虚拟设备，设成默认。
# 在容器里以 root 执行：  sh 02-start-pa.sh
set -eu

SOCK=/tmp/pulse-node/pulse/native

if pactl info >/dev/null 2>&1; then
  echo "== PulseAudio 已在运行，跳过启动 =="
else
  echo "== 启动 PulseAudio（以 QQ 的同一个用户 node 运行）=="
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

echo "== 默认设备 =="
pactl set-default-sink   qq_out
pactl set-default-source qq_in

echo "== 现状 =="
pactl info | sed -n '1,10p'
echo "--- sinks"
pactl list short sinks
echo "--- sources"
pactl list short sources
