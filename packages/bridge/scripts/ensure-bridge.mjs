#!/usr/bin/env node
/**
 * One-shot "make the bridge follow DSH" check, meant to be run by launchd
 * every 20 seconds (see install-watchdog.mjs).
 *
 * It does three things and exits:
 *   1. find the current DeepSeek Harness listening port;
 *   2. check whether the bridge is alive and its config points at that port;
 *   3. if not, run start-mac.sh (which updates config.json and starts it).
 *
 * It never keeps a long-lived process, so launchd owns the schedule and a
 * crashed/missing bridge can never leave a stale in-memory port behind.
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
const START_SCRIPT = path.join(ROOT, 'start-mac.sh');
const LOG_FILE = path.join(DATA_DIR, 'watchdog.log');

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
  } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
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
  for (const line of output.split('\n')) {
    if (!/DeepSeek/.test(line)) continue;
    const match = /:(\d+)\s*\(LISTEN\)/.exec(line);
    if (match) return Number(match[1]);
  }
  return 0;
}

function takeLock() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const now = Date.now();
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      if (now - stat.mtimeMs < 60_000) return false;
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

function main() {
  const port = findDshPort();
  if (!port) return; // DSH is not running; nothing to attach to.

  const expected = `http://127.0.0.1:${port}`;
  const current = readBaseUrl();
  const pid = readPid();
  const running = alive(pid);

  if (running && current === expected) return;

  if (!takeLock()) return; // another launchd tick is already working
  try {
    const reason = !running ? 'bridge is not running' : `bridge port is ${current || '(empty)'}, DSH is ${expected}`;
    log(`[ensure-bridge] ${reason}; starting via start-mac.sh`);
    const result = spawnSync('bash', [START_SCRIPT], {
      cwd: ROOT,
      timeout: 60_000,
      encoding: 'utf8',
      env: process.env,
    });
    if (result.status === 0) log(`[ensure-bridge] started; pid file now ${readPid() || '(missing)'}`);
    else log(`[ensure-bridge] start-mac.sh failed (status ${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  } finally {
    releaseLock();
  }
}

main();
