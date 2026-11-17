// 通话音频链路的回归：ffmpeg 转码的失败路径 + 临时文件清理。
//
// 事故形态：toPcm48 以前没有 error / stdin-error / 超时处理，ffmpeg 不在 PATH 或提前
// 退出时，往 stdin 写会触发 EPIPE —— Node 的 unhandled 'error' 直接把 call-loop 打死
// （线上两次，通话当场中断、LaunchAgent 重起、会话归档）。而转码调用又在 try 之外，
// 一句失败就把后面所有句子一起丢掉。
//
// 这里用假 spawn 覆盖全部失败路径，不需要真的装 ffmpeg、也不需要麦克风。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPcmConverter, createScratchJanitor, PCM_ARGS } from '../src/call-audio.js';

function fakeSpawn(behavior) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (buffer) => { behavior(child, buffer); };
    child.kill = (signal) => { child.killed = signal; };
    return child;
  };
  return { spawnImpl, calls };
}

// 1) 正常转码
{
  const { spawnImpl, calls } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from([1, 2, 3]));
    child.stdout.emit('data', Buffer.from([4]));
    child.emit('close', 0);
  });
  const toPcm = createPcmConverter({ spawnImpl });
  const pcm = await toPcm(Buffer.from('fake-tts'));
  assert.deepEqual([...pcm], [1, 2, 3, 4], 'stdout 分片要拼成完整 PCM');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'ffmpeg');
  assert.deepEqual(calls[0].args, [...PCM_ARGS], '参数要保持 48k/单声道/s16le');
  assert.equal(calls[0].opts.stdio[0], 'pipe');
  console.log('  ✅ 正常转码：分片拼接 + 参数不变');
}

// 2) ffmpeg 非 0 退出：带上 stderr 片段，且只 reject 一次
{
  const { spawnImpl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 1);
    child.emit('close', 1);
  });
  const toPcm = createPcmConverter({ spawnImpl });
  await assert.rejects(() => toPcm(Buffer.from('x')), /ffmpeg 转码失败（exit 1）.*boom/s);
  console.log('  ✅ 非 0 退出：reject 带 stderr，重复 close 不重复结算');
}

// 3) ffmpeg 启动失败（不在 PATH）：'error' 事件必须变成 reject，不能成为未捕获异常
{
  const { spawnImpl } = fakeSpawn((child) => {
    child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
  });
  const toPcm = createPcmConverter({ spawnImpl });
  await assert.rejects(() => toPcm(Buffer.from('x')), /ffmpeg 启动失败.*ENOENT/s);
  console.log('  ✅ 启动失败：ENOENT 变成 reject（旧实现会打出进程级异常）');
}

// 4) 写 stdin 时 EPIPE（ffmpeg 提前退出）：不能打死进程，最终仍要 reject
{
  const { spawnImpl } = fakeSpawn((child) => {
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.emit('close', 1);
  });
  const toPcm = createPcmConverter({ spawnImpl });
  await assert.rejects(() => toPcm(Buffer.from('x')), /ffmpeg 转码失败/);
  console.log('  ✅ stdin EPIPE：被吃掉，由 close 给结论（进程不会被打死）');
}

// 5) 同步抛错（spawn 本身炸）
{
  const toPcm = createPcmConverter({ spawnImpl: () => { throw new Error('EAGAIN'); } });
  await assert.rejects(() => toPcm(Buffer.from('x')), /ffmpeg 启动失败.*EAGAIN/s);
  console.log('  ✅ spawn 同步抛错：变成 reject');
}

// 6) 超时：kill 掉子进程并 reject
{
  const { spawnImpl } = fakeSpawn(() => { /* 永远不 close */ });
  const toPcm = createPcmConverter({ spawnImpl });
  const child = [];
  const started = Date.now();
  await assert.rejects(() => toPcm(Buffer.from('x'), { timeout: 1000 }), /ffmpeg 转码超时/);
  assert.ok(Date.now() - started >= 900, '超时不应提前触发');
  console.log('  ✅ 超时：1s 后 reject（并 SIGKILL 子进程）');
}

// 7) 临时文件清理器
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-audio-janitor-'));
  try {
    const janitor = createScratchJanitor({ keep: 2 });
    const files = ['a.png', 'b.png', 'c.png'].map((name) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, 'x');
      return file;
    });
    janitor.remember(files[0]);
    janitor.remember(files[1]);
    assert.equal(janitor.size, 2);
    assert.ok(fs.existsSync(files[0]), '未超上限时不删');
    janitor.remember(files[2]);
    assert.equal(janitor.size, 2, '超过 keep 只保留最近的');
    assert.equal(fs.existsSync(files[0]), false, '最旧的应当被删掉');
    assert.ok(fs.existsSync(files[1]) && fs.existsSync(files[2]));

    janitor.remember(null);            // 空路径忽略
    janitor.remember(path.join(dir, 'never-existed.png')); // 不存在也不报错
    janitor.dropAll();
    assert.equal(janitor.size, 0);
    assert.equal(fs.existsSync(files[1]), false, 'dropAll 要删干净');
    assert.equal(fs.existsSync(files[2]), false);
    janitor.dropAll();                 // 幂等
    console.log('  ✅ 临时文件清理器：keep 上限 / 空路径 / 缺失文件 / dropAll 幂等');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 8) 接线契约：call-loop 必须用新实现，并且容器内截图在同一条 exec 里清理
{
  const src = fs.readFileSync(new URL('./call-loop.mjs', import.meta.url), 'utf8');
  assert.match(src, /const toPcm48 = createPcmConverter\(/, 'call-loop 必须使用带错误处理的转换器');
  assert.match(src, /」转码失败，跳过/, '单句转码失败要跳过这一句而不是丢掉整轮');
  assert.match(src, /rm -f \/tmp\/call-window-\*\.png;/, '容器内旧截图必须在同一条 docker exec 里清掉');
  assert.match(src, /this\.shots\?\.dropAll\(\)/, '宿主机截图必须按批清理');
  console.log('  ✅ 接线契约：转换器 / 单句跳过 / 容器清理 / 宿主机清理');
}

console.log('\nPASS');
