/**
 * 通话配置：自动接听开关、只接谁、接听按钮坐标。
 *
 * 认人这块要说清楚：QQ 是 Electron，来电窗口里没有可读的控件树，窗口标题默认也只是 "QQ"。
 * 所以第一版只做「**窗口标题里出现白名单里的名字**」这一种识别——拿得到就接，拿不到就不接
 * （fail-closed）。白名单可以写 QQ 号，运行时用 OneBot 的 get_friend_list 把号码换成昵称/备注。
 */

/** 来电浮层的几何。默认值是 800x600 窗口实测量的；QQ 换界面才需要改。 */
export const CALL_GEOMETRY_DEFAULTS = Object.freeze({
  avatarSize: 116,      // 头像直径
  avatarOffsetY: -129,  // 头像圆心相对窗口中心
  acceptOffsetX: -68,   // 接听按钮圆心相对窗口中心
  acceptOffsetY: 186
});

/** 群语音邀请浮层的几何（头像 116px，接听按钮更靠下）。 */
export const CALL_GROUP_GEOMETRY_DEFAULTS = Object.freeze({
  avatarSize: 116,
  avatarOffsetY: -83,
  acceptOffsetX: -65,
  acceptOffsetY: 238
});

export const CALL_DEFAULTS = Object.freeze({
  autoAnswer: false,
  preset: '',
  diarization: {
    mode: 'off',
    modelPath: '',
    threshold: 0.65,
    maxSpeakers: 8,
    minSegmentMs: 600,
    minNewClusterMs: 1500
  },
  turnDetection: {
    mode: 'smart',
    threshold: 0.5,
    continuationWindowMs: 1200,
    maxWaitMs: 2500,
    pythonPath: '',
    modelPath: ''
  },
  allow: [],
  allowGroups: [],
  allowNames: [],
  acceptX: null,
  acceptY: null
});

function toIdList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[^0-9]+/);
  const out = [];
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (!/^\d{5,12}$/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function toNameList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，\n]/);
  const out = [];
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (!s || s.length > 40) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function toGeometry(raw, defaults = CALL_GEOMETRY_DEFAULTS) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const pick = (key) => {
    const n = Number(r[key]);
    return Number.isFinite(n) ? Math.round(n) : defaults[key];
  };
  const size = Math.min(400, Math.max(40, pick('avatarSize')));
  return {
    avatarSize: size,
    avatarOffsetY: Math.min(600, Math.max(-600, pick('avatarOffsetY'))),
    acceptOffsetX: Math.min(600, Math.max(-600, pick('acceptOffsetX'))),
    acceptOffsetY: Math.min(600, Math.max(-600, pick('acceptOffsetY')))
  };
}

function toCoord(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toDiarization(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const mode = r.mode === 'anonymous' ? 'anonymous' : 'off';
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const thresholdRaw = Number(r.threshold);
  return {
    mode,
    modelPath: typeof r.modelPath === 'string' ? r.modelPath.trim() : '',
    threshold: Number.isFinite(thresholdRaw) ? Math.min(0.9, Math.max(0.45, thresholdRaw)) : 0.65,
    maxSpeakers: clamp(r.maxSpeakers, 2, 8, 8),
    minSegmentMs: clamp(r.minSegmentMs, 300, 2000, 600),
    minNewClusterMs: clamp(r.minNewClusterMs, 600, 4000, 1500)
  };
}

function toTurnDetection(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const mode = ['smart', 'punctuation', 'vad'].includes(r.mode) ? r.mode : 'smart';
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const thresholdRaw = Number(r.threshold);
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.min(0.95, Math.max(0.05, thresholdRaw))
    : 0.5;
  return {
    mode,
    threshold,
    continuationWindowMs: clamp(r.continuationWindowMs, 300, 3000, 1200),
    maxWaitMs: clamp(r.maxWaitMs, 1000, 8000, 2500),
    pythonPath: typeof r.pythonPath === 'string' ? r.pythonPath.trim() : '',
    modelPath: typeof r.modelPath === 'string' ? r.modelPath.trim() : ''
  };
}

/** 收敛成运行时用的形状。任何非法值都退回默认，绝不抛错（配置文件是手改的）。 */
export function normalizeCallConfig(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const acceptX = toCoord(r.acceptX);
  const acceptY = toCoord(r.acceptY);
  return {
    geometry: toGeometry(r.geometry),
    groupGeometry: toGeometry(r.groupGeometry, CALL_GROUP_GEOMETRY_DEFAULTS),
    autoAnswer: r.autoAnswer === true,
    preset: typeof r.preset === 'string' ? r.preset.trim().slice(0, 64) : '',
    diarization: toDiarization(r.diarization),
    turnDetection: toTurnDetection(r.turnDetection),
    allow: toIdList(r.allow),
    allowGroups: toIdList(r.allowGroups),
    allowNames: toNameList(r.allowNames),
    acceptX,
    acceptY,
    accept: (acceptX !== null && acceptY !== null) ? { x: acceptX, y: acceptY } : null
  };
}

/**
 * 从窗口标题里认人。
 * @returns {string|null} 命中的名字；没命中返回 null
 */
export function matchCaller(title, names) {
  const text = String(title ?? '').trim();
  if (!text) return null;
  for (const name of names ?? []) {
    const n = String(name ?? '').trim();
    if (n && text.includes(n)) return n;
  }
  return null;
}

/**
 * 把 get_friend_list 的结果压成「QQ 号 → 可选的名字们」。
 * 备注优先（用户自己写的备注比昵称更像他会说的名字），昵称也收着。
 */
export function friendNameIndex(friends) {
  const index = new Map();
  for (const f of Array.isArray(friends) ? friends : []) {
    const id = String(f?.user_id ?? '');
    if (!id) continue;
    const names = [f?.remark, f?.card, f?.nickname]
      .map((x) => String(x ?? '').trim())
      .filter((x) => x.length >= 1 && x.length <= 40);
    index.set(id, [...new Set(names)]);
  }
  return index;
}
