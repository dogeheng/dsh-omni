#!/bin/sh
# B-0 第一步：在 snowluma 容器里装 PulseAudio 并配置好客户端默认服务器。
# 在容器里以 root 执行：  sh 01-setup.sh
set -eu

echo "== 1/4 安装 pulseaudio =="
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  pulseaudio pulseaudio-utils libpulse-mainloop-glib0

echo "== 2/4 给 QQ 的用户 node 准备运行时目录 =="
install -d -o node -g node -m 700 /tmp/pulse-node

echo "== 3/4 写全局 pulse 客户端配置（QQ / ffmpeg / pactl 都会读到）=="
mkdir -p /etc/pulse
cat > /etc/pulse/client.conf <<'EOF'
# B-0: 所有本地客户端统一连到我们起的这一个 PulseAudio
default-server = unix:/tmp/pulse-node/pulse/native
autospawn = no
EOF

echo "== 4/4 检查 AVSDK 的依赖是否补齐 =="
if ldd /opt/QQ/resources/app/avsdk/libAVSDKPlugin.so 2>/dev/null | grep -q "not found"; then
  echo "!! 仍有未解析的依赖："
  ldd /opt/QQ/resources/app/avsdk/libAVSDKPlugin.so | grep "not found"
else
  echo "OK: libAVSDKPlugin.so 依赖已全部解析"
fi
