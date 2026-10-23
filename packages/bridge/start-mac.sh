#!/usr/bin/env bash
# macOS 启动/重启桥接。
#
# 为什么需要它：DeepSeek Harness 桌面版每次启动都会换一个随机端口
# （60136 → 58165 → …），而桥接的 dsh.baseUrl 是写死在 config.json 里的。
# 直接 npm start 会在 DSH 重启后一直连旧端口，表现为「QQ 没反应」。
#
# 这个脚本会：
#   1. 找到当前 DeepSeek Harness 进程正在监听的端口，写回 config.json；
#   2. 停掉旧桥接进程（data/bridge.pid）；
#   3. 后台启动新桥接并写回 pid。
#
# 用法：bash ~/Documents/dsh-omni/start-mac.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/DeepSeek/ { n=split($9, a, ":"); if (a[n] ~ /^[0-9]+$/) { print a[n]; exit } }')"
if [ -n "${PORT:-}" ]; then
  DSH_URL="http://127.0.0.1:${PORT}" node -e '
    const fs = require("fs");
    const url = process.env.DSH_URL;
    const c = JSON.parse(fs.readFileSync("config.json", "utf8"));
    if (c.dsh.baseUrl !== url) {
      c.dsh.baseUrl = url;
      fs.writeFileSync("config.json", JSON.stringify(c, null, 2) + "\n");
      console.log("DSH 地址已更新: " + url);
    } else {
      console.log("DSH 地址: " + url);
    }
  '
else
  echo "⚠️  没找到 DSH 监听端口，沿用 config.json 里的 dsh.baseUrl"
fi

if [ -f data/bridge.pid ]; then
  OLD="$(cat data/bridge.pid)"
  if kill "$OLD" 2>/dev/null; then
    echo "已停止旧桥接 pid=$OLD"
    sleep 1
  fi
fi

nohup node src/bridge.js >/dev/null 2>&1 &
echo $! > data/bridge.pid
sleep 3
echo "桥接已启动 pid=$(cat data/bridge.pid)"
tail -4 data/bridge.log
