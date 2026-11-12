#!/usr/bin/env node
/**
 * 准备零样本说话人聚类（匿名 diarization）的模型：
 *   3D-Speaker CAM++（中文+英文，约 20 万说话人，Apache-2.0）
 *
 * 用法：
 *   node scripts/setup-speaker.mjs           # 下载/补齐
 *   node scripts/setup-speaker.mjs --status
 *
 * 不下载也能跑：call.diarization.mode 会自动降级为 off，不影响通话。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MODEL_DIR = path.join(ROOT, 'data', 'models', 'speaker');
const MODEL = path.join(MODEL_DIR, '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx');
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/'
  + '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';

function status() {
  const ok = fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1024 * 1024;
  console.log(`[speaker] model: ${ok ? '✅' : '❌'} ${MODEL}${ok ? ` (${(fs.statSync(MODEL).size / 1024 / 1024).toFixed(1)} MB)` : ''}`);
  console.log(`[speaker] worker:${fs.existsSync(path.join(ROOT, 'src', 'speaker-worker.mjs')) ? '✅' : '❌'} src/speaker-worker.mjs`);
  console.log('[speaker] 配置: call.diarization.mode = anonymous（模型缺失时自动关闭）');
  return ok;
}

async function download() {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  if (fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1024 * 1024) {
    console.log(`[speaker] 模型已存在：${MODEL}`);
    return;
  }
  console.log(`[speaker] 下载模型：${MODEL_URL}`);
  const response = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024 * 1024) throw new Error(`模型太小（${buffer.length} 字节）`);
  const temp = `${MODEL}.part`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, MODEL);
  console.log(`[speaker] 模型已保存：${MODEL} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

const args = new Set(process.argv.slice(2));
if (args.has('--status')) {
  process.exit(status() ? 0 : 1);
}
try {
  await download();
  process.exit(status() ? 0 : 1);
} catch (error) {
  console.error(`[speaker] 安装失败：${error?.message ?? error}`);
  process.exit(1);
}
