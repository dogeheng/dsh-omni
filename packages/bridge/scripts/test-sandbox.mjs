import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteSandboxFile, listSandbox, mkdirSandbox, normalizeSandboxConfig,
  readSandboxBinary, readSandboxFile, sandboxInfo, writeSandboxFile,
} from '../src/sandbox.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-'));
const cfg = normalizeSandboxConfig({ root: tmp, maxReadBytes: 4096, maxWriteBytes: 4096 });
mkdirSandbox(cfg, 'notes');
writeSandboxFile(cfg, 'notes/todo.md', 'hello sandbox');
assert.equal(readSandboxFile(cfg, 'notes/todo.md').content, 'hello sandbox');
assert.deepEqual(listSandbox(cfg, 'notes').entries.map((e) => e.name), ['todo.md']);
writeSandboxFile(cfg, 'notes/todo.md', ' + more', { append: true });
assert.equal(readSandboxFile(cfg, 'notes/todo.md').content, 'hello sandbox + more');

for (const bad of ['../outside.txt', '/etc/passwd', 'notes/../../outside', 'a\0b']) {
  assert.throws(() => readSandboxFile(cfg, bad), /sandbox 路径被拒绝/);
}
assert.throws(() => writeSandboxFile(cfg, '../escape.txt', 'x'), /sandbox 路径被拒绝/);
assert.throws(() => writeSandboxFile(cfg, 'missing/child.txt', 'x'), /sandbox 路径被拒绝/);
assert.throws(() => writeSandboxFile(cfg, 'notes/todo.md', 'x'.repeat(5000)), /超过写入上限/);

const outside = path.join(tmp, 'outside.txt');
fs.writeFileSync(outside, 'outside');
fs.symlinkSync(outside, path.join(cfg.workspace, 'link.txt'));
assert.throws(() => readSandboxFile(cfg, 'link.txt'), /symlink/);
assert.throws(() => writeSandboxFile(cfg, 'link.txt', 'x'), /symlink/);
assert.throws(() => deleteSandboxFile(cfg, 'link.txt'), /symlink/);
assert.throws(() => listSandbox(cfg, 'link.txt'), /symlink|not a directory/);

deleteSandboxFile(cfg, 'notes/todo.md');
assert.equal(fs.existsSync(path.join(cfg.workspace, 'notes/todo.md')), false);
assert.throws(() => deleteSandboxFile(cfg, 'notes'), /refusing to delete a directory/);
assert.equal(sandboxInfo({ root: tmp }).workspace, path.join(tmp, 'workspace'));

const mcp = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'mcp-snowluma-safe.js'), 'utf8');
for (const name of ['sandbox_list', 'sandbox_read', 'sandbox_write', 'sandbox_mkdir', 'sandbox_delete', 'sandbox_info']) {
  assert.ok(mcp.includes(`server.tool('${name}'`), `缺少 ${name}`);
}
console.log('sandbox tests passed');
fs.rmSync(tmp, { recursive: true, force: true });

// ── 二进制读取（本地图片出口用）───────────────────────────────────────────────
{
  // 与文本读取共用同一套路径校验：只接受工作区内相对路径、拒绝 symlink
  fs.mkdirSync(path.join(cfg.workspace, 'out'), { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  fs.writeFileSync(path.join(cfg.workspace, 'out', 'pic.png'), png);
  const bin = readSandboxBinary(cfg, 'out/pic.png');
  assert.deepEqual([...bin.buffer], [...png], '二进制内容要原样读回');
  assert.equal(bin.path, path.join('out', 'pic.png'));
  assert.equal(bin.bytes, png.length);
  for (const bad of ['../outside.bin', '/etc/passwd', 'out/../../x']) {
    assert.throws(() => readSandboxBinary(cfg, bad), /sandbox 路径被拒绝/);
  }
  assert.throws(() => readSandboxBinary(cfg, 'link.txt'), /symlink|sandbox 路径被拒绝/);
  // 上限：按调用方给的值卡（图片出口传 media.maxBytes）
  fs.writeFileSync(path.join(cfg.workspace, 'out', 'big.png'), Buffer.alloc(2048, 1));
  assert.throws(() => readSandboxBinary(cfg, 'out/big.png', { maxBytes: 1024 }), /超过读取上限/);
  assert.equal(readSandboxBinary(cfg, 'out/big.png', { maxBytes: 4096 }).bytes, 2048);
  assert.throws(() => readSandboxBinary(cfg, 'out'), /not a regular file|sandbox 路径被拒绝/);
  console.log('  ✅ 沙箱二进制读取：路径校验/符号链接/上限都生效');
}
