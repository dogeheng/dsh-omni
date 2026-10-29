// 电源感知与「离电省电」策略。
//
// 设计边界（很重要，改之前先读）：
//   1. 这里**只做判定**，不碰网络、不碰 QQ、不写业务配置。桥接用它决定某个能力还能不能用；
//      真正的拒绝发生在各调用点（bridge.js 的集中闸门、voice-asr.js 的引擎覆盖）。
//   2. 电源状态写一份 `data/power-state.json`，给**别的进程**只读：
//      联网搜索 MCP（mcp-web-search-safe.js）是独立进程，拿不到桥接的内存状态。
//   3. 读不到电源 / 读不懂 pmset 输出时一律**放行**（fail-open）。省电是优化，不是安全边界：
//      因为一次 `pmset` 失败就把机器人锁死，是比费电更糟的故障。
//   4. 用户手动开关与电源策略是两层：实际可用 = 手动开关 AND（插电 ? 全放行 : 离电白名单）。
//      这里只回答后半句，不修改 `features.*` / `socialV2.*` 里的任何用户意图。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** 永远放行的核心能力：文字收发、读消息、等待、唤醒配置。离电也不能让机器人失联。 */
export const CORE_CAPABILITY = 'chat';

/**
 * 可被离电策略限制的能力。id 是稳定契约（写进 config.json 与测试），
 * label/note 只用于控制台展示与提示词，不要拿来做判定。
 */
export const POWER_CAPABILITIES = [
  { id: 'voice', label: '语音发送', note: 'qq_send_voice / qq_list_voices（本地语音库）' },
  { id: 'speak', label: '开口说话', note: 'qq_speak（云端 TTS 或本地音色服务）' },
  { id: 'asr', label: '听懂语音', note: '本地 SenseVoice 转写；关闭后回退 QQ 自带转写' },
  { id: 'sing', label: '唱歌 / 翻唱', note: 'qq_sing、sing_short_cover（本地 Seed-VC，最费电）' },
  { id: 'images', label: '图片理解', note: 'qq_get_message_images（下载图片 + 视觉模型）' },
  { id: 'sticker', label: '表情包', note: '收藏、标注、发送表情' },
  { id: 'memory', label: '长期记忆', note: 'qq_memory_*（本地读写，几乎不耗电）' },
  { id: 'webSearch', label: '联网搜索', note: 'web_search / web_fetch / 图片搜索' },
];

export const POWER_CAPABILITY_IDS = POWER_CAPABILITIES.map((item) => item.id);

/** 离电默认放行：只留几乎不耗电的两项，重活全部关掉。 */
export const DEFAULT_BATTERY_ALLOW = ['sticker', 'memory'];

/** 离电时可自动切换的思考强度；空字符串表示不自动切换。'restore' 只用于插电侧。 */
export const POWER_EFFORT_VALUES = ['', 'low', 'high', 'max'];

export const POWER_DEFAULTS = Object.freeze({
  enabled: true,
  pollMs: 15_000,
  debounceMs: 10_000,
  battery: Object.freeze({
    allow: Object.freeze([...DEFAULT_BATTERY_ALLOW]),
    reasoningEffort: 'low',
    pauseProactive: true,
  }),
});

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 归一化 config.json 的 `power` 段。未知能力 id 直接丢弃（不是报错）——
 * 配置是用户可直接编辑的，拼错一个词不该让整段策略失效。
 */
