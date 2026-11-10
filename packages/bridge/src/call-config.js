/**
 * 通话配置：自动接听开关、只接谁、接听按钮坐标。
 *
 * 认人这块要说清楚：QQ 是 Electron，来电窗口里没有可读的控件树，窗口标题默认也只是 "QQ"。
 * 所以第一版只做「**窗口标题里出现白名单里的名字**」这一种识别——拿得到就接，拿不到就不接
 * （fail-closed）。白名单可以写 QQ 号，运行时用 OneBot 的 get_friend_list 把号码换成昵称/备注。
 */

export const CALL_DEFAULTS = Object.freeze({
  autoAnswer: false,
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

function toCoord(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** 收敛成运行时用的形状。任何非法值都退回默认，绝不抛错（配置文件是手改的）。 */
export function normalizeCallConfig(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const acceptX = toCoord(r.acceptX);
  const acceptY = toCoord(r.acceptY);
  return {
    autoAnswer: r.autoAnswer === true,
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
