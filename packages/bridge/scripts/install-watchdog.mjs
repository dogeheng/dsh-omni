#!/usr/bin/env node
/**
 * Install a per-user macOS LaunchAgent that runs ensure-bridge.mjs every
 * 20 seconds. This is what makes the whole stack follow DSH: when DSH is up,
 * it starts Docker / SnowLuma if needed, then keeps the bridge pointed at the
 * current DSH port (DSH changes its port on every restart).
 *
 * Usage:
 *   node scripts/install-watchdog.mjs            # install + start
 *   node scripts/install-watchdog.mjs --status   # show launchd state
 *   node scripts/install-watchdog.mjs --uninstall
 *
 * No sudo. The plist lives in ~/Library/LaunchAgents.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SCRIPT = path.join(HERE, 'ensure-bridge.mjs');
const LABEL = 'com.dogeheng.dsh-omni-bridge';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
// launchd 自己打开 StandardOut/Error 时不走进程的 TCC 授权：如果日志放在
// ~/Documents（macOS 受保护目录），xpcproxy 会报 "Operation not permitted"
// 并让整个 job 变成 spawn failed。日志统一放到 ~/Library/Logs。
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'dsh-omni');
const LOG = path.join(LOG_DIR, 'watchdog.log');
const UID = String(process.getuid?.() ?? '');
const DOMAIN = `gui/${UID}`;
const NODE = process.execPath;

function fail(message) {
  console.error(`[watchdog] ${message}`);
  process.exit(1);
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function pathEnv() {
  // LaunchAgent 不继承登录 shell 的 PATH；把安装时的 PATH（nvm/fnm/volta 等）
  // 和 Node 自身目录一起写进去，换一台电脑/换 Node 安装方式也能找到解释器。
  const fromShell = String(process.env.PATH || '').split(':').filter(Boolean);
  return [...new Set([
    path.dirname(NODE),
    ...fromShell,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])].join(':');
}

function plistText() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(NODE)}</string>
    <string>${xml(SCRIPT)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>20</integer>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathEnv())}</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args, { ignoreFailure = false } = {}) {
  try {
    const output = execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output.trim();
  } catch (error) {
    if (ignoreFailure) return '';
    throw error;
  }
}

function bootout() {
  launchctl(['bootout', `${DOMAIN}/${LABEL}`], { ignoreFailure: true });
}

function install() {
  if (process.platform !== 'darwin') fail('this installer currently supports macOS only');
  if (!fs.existsSync(SCRIPT)) fail(`missing ${SCRIPT}`);
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PLIST, plistText(), { mode: 0o644 });
  bootout();
  try {
    launchctl(['bootstrap', DOMAIN, PLIST]);
    launchctl(['enable', `${DOMAIN}/${LABEL}`], { ignoreFailure: true });
    launchctl(['kickstart', '-k', `${DOMAIN}/${LABEL}`], { ignoreFailure: true });
  } catch (error) {
    fail(`launchctl bootstrap failed: ${error?.stderr?.toString?.() ?? error?.message ?? error}`);
  }
  console.log(`[watchdog] installed ${LABEL}`);
  console.log(`[watchdog] plist:  ${PLIST}`);
  console.log(`[watchdog] script: ${SCRIPT}`);
  console.log(`[watchdog] logs:   ${LOG}`);
  console.log(`[watchdog] next:   every 20s, and at login (Docker → container → bridge)`);
}

function status() {
  try {
    console.log(launchctl(['print', `${DOMAIN}/${LABEL}`]));
  } catch (error) {
    console.log('[watchdog] not loaded');
  }
}

function uninstall() {
  bootout();
  try { fs.rmSync(PLIST, { force: true }); } catch {}
  console.log(`[watchdog] removed ${LABEL}`);
}

const args = new Set(process.argv.slice(2));
if (args.has('--uninstall')) uninstall();
else if (args.has('--status')) status();
else install();
