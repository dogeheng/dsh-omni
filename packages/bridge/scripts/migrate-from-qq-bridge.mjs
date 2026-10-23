#!/usr/bin/env node
/**
 * Copy local runtime data from a qq-bridge checkout into this package.
 *
 * This script deliberately does NOT run anything, rewrite the DSH profile, or
 * touch the old checkout. It only copies files. Review the dry-run output first.
 *
 * Usage:
 *   node scripts/migrate-from-qq-bridge.mjs [--dry-run] [--force] [--with-env]
 *     [--from <path>] [--to <path>]
 *
 * Defaults:
 *   --from  ~/Documents/qq-bridge
 *   --to    this package (packages/bridge)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TO = path.resolve(HERE, '..');
const DEFAULT_FROM = path.join(os.homedir(), 'Documents', 'qq-bridge');

function parseArgs(argv) {
  const out = { from: DEFAULT_FROM, to: DEFAULT_TO, dryRun: false, force: false, withEnv: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') out.from = path.resolve(argv[++i] ?? '');
    else if (arg === '--to') out.to = path.resolve(argv[++i] ?? '');
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--with-env') out.withEnv = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else { console.error(`unknown argument: ${arg}`); printHelp(); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log(`usage: node scripts/migrate-from-qq-bridge.mjs [options]

  --from <path>   qq-bridge checkout (default: ~/Documents/qq-bridge)
  --to <path>     dsh-omni bridge package (default: this package)
  --dry-run       show what would be copied, copy nothing
  --force         overwrite existing files (default: skip existing)
  --with-env      also copy .env (contains the VNC password)
  --help          show this help
`);
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function copyFile(from, to, { dryRun, force }) {
  if (!exists(from)) { console.log(`skip (missing): ${from}`); return false; }
  if (exists(to) && !force) { console.log(`skip (exists):  ${to}`); return false; }
  console.log(`${dryRun ? 'would copy' : 'copy'}: ${from} -> ${to}`);
  if (dryRun) return true;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

function copyTree(from, to, { dryRun, force, filter }) {
  if (!exists(from)) { console.log(`skip (missing): ${from}`); return false; }
  const walk = (rel = '') => {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      if (filter && !filter(src, stat, rel)) return;
      if (!dryRun) fs.mkdirSync(dst, { recursive: true });
      for (const name of fs.readdirSync(src)) walk(path.join(rel, name));
      return;
    }
    if (filter && !filter(src, stat, rel)) return;
    copyFile(src, dst, { dryRun, force });
  };
  walk('');
  return true;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[migrate] from: ${opts.from}`);
  console.log(`[migrate] to:   ${opts.to}`);
  if (!exists(opts.from)) {
    console.error(`[migrate] source does not exist: ${opts.from}`);
    process.exit(1);
  }
  if (!exists(path.join(opts.from, 'config.json')) && !exists(path.join(opts.from, 'state'))) {
    console.error('[migrate] source does not look like a qq-bridge checkout (no config.json/state)');
    process.exit(1);
  }

  // 1) config.json
  copyFile(path.join(opts.from, 'config.json'), path.join(opts.to, 'config.json'), opts);

  // 2) state/ -> data/ (skip stale process files and logs)
  const stateFilter = (src, stat, rel) => {
    if (stat.isDirectory()) return true;
    const base = path.basename(rel);
    if (base === 'bridge.lock' || base === 'bridge.pid') return false;
    if (base.includes('.log') || base.includes('.bak')) return false;
    return true;
  };
  copyTree(path.join(opts.from, 'state'), path.join(opts.to, 'data'), { ...opts, filter: stateFilter });

  // 3) roles/ (personal cards included; this is a local copy, not a repo commit)
  copyTree(path.join(opts.from, 'roles'), path.join(opts.to, 'roles'), opts);

  // 4) audio/
  copyTree(path.join(opts.from, 'audio'), path.join(opts.to, 'audio'), opts);

  // 5) optional .env
  if (opts.withEnv) {
    copyFile(path.join(opts.from, '.env'), path.join(opts.to, '.env'), opts);
  }

  console.log('\n[migrate] done.');
  console.log('[migrate] next steps:');
  console.log('  1. review packages/bridge/config.json for absolute paths');
  console.log('  2. node packages/bridge/scripts/setup-dsh.mjs desktop');
  console.log('  3. restart DSH');
  console.log('  4. bash packages/bridge/start-mac.sh');
  if (!opts.withEnv) console.log('  note: .env was not copied (use --with-env if you need the VNC password)');
}

main();
