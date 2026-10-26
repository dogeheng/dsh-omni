#!/usr/bin/env node
// 可选：把 FeiyuVoice 声音服务取到本地（不复制进本仓库的 git 历史）。
//
// FeiyuVoice 是独立项目：CosyVoice3 TTS + RVC + 可选的 SVS 按谱唱歌。
// 它的 NOTICE 明确「No blanket license is assigned to locally authored source」，
// 所以 dsh-omni 只提供 HTTP 客户端适配，不 vendor 它的代码/模型；本脚本只把上游
// checkout clone 到被 gitignore 的 packages/feiyu-voice/，方便同机或拷到 GPU 机器部署。
//
// 用法：
//   node scripts/setup-feiyu.mjs                 # clone 到 packages/feiyu-voice
//   node scripts/setup-feiyu.mjs --dir <path>    # 指定目录
//   node scripts/setup-feiyu.mjs --check         # 只检查已有 checkout
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};
const target = path.resolve(valueOf('--dir') || path.join(ROOT, '..', 'feiyu-voice'));
const checkOnly = args.includes('--check');
const REPO = 'https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice.git';

function looksLikeCheckout(dir) {
  return fs.existsSync(path.join(dir, 'server', 'feiyu_voice_service', 'app.py'))
    && fs.existsSync(path.join(dir, 'server', 'INSTALL_AGENT.md'));
}

console.log(`[feiyu] 目标目录：${target}`);
if (looksLikeCheckout(target)) {
  console.log('[feiyu] 已检测到 FeiyuVoice checkout');
} else if (checkOnly) {
  console.error('[feiyu] 未找到 checkout；去掉 --check 运行安装，或检查 --dir');
  process.exit(1);
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    console.error(`[feiyu] 目录已存在但不是 FeiyuVoice checkout：${target}`);
    process.exit(1);
  }
  const r = spawnSync('git', ['clone', '--depth', '1', REPO, target], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[feiyu] git clone 失败；可手动 clone 后把 --dir 指过去');
    process.exit(1);
  }
}

const server = path.join(target, 'server');
console.log('\n下一步（在服务端机器上，推荐 WSL2 + NVIDIA/AMD GPU）：');
console.log(`  cd "${server}"`);
console.log('  python -m venv .venv && source .venv/bin/activate');
console.log('  pip install -r requirements-service.txt');
console.log('  cp configs/voice_service.cuda.example.json configs/voice_service.json   # 按显卡调整');
console.log('  # 按 INSTALL_AGENT.md 下载模型、选择/生成 runtime profile');
console.log('  python -m feiyu_voice_service --host 127.0.0.1 --port 9880');
console.log(`\nAPI Key 随后在：${path.join(server, '.runtime', 'voice-service', 'api_key.txt')}`);
console.log('把服务地址和 Key 填到 dsh-omni 控制台「二代仿真 → 开口说话 → FeiyuVoice」。');
console.log('提示：服务默认也是 9880；如果 GPT-SoVITS 也占这个端口，改其中一个。');

if (process.platform === 'darwin') {
  console.log('\n⚠️ 当前是 macOS：FeiyuVoice 上游的 runtime profile 只提供 CUDA / WSL ROCm，没有 macOS MPS 支持。');
  console.log('   本机可以只保留这个 checkout 作为代码参考；实际推理请在 WSL/Linux GPU 机器上跑，再把 baseUrl 指过去。');
} else if (process.platform === 'win32') {
  console.log('\n提示：Windows 上按上游指南在 WSL2 里安装，不要在原生 PowerShell 里装 GPU 运行时。');
}

console.log('\n参考：https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice');
