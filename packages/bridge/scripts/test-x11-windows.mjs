#!/usr/bin/env node
/**
 * x11-windows 的单元测试：不碰 X、不碰容器，只用固定文本。
 * 用法：npm run test:windows
 */
import { parseWindows, pickNewWindow, centerOf } from '../src/x11-windows.js';

const checks = [];
const ok = (n, d = '') => checks.push({ n, pass: true, d });
const bad = (n, d = '') => checks.push({ n, pass: false, d });

const TREE = `
xwininfo: Window id: 0x50d (the root window) (has no name)

  Root window id: 0x50d (the root window) (has no name)
  Parent window id: 0x0 (none)
     62 children:
     0x800057 "QQ": ("qq" "QQ")  800x600+240+90  +240+90
     0x800028 "QQ": ("qq" "QQ")  720x640+280+70  +280+70
     0x800023 "QQ": ("qq" "QQ")  1x1+639+389  +639+389
     0x40002c (has no name): ()  1x1+3+2  +3+2
     0x2001a6 (has no name): ()  204x57+0+0  +0+0
`;

const ws = parseWindows(TREE);
ws.length === 3
  ? ok('解析出 3 个带标题的窗口', `共 ${ws.length}`)
  : bad('解析出 3 个带标题的窗口', `得到 ${ws.length}`);

const first = ws[0];
first?.id === '0x800057' && first.title === 'QQ' && first.width === 800 && first.height === 600
  ? ok('字段解析正确', JSON.stringify(first))
  : bad('字段解析正确', JSON.stringify(first));

const neg = parseWindows('     0x123456 "X": ("a" "b")  300x200+-10+-20  +-10+-20');
neg[0]?.x === -10 && neg[0]?.y === -20
  ? ok('负坐标')
  : bad('负坐标', JSON.stringify(neg[0]));

const known = new Set(['0x800057', '0x800028', '0x800023']);
pickNewWindow(ws, known) === null
  ? ok('没有新窗口时不误判')
  : bad('没有新窗口时不误判');

const withCall = [...ws, { id: '0x900001', title: 'QQ', width: 360, height: 420, x: 460, y: 190 }];
const picked = pickNewWindow(withCall, known);
picked?.id === '0x900001'
  ? ok('新窗口被认出来', `${picked.width}x${picked.height}`)
  : bad('新窗口被认出来', JSON.stringify(picked));

const tiny = [...ws, { id: '0x900002', title: 'QQ', width: 60, height: 40, x: 0, y: 0 }];
pickNewWindow(tiny, known) === null
  ? ok('过小的窗口不算来电')
  : bad('过小的窗口不算来电');

const c = centerOf({ x: 460, y: 190, width: 360, height: 420 });
c.x === 640 && c.y === 400 ? ok('中心点计算', `${c.x},${c.y}`) : bad('中心点计算', JSON.stringify(c));

console.log('== 结果');
let failed = 0;
for (const k of checks) {
  if (!k.pass) failed++;
  console.log(`  ${k.pass ? '✅' : '❌'} ${k.n}${k.d ? `：${k.d}` : ''}`);
}
console.log(failed === 0 ? '\nPASS' : `\nFAIL（${failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
