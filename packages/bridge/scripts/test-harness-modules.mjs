// 守卫：audit-bridge-harness.mjs 必须认识 bridge.js 的每个本地模块。
//
// 为什么需要：harness 用手工白名单把 bridge.js 的模块展开进 vm context。新增一个
// import 却忘了同步，main() 就会抛 ReferenceError，于是**所有**依赖 harness 的
// 套件一起红（真实事故：call-presence / voiceprints 等 7 个模块漏注入，
// 12 个套件 pass 0，P1 安全回归整整一周没跑过）。
//
// 本测试只做静态比对：不启动 bridge、不碰网络、不写任何状态文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bridgeSource = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const harnessSource = fs.readFileSync(path.join(root, 'scripts/audit-bridge-harness.mjs'), 'utf8');

/**
 * 不走 namespace 注入的特例，以及理由。新增特例必须写清原因 ——
 * 「懒得加」不算原因，那正是本守卫要防的事。
 */
const SPECIAL = new Map([
  ['qq-model-view.js', '在 VM 内单独执行整份源码，只挂 compactModelMessage 等三个函数'],
  ['dsh-client.js', '只注入 unwrap / createTurnCollector；其余导出是真实网络客户端'],
]);

/** bridge.js 里用相对路径 import 的本地模块文件名。 */
function bridgeLocalModules() {
  const files = new Set();
  for (const match of bridgeSource.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) files.add(match[1]);
  return files;
}

/** harness 里 import * as <binding> from '../src/<file>' 的映射。 */
function harnessModules() {
  const files = new Map();
  for (const match of harnessSource.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]\.\.\/src\/([^'"]+)['"]/g)) {
    files.set(match[2], match[1]);
  }
  return files;
}

/** vm.createContext 字面量里展开（...binding）的绑定名。 */
function contextSpreads() {
  const start = harnessSource.indexOf('const context = vm.createContext({');
  assert.notEqual(start, -1, '找不到 vm.createContext 字面量');
  const end = harnessSource.indexOf('const modelViewSource', start);
  assert.notEqual(end, -1, '找不到 vm context 字面量的结尾');
  return new Set([...harnessSource.slice(start, end).matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]));
}

test('bridge.js 的每个本地模块都在 harness 里被显式处理', () => {
  const harness = harnessModules();
  const missing = [...bridgeLocalModules()]
    .filter((file) => !SPECIAL.has(file) && !harness.has(file))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `以下模块没注入 audit-bridge-harness.mjs，main() 用到时会抛 ReferenceError：\n  ${missing.join('\n  ')}\n`
      + '请 import * as 并在 vm.createContext 字面量里展开；确属特例就加进 SPECIAL 并写明理由。',
  );
});

test('harness import 的每个模块都展开进了 vm context', () => {
  const spreads = contextSpreads();
  const orphan = [...harnessModules().entries()]
    .filter(([, binding]) => !spreads.has(binding))
    .map(([file, binding]) => `${file}（绑定 ${binding}）`)
    .sort();
  assert.deepEqual(orphan, [], `这些模块 import 了却没展开进 context：\n  ${orphan.join('\n  ')}`);
});

test('SPECIAL 特例清单没有过期项', () => {
  const harness = harnessModules();
  for (const [file, reason] of SPECIAL) {
    assert.ok(reason && reason.trim().length >= 8, `SPECIAL 里的 ${file} 缺少理由`);
    assert.ok(fs.existsSync(path.join(root, 'src', file)), `SPECIAL 指向不存在的文件：${file}`);
    assert.ok(!harness.has(file), `${file} 已经按 namespace 注入了，请从 SPECIAL 删除`);
    assert.ok(harnessSource.includes(file), `SPECIAL 里的 ${file} 在 harness 里完全没被引用`);
  }
});
