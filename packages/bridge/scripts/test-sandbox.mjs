import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteSandboxFile, listSandbox, mkdirSandbox, normalizeSandboxConfig,
  readSandboxFile, sandboxInfo, writeSandboxFile,
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
