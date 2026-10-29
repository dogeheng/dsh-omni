#!/usr/bin/env node
// Create the isolated file workspace. No shell/VM boundary is provided here;
// this script only prepares workspace/ and exchange/ with 0700 permissions.
import fs from 'node:fs';
import { normalizeSandboxConfig } from '../src/sandbox.js';

const cfg = normalizeSandboxConfig({});
for (const dir of [cfg.root, cfg.workspace, cfg.exchange]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}
console.log(`sandbox root: ${cfg.root}`);
console.log(`workspace:    ${cfg.workspace}`);
console.log(`exchange:     ${cfg.exchange}`);
console.log('capabilities: sandbox_list/read/write/mkdir/delete/info (no shell, no network, no host paths)');
