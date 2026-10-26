#!/usr/bin/env node
// 下载本地语音识别模型（SenseVoice-Small int8，sherpa-onnx 官方转换版，约 160MB 压缩包 / 230MB 解压）。
//
//   npm run setup:asr            # 下载到 data/models/（已在 .gitignore 里）
//   npm run setup:asr -- --force # 重新下载
//
// 模型来源：k2-fsa/sherpa-onnx 的 asr-models 发布页（FunAudioLLM/SenseVoice 的 ONNX 导出）。
// 选 2024-07-17 版而不是 2025-09-09 版：后者不输出情绪/事件标签，而「语气开心」「有笑声」
// 这类信息正是让大肥鱼听出语气的关键。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_SENSEVOICE_DIR, SENSEVOICE_MODEL_URL } from '../src/voice-asr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const modelDir = path.join(ROOT, DEFAULT_SENSEVOICE_DIR);
const modelsRoot = path.dirname(modelDir);
const archive = path.join(modelsRoot, path.basename(new URL(SENSEVOICE_MODEL_URL).pathname));

function ready() {
  return fs.existsSync(path.join(modelDir, 'model.int8.onnx')) && fs.existsSync(path.join(modelDir, 'tokens.txt'));
}

if (ready() && !force) {
  console.log(`✅ SenseVoice 模型已存在：${path.relative(ROOT, modelDir)}`);
  process.exit(0);
}

fs.mkdirSync(modelsRoot, { recursive: true });
console.log(`⬇️  下载 ${SENSEVOICE_MODEL_URL}`);
const res = await fetch(SENSEVOICE_MODEL_URL, { redirect: 'follow' });
if (!res.ok || !res.body) {
  console.error(`❌ 下载失败：HTTP ${res.status}。可以手动下载上面的地址，解压到 ${path.relative(ROOT, modelsRoot)}/ 下`);
  process.exit(1);
}
const total = Number(res.headers.get('content-length') || 0);
let done = 0;
let lastPct = -1;
const body = Readable.fromWeb(res.body);
body.on('data', (chunk) => {
  done += chunk.length;
  const pct = total ? Math.floor((done / total) * 100) : -1;
  if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`  ${pct}%`); }
});
await pipeline(body, fs.createWriteStream(archive));
process.stdout.write('\n');

console.log('📦 解压中…');
// macOS / Linux / Windows 10+ 自带的 tar（bsdtar）都支持 bz2
const r = spawnSync('tar', ['-xjf', archive, '-C', modelsRoot], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`❌ 解压失败，请手动解压 ${archive} 到 ${modelsRoot}`);
  process.exit(1);
}
fs.rmSync(archive, { force: true });
if (!ready()) {
  console.error(`❌ 解压后没找到 model.int8.onnx / tokens.txt（目录：${modelDir}）`);
  process.exit(1);
}
console.log(`✅ 完成：${path.relative(ROOT, modelDir)}`);
console.log('   重启桥接后，群友发的语音会自动转写成「[语音 N秒] 原话」。');
