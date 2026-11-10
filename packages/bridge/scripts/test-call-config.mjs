#!/usr/bin/env node
/**
 * 通话配置与认人逻辑的单元测试（不碰 QQ、不碰 X）。
 * 用法：npm run test:callconfig
 */
import { normalizeCallConfig, matchCaller, friendNameIndex } from '../src/call-config.js';

const checks = [];
const ok = (n, d = '') => checks.push({ n, pass: true, d });
const bad = (n, d = '') => checks.push({ n, pass: false, d });

const empty = normalizeCallConfig(undefined);
!empty.autoAnswer && empty.allow.length === 0 && empty.accept === null
  ? ok('缺省配置是关闭且不接任何人')
  : bad('缺省配置是关闭且不接任何人', JSON.stringify(empty));

const c = normalizeCallConfig({ autoAnswer: true, allow: ['123456', 234567, 'abc', '12'], allowNames: '小明, 小红', acceptX: '300', acceptY: 340 });
c.autoAnswer === true && c.allow.length === 2 && c.accept.x === 300 && c.accept.y === 340
  ? ok('号码与坐标归一化', `${c.allow.join('/')} @${c.accept.x},${c.accept.y}`)
  : bad('号码与坐标归一化', JSON.stringify(c));

c.allowNames.length === 2 ? ok('名字列表', c.allowNames.join('、')) : bad('名字列表', JSON.stringify(c.allowNames));

normalizeCallConfig({ acceptX: 300 }).accept === null
  ? ok('只给一个坐标不算数')
  : bad('只给一个坐标不算数');

matchCaller('与 小明 语音通话中', ['小明']) === '小明'
  ? ok('标题里能认出来')
  : bad('标题里能认出来');

matchCaller('QQ', ['小明']) === null ? ok('标题里没名字就不认') : bad('标题里没名字就不认');
matchCaller('', ['小明']) === null ? ok('空标题不认') : bad('空标题不认');

const idx = friendNameIndex([
  { user_id: 123456, nickname: '肥鱼', remark: '大肥鱼', card: '' },
  { user_id: 999, nickname: '别人' }
]);
const names = idx.get('123456') ?? [];
names.includes('大肥鱼') && names.includes('肥鱼') && !names.includes('')
  ? ok('好友索引取备注+昵称', names.join('、'))
  : bad('好友索引取备注+昵称', JSON.stringify(names));

// 白名单里的人 → 名字集合
const allowed = ['123456'];
const resolved = allowed.flatMap((id) => idx.get(id) ?? []).concat(['小明']);
matchCaller('大肥鱼 的来电', resolved) === '大肥鱼'
  ? ok('白名单号码换成名字后能认')
  : bad('白名单号码换成名字后能认', JSON.stringify(resolved));

console.log('== 结果');
let failed = 0;
for (const k of checks) {
  if (!k.pass) failed++;
  console.log(`  ${k.pass ? '✅' : '❌'} ${k.n}${k.d ? `：${k.d}` : ''}`);
}
console.log(failed === 0 ? '\nPASS' : `\nFAIL（${failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