export function normalizePowerConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const battery = isPlainObject(src.battery) ? src.battery : {};
  const rawAllow = Array.isArray(battery.allow) ? battery.allow : DEFAULT_BATTERY_ALLOW;
  const allow = [...new Set(rawAllow.map((id) => String(id ?? '').trim()).filter((id) => POWER_CAPABILITY_IDS.includes(id)))];
  // 注意：'' 是合法值（= 不自动切换），所以不能用 `?? ''` 兜底 —— undefined 要落到默认 low。
  const rawEffort = battery.reasoningEffort === undefined
    ? POWER_DEFAULTS.battery.reasoningEffort
    : String(battery.reasoningEffort ?? '').trim().toLowerCase();
  const batteryEffort = POWER_EFFORT_VALUES.includes(rawEffort)
    ? rawEffort
    : POWER_DEFAULTS.battery.reasoningEffort;
  return {
    enabled: src.enabled !== false,
    pollMs: clampInt(src.pollMs, 5_000, 600_000, POWER_DEFAULTS.pollMs),
    debounceMs: clampInt(src.debounceMs, 0, 300_000, POWER_DEFAULTS.debounceMs),
    battery: {
      allow: allow.length ? allow : [...DEFAULT_BATTERY_ALLOW],
      reasoningEffort: batteryEffort,
      pauseProactive: battery.pauseProactive !== false,
    },
  };
}

/**
 * 解析 `pmset -g batt`。
 * 真实输出（macOS 14/15，Apple Silicon）：
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=22610019)	100%; charged; 0:00 remaining present: true
 * 或
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=22610019)	82%; discharging; 4:12 remaining present: true
 * 台式机没有电池行，只有第一行；这里按 AC 处理（永不省电，符合直觉）。
 */
export function parsePmsetBattery(text) {
  const raw = String(text ?? '');
  const sourceMatch = /Now drawing from '([^']+)'/.exec(raw);
  let source = 'unknown';
  if (sourceMatch) {
    const word = sourceMatch[1].toLowerCase();
    if (word.includes('battery')) source = 'battery';
    else if (word.includes('ac')) source = 'ac';
  }
  const percentMatch = /(\d{1,3})%/.exec(raw);
  const percent = percentMatch ? Math.min(100, Math.max(0, Number(percentMatch[1]))) : null;
  let charging = null;
  if (/;\s*charging\b/i.test(raw)) charging = true;
  else if (/;\s*discharging\b/i.test(raw)) charging = false;
  else if (/;\s*charged\b/i.test(raw)) charging = true;
  return { source, percent, charging };
}

/** 解析 `pmset -g` 里的 lowpowermode（系统低电量模式）。读不到就当没开。 */
export function parsePmsetLowPower(text) {
  const match = /lowpowermode\s+(\d+)/i.exec(String(text ?? ''));
  return match ? match[1] === '1' : false;
}

/** 采样一次电源状态（不写文件、不做去抖）。 */
export async function samplePowerSource({ execFileImpl = execFile, timeoutMs = 4000 } = {}) {
  const run = (args) => new Promise((resolve) => {
    try {
      execFileImpl('pmset', args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
        resolve(error ? '' : String(stdout ?? ''));
      });
    } catch {
      resolve('');
    }
  });
  const [battText, generalText] = await Promise.all([run(['-g', 'batt']), run(['-g'])]);
  const parsed = parsePmsetBattery(battText);
  return {
    ...parsed,
    lowPowerMode: parsePmsetLowPower(generalText),
    sampledAt: new Date().toISOString(),
  };
}

/** 策略判定（纯函数）：返回离电时允许的能力集合与拒绝集合。 */
export function decidePowerPolicy(powerCfg, state) {
  const cfg = normalizePowerConfig(powerCfg);
  const source = state?.source ?? 'unknown';
  const onBattery = source === 'battery';
  if (!cfg.enabled || !onBattery) {
    return {
      onBattery,
      source,
      enabled: cfg.enabled,
      allow: [...POWER_CAPABILITY_IDS],
      deny: [],
    };
  }
  const allow = new Set(cfg.battery.allow);
  return {
    onBattery: true,
    source,
    enabled: true,
    allow: POWER_CAPABILITY_IDS.filter((id) => allow.has(id)),
    deny: POWER_CAPABILITY_IDS.filter((id) => !allow.has(id)),
  };
}

