#!/usr/bin/env node
// macOS 手动启停入口；命令执行可注入，离线测试不会操作真实 Docker/DSH。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DSH_COMMAND = /\/DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness(?:\s|$)/;

export function createStackController({
  root = ROOT,
  platform = process.platform,
  exec = (command, args, options) => execFileSync(command, args, options),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = message => console.log(message),
} = {}) {
  const data = path.join(root, 'data');
  const stopped = path.join(data, 'stack-stopped');
  const pidFile = path.join(data, 'bridge.pid');
  const configFile = path.join(root, 'config.json');
  const run = (command, args, options = {}) => String(exec(command, args, {
    cwd: root, timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }) ?? '').trim();
  const probe = (command, args) => { try { return run(command, args); } catch { return ''; } };
  const config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const readConfig = () => { try { return config(); } catch { return {}; } };
  const consolePort = () => Number(readConfig().consolePort) || 3100;
  const pids = text => [...new Set(String(text).split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 1))];
  const commandOf = pid => probe('ps', ['-p', String(pid), '-o', 'command=']);
  const dockerReady = () => !!probe('docker', ['info', '--format', '{{.ServerVersion}}']);
  const containerName = () => {
    let env = '';
    try { env = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch {}
    const fromEnv = /^\s*SNOWLUMA_CONTAINER\s*=\s*["']?([^\s"'#]+)["']?\s*$/m.exec(env)?.[1];
    return String(readConfig().stack?.container || fromEnv || 'snowluma');
  };
  const containerRunning = () => probe('docker', ['inspect', '-f', '{{.State.Running}}', containerName()]) === 'true';
  const dshPids = () => pids(probe('pgrep', ['-f', '/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness']))
    .filter(pid => DSH_COMMAND.test(commandOf(pid)));
  const dshPort = () => {
    const output = probe('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    for (const line of output.split('\n')) {
      if (!/DeepSeek/.test(line)) continue;
      const match = /127\.0\.0\.1:(\d+)\s+\(LISTEN\)/.exec(line);
      if (match) return Number(match[1]);
    }
    return 0;
  };
  const portPids = () => pids(probe('lsof', ['-nP', '-t', `-iTCP:${consolePort()}`, '-sTCP:LISTEN']));
  const isOurBridge = pid => {
    const command = commandOf(pid);
    if (!/(?:^|\/)node\s+(?:\S*\/)?src\/bridge\.js(?:\s|$)/.test(command)) return false;
    const cwd = probe('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n').find(line => line.startsWith('n'))?.slice(1);
    return cwd === fs.realpathSync(root);
  };
  const bridgePids = () => {
    let saved = '';
    try { saved = fs.readFileSync(pidFile, 'utf8'); } catch {}
    return [...new Set([...pids(saved), ...portPids(), ...pids(probe('pgrep', ['-f', 'src/bridge.js']))])]
      .filter(isOurBridge);
  };
  const pause = () => {
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stopped, 'Stopped manually; make start resumes automatic recovery.\n', { mode: 0o600 });
  };
  async function waitFor(check, seconds, label) {
    for (let attempt = 0; attempt <= seconds; attempt++) {
      const result = check();
      if (result) return result;
      if (attempt < seconds) await sleep(1000);
    }
    throw new Error(`${label}未在 ${seconds} 秒内就绪。`);
  }

  async function start() {
    // 在打开应用前先验证安装，失败时不启动半套服务。
    const cfg = config();
    if (!fs.existsSync(path.join(root, 'node_modules', '@snowluma', 'sdk'))) {
      throw new Error('请先执行 npm --prefix packages/bridge install。');
    }
    pause(); // 启动期间也由本命令统一编排，避免 watchdog 抢先启动桥接。
    if (!dockerReady()) {
      log('正在打开 Docker Desktop，等待引擎就绪…');
      run('open', ['-a', 'Docker']);
      await waitFor(dockerReady, 120, 'Docker');
    }
    const container = containerName();
    if (!containerRunning()) {
      if (probe('docker', ['inspect', '-f', '{{.Name}}', container])) {
        log(`正在启动 ${container}…`);
        run('docker', ['start', container], { timeout: 90000 });
      } else {
        if (!fs.existsSync(path.join(root, '.env'))) throw new Error('缺少 packages/bridge/.env，请先按安装文档配置。');
        log('正在创建 SnowLuma 容器…');
        run('docker', ['compose', '--env-file', path.join(root, '.env'), '-f',
          path.resolve(root, cfg.stack?.composeFile || 'docker-compose.snowluma.yml'), 'up', '-d'], { timeout: 240000 });
      }
      await waitFor(containerRunning, 30, 'SnowLuma 容器');
    }
    let port = dshPort();
    if (!port) {
      log('正在打开 DeepSeek Harness，等待本机端口就绪…');
      run('open', ['-a', 'DeepSeek Harness']);
      port = await waitFor(dshPort, 90, 'DSH');
    }
    const listening = portPids().some(isOurBridge);
    if (!listening || readConfig().dsh?.baseUrl !== `http://127.0.0.1:${port}`) {
      log('正在启动 QQ 桥接…');
      run('bash', [path.join(root, 'start-mac.sh')], { timeout: 60000 });
      await waitFor(() => portPids().some(isOurBridge), 15, 'QQ 桥接');
    } else {
      log('QQ 桥接已在运行。');
    }
    fs.rmSync(stopped, { force: true });
    log(`启动完成。控制台：http://127.0.0.1:${consolePort()}`);
    log('首次登录或 QQ 登录失效时，请到 http://127.0.0.1:6081 扫码。');
  }

  async function stop() {
    pause(); // 先禁止 watchdog/DSH 插件把服务重新拉起。
    const errors = [];
    const terminate = async (pid, check, label) => {
      try {
        if (!check(pid)) return;
        run('/bin/kill', ['-TERM', String(pid)]);
        await waitFor(() => !check(pid), 15, `${label}退出`);
      } catch (error) { errors.push(`${label}：${error.message}`); }
    };
    for (const pid of bridgePids()) await terminate(pid, isOurBridge, 'QQ 桥接');
    if (!bridgePids().length) fs.rmSync(pidFile, { force: true });
    for (const pid of dshPids()) await terminate(pid, id => DSH_COMMAND.test(commandOf(id)), 'DSH');
    if (dshPort()) {
      try { await waitFor(() => !dshPort(), 15, 'DSH 端口关闭'); }
      catch (error) { errors.push(error.message); }
    }
    const docker = dockerReady();
    if (docker && containerRunning()) {
      try {
        run('docker', ['stop', containerName()], { timeout: 45000 });
        if (containerRunning()) throw new Error('容器仍在运行');
      }
      catch (error) { errors.push(`SnowLuma：${error.message}`); }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    log(docker ? '已关闭 QQ 桥接、SnowLuma 和 DSH。' : '已关闭 QQ 桥接和 DSH；Docker 未就绪，无法查询 SnowLuma。');
    log('自动拉起已暂停，make start 时恢复。');
    log('配置、记忆和 QQ 登录态保留。Docker Desktop 继续运行。');
  }

  function status() {
    const docker = dockerReady();
    const port = dshPort();
    log(`Docker：${docker ? '运行中' : '未就绪'}`);
    log(`SnowLuma：${docker ? (containerRunning() ? '运行中' : '已停止或尚未创建') : '无法查询（Docker 未就绪）'}`);
    log(`DSH：${port ? `运行中（端口 ${port}）` : dshPids().length ? '进程运行中，端口尚未就绪' : '已停止'}`);
    const bridge = bridgePids();
    log(`QQ 桥接：${bridge.length ? `运行中（PID ${bridge.join(', ')}）` : '已停止'}`);
    log(`自动拉起：${fs.existsSync(stopped) ? '已手动暂停，make start 时恢复' : '按现有 watchdog 配置运行'}`);
  }

  return async action => {
    if (platform !== 'darwin') throw new Error('make 启停入口目前用于 macOS + DSH 桌面版。');
    if (action === 'start') await start();
    else if (action === 'stop') await stop();
    else if (action === 'restart') { await stop(); await start(); }
    else if (action === 'status') status();
    else throw new Error('用法：make start | stop | restart | status');
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await createStackController()(process.argv[2]); }
  catch (error) {
    console.error(`[stack] ${error.message}`);
    process.exitCode = 1;
  }
}
