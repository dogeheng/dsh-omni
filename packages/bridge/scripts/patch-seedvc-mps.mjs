#!/usr/bin/env node
// 本地 Seed-VC 补丁：当前上游在 Apple Silicon 上会把 float64 的 F0 数组直接搬到 MPS，
// PyTorch 会报 "Cannot convert a MPS Tensor to float64 dtype"。这里只把 F0 转 float32。
//
// 这是对本地 checkout 的补丁，不修改/分发上游代码；setup:seedvc 会在 clone 后自动运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const target = path.resolve(valueOf('--dir') || path.join(ROOT, '..', 'seed-vc'));
const file = path.join(target, 'inference.py');
if (!fs.existsSync(file)) {
  console.error(`[seedvc-patch] 找不到 ${file}`);
  process.exit(1);
}
let s = fs.readFileSync(file, 'utf8');
const before = s;
s = s.replace(
  'F0_ori = torch.from_numpy(F0_ori).to(device)[None]',
  'F0_ori = torch.from_numpy(F0_ori.astype(np.float32)).to(device)[None]'
);
s = s.replace(
  'F0_alt = torch.from_numpy(F0_alt).to(device)[None]',
  'F0_alt = torch.from_numpy(F0_alt.astype(np.float32)).to(device)[None]'
);
if (s === before) {
  if (s.includes('F0_ori.astype(np.float32)') && s.includes('F0_alt.astype(np.float32)')) {
    console.log('[seedvc-patch] 已经打过补丁');
    process.exit(0);
  }
  console.error('[seedvc-patch] 上游 inference.py 结构变了，没找到 F0_ori/F0_alt 行；请手动检查');
  process.exit(1);
}
fs.writeFileSync(file, s);
console.log('[seedvc-patch] 已把 F0_ori/F0_alt 转成 float32（修复 Apple Silicon MPS）');
