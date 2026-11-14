// Lifecycle tests use temporary files and a fake command executor only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStackController } from './stack-mac.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stack-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules', '@snowluma', 'sdk'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ consolePort: 3100, dsh: { baseUrl: 'http://127.0.0.1:54534' } }));
  fs.writeFileSync(path.join(root, '.env'), 'SNOWLUMA_CONTAINER=snowluma\n');
  const state = { docker: false, container: false, exists: true, dsh: false, bridge: false, ...options };
  const calls = [];
  const logs = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    const fail = () => { throw new Error(`Fixture command failed: ${command}`); };
    if (command === 'open') {
      if (args[1] === 'Docker' && !state.dockerStuck) state.docker = true;
      if (args[1] === 'DeepSeek Harness' && !state.dshStuck) state.dsh = true;
      return '';
    }
    if (command === 'docker') {
      if (args[0] === 'info') return state.docker ? '28.0.0' : fail();
      if (args[0] === 'inspect') {
        if (!state.exists) return fail();
        return args[2] === '{{.Name}}' ? '/snowluma' : String(state.container);
      }
      if (args[0] === 'start' || args[0] === 'compose') { state.container = true; state.exists = true; return ''; }
      if (args[0] === 'stop') { if (state.stopFails) return fail(); state.container = false; return ''; }
    }
    if (command === 'lsof') {
      if (args.includes('-d')) {
        const pid = args[args.indexOf('-p') + 1];
        return `p${pid}\nn${pid === '999' ? '/some/other/project' : fs.realpathSync(root)}\n`;
      }
      if (args.includes('-t')) return [state.bridge ? '303' : '', state.foreign ? '999' : ''].filter(Boolean).join('\n');
      return state.dsh ? 'DeepSeek 202 user 23u IPv4 0t0 TCP 127.0.0.1:54534 (LISTEN)' : '';
    }
    if (command === 'pgrep') {
      return args[1] === 'src/bridge.js' ? (state.bridge ? '303' : '') : (state.dsh ? '202' : '');
    }
    if (command === 'ps') {
      if (args[1] === '303') return state.bridge ? '/opt/homebrew/bin/node src/bridge.js' : '';
      if (args[1] === '999') return '/opt/homebrew/bin/node src/bridge.js';
      return state.dsh ? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' : '';
    }
    if (command === 'bash') {
      if (!state.bridgeStuck) state.bridge = true;
      fs.writeFileSync(path.join(root, 'data', 'bridge.pid'), '303');
      const file = path.join(root, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(file));
      cfg.dsh.baseUrl = 'http://127.0.0.1:54534';
      fs.writeFileSync(file, JSON.stringify(cfg));
      return '';
    }
    if (command === '/bin/kill') {
      if (args[1] === '303') state.bridge = false;
      else if (args[1] === '202') state.dsh = false;
      else throw new Error('Attempted to kill an unrelated process');
      return '';
    }
    throw new Error('Unexpected command: ' + JSON.stringify([command, ...args]));
  };
  return {
    root, state, calls, logs,
    stopped: path.join(root, 'data', 'stack-stopped'),
    control: createStackController({ root, platform: 'darwin', exec, sleep: async () => {}, log: line => logs.push(line) }),
  };
}

test('cold start brings up dependencies in order and reuses a healthy stack', async t => {
  const f = fixture(t);
  await f.control('start');
  const mutations = () => f.calls.filter(([cmd, action]) => cmd === 'open' || cmd === 'bash' || (cmd === 'docker' && action === 'start'));
  assert.deepEqual(mutations().map(([cmd, action, name]) => [cmd, action, cmd === 'open' ? name : undefined]), [
    ['open', '-a', 'Docker'], ['docker', 'start', undefined], ['open', '-a', 'DeepSeek Harness'], ['bash', path.join(f.root, 'start-mac.sh'), undefined],
  ]);
  assert.equal(fs.existsSync(f.stopped), false);
  const before = mutations().length;
  await f.control('start');
  assert.equal(mutations().length, before, 'Repeated start must not restart a healthy stack');
});

