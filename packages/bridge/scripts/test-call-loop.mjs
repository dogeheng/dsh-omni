#!/usr/bin/env node
/**
 * call-loop 集成自测：不碰容器、不需要打电话。
 *
 * 拿仓库自带的 zh.wav 当"对方说的话"，喂给 call-loop，
 * 检查「断句 → 识别 → DSH 思考 → TTS 合成 → 写出 48k PCM」整条链是否走通。
 *
 * 需要：DSH 在跑（config.json 的 dsh.baseUrl 可达）+ TTS 服务商可用。
 * 用法：npm run test:call
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WAV = path.join(ROOT, 'data/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav');
const OUT = path.join(os.tmpdir(), `call-loop-test-${process.pid}.raw`);

const checks = [];
const ok = (name, detail = '') => checks.push({ name, pass: true, detail });
const bad = (name, detail = '') => checks.push({ name, pass: false, detail });

function run() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'call-loop.mjs'),
      '--from-wav', WAV,
      '--out-wav', OUT,
      '--once'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
    child.stderr.on('data', (b) => { out += b; process.stderr.write(b); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function main() {
  if (!fs.existsSync(WAV)) {
    console.error(`缺少测试音频：${WAV}`);
    process.exit(1);
  }
  try { fs.unlinkSync(OUT); } catch {}

  console.log(`== 输入：${path.basename(WAV)}`);
  const { code, out } = await run();

  code === 0 ? ok('进程正常退出') : bad('进程正常退出', `code=${code}`);

  const vad = out.match(/vad\s+一句话 ([\d.]+)s/);
  vad ? ok('VAD 切出一句话', `${vad[1]}s`) : bad('VAD 切出一句话');

  const asr = out.match(/asr\s+\d+ms → 「(.+?)」/);
  asr && asr[1].trim().length >= 2 ? ok('SenseVoice 识别', asr[1]) : bad('SenseVoice 识别');

  const brain = out.match(/brain\s+\d+ms → 「(.+?)」/);
  brain && brain[1].trim() ? ok('DSH 回复', brain[1].slice(0, 40)) : bad('DSH 回复');

  const tts = out.match(/tts\s+首句开口 (\d+)ms（共 (\d+) 句）/);
  tts ? ok('TTS 首句开口', `${tts[1]}ms，共 ${tts[2]} 句`) : bad('TTS 首句开口');

  let bytes = 0;
  try { bytes = fs.statSync(OUT).size; } catch {}
  const seconds = bytes / 2 / 48000;
  bytes > 48000 * 2 * 0.5
    ? ok('输出 48k PCM', `${(bytes / 1024).toFixed(0)}KB / ${seconds.toFixed(2)}s`)
    : bad('输出 48k PCM', `${bytes} bytes`);

  try { fs.unlinkSync(OUT); } catch {}

  console.log('\n== 结果');
  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? `：${c.detail}` : ''}`);
  }
  console.log(failed === 0 ? '\nPASS' : `\nFAIL（${failed} 项）`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
