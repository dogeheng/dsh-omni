/**
 * X11 窗口树的解析与"来电窗口"判定。
 *
 * QQ 是 Electron，所有窗口标题都叫 "QQ"，**靠标题认不出来电窗口**。
 * 所以判据是"有没有一个从没见过的大窗口冒出来"。
 * 解析逻辑单独放在这里，方便用固定文本做单元测试（不需要真的开 X）。
 */

/** 从 `xwininfo -root -tree` 的文本里取出顶层窗口。 */
export function parseWindows(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*(0x[0-9a-fA-F]+)\s+"([^"]*)":\s*\([^)]*\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
    if (!m) continue;
    out.push({
      id: m[1],
      title: m[2],
      width: Number(m[3]),
      height: Number(m[4]),
      x: Number(m[5]),
      y: Number(m[6])
    });
  }
  return out;
}

/**
 * 找"新冒出来的、够大的"窗口。
 *
 * @param {Array} windows    当前窗口
 * @param {Set<string>} known 已经见过的窗口 id
 * @param {{minWidth?:number,minHeight?:number,ignoreTitles?:string[]}} opts
 */
export function pickNewWindow(windows, known, { minWidth = 240, minHeight = 160, ignoreTitles = [] } = {}) {
  const skip = new Set(ignoreTitles);
  // 先挑大的：来电窗口一般比聊天窗口小，但绝不只是个 1x1 的输入法窗口
  const candidates = windows
    .filter((w) => !known.has(w.id) && w.width >= minWidth && w.height >= minHeight && !skip.has(w.title))
    .sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates[0] ?? null;
}

/** 窗口中心点（绝对坐标）。 */
export function centerOf(win) {
  return { x: Math.round(win.x + win.width / 2), y: Math.round(win.y + win.height / 2) };
}
