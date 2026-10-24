#!/usr/bin/env node
/**
 * Install the dsh-omni launcher as a per-machine DSH bundle.
 *
 * Why a copy instead of a symlink: the launcher needs the local VNC password
 * and bridge console token to build "one click" URLs. Those values must never
 * be committed or shared across machines, so this script copies the package
 * into ~/.dsh/plugins/dsh-omni-launcher and rewrites the two URL placeholders
 * in the installed client.js. The repository copy stays credential-free.
 *
 * Usage:
 *   node scripts/install.mjs [--dry-run]
 *
 * Inputs (all optional, with fallbacks):
 *   DSH_OMNI_BRIDGE_DIR   bridge package dir (default: ../../bridge)
 *   DSH_HOME              DSH home (default: ~/.dsh)
 *   DSH_PROFILE           profile to register into (default: desktop)
 *   VNC_PASSWD            overrides .env
 *   SNOWLUMA_VNC_PORT     default 6081
 *   SNOWLUMA_WEBUI_PORT   default 5099
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const BRIDGE_DIR = path.resolve(process.env.DSH_OMNI_BRIDGE_DIR || path.join(REPO_ROOT, 'packages', 'bridge'));
const DSH_HOME = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const INSTALL_DIR = path.join(DSH_HOME, 'plugins', 'dsh-omni-launcher');
const PROFILE_LINK = path.join(PROFILE_DIR, 'node_modules', 'dsh-omni-launcher');
const BUNDLE_NAME = 'dsh-omni-launcher';
const DRY_RUN = process.argv.includes('--dry-run');

function removePath(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  } catch {}
}

function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readText(file)); } catch { return fallback; }
}

function parseEnv(file) {
  const out = {};
  for (const line of readText(file).split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function readConsoleToken() {
  for (const file of [path.join(BRIDGE_DIR, 'data', 'console-token'), path.join(BRIDGE_DIR, 'state', 'console-token')]) {
    const token = readText(file).trim();
    if (token) return token;
  }
  return '';
}

function main() {
  const env = parseEnv(path.join(BRIDGE_DIR, '.env'));
  const config = readJson(path.join(BRIDGE_DIR, 'config.json'), {});
  const vncPass = String(process.env.VNC_PASSWD ?? env.VNC_PASSWD ?? '');
  const vncPort = Number(process.env.SNOWLUMA_VNC_PORT || env.SNOWLUMA_VNC_PORT || 6081);
  const webuiPort = Number(process.env.SNOWLUMA_WEBUI_PORT || env.SNOWLUMA_WEBUI_PORT || 5099);
  const consolePort = Number(process.env.DSH_OMNI_CONSOLE_PORT || config.consolePort || 3100);
  const token = readConsoleToken();

  const vnc = new URL(`http://127.0.0.1:${vncPort}/`);
  vnc.searchParams.set('autoconnect', '1');
  vnc.searchParams.set('resize', 'scale');
  if (vncPass) vnc.searchParams.set('password', vncPass);

  const consoleUrl = new URL(`http://127.0.0.1:${consolePort}/`);
  if (token) consoleUrl.searchParams.set('token', token);

  console.log(`[launcher] bridge:  ${BRIDGE_DIR}`);
  console.log(`[launcher] target:  ${INSTALL_DIR}`);
  console.log(`[launcher] VNC:     ${vnc.origin}  password=${vncPass ? 'yes' : 'no'}`);
  console.log(`[launcher] Console: ${consoleUrl.origin}  token=${token ? 'yes' : 'no'}`);
  console.log(`[launcher] WebUI:   http://127.0.0.1:${webuiPort}/`);
  if (!vncPass) console.log('[launcher] warning: no VNC_PASSWD found in .env or environment; VNC will ask for it.');
  if (!token) console.log('[launcher] warning: no console token found; run the bridge once before installing the launcher.');

  if (DRY_RUN) {
    console.log('[launcher] dry-run: nothing written.');
    return;
  }

  // 1) Copy a credential-patched package. Never modify the repository copy.
  removePath(INSTALL_DIR);
  fs.mkdirSync(INSTALL_DIR, { recursive: true, mode: 0o700 });
  for (const file of ['client.js', 'index.js', 'cordis.patch.yml', 'package.json', 'icon.svg']) {
    const src = path.join(PACKAGE_DIR, file);
    if (!fs.existsSync(src)) throw new Error(`missing launcher file: ${src}`);
    fs.copyFileSync(src, path.join(INSTALL_DIR, file));
  }
  const clientFile = path.join(INSTALL_DIR, 'client.js');
  let client = readText(clientFile);
  client = client.replaceAll('__DSH_OMNI_VNC_URL__', JSON.stringify(vnc.toString()).slice(1, -1));
  client = client.replaceAll('__DSH_OMNI_CONSOLE_URL__', JSON.stringify(consoleUrl.toString()).slice(1, -1));
  fs.writeFileSync(clientFile, client, { mode: 0o600 });
  console.log('[launcher] patched installed client.js with local URLs');

  // 2) Register the bundle in the profile if the profile exists.
  if (!fs.existsSync(PROFILE_DIR)) {
    console.log(`[launcher] profile not found: ${PROFILE_DIR}`);
    console.log('[launcher] copy is ready; register it with DSH plugin manager or re-run with DSH_PROFILE set.');
    return;
  }
  fs.mkdirSync(path.join(PROFILE_DIR, 'node_modules'), { recursive: true });
  removePath(PROFILE_LINK);
  fs.symlinkSync(INSTALL_DIR, PROFILE_LINK, 'dir');

  const packageFile = path.join(PROFILE_DIR, 'package.json');
  const profile = readJson(packageFile, {});
  profile.dependencies = profile.dependencies || {};
  profile.dependencies[BUNDLE_NAME] = `link:${INSTALL_DIR}`;
  profile.dsh = profile.dsh || {};
  profile.dsh.profile = profile.dsh.profile || {};
  const bundles = Array.isArray(profile.dsh.profile.bundles) ? profile.dsh.profile.bundles : [];
  if (!bundles.includes(BUNDLE_NAME)) bundles.push(BUNDLE_NAME);
  profile.dsh.profile.bundles = bundles;
  fs.writeFileSync(packageFile, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(`[launcher] registered ${BUNDLE_NAME} in profile ${PROFILE}`);
  console.log('[launcher] refresh the DSH page (or restart DSH) to load the patched client.');
}

main();
