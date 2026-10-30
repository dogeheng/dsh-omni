#!/usr/bin/env node
/**
 * One-shot "make the stack follow DSH" check, meant to be run by launchd
 * every 20 seconds (see install-watchdog.mjs), and kicked once by the DSH
 * plugin when the app starts (see plugins/dsh-omni-mode-console/lib/index.js).
 *
 * It does four things and exits:
 *   1. find the current DeepSeek Harness listening port;
 *   2. make sure Docker Desktop + the SnowLuma container are up (config.stack);
 *   3. check whether the bridge is alive and its config points at that port;
 *   4. if not, run start-mac.sh (which updates config.json and starts it).
 *
 * It never keeps a long-lived process, so launchd owns the schedule and a
 * crashed/missing bridge can never leave a stale in-memory port behind.
 *
 * 为什么先 Docker 后桥接：桥接启动时就会连 SnowLuma 的 3001；容器还没起来的话，
 * 它会在日志里刷一串 ECONNREFUSED，虽然会自动重连，但看起来像故障。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PID_FILE = path.join(DATA_DIR, 'bridge.pid');
const LOCK_FILE = path.join(DATA_DIR, 'ensure-bridge.lock');
const GUARD_FILE = path.join(DATA_DIR, 'ensure-bridge.state.json');
const START_SCRIPT = path.join(ROOT, 'start-mac.sh');
const LOG_FILE = path.join(DATA_DIR, 'watchdog.log');
const START_COOLDOWN_MS = 90_000;

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
  } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 监听控制台端口的进程（pid 文件过期时用它认领真正活着的桥接）。 */
