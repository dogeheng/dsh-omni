#!/usr/bin/env node
/**
 * 把 call-loop 装成常驻的 LaunchAgent（macOS）。
 *
 * 目的是「不用手动开脚本」：开机/登录自动跑，挂了自动重起。
 * 常驻的只是一个几十 MB 的看门进程；ASR、TTS、麦克风泵仍然是按需拉起、挂断回收。
 *
 * 用法：npm run install:call      卸载：npm run uninstall:call
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LABEL = 'com.dogeheng.dsh-omni-call';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const SCRIPT = path.join(ROOT, 'scripts', 'call-loop.mjs');
const LOG = path.join(ROOT, 'data', 'call-loop.log');

function which(bin) {
  try {
    return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function pathForLaunchd() {
  const dirs = new Set(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  for (const bin of ['docker', 'ffmpeg', 'node']) {
    const p = which(bin);
    if (p) dirs.add(path.dirname(p));
  }
  return [...dirs].join(':');
}

const node = process.execPath;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(SCRIPT)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathForLaunchd())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;

fs.mkdirSync(path.dirname(PLIST), { recursive: true });
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(PLIST, plist);

const domain = `gui/${process.getuid()}`;
try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }); } catch {}
try {
  execFileSync('launchctl', ['bootstrap', domain, PLIST], { stdio: 'inherit' });
  execFileSync('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`], { stdio: 'ignore' });
} catch (error) {
  console.error(`安装失败：${error?.message ?? error}`);
  console.error(`手动试：launchctl bootstrap ${domain} ${PLIST}`);
  process.exit(1);
}

console.log(`✅ 已安装并启动：${LABEL}`);
console.log(`   plist: ${PLIST}`);
console.log(`   日志 : ${LOG}`);
console.log(`   卸载 : npm run uninstall:call`);
