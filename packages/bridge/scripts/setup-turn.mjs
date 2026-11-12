#!/usr/bin/env node
/**
 * 准备语义端点检测（Pipecat Smart Turn v3）：
 *   - 在 packages/bridge/.turn-venv 建独立 Python 环境（不碰 Seed-VC 的 venv）
 *   - 安装 onnxruntime / numpy / transformers
 *   - 下载 8MB int8 ONNX 模型到 data/models/smart-turn/
 *
 * 用法：
 *   node scripts/setup-turn.mjs            # 安装/补齐
 *   node scripts/setup-turn.mjs --status   # 只看状态
 *   node scripts/setup-turn.mjs --force    # 重装依赖
 *
 * 不装也能跑：call-loop 会自动回退到「句末标点 + 连接词」启发式。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VENV = path.join(ROOT, '.turn-venv');
const PYTHON = path.join(VENV, 'bin', 'python');
const MODEL_DIR = path.join(ROOT, 'data', 'models', 'smart-turn');
const MODEL = path.join(MODEL_DIR, 'smart-turn-v3.2-cpu.onnx');
const MODEL_URL = 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx';
const WORKER = path.join(HERE, 'turn-detector-worker.py');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`);
}

function status() {
  const py = fs.existsSync(PYTHON);
  const model = fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1024 * 1024;
  console.log(`[turn] venv:  ${py ? '✅' : '❌'} ${VENV}`);
  console.log(`[turn] model: ${model ? '✅' : '❌'} ${MODEL}${model ? ` (${(fs.statSync(MODEL).size / 1024 / 1024).toFixed(1)} MB)` : ''}`);
  console.log(`[turn] worker:${fs.existsSync(WORKER) ? '✅' : '❌'} ${WORKER}`);
  console.log(`[turn] 配置: call.turnDetection.mode = smart（缺 venv/模型时自动回退标点）`);
  return py && model;
}

async function downloadModel() {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  if (fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1024 * 1024) {
    console.log(`[turn] 模型已存在：${MODEL}`);
    return;
  }
  console.log(`[turn] 下载模型：${MODEL_URL}`);
  const response = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024 * 1024) throw new Error(`模型太小（${buffer.length} 字节）`);
  const temp = `${MODEL}.part`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, MODEL);
  console.log(`[turn] 模型已保存：${MODEL} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

function install({ force = false } = {}) {
  const hasVenv = fs.existsSync(PYTHON);
  if (!hasVenv) {
    const basePython = process.env.PYTHON || 'python3';
    console.log(`[turn] 创建 venv：${VENV}（${basePython}）`);
    run(basePython, ['-m', 'venv', VENV]);
  } else if (!force) {
    console.log(`[turn] venv 已存在：${VENV}`);
  }
  console.log('[turn] 安装依赖：onnxruntime numpy transformers');
  run(PYTHON, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
  run(PYTHON, ['-m', 'pip', 'install', '--quiet', 'onnxruntime', 'numpy', 'transformers']);
}

const args = new Set(process.argv.slice(2));
if (args.has('--status')) {
  const ok = status();
  process.exit(ok ? 0 : 1);
}
try {
  install({ force: args.has('--force') });
  await downloadModel();
  const ok = status();
  console.log(ok ? '[turn] 完成。call-loop 下次启动会用 Smart Turn。' : '[turn] 还不完整，看上面的 ❌。');
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(`[turn] 安装失败：${error?.message ?? error}`);
  process.exit(1);
}