/** 某个能力此刻是否可用。未知/过期状态一律放行（fail-open）。 */
export function powerAllowsCapability(powerCfg, state, capability) {
  const id = String(capability ?? '').trim();
  if (!id || id === CORE_CAPABILITY) return true;
  if (!POWER_CAPABILITY_IDS.includes(id)) return true; // 不认识的能力不拦
  const cfg = normalizePowerConfig(powerCfg);
  if (!cfg.enabled) return true;
  if (!state || state.stale === true) return true;
  if (state.source !== 'battery') return true;
  return cfg.battery.allow.includes(id);
}

/**
 * 把 HTTP 路径映射到能力。只登记**智能体调用**（带 x-agent-call）会走到的写路径；
 * 控制台的管理操作不在闸门范围内（它们不带 x-agent-call）。
 * 返回 null 表示这条路径不归电源策略管。
 */
const PATH_CAPABILITY_RULES = [
  [/^\/api\/socialV2\/(send-voice|voices)(\/|$)/, 'voice'],
  [/^\/api\/voice\/(send|list)(\/|$)/, 'voice'],
  [/^\/api\/send\/voice(\/|$)/, 'voice'],
  [/^\/api\/socialV2\/speak(\/|$)/, 'speak'],
  [/^\/api\/socialV2\/(sing|cover)(\/|$)/, 'sing'],
  [/^\/api\/images\//, 'images'],
  [/^\/api\/socialV2\/memory(-|$)/, 'memory'],
  [/^\/api\/socialV2\/(send-sticker|add-sticker|collect-sticker|sticker-list|sticker-image|sticker-note|sticker-remark|self-image)(\/|$)/, 'sticker'],
];

export function powerCapabilityForPath(pathname) {
  const p = String(pathname ?? '');
  for (const [re, cap] of PATH_CAPABILITY_RULES) {
    if (re.test(p)) return cap;
  }
  return null;
}

export function powerCapabilityLabel(id) {
  return POWER_CAPABILITIES.find((item) => item.id === id)?.label ?? id;
}

/** 给模型的拒答文案：一句话、说明原因、给出替代动作，避免它反复重试。 */
export function powerRefusal(capability) {
  const label = powerCapabilityLabel(capability);
  return {
    code: 'POWER_SAVING',
    capability,
    error: `现在使用电池，省电模式已关闭「${label}」`,
    hint: '不要重试这个工具；用文字正常回复，或告诉对方插电后就可以了。',
  };
}

/** 每轮提示词里的一行电源说明；插电/关闭策略时返回空串（不占 token）。 */
export function powerPromptLine(powerCfg, state) {
  const cfg = normalizePowerConfig(powerCfg);
  if (!cfg.enabled) return '';
  if (!state || state.stale === true || state.source !== 'battery') return '';
  const policy = decidePowerPolicy(cfg, state);
  if (!policy.deny.length) return '';
  const denied = policy.deny.map(powerCapabilityLabel).join('、');
  return `【电源】现在用电池，省电模式已关闭：${denied}。需要这些能力时直接说明「现在省电模式关了」，不要调用对应工具。`;
}

/** 状态文件（别的进程只读它）。 */
export const POWER_STATE_FILE = 'power-state.json';

function stateFilePath(root) {
  return path.join(root, 'data', POWER_STATE_FILE);
}

/** 读状态文件；mtime 缓存，避免每次工具调用都真的读盘。 */
const stateCache = new Map(); // file -> { mtimeMs, value }
export function readPowerState(root, { now = Date.now(), maxAgeMs = 10 * 60 * 1000, cache = true } = {}) {
  const file = stateFilePath(root);
  try {
    const stat = fs.statSync(file);
    const hit = stateCache.get(file);
    if (cache && hit && hit.mtimeMs === stat.mtimeMs) {
      return { ...hit.value, stale: now - Date.parse(hit.value.committedAt ?? 0) > maxAgeMs };
    }
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    stateCache.set(file, { mtimeMs: stat.mtimeMs, value });
    return { ...value, stale: now - Date.parse(value.committedAt ?? 0) > maxAgeMs };
  } catch {
    return null;
  }
}

function writeStateFile(root, state) {
  const file = stateFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return state;
}

/**
 * 电源监控：定时采样 + 去抖 + 状态文件 + 变更回调。
 *
 * 去抖的必要性：插拔充电器时 macOS 会因为 PD 协商短暂报另一个源，不去抖会出现
 * 「拔一下电，思考强度被切了两次、日志刷两条」。
 *
 * @param {object} options
 * @param {string} options.root          仓库根（bridge 目录），状态文件写到 <root>/data/
 * @param {() => object} options.getConfig 每次读取最新 power 配置（控制台可热改）
 * @param {(msg: string) => void} [options.log]
 * @param {(prev: object|null, next: object) => void} [options.onChange]
 */
export function createPowerMonitor({ root, getConfig, log = () => {}, onChange = () => {}, sample = samplePowerSource, now = Date.now }) {
  let committed = null;
  let observed = null;
  let pendingSource = '';
  let pendingSince = 0;
  let simulated = null; // 'ac' | 'battery' | null
  let timer = null;
  let stopped = false;
  let sampling = false;

  const cfg = () => normalizePowerConfig(getConfig?.() ?? {});

  function commit(next, { reason = 'sample', force = false } = {}) {
    const prev = committed;
    if (!force && prev && prev.source === next.source && prev.percent === next.percent) {
      // 同源同电量：只刷新 sampledAt，不触发回调，但写文件让外部看到新鲜度。
      committed = next;
      try { writeStateFile(root, committed); } catch {}
      return committed;
    }
    committed = next;
    try { writeStateFile(root, committed); } catch (error) { log(`[power] 写状态文件失败：${error?.message ?? error}`); }
    const changed = !prev || prev.source !== next.source;
    if (changed) {
      log(`[power] 电源变化：${prev?.source ?? 'unknown'} → ${next.source}（${reason}）`);
      try { onChange(prev, next, { reason, changed }); } catch (error) { log(`[power] 应用策略失败：${error?.message ?? error}`); }
    }
    return committed;
  }

  async function tick(reason = 'sample', { force = false } = {}) {
    if (stopped || sampling) return committed;
    sampling = true;
    try {
      const sampleState = await sample();
      if (stopped) return committed;
      if (simulated) {
        sampleState.source = simulated;
        sampleState.percent = null;
        sampleState.charging = simulated === 'ac';
        sampleState.simulated = true;
      } else {
        sampleState.simulated = false;
      }
      observed = sampleState;

      // 首次采样、模拟切换：立刻生效（不让人盯着 20 秒的「等待中」）。
      if (force || !committed || observed.source === 'unknown') {
        pendingSource = '';
        return commit({ ...sampleState, committedAt: new Date(now()).toISOString() }, { reason });
      }
      if (observed.source === committed.source) {
        pendingSource = '';
        return commit({ ...sampleState, committedAt: new Date(now()).toISOString() }, { reason });
      }
      if (pendingSource !== observed.source) {
        pendingSource = observed.source;
        pendingSince = now();
        log(`[power] 检测到 ${observed.source}，等待 ${cfg().debounceMs}ms 去抖`);
        return committed;
      }
      if (now() - pendingSince >= cfg().debounceMs) {
        pendingSource = '';
        return commit({ ...sampleState, committedAt: new Date(now()).toISOString() }, { reason: 'debounced' });
      }
      return committed;
    } finally {
      sampling = false;
    }
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try { await tick(); } finally { schedule(); }
    }, cfg().pollMs);
    timer.unref?.();
  }

  return {
    async start() {
      stopped = false;
      const state = await tick('startup');
      schedule();
      return state;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    state() { return committed; },
    observed() { return observed; },
    async refresh(reason = 'manual') { return tick(reason); },
    /** 模拟离电/插电（控制台测试用）；传 null 恢复真实采样。 */
    async simulate(source) {
      simulated = source === 'battery' || source === 'ac' ? source : null;
      pendingSource = '';
      return tick(simulated ? 'simulate' : 'simulate-off', { force: true });
    },
    simulated() { return simulated; },
  };
}
