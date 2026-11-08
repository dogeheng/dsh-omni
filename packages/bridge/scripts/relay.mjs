#!/usr/bin/env node
// dsh-omni relay 命令行：让任何脚本/agent 通过 QQ 问你一句话并拿到回答。
//
// 为什么做成 CLI 而不是 SDK：Codex、Claude Code、定时任务、shell 脚本都能直接调一行，
// 不需要装包、不需要起常驻进程。`ask` 会阻塞到有答案/超时；这就是"按需启动的守护进程"。
//
// 用法：
//   relay ask "期望薪资填哪个？" --choices 25k,30k --timeout 1800
//   relay ask "..." --app resume-bot
//   relay notify "简历投完了，3 家进面试"
//   relay status <id>
//   relay apps new resume-bot        # 管理动作，需要控制台令牌
//   relay apps list
//   relay apps revoke <id>
//
// 配置：环境变量 DSH_OMNI_RELAY_TOKEN / DSH_OMNI_RELAY_URL，
//       或 ~/.config/dsh-omni/relay.json（{"token":"relay_...","url":"http://127.0.0.1:3100"}）。
// 退出码：0 有答案 · 2 超时 · 3 被取消 · 4 投递失败/参数错误。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(os.homedir(), '.config', 'dsh-omni', 'relay.json');

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const fileCfg = readJson(CONFIG_FILE, {});
const baseUrl = String(process.env.DSH_OMNI_RELAY_URL || fileCfg.url || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const token = String(process.env.DSH_OMNI_RELAY_TOKEN || fileCfg.token || '').trim();

function consoleToken() {
  if (process.env.DSH_OMNI_CONSOLE_TOKEN) return String(process.env.DSH_OMNI_CONSOLE_TOKEN).trim();
  const local = path.join(ROOT, 'data', 'console-token');
  const raw = readJsonSafeText(local);
  return String(raw ?? '').trim();
}

function readJsonSafeText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

async function call(pathname, { method = 'GET', body, useConsole = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (useConsole) {
    const ct = consoleToken();
    if (!ct) throw new Error('找不到控制台令牌（data/console-token），可设 DSH_OMNI_CONSOLE_TOKEN');
    headers['x-console-token'] = ct;
  } else {
    if (!token) throw new Error('缺少中继令牌：设 DSH_OMNI_RELAY_TOKEN，或写进 ~/.config/dsh-omni/relay.json');
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else {
      positional.push(item);
    }
  }
  return { positional, flags };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cmdAsk(positional, flags) {
  const text = positional.join(' ').trim();
  if (!text) throw new Error('用法：relay ask "问题" [--choices a,b] [--timeout 秒] [--app 名字]');
  const choices = String(flags.choices ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const timeoutSec = Math.max(30, Number(flags.timeout ?? 1800));
  const created = await call('/api/relay/ask', {
    method: 'POST',
    body: { text, choices, timeoutSec, level: flags.urgent ? 'urgent' : (flags.level || 'warn'), waitSec: 0 }
  });
  process.stderr.write(`已发出 #${created.code}（${created.id}），等回答…\n`);
  const deadline = Date.now() + timeoutSec * 1000;
  let current = created;
  while (!['answered', 'timeout', 'cancelled', 'undeliverable'].includes(current.status)) {
    if (Date.now() > deadline) break;
    await sleep(500);
    current = await call(`/api/relay/requests/${encodeURIComponent(current.id)}?wait=25`);
  }
  if (current.status === 'answered') {
    process.stdout.write(String(current.answer?.text ?? ''));
    return 0;
  }
  process.stderr.write(current.status === 'timeout' ? '超时未回答\n' : `未得到回答：${current.status}${current.lastError ? `（${current.lastError}）` : ''}\n`);
  if (current.status === 'cancelled') return 3;
  if (current.status === 'undeliverable') return 4;
  return 2;
}

async function cmdNotify(positional, flags) {
  const text = positional.join(' ').trim();
  if (!text) throw new Error('用法：relay notify "内容"');
  const created = await call('/api/relay/notify', {
    method: 'POST',
    body: { text, level: flags.urgent ? 'urgent' : (flags.level || 'info') }
  });
  process.stderr.write(`已发送（${created.id}）\n`);
  return 0;
}

async function cmdStatus(positional) {
  const id = positional[0];
  if (!id) throw new Error('用法：relay status <id>');
  const data = await call(`/api/relay/requests/${encodeURIComponent(id)}`);
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  return 0;
}

async function cmdApps(positional) {
  const [action, arg] = positional;
  if (action === 'new') {
    if (!arg) throw new Error('用法：relay apps new <应用名>');
    const data = await call('/api/relay-admin/apps', { method: 'POST', body: { name: arg }, useConsole: true });
    process.stdout.write(`应用：${data.app.name}（${data.app.id}）\n令牌（只显示这一次）：\n${data.token}\n`);
    return 0;
  }
  if (action === 'revoke') {
    if (!arg) throw new Error('用法：relay apps revoke <appId>');
    await call('/api/relay-admin/apps/revoke', { method: 'POST', body: { id: arg }, useConsole: true });
    process.stderr.write('已吊销\n');
    return 0;
  }
  const data = await call('/api/relay-admin/status', { useConsole: true });
  if (!data.apps?.length) { process.stdout.write('（没有应用）\n'); return 0; }
  for (const app of data.apps) {
    process.stdout.write(`${app.id}\t${app.name}\t${app.hint}…\t${app.revoked ? '已吊销' : '有效'}\n`);
  }
  return 0;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.shift();
  try {
    if (command === 'ask') process.exitCode = await cmdAsk(positional, flags);
    else if (command === 'notify') process.exitCode = await cmdNotify(positional, flags);
    else if (command === 'status') process.exitCode = await cmdStatus(positional);
    else if (command === 'apps') process.exitCode = await cmdApps(positional);
    else {
      process.stderr.write('用法：relay <ask|notify|status|apps> ...\n');
      process.exitCode = 4;
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 4;
  }
}

main();
