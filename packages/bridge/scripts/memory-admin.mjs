#!/usr/bin/env node
// 长期记忆运维 CLI（不需要启动桥接，也不碰 QQ/DSH）。
//
// 用法（在 packages/bridge 下）：
//   node scripts/memory-admin.mjs status
//   node scripts/memory-admin.mjs migrate [--force]
//   node scripts/memory-admin.mjs verify
//   node scripts/memory-admin.mjs rollback
//   node scripts/memory-admin.mjs backup
//   node scripts/memory-admin.mjs forget --id 12
//   node scripts/memory-admin.mjs forget --content "蝴蝶酥"
//
// 性能/内存测量见 scripts/memory-bench.mjs（它用临时库，不会污染真实记忆）。
//
// 退出码：0 成功；1 失败（便于接进 CI / 手动验收）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MemoryStore,
  defaultMemoryConfig,
  normalizeMemoryConfig,
  readLegacyState,
  resolveMemoryDbPath,
  runLegacyMigration,
  rollbackLegacyMigration,
  verifyLegacyMigration
} from '../src/memory/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null;
};

function loadConfig() {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return normalizeMemoryConfig(file.memory, { root: ROOT });
  } catch {
    return { ...defaultMemoryConfig(ROOT) };
  }
}

const cfg = loadConfig();
const dbFile = resolveMemoryDbPath(cfg);
const backupDir = path.join(path.dirname(dbFile), 'backups');
const legacyFile = path.join(ROOT, 'data', cfg.migrate.legacySource);

function open({ required = true, create = false } = {}) {
  if (!fs.existsSync(dbFile) && !create) {
    if (!required) return null;
    console.error(`记忆库不存在：${dbFile}\n（先跑一次 migrate；它会在 ${path.dirname(dbFile)} 建库）`);
    process.exit(1);
  }
  const store = new MemoryStore({ file: dbFile, logger: (m) => console.error(m) });
  store.open();
  return store;
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function status() {
  const exists = fs.existsSync(dbFile);
  const store = exists ? open({ required: false }) : null;
  const legacy = fs.existsSync(legacyFile) ? readLegacyState(legacyFile) : null;
  const out = {
    root: ROOT,
    enabled: cfg.enabled,
    mode: cfg.retrieval.mode,
    personaId: cfg.personaId,
    dbFile,
    dbExists: exists,
    config: cfg,
    legacy: legacy ? { file: legacyFile, bytes: legacy.text.length, hash: legacy.hash.slice(0, 16) } : null,
    store: store ? store.stats({ personaId: cfg.personaId }) : null,
    lastMigration: store ? store.lastMigration({ source: path.basename(legacyFile) }) : null
  };
  print(out);
  store?.close();
}

function migrate() {
  // 第一次迁移时库还不存在：直接建（建库是幂等的，schema 由 store 自己保证）。
  const store = open({ create: true });
  const result = runLegacyMigration(store, {
    legacyFile,
    backupDir,
    personaId: cfg.personaId,
    logger: (m) => console.error(m),
    force: flag('force') === true
  });
  print({ ok: result.ok, skipped: !!result.skipped, reason: result.reason, imported: result.imported, duplicates: result.duplicates, stats: result.stats, backup: result.backup?.path });
  store.close();
  process.exit(result.ok === false ? 1 : 0);
}

function verify() {
  const store = open();
  const result = verifyLegacyMigration(store, { legacyFile, personaId: cfg.personaId });
  print({
    ok: result.ok,
    total: result.total,
    stats: result.stats,
    missing: result.missing?.slice(0, 20),
    mismatched: result.mismatched?.slice(0, 20)
  });
  store.close();
  process.exit(result.ok ? 0 : 1);
}

function rollback() {
  const store = open();
  const result = rollbackLegacyMigration(store, {
    backupDir, personaId: cfg.personaId, logger: (m) => console.error(m)
  });
  print({ ok: result.ok, removed: result.removed, dbBackup: result.dbBackup });
  store.close();
}

function backup() {
  const store = open();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = store.backupTo(path.join(backupDir, `memory.${stamp}.sqlite`));
  print({ ok: true, backup: target, bytes: fs.statSync(target).size });
  store.close();
}

function forget() {
  const store = open();
  const idFlag = flag('id');
  // flag() 在没有值时就返回 true；Number(true) === 1 会误删 #1，必须先判类型。
  const id = typeof idFlag === 'string' ? Number(idFlag) : NaN;
  const content = flag('content');
  let removed = 0;
  if (Number.isInteger(id) && id > 0) {
    const row = store.getMemory(id);
    if (row && store.deleteMemory(id, { reason: 'CLI 手动删除' })) {
      // 墓碑：阻止迁移/提炼复活；桥接下次唤醒时会据此清理旧 social-v2 副本。
      store.addTombstone({ personaId: cfg.personaId, row });
      removed = 1;
    }
  } else if (typeof content === 'string' && content.trim()) {
    const rows = store.listMemories({ personaId: cfg.personaId, status: 'active', limit: 500 })
      .filter((row) => row.content.includes(content.trim()));
    for (const row of rows) {
      if (store.deleteMemory(row.id, { reason: 'CLI 手动删除' })) {
        store.addTombstone({ personaId: cfg.personaId, row });
        removed += 1;
      }
    }
  } else {
    console.error('需要 --id 或 --content');
    process.exit(1);
  }
  print({ ok: removed > 0, removed });
  store.close();
}

switch (command) {
  case 'status': status(); break;
  case 'migrate': migrate(); break;
  case 'verify': verify(); break;
  case 'rollback': rollback(); break;
  case 'backup': backup(); break;
  case 'forget': forget(); break;
  default:
    console.error(`未知命令：${command}\n可用：status | migrate | verify | rollback | backup | forget`);
    process.exit(1);
}