function portOwner(port) {
  try {
    const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const pid = Number(out.split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function isBridgeProcess(pid) {
  if (!pid) return false;
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /src\/bridge\.js/.test(command);
  } catch {
    return false;
  }
}

function readBaseUrl() {
  try {
    return String(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).dsh?.baseUrl ?? '');
  } catch {
    return '';
  }
}

function findDshPort() {
  let output;
  try {
    output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return 0;
  }
  let fallback = 0;
  for (const line of output.split('\n')) {
    if (!/DeepSeek/.test(line)) continue;
    const name = line.split(/\s+/)[8] || '';
    const match = /:(\d+)\s*\(LISTEN\)/.exec(line);
    if (!match) continue;
    // DSH also listens on an internal *:3081; the bridge needs the loopback Web port.
    if (name.startsWith('127.0.0.1:')) return Number(match[1]);
    if (!fallback) fallback = Number(match[1]);
  }
  return fallback;
}

function readGuard() {
  try {
    const value = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeGuard(value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(GUARD_FILE, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {}
}

function takeLock() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const now = Date.now();
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      // Docker 启动最长等 stack.dockerWaitMs（上限 300s），锁窗口必须比它长，
      // 否则第二个 tick 会重复拉起。
      if (now - stat.mtimeMs < 360_000) return false;
      fs.rmSync(LOCK_FILE, { force: true });
    }
    fs.writeFileSync(LOCK_FILE, `${process.pid} ${now}\n`, { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
}

function dockerReady() {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 8000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function containerRunning(name) {
  try {
    const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      timeout: 8000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  try { spawnSync('sleep', [String(ms / 1000)], { timeout: ms + 5000 }); } catch {}
}

/** 确保 Docker Desktop 在跑；首次启动最多等 stack.dockerWaitMs（默认 120s）。 */
function ensureDocker(stack) {
  if (dockerReady()) return true;
  if (stack.docker === false) {
    log('[ensure-stack] Docker 未运行，且 config.stack.docker=false，跳过');
    return false;
  }
  log('[ensure-stack] Docker 未运行，尝试启动 Docker Desktop');
  try {
    spawnSync('open', ['-a', 'Docker'], { timeout: 20_000, stdio: 'ignore' });
  } catch (error) {
    log(`[ensure-stack] open -a Docker 失败：${error?.message ?? error}`);
    return false;
  }
  const waitMs = Math.min(300_000, Math.max(15_000, Number(stack.dockerWaitMs) || 120_000));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    sleepSync(3000);
    if (dockerReady()) {
      log('[ensure-stack] Docker 已就绪');
      return true;
    }
  }
  log(`[ensure-stack] Docker 在 ${Math.round(waitMs / 1000)}s 内未就绪，先继续启动桥接`);
  return false;
}

/** 确保 SnowLuma 容器在跑：优先 docker start（保留登录态），没有容器才 compose up。 */
function ensureContainer(stack) {
  const name = String(stack.container || 'snowluma');
  if (containerRunning(name)) return true;
  try {
    log(`[ensure-stack] 启动容器 ${name}`);
    execFileSync('docker', ['start', name], { timeout: 90_000, stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch (error) {
    const compose = String(stack.composeFile || 'docker-compose.snowluma.yml');
    log(`[ensure-stack] docker start 失败（${error?.message ?? error}），尝试 compose up`);
    try {
      execFileSync('docker', ['compose', '-f', compose, 'up', '-d'], {
        cwd: ROOT,
        timeout: 240_000,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return true;
    } catch (composeError) {
      log(`[ensure-stack] compose up 失败：${composeError?.message ?? composeError}`);
      return false;
    }
  }
}

function main() {
  const cfg = readConfig();
  const stack = cfg.stack && typeof cfg.stack === 'object' ? cfg.stack : {};
  if (stack.autoStart === false) return;

  const port = findDshPort();
  if (!port) return; // DSH is not running; leave Docker/QQ online, do nothing.

  const expected = `http://127.0.0.1:${port}`;
  const current = readBaseUrl();
  let pid = readPid();
  // pid 文件可能被上一轮 start-mac 写成已退出的 pid，而 3100 仍由旧桥接占着。
  // 先认领端口上的桥接，否则下一轮 start-mac 会再起一个，造成重复进程。
  const consolePort = Math.max(1, Number(cfg.consolePort) || 3100);
  const owner = portOwner(consolePort);
  if (owner && isBridgeProcess(owner) && owner !== pid) {
    try { fs.writeFileSync(PID_FILE, `${owner}\n`, { mode: 0o600 }); } catch {}
    log(`[ensure-bridge] adopted live bridge pid=${owner}（pid 文件原为 ${pid || '空'}）`);
    pid = owner;
  }
  const running = alive(pid) && isBridgeProcess(pid);
  const guard = readGuard();
  const now = Date.now();
  const bridgeHealthy = running && current === expected;
  const container = String(stack.container || 'snowluma');
  // 容器检查每 5 分钟一次就够（这是每 20 秒跑一次的 LaunchAgent，docker info + inspect
  // 每天要 spawn 八千多次，对离电续航不友好）。桥接端口的检查仍然每轮都做。
  const CONTAINER_TTL_MS = 5 * 60 * 1000;
  let containerOk;
  if (guard.containerOk === true && now - Number(guard.containerCheckedAt || 0) < CONTAINER_TTL_MS) {
    containerOk = true;
  } else {
    containerOk = dockerReady() && containerRunning(container);
    writeGuard({ ...guard, containerOk, containerCheckedAt: now });
    guard.containerOk = containerOk;
    guard.containerCheckedAt = now;
  }
  if (bridgeHealthy && containerOk) return;

  // 端口抖动保护：只在「桥接还活着、但配置里的端口和当前探测不一致」时要求连续两次
  // 探测到同一个端口。冷启动（桥接没在跑）立即拉起，不等第二个 tick。
  if (running && !bridgeHealthy) {
    const seen = guard.port === port ? Number(guard.portSeen || 0) + 1 : 1;
    writeGuard({ ...guard, port, portSeen: seen });
    if (seen < 2) {
      log(`[ensure-stack] DSH 端口暂定为 ${port}（第 ${seen} 次），等待下一次确认`);
      return;
    }
  } else if (guard.port !== port) {
    writeGuard({ ...guard, port, portSeen: 1 });
  }

  // 只在「要重启桥接」时套用冷却；容器掉了要立刻补，不能等 90 秒。
  if (!bridgeHealthy && now - Number(guard.lastStartAt || 0) < START_COOLDOWN_MS) {
    log('[ensure-stack] 90s 内刚重启过桥接，跳过本轮以免抖动');
    return;
  }

  if (!takeLock()) return; // another launchd tick is already working
  try {
    // 先保证依赖在，再拉起桥接。桥接健康时只补容器，不动桥接进程。
    if (!containerOk && ensureDocker(stack)) {
      const ok = ensureContainer(stack);
      writeGuard({ ...readGuard(), containerOk: ok, containerCheckedAt: Date.now() });
    }

    if (bridgeHealthy) {
      log('[ensure-stack] 桥接健康，只检查了 SnowLuma 容器');
      return;
    }

    const reason = !running ? 'bridge is not running' : `bridge port is ${current || '(empty)'}, DSH is ${expected}`;
    log(`[ensure-stack] ${reason}; starting via start-mac.sh`);
    const result = spawnSync('bash', [START_SCRIPT], {
      cwd: ROOT,
      timeout: 60_000,
      encoding: 'utf8',
      env: process.env,
    });
    if (result.status === 0) {
      log(`[ensure-stack] started; pid file now ${readPid() || '(missing)'}`);
      writeGuard({ ...readGuard(), port, portSeen: 0, lastStartAt: Date.now() });
    } else {
      log(`[ensure-stack] start-mac.sh failed (status ${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
    }
  } finally {
    releaseLock();
  }
}

main();
