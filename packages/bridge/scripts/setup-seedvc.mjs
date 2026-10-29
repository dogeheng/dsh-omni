#!/usr/bin/env node
// 准备 Seed-VC（唱歌引擎）。只 clone 上游到 gitignored 的 packages/seed-vc/，不自动装
// 几 GB 的模型/依赖；装不装、装哪台机器由你决定。
//
// 用法：
//   node scripts/setup-seedvc.mjs              # clone 到 packages/seed-vc
//   node scripts/setup-seedvc.mjs --check      # 只检查
//   node scripts/setup-seedvc.mjs --dir <path>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const target = path.resolve(valueOf('--dir') || path.join(ROOT, '..', 'seed-vc'));
const checkOnly = args.includes('--check');
const REPO = 'https://github.com/Plachtaa/seed-vc.git';

function looksLikeCheckout(dir) {
  return fs.existsSync(path.join(dir, 'inference.py')) && fs.existsSync(path.join(dir, 'configs'));
}

console.log(`[seedvc] 目标目录：${target}`);
if (looksLikeCheckout(target)) {
  console.log('[seedvc] 已检测到 Seed-VC checkout');
} else if (checkOnly) {
  console.error('[seedvc] 未找到 checkout；去掉 --check 运行安装');
  process.exit(1);
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    console.error(`[seedvc] 目录已存在但不是 Seed-VC checkout：${target}`);
    process.exit(1);
  }
  const r = spawnSync('git', ['clone', '--depth', '1', REPO, target], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('[seedvc] git clone 失败'); process.exit(1); }
  const patch = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'patch-seedvc-mps.mjs'), '--dir', target], { stdio: 'inherit' });
  if (patch.status !== 0) console.error('[seedvc] MPS 补丁未应用；macOS 上可能报 float64 错误');
}

const venv = path.join(target, '.venv');
console.log('\n下一步（在 seed-vc 目录里）：');
console.log(`  cd "${target}"`);
console.log('  python3 -m venv .venv');
console.log('  .venv/bin/pip install -r requirements-mac.txt    # macOS');
console.log('  # Windows/Linux 用 requirements.txt');
console.log('  # 首次推理会自动从 HuggingFace 下载约 1.4GB 权重；国内可设 HF_ENDPOINT=https://hf-mirror.com');
console.log('\n把曲库放在：packages/bridge/data/singing/songs/<歌名>/');
console.log('  vocal.wav          # 15–20 秒干净干声（必需）');
console.log('  instrumental.wav   # 同长度伴奏（可选）');
console.log('  meta.json          # {"title":"雨爱","source":"...","license":"..."}（可选）');
console.log('参考音频：packages/bridge/data/voice/dsh-ref.wav（用 CosyVoice 的 DSH 音色生成 20–25 秒）');
console.log('控制台「二代仿真 → 开口说话 → 唱歌」里打开开关，保存后重启 DSH 注册 qq_sing。');
if (process.platform === 'darwin') {
  console.log('\n⚠️ macOS：Seed-VC 官方支持 Apple Silicon；只跑 15–20 秒换嗓，不在本机做人声分离。');
  console.log('   峰值内存以控制台实测为准；默认上限 5600MB，超限会被杀掉。');
}
console.log('\n参考：https://github.com/Plachtaa/seed-vc');