test('first container creation uses the repository env and compose file', async t => {
  const f = fixture(t, { docker: true, exists: false });
  await f.control('start');
  const compose = f.calls.find(([cmd, action]) => cmd === 'docker' && action === 'compose');
  assert.deepEqual(compose, ['docker', 'compose', '--env-file', path.join(f.root, '.env'), '-f', path.join(f.root, 'docker-compose.snowluma.yml'), 'up', '-d']);
});

test('stop handles stale PIDs, refuses foreign processes and preserves data', async t => {
  const f = fixture(t, { docker: true, container: true, dsh: true, bridge: true, foreign: true });
  fs.writeFileSync(path.join(f.root, 'data', 'bridge.pid'), '999');
  fs.writeFileSync(path.join(f.root, 'data', 'memory-fixture'), 'keep');
  await f.control('stop');
  assert.deepEqual(f.calls.filter(([cmd]) => cmd === '/bin/kill'), [['/bin/kill', '-TERM', '303'], ['/bin/kill', '-TERM', '202']]);
  assert.equal(f.state.container, false);
  assert.equal(f.state.docker, true, 'Other Docker workloads must stay available');
  assert.equal(fs.readFileSync(path.join(f.root, 'data', 'memory-fixture'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(f.stopped), true);
  assert.equal(fs.existsSync(path.join(f.root, 'data', 'bridge.pid')), false);
  await f.control('stop');
});

test('restart stops before starting and restores automatic recovery', async t => {
  const f = fixture(t, { docker: true, container: true, dsh: true, bridge: true });
  await f.control('restart');
  assert.ok(f.calls.findIndex(([cmd, action]) => cmd === 'docker' && action === 'stop') < f.calls.findIndex(([cmd, action]) => cmd === 'docker' && action === 'start'));
  assert.equal(f.state.bridge, true);
  assert.equal(fs.existsSync(f.stopped), false);
});

test('status is read-only and does not launch applications', async t => {
  const f = fixture(t);
  await f.control('status');
  assert.equal(f.calls.some(([cmd, action]) => ['open', 'bash', '/bin/kill'].includes(cmd) || ['start', 'stop', 'compose'].includes(action)), false);
  assert.equal(fs.existsSync(f.stopped), false);
  assert.ok(f.logs.some(line => line === 'QQ 桥接：已停止'));
});

test('DSH timeout prevents bridge startup and leaves automatic recovery paused', async t => {
  const f = fixture(t, { docker: true, container: true, dshStuck: true });
  await assert.rejects(f.control('start'), /DSH未在 90 秒内就绪/);
  assert.equal(f.calls.some(([cmd]) => cmd === 'bash'), false);
  assert.equal(fs.existsSync(f.stopped), true);
});

test('missing dependencies fail before launching applications', async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true });
  await assert.rejects(f.control('start'), /npm --prefix packages\/bridge install/);
  assert.equal(f.calls.length, 0);
});

test('container stop failure is reported after bridge and DSH are stopped', async t => {
  const f = fixture(t, { docker: true, container: true, dsh: true, bridge: true, stopFails: true });
  await assert.rejects(f.control('stop'), /SnowLuma/);
  assert.equal(f.state.dsh, false);
  assert.equal(f.state.bridge, false);
  assert.equal(fs.existsSync(f.stopped), true);
});

test('watchdog exits before invoking any system command while manually stopped', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.stopped, 'stopped');
  // Run the real watchdog in a VM with a temporary root and command traps.
  const vm = await import('node:vm');
  let source = fs.readFileSync(new URL('./ensure-bridge.mjs', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('file://' + path.join(f.root, 'scripts', 'ensure-bridge.mjs')).href));
  vm.runInNewContext(source, {
    fs, path, fileURLToPath: (await import('node:url')).fileURLToPath,
    execFileSync: () => { throw new Error('Watchdog must not run commands'); },
    spawnSync: () => { throw new Error('Watchdog must not spawn'); },
    process: { stdout: { isTTY: false } },
  });
});
