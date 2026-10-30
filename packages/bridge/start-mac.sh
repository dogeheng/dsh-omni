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

# DeepSeek 可能同时监听 *:3081（内部）和 127.0.0.1:<随机>（Web GUI）。
# 桥接必须连后者；优先选 127.0.0.1 上的端口。
PORT="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/DeepSeek/ { name=$9; if (name ~ /^127\.0\.0\.1:/) { n=split(name, a, ":"); if (a[n] ~ /^[0-9]+$/) { print a[n]; exit } } }')"
if [ -z "${PORT:-}" ]; then
  PORT="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/DeepSeek/ { name=$9; n=split(name, a, ":"); if (a[n] ~ /^[0-9]+$/) { print a[n]; exit } }')"
fi
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

# 停掉本目录下所有桥接。只杀 data/bridge.pid 不够：watchdog 可能把 pid 文件
# 覆盖成一个已经退出的 pid，而真正占着 3100 的旧进程还活着；再启动就会撞
# EADDRINUSE，并在日志里留下“两个桥接”的假象。
stop_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  local cwd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [ "$cwd" = "$PWD" ] || return 0
  if kill "$pid" 2>/dev/null; then
    echo "已停止旧桥接 pid=$pid"
  fi
}

if [ -f data/bridge.pid ]; then
  stop_pid "$(cat data/bridge.pid)"
fi
# 端口上活着的桥接（pid 文件过期时不会出现在上面的检查里）
for pid in $(lsof -nP -t -iTCP:3100 -sTCP:LISTEN 2>/dev/null || true); do
  stop_pid "$pid"
done
# 按命令名兜底：刚启动、还没开始监听端口的桥接
for pid in $(pgrep -f "node src/bridge.js" 2>/dev/null || true); do
  stop_pid "$pid"
done
# 等端口释放，最多 10 秒
for _ in $(seq 1 20); do
  lsof -nP -iTCP:3100 -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.5
done

# 用 Node 的 detached spawn 而不是 nohup：从 launchd/DSH 这类短命父进程里
# 启动时，nohup 只能忽略 SIGHUP，子进程仍留在父进程的 process group 里，
# 父进程退出时可能被一起杀掉。detached 会新建 session/process group，
# unref() 后父进程退出也不影响桥接。
node <<'NODE'
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['src/bridge.js'], {
  cwd: process.cwd(),
  detached: true,
  stdio: 'ignore',
  env: process.env,
});
child.unref();
fs.writeFileSync('data/bridge.pid', String(child.pid));
NODE
sleep 3
echo "桥接已启动 pid=$(cat data/bridge.pid)"
tail -4 data/bridge.log
