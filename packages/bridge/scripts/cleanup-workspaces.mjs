#!/usr/bin/env node
/**
 * Clean up DSH workspaces left behind by one-off probes/tests/sticker jobs.
 *
 * Workspace deletion only removes the DSH registration; files and Session logs
 * stay on disk (see workspaceController.delete). That is exactly what we want
 * for these test fixtures.
 *
 * Usage:
 *   node scripts/cleanup-workspaces.mjs --dry-run
 *   node scripts/cleanup-workspaces.mjs --delete-temp
 *   node scripts/cleanup-workspaces.mjs --rename-qq
 *   node scripts/cleanup-workspaces.mjs --delete-temp --rename-qq
 *   node scripts/cleanup-workspaces.mjs --delete-obsolete
 *
 * Default is dry-run; pass --apply to actually write. `--delete-temp` removes
 * workspaces whose path is under the OS temp dir and whose title matches a
 * known one-off prefix. `--rename-qq` renames the old QQ workspace and the new
 * path-based "agents" workspace so the user sees one QQ 聊天 entry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/dsh-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const REGISTRY = path.join(DSH_HOME, 'storages', 'workspace.json');
const CONFIG = path.join(ROOT, 'config.json');
const TMP = (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return path.resolve(os.tmpdir()); } })();
const TEMP_PREFIX = /^(qq-probe-|qq-preset-|sticker-|dsh-omni-probe-)/;

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const deleteTemp = args.has('--delete-temp') || args.has('--all');
const renameQq = args.has('--rename-qq') || args.has('--all');
const deleteObsolete = args.has('--delete-obsolete') || args.has('--all');
if (!deleteTemp && !renameQq && !deleteObsolete) {
  console.log('nothing selected; use --delete-temp, --rename-qq and/or --delete-obsolete (default is dry-run)');
  process.exit(0);
}

function loadRegistry() {
  const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  return Object.entries(raw.tables.workspaces).map(([id, w]) => ({
    id,
    title: String(w.title ?? ''),
    path: String(w.path ?? ''),
    sessions: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
  }));
}

function isTemp(item) {
  const p = path.resolve(item.path);
  return (p === TMP || p.startsWith(TMP + path.sep)) && TEMP_PREFIX.test(item.title);
}

function makeClient() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const baseUrl = String(cfg.dsh?.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('config.json has no dsh.baseUrl');
  const auth = {
    token: cfg.dsh?.authToken || discoverDshLaunchToken(),
    header: cfg.dsh?.authHeader,
    prefix: cfg.dsh?.authPrefix,
  };
  return new NodeApiClient(baseUrl, undefined, auth);
}

async function main() {
  const items = loadRegistry();
  const temp = items.filter(isTemp);
  const oldQq = items.find((w) => w.title === 'QQ 聊天' && /(^|\/)qq-bridge\//.test(w.path));
  const newAgents = items.find((w) => w.title === 'agents' && /dsh-omni\/packages\/bridge\/data\/agents$/.test(w.path));
  const oldSlang = items.find((w) => w.title === 'QQ 黑话学习' && /(^|\/)qq-bridge\/state\/slang-agent$/.test(w.path));

  console.log(`workspaces: ${items.length}; temp candidates: ${temp.length}`);
  for (const w of temp) console.log(`  ${w.id}  ${w.title}  sessions=${w.sessions}  ${w.path}`);
  if (deleteObsolete) console.log(`obsolete: old slang = ${oldSlang ? `${oldSlang.id} (${oldSlang.path})` : '(not found)'}`);
  if (renameQq) {
    console.log(`rename: old QQ = ${oldQq ? `${oldQq.id} (${oldQq.path})` : '(not found)'}`);
    console.log(`rename: new agents = ${newAgents ? `${newAgents.id} (${newAgents.path})` : '(not found)'}`);
  }

  if (!apply) {
    console.log('dry-run only; add --apply to delete/rename');
    return;
  }

  const api = makeClient();
  for (const w of temp) {
    try {
      unwrap(await api.workspace.delete({ workspaceId: w.id }), 'workspace.delete');
      console.log(`deleted workspace: ${w.title} (${w.id})`);
    } catch (error) {
      console.error(`failed to delete ${w.title} (${w.id}): ${error?.message ?? error}`);
    }
  }

  if (deleteObsolete && oldSlang) {
    try {
      unwrap(await api.workspace.delete({ workspaceId: oldSlang.id }), 'workspace.delete');
      console.log('deleted obsolete workspace: QQ 黑话学习（旧路径）');
    } catch (error) {
      console.error(`failed to delete obsolete slang workspace: ${error?.message ?? error}`);
    }
  }

  if (renameQq && oldQq && newAgents) {
    // Rename old first, otherwise "QQ 聊天" is not unique.
    try {
      unwrap(await api.workspace.rename({ workspaceId: oldQq.id, title: 'QQ 聊天（旧）' }), 'workspace.rename');
      console.log('renamed old QQ workspace to QQ 聊天（旧）');
    } catch (error) {
      console.error(`failed to rename old QQ workspace: ${error?.message ?? error}`);
    }
    try {
      unwrap(await api.workspace.rename({ workspaceId: newAgents.id, title: 'QQ 聊天' }), 'workspace.rename');
      console.log('renamed agents -> QQ 聊天');
    } catch (error) {
      console.error(`failed to rename agents: ${error?.message ?? error}`);
    }
  }
}

main().catch((error) => {
  console.error(`cleanup failed: ${error?.message ?? error}`);
  process.exit(1);
});
