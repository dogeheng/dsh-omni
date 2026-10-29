// 受限文件工作区：所有路径都必须落在 sandbox root 内。
// 这不是 VM/容器边界：只提供文件工具，不提供 shell；需要执行命令时请使用后续容器方案。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SANDBOX_DEFAULTS = Object.freeze({
  enabled: true,
  root: '',
  maxReadBytes: 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxEntries: 500,
});

const badPath = (why) => Object.assign(new Error(`sandbox 路径被拒绝：${why}`), { code: 'SANDBOX_PATH' });

function normalizeConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const root = typeof r.root === 'string' && r.root.trim()
    ? path.resolve(r.root.trim())
    : path.join(os.homedir(), 'dsh-sandbox');
  return {
    enabled: r.enabled !== false,
    root,
    workspace: path.join(root, 'workspace'),
    exchange: path.join(root, 'exchange'),
    maxReadBytes: Number.isFinite(Number(r.maxReadBytes)) ? Math.max(1024, Math.min(16 * 1024 * 1024, Math.round(Number(r.maxReadBytes)))) : SANDBOX_DEFAULTS.maxReadBytes,
    maxWriteBytes: Number.isFinite(Number(r.maxWriteBytes)) ? Math.max(1024, Math.min(16 * 1024 * 1024, Math.round(Number(r.maxWriteBytes)))) : SANDBOX_DEFAULTS.maxWriteBytes,
    maxEntries: Number.isFinite(Number(r.maxEntries)) ? Math.max(1, Math.min(5000, Math.round(Number(r.maxEntries)))) : SANDBOX_DEFAULTS.maxEntries,
  };
}

function ensureRoots(cfg) {
  for (const dir of [cfg.root, cfg.workspace, cfg.exchange]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return cfg;
}

function realRoot(cfg) {
  try { return fs.realpathSync.native(cfg.workspace); } catch { return path.resolve(cfg.workspace); }
}

function assertRelative(input) {
  const s = String(input ?? '').trim();
  if (!s) throw badPath('empty path');
  if (s.includes('\0')) throw badPath('NUL byte');
  if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) throw badPath('absolute path');
  const parts = s.split(/[\\/]+/);
  if (parts.some((p) => p === '..')) throw badPath('.. segment');
  return s;
}

/**
 * 解析工作区内的路径。允许 "."，允许不存在的最终文件（write），
 * 但父目录必须存在且是工作区内的真实目录；任何 symlink 组件都拒绝。
 */
export function resolveInWorkspace(cfg, input, { mustExist = false, forWrite = false } = {}) {
  ensureRoots(cfg);
  const rel = assertRelative(input);
  const root = realRoot(cfg);
  const candidate = path.resolve(root, rel);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw badPath('outside workspace');

  // 逐段 lstat，拒绝 symlink；不跟随用户提供的任何链接。
  const segs = relative ? relative.split(path.sep) : [];
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) {
      if (e.code === 'ENOENT' && forWrite && i === segs.length - 1) return cur;
      throw badPath(`missing component: ${segs[i]}`);
    }
    if (st.isSymbolicLink()) throw badPath(`symlink: ${segs[i]}`);
    if (i < segs.length - 1 && !st.isDirectory()) throw badPath(`not a directory: ${segs[i]}`);
  }
  if (mustExist && !fs.existsSync(candidate)) throw badPath('not found');
  return candidate;
}

function openNoFollow(file, flags) {
  return fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0));
}

export function readSandboxFile(cfg, input) {
  ensureRoots(cfg);
  const file = resolveInWorkspace(cfg, input, { mustExist: true });
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw badPath('not a regular file');
  if (st.size > cfg.maxReadBytes) throw Object.assign(new Error(`文件超过读取上限 ${cfg.maxReadBytes} 字节`), { code: 'SANDBOX_TOO_LARGE' });
  const fd = openNoFollow(file, fs.constants.O_RDONLY);
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) throw badPath('not a regular file');
    return { path: path.relative(cfg.workspace, file), content: fs.readFileSync(fd, 'utf8'), bytes: fst.size };
  } finally { fs.closeSync(fd); }
}

export function writeSandboxFile(cfg, input, content, { append = false } = {}) {
  ensureRoots(cfg);
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > cfg.maxWriteBytes) throw Object.assign(new Error(`内容超过写入上限 ${cfg.maxWriteBytes} 字节`), { code: 'SANDBOX_TOO_LARGE' });
  const file = resolveInWorkspace(cfg, input, { forWrite: true });
  const flags = (append ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC);
  const fd = openNoFollow(file, flags);
  try {
    fs.writeFileSync(fd, text, 'utf8');
  } finally { fs.closeSync(fd); }
  return { path: path.relative(cfg.workspace, file), bytes };
}

export function listSandbox(cfg, input = '.') {
  ensureRoots(cfg);
  const dir = resolveInWorkspace(cfg, input || '.', { mustExist: true });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw badPath('not a directory');
  const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, cfg.maxEntries).map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : e.isFile() ? 'file' : 'other',
    path: path.relative(cfg.workspace, path.join(dir, e.name)),
  }));
  return { path: path.relative(cfg.workspace, dir) || '.', entries };
}

export function mkdirSandbox(cfg, input) {
  ensureRoots(cfg);
  const rel = assertRelative(input);
  const root = realRoot(cfg);
  const target = path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw badPath('outside workspace');
  const segs = relative ? relative.split(path.sep) : [];
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) throw badPath(`symlink: ${segs[i]}`);
      if (!st.isDirectory()) throw badPath(`not a directory: ${segs[i]}`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(cur, { mode: 0o700 });
    }
  }
  return { path: path.relative(cfg.workspace, target) || '.', created: true };
}

export function deleteSandboxFile(cfg, input) {
  ensureRoots(cfg);
  const file = resolveInWorkspace(cfg, input, { mustExist: true });
  const st = fs.lstatSync(file);
  if (st.isDirectory()) throw badPath('refusing to delete a directory');
  if (!st.isFile()) throw badPath('not a regular file');
  fs.unlinkSync(file);
  return { path: path.relative(cfg.workspace, file), deleted: true };
}

export function sandboxInfo(raw = {}) {
  const cfg = normalizeConfig(raw);
  ensureRoots(cfg);
  return { enabled: cfg.enabled, root: cfg.root, workspace: cfg.workspace, exchange: cfg.exchange, maxReadBytes: cfg.maxReadBytes, maxWriteBytes: cfg.maxWriteBytes };
}

export { normalizeConfig as normalizeSandboxConfig };
