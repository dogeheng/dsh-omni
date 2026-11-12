#!/usr/bin/env node
/**
 * 本地声纹库运维 CLI。
 *
 * 用法：
 *   node scripts/voiceprints.mjs list [--json]
 *   node scripts/voiceprints.mjs enroll --name 张三 --audio ./sample.wav [--qq 12345678] [--dir data/voiceprints]
 *   node scripts/voiceprints.mjs rename --id qq_12345678 --name 张三丰
 *   node scripts/voiceprints.mjs remove --id qq_12345678
 *
 * 模型：data/models/speaker/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
 * 没装模型时先 npm run setup:speaker。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { VoiceprintStore } from '../src/voiceprints.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MODEL = path.join(ROOT, 'data', 'models', 'speaker', '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx');

function usage() {
  console.log(`用法：
  voiceprints list [--json]
  voiceprints enroll --name 张三 --audio ./sample.wav [--qq 12345678]
  voiceprints rename --id qq_12345678 --name 张三丰
  voiceprints remove --id qq_12345678

可选：--dir <声纹目录>（默认 data/voiceprints；测试/迁移用）`);
}

function parse(argv) {
  const opts = {};
  const rest = [...argv];
  const command = rest.shift();
  while (rest.length) {
    const token = rest.shift();
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`);
    const key = token.slice(2);
    if (['json', 'help'].includes(key)) { opts[key] = true; continue; }
    const value = rest.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`);
    opts[key] = value;
  }
  return { command, opts };
}

function pcmToFloat(buffer) {
  const samples = new Float32Array(buffer.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

function extractCentroid(audioFile) {
  if (!fs.existsSync(audioFile)) throw new Error(`音频不存在：${audioFile}`);
  if (!fs.existsSync(MODEL)) throw new Error(`缺少声纹模型：${MODEL}\n先运行 npm run setup:speaker`);
  const pcm = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', audioFile,
    '-t', '20', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'
  ], { maxBuffer: 64 * 1024 * 1024 });
  if (pcm.length < 16000 * 2) throw new Error('音频太短（至少 1 秒）');
  const sherpa = require('sherpa-onnx-node');
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 1 });
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples: pcmToFloat(pcm) });
  const embedding = extractor.compute(stream);
  return { centroid: [...embedding], samplePcm: Buffer.from(pcm.subarray(0, 16000 * 2 * 5)) };
}

const { command, opts } = parse(process.argv.slice(2));
if (!command || command === 'help' || opts.help) { usage(); process.exit(command ? 0 : 1); }
const dir = opts.dir ? path.resolve(ROOT, opts.dir) : null;
const store = new VoiceprintStore({ root: ROOT, dir, log: (tag, message) => console.error(`[${tag}] ${message}`) });

try {
  if (command === 'list') {
    const rows = store.list();
    if (opts.json) console.log(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) console.log('（声纹库为空）');
    else {
      console.log('ID\t名字\tQQ\t样本\t来源\t试听');
      for (const r of rows) console.log(`${r.id}\t${r.name}\t${r.qq || '-'}\t${r.samples}\t${r.source}\t${r.hasSample ? '有' : '无'}`);
    }
  } else if (command === 'enroll') {
    if (!opts.name || !opts.audio) { usage(); process.exit(1); }
    const { centroid, samplePcm } = extractCentroid(path.resolve(process.cwd(), String(opts.audio)));
    const record = store.enroll({
      name: opts.name,
      qq: opts.qq || '',
      centroid,
      samples: 1,
      source: 'manual',
      samplePcm
    });
    console.log(JSON.stringify({ ok: true, id: record.id, name: record.name, qq: record.qq, samples: record.samples }, null, 2));
  } else if (command === 'rename') {
    if (!opts.id || !opts.name) { usage(); process.exit(1); }
    const record = store.rename(String(opts.id), opts.name);
    console.log(JSON.stringify({ ok: true, id: record.id, name: record.name }, null, 2));
  } else if (command === 'remove') {
    if (!opts.id) { usage(); process.exit(1); }
    const record = store.remove(String(opts.id));
    console.log(JSON.stringify({ ok: true, id: record.id, name: record.name }, null, 2));
  } else {
    usage();
    process.exit(1);
  }
} catch (error) {
  console.error(`voiceprints: ${error?.message ?? error}`);
  process.exit(1);
}
