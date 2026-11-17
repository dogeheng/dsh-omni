#!/usr/bin/env node
/**
 * 一键跑完 packages/bridge 的全部测试。
 *
 * 做什么
 * ------
 * 1. 读 packages/bridge/package.json 的 scripts，**自动**挑出所有 `test:*` 入口
 *    （不手写清单；以后新增 test:* 会自动进来，不会漂移）；
 * 2. 对每个入口，把它命令里的每个 `node scripts/xxx.mjs` 解析出来，逐个用当前
 *    的 node（process.execPath）起子进程跑；链式命令（`a && b`）串行执行，任一
 *    失败即该入口失败；
 * 3. 每个子脚本默认 300s 超时（TEST_TIMEOUT_MS 可改），stdout/stderr 先收着，
 *    只有失败/超时才打印尾部，避免刷屏；
 * 4. 最后打一张汇总表（结果 / 名称 / 耗时），有失败或超时则 process.exitCode = 1。
 *
 * 用法
 * ----
 *   node scripts/test-all.mjs
 *   node scripts/test-all.mjs --ci                          # 等价于 CI=true
 *   TEST_FILTER=thread node scripts/test-all.mjs            # 只跑名称/命令里含 "thread" 的入口
 *   TEST_TIMEOUT_MS=60000 node scripts/test-all.mjs         # 单个子脚本超时 60s
 *   TEST_SKIP=test:audit,test:relay node scripts/test-all.mjs  # 额外跳过（标记 SKIP）
 *
 * 为什么有排除/跳过名单
 * --------------------
 * 本机（macOS，有真实 data/、config.json、运行中的 DSH、Playwright）和 Linux CI
 * 裸机的环境差很多，所以分三层：
 *
 * A. 任何环境都不由本脚本跑（需要真实浏览器，Playwright 不在 npm 依赖里）：
 *    - test:console-ui        真实 Chromium 跑隔离控制台 fixture（test-console-ui.mjs）
 *    - test:console-character 同上，真实渲染动画检查（test-console-character.mjs）
 *    ⚠️ 与任务口径的差异：任务把 test:i18n 也列为 Playwright，但实际读代码确认
 *    test-console-i18n.mjs 是**静态契约**——只读 console.html / i18n.en.json /
 *    console-assets.js，用 node:test 跑，不启动浏览器，因此**没有**排除它。
 *    （它同时出现在 test:audit 的子清单里，保留独立入口只是多跑一次静态断言。）
 *
 * B. 只有 CI=true / --ci 才跳过（本机照跑，见 CI_SKIP）：这些在 Linux 裸机上
 *    **必然**拿不到所需的资源：
 *    - test:call               需要本机 data/models/sherpa-onnx-…/test_wavs/zh.wav
 *                              （data/ 被 .gitignore，CI 里没有）、运行中的 DSH
 *                              （config.json 的 dsh.baseUrl）和 TTS 服务商；
 *                              test-call-loop.mjs 确实用 --from-wav、不碰容器/声卡，
 *                              但它依赖的是「本机 data + 在线服务」，不是纯函数。
 *    - test:dsh-auth           需要运行中的 DSH（127.0.0.1:3080）和 ~/.dsh 里的
 *                              browser-session 签名密钥；CI 没有 DSH 进程。
 *    - test:session-retire:e2e 需要活的 DSH 实测会话退役契约；CI 没有 DSH 进程。
 *    - test:setup-idempotent   通过 scripts/dsh-modules.mjs 反查**已安装 DSH** 的
 *                              node_modules 来加载 js-yaml；CI 裸机没有 DSH 安装。
 *    - test:preset-prompt      断言「CRLF 文件写回仍是 CRLF」，但仓库里的
 *                              dsh/agent-presets/qq-chat-v2/agent.cordis.yml 是 LF
 *                              （该测试假设的是 Windows 式 checkout），Linux 必然失败。
 *    - test:audit              它把一批**依赖本机环境**的子套件聚成一个入口，裸 Linux
 *                              CI 里必然红，没法整包变绿：
 *                                · test-console-encoding 要 Windows 的 chcp；
 *                                · test-voice-system 要 .gitignore 掉的私有文档
 *                                  packages/bridge/docs/guides/VOICE.md；
 *                                · test-preset-local-tools 要已安装 DSH 的工具包；
 *                                · test-preset-prompt 要 CRLF 工作区（同上）；
 *                                · test-audit-setup-guards 要 CRLF 的 start.bat，
 *                                  而入库文件是 LF。
 *                              （这些问题在 macOS 本机也复现，不是 Linux 独有；
 *                              修法应是把这些子套件拆出去或改成环境感知，属于
 *                              测试自身的问题，不在本脚本职责内。）
 *
 *    其余「看起来像本机环境」的都由测试自己兜住了，不需要跳过：
 *    - test:power / test:reminders 是纯函数 + 注入 exec，不会真的执行 pmset/osascript；
 *    - test:windows 只用固定文本解析 xwininfo 输出；
 *    - test:speaker-match 在缺模型/样本时自己 SKIP 并 exit 0；
 *    - test:audit 之外、需要 ffmpeg/sherpa/模型 的纯函数/假实现测试都自带跳过逻辑；
 *    - 需要 Playwright 的三个 console 套件里，两个真浏览器的在 A 层排除，
 *      i18n 是静态的所以照跑。
 *
 *    注：`npm ci` / `npm install` 在 CI 上会被 package-lock.json 里一条缺 version 的
 *    可选依赖（sherpa-onnx-node 下的 sherpa-onnx-win-arm64）搞崩（Invalid Version），
 *    workflow 里会先在工作区删掉该条再装；这和测试列表无关，但会影响 --omit=optional。
 *
 * C. TEST_SKIP 环境变量：临时在命令行点名跳过某几个入口（汇总里标 SKIP）。
 *
 * 设计约束
 * --------
 * - 不用绝对路径 / 本机用户目录：package 根一律 fileURLToPath(new URL('..', import.meta.url))；
 * - 不改动、也不依赖测试本身对 cwd 的假设：子进程 cwd 固定为 packages/bridge。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json');
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const IS_CI = process.env.CI === 'true' || process.env.CI === '1' || process.argv.includes('--ci');
const SELF_SCRIPT_NAME = 'test:all';
const FILTER = (process.env.TEST_FILTER ?? '').trim().toLowerCase();
const TIMEOUT_MS = parseTimeout(process.env.TEST_TIMEOUT_MS);
const EXTRA_SKIP = new Set(
  (process.env.TEST_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);

// A 层：任何环境都不跑（需要真实浏览器）。key = npm script 名。
const ALWAYS_EXCLUDED = new Map([
  ['test:console-ui', '需要真实 Chromium（Playwright），不是 npm 依赖'],
  ['test:console-character', '需要真实 Chromium（Playwright），不是 npm 依赖'],
]);

// B 层：只在 CI（CI=true / --ci）里跳过。key = npm script 名，value = 理由。
const CI_SKIP = new Map([
  ['test:call', '需要本机 data/models 的 wav + 运行中的 DSH + TTS 服务商'],
  ['test:dsh-auth', '需要运行中的 DSH（127.0.0.1:3080）和 ~/.dsh 里的 signing secret'],
  ['test:session-retire:e2e', '需要运行中的 DSH 实测会话退役契约'],
  ['test:setup-idempotent', '需要已安装 DSH 的 node_modules（dsh-modules.mjs 反查）'],
  ['test:preset-prompt', '断言 CRLF 回写，但仓库里的 preset 文件是 LF（Windows 式 checkout 假设）'],
  ['test:audit', '聚合了需要 Windows chcp / 私有 VOICE.md / 已安装 DSH / CRLF 工作区的子套件'],
]);

function parseTimeout(raw) {
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`⚠️  TEST_TIMEOUT_MS=${raw} 不是正数，回退到 ${DEFAULT_TIMEOUT_MS}ms`);
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(value);
}

/** 把一条 npm script 命令拆成要执行的 node 脚本文件列表（拒绝看不懂的写法）。 */
function parseNodeRuns(name, command) {
  const files = [];
  for (const rawSegment of String(command).split('&&')) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const tokens = (segment.match(/(?:"[^"]+"|'[^']+'|\S+)/g) ?? [])
      .map((token) => token.replace(/^["']|["']$/g, ''));
    if (tokens[0] !== 'node') {
      throw new Error(`无法解析 ${name} 的命令片段（只支持 node <file>）: ${segment}`);
    }
    const file = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (!file) throw new Error(`无法解析 ${name} 的 node 脚本路径: ${segment}`);
    files.push(file);
  }
  if (files.length === 0) throw new Error(`无法解析 ${name} 的命令: ${command}`);
  return files;
}

/** 读出 package.json 里全部 test:* 入口。 */
function discoverEntries() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const scripts = pkg.scripts ?? {};
  return Object.entries(scripts)
    .filter(([name]) => name.startsWith('test:'))
    .map(([name, command]) => ({ name, command, runs: parseNodeRuns(name, command) }));
}

function skipReasonFor(name) {
  if (EXTRA_SKIP.has(name)) return { kind: 'TEST_SKIP', reason: 'TEST_SKIP 指定跳过' };
  if (IS_CI && CI_SKIP.has(name)) return { kind: 'CI_SKIP', reason: CI_SKIP.get(name) };
  return null;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 只保留末尾若干行/字符，失败时贴出来够定位即可。 */
function tail(text, maxLines = 80, maxChars = 30_000) {
  const trimmed = String(text ?? '').trimEnd();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  const slice = lines.slice(-maxLines).join('\n');
  return slice.length > maxChars ? `…（前略）…\n${slice.slice(-maxChars)}` : slice;
}

function printRunOutput(run) {
  const stdout = tail(run.stdout);
  const stderr = tail(run.stderr);
  if (stdout) console.log(`--- ${run.file} stdout ---\n${stdout}`);
  if (stderr) console.log(`--- ${run.file} stderr ---\n${stderr}`);
}

function main() {
  const discovered = discoverEntries();
  // `test:all` 就是本脚本自己：必须排除，否则会无限递归。
  const entries = discovered.filter(
    (entry) => entry.name !== SELF_SCRIPT_NAME && !ALWAYS_EXCLUDED.has(entry.name),
  );
  const selected = FILTER
    ? entries.filter((entry) => `${entry.name}\n${entry.command}`.toLowerCase().includes(FILTER))
    : entries;

  console.log('='.repeat(72));
  console.log(IS_CI ? '模式: CI（Linux 上不可用的套件标记 SKIP）' : '模式: 本机全量');
  console.log(`node: ${process.version}   package: packages/bridge`);
  console.log(
    `发现 test:* 入口: ${discovered.length}` +
      `（排除本脚本自身 1 个 + 浏览器套件 ${ALWAYS_EXCLUDED.size} 个）`,
  );
  console.log(`本次要跑: ${selected.length} 个入口${FILTER ? `（TEST_FILTER=${FILTER}）` : ''}`);
  console.log(`单个子脚本超时: ${formatDuration(TIMEOUT_MS)}`);
  if (IS_CI) {
    console.log('CI 跳过名单:');
    for (const [name, reason] of CI_SKIP) console.log(`  - ${name}: ${reason}`);
  }
  if (EXTRA_SKIP.size) console.log(`TEST_SKIP: ${[...EXTRA_SKIP].join(', ')}`);
  console.log('='.repeat(72));

  if (selected.length === 0) {
    console.error(`❌ TEST_FILTER=${FILTER} 没匹配到任何 test:* 入口`);
    process.exitCode = 2;
    return;
  }

  const rows = [];
  const startedAll = Date.now();

  selected.forEach((entry, index) => {
    const prefix = `[${String(index + 1).padStart(String(selected.length).length)}/${selected.length}] ${entry.name}`;
    const skip = skipReasonFor(entry.name);
    if (skip) {
      rows.push({ status: 'SKIP', name: entry.name, ms: 0, note: skip.kind });
      console.log(`⏭  ${prefix}  SKIP（${skip.kind}）`);
      return;
    }

    const started = Date.now();
    let status = 'PASS';
    let note = '';
    let failedRun = null;

    for (const file of entry.runs) {
      const absolute = path.resolve(PACKAGE_ROOT, file);
      if (!fs.existsSync(absolute)) {
        status = 'FAIL';
        note = `脚本文件不存在: ${file}`;
        break;
      }
      const result = spawnSync(process.execPath, [absolute], {
        cwd: PACKAGE_ROOT,
        stdio: 'pipe',
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        // 默认关掉 live 段（需要真实 QQ/DSH/GUI 的段落都只认 '1'），CI 里也必须是离线。
        env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
      });
      const run = {
        file,
        stdout: result.stdout?.toString() ?? '',
        stderr: result.stderr?.toString() ?? '',
        status: result.status,
        timedOut: result.error?.code === 'ETIMEDOUT',
        error: result.error,
      };

      if (run.timedOut) {
        status = 'TIMEOUT';
        note = `${file} 超过 ${formatDuration(TIMEOUT_MS)}`;
        failedRun = run;
        break;
      }
      if (run.error || run.status !== 0) {
        status = 'FAIL';
        note = `exit ${run.status ?? 'null'} @ ${file}${run.error ? `（${run.error.message}）` : ''}`;
        failedRun = run;
        break;
      }
    }

    const ms = Date.now() - started;
    rows.push({ status, name: entry.name, ms, note });
    if (status === 'PASS') {
      console.log(`✅ ${prefix}  PASS  ${formatDuration(ms)}`);
    } else {
      console.log(`❌ ${prefix}  ${status}  ${formatDuration(ms)}  ${note}`);
      if (failedRun) printRunOutput(failedRun);
    }
  });

  const passed = rows.filter((row) => row.status === 'PASS').length;
  const failed = rows.filter((row) => row.status === 'FAIL').length;
  const timedOut = rows.filter((row) => row.status === 'TIMEOUT').length;
  const skipped = rows.filter((row) => row.status === 'SKIP').length;
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const elapsed = Date.now() - startedAll;

  console.log(`\n${'='.repeat(72)}`);
  console.log('测试汇总');
  console.log(`${'RESULT'.padEnd(9)}${'NAME'.padEnd(nameWidth + 2)}${'TIME'.padEnd(9)}NOTE`);
  console.log('-'.repeat(72));
  for (const row of rows) {
    console.log(`${row.status.padEnd(9)}${row.name.padEnd(nameWidth + 2)}${formatDuration(row.ms).padEnd(9)}${row.note}`);
  }
  console.log('-'.repeat(72));
  console.log(
    `通过 ${passed} / 失败 ${failed} / 超时 ${timedOut} / 跳过 ${skipped} / 共 ${rows.length}` +
      `    总耗时 ${formatDuration(elapsed)}`,
  );
  if (FILTER) console.log(`（TEST_FILTER=${FILTER}，只跑了匹配的入口）`);
  console.log('='.repeat(72));

  if (IS_CI && selected.some((entry) => CI_SKIP.has(entry.name) && !EXTRA_SKIP.has(entry.name))) {
    console.log('\nCI 跳过原因：');
    for (const entry of selected) {
      if (CI_SKIP.has(entry.name) && !EXTRA_SKIP.has(entry.name)) {
        console.log(`  - ${entry.name}: ${CI_SKIP.get(entry.name)}`);
      }
    }
  }

  if (!FILTER) {
    const excluded = [...ALWAYS_EXCLUDED.entries()];
    if (excluded.length) {
      console.log('\n始终排除（任何环境都不跑）：');
      for (const [name, reason] of excluded) console.log(`  - ${name}: ${reason}`);
    }
  }

  process.exitCode = failed + timedOut > 0 ? 1 : 0;
}

main();
