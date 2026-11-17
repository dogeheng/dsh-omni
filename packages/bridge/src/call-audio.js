// 通话链路的音频工具：TTS 出来的任意格式 → QQ 麦克风要的 48k 单声道 s16le。
//
// 为什么单独成模块：这段以前是 call-loop 里的一个内联函数，既没有 error 事件处理，
// 也没有超时。ffmpeg 不在 PATH、或者中途退出时，往 stdin 写就会触发 EPIPE ——
// Node 的 unhandled 'error' 会直接打死整个 call-loop，通话当场中断
// （线上日志里两次 `Error: write EPIPE` 就是它）。抽出来才能用假 spawn 做回归。
import fs from 'node:fs';
import { spawn as realSpawn } from 'node:child_process';

export const PCM_ARGS = Object.freeze([
  '-hide_banner', '-loglevel', 'error',
  '-i', 'pipe:0',
  '-ar', '48000', '-ac', '1', '-f', 's16le', 'pipe:1',
]);

/**
 * 造一个「音频 → PCM」转换器。
 * @param {object} [options]
 * @param {Function} [options.spawnImpl] 测试注入用；默认 child_process.spawn
 * @param {number} [options.timeoutMs] 单句转码上限
 */
export function createPcmConverter({ spawnImpl = realSpawn, timeoutMs = 8000 } = {}) {
  return function toPcm48(buffer, { timeout = timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      let ff;
      try {
        ff = spawnImpl('ffmpeg', PCM_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        reject(new Error(`ffmpeg 启动失败：${error?.message ?? error}`));
        return;
      }
      const chunks = [];
      let stderr = '';
      let settled = false;
      let timer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      ff.on('error', (error) => finish(reject, new Error(`ffmpeg 启动失败：${error?.message ?? error}`)));
      // ffmpeg 提前退出时写 stdin 会 EPIPE：这里必须挂一个 handler，否则进程级未捕获异常。
      // 真正的结论由 close / error 事件给出，这里只是把管道错误吃掉。
      ff.stdin?.on('error', () => {});
      ff.stdout?.on('data', (chunk) => chunks.push(chunk));
      ff.stderr?.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      ff.on('close', (code) => {
        if (code === 0) finish(resolve, Buffer.concat(chunks));
        else finish(reject, new Error(`ffmpeg 转码失败（exit ${code}）：${stderr.slice(0, 160) || '无输出'}`));
      });
      timer = setTimeout(() => {
        try { ff.kill('SIGKILL'); } catch {}
        finish(reject, new Error(`ffmpeg 转码超时（${timeout}ms）`));
      }, Math.max(1000, Number(timeout) || timeoutMs));
      // 故意不 unref：这个定时器的作用就是"子进程还没结束，就继续等它"。
      // unref 会让事件循环在转换未完成时提前退出，超时也永远不会触发。
      try {
        ff.stdin.end(buffer);
      } catch (error) {
        finish(reject, new Error(`音频写入失败：${error?.message ?? error}`));
      }
    });
  };
}

/**
 * 截图等临时文件的清理器：只记住自己发出去的路径，用完一批清一批。
 *
 * 为什么需要：来电截图（宿主机 os.tmpdir() 里的 call-window-*.png）以前从不删除，
 * 实测四天堆了 14 个 / 1.1MB；容器里的副本同样在堆。这里只管宿主机，
 * 容器侧由调用方在同一条 docker exec 里 `rm -f`（不额外起进程）。
 */
export function createScratchJanitor({ unlink = (file) => fs.unlinkSync(file), keep = 8 } = {}) {
  let paths = [];
  const safeUnlink = (file) => { try { unlink(file); } catch { /* 已经不在就算了 */ } };
  return {
    /** 记一个之后才用得到的临时文件；超过 keep 条时顺手删最旧的。 */
    remember(file) {
      if (!file) return;
      paths.push(file);
      while (paths.length > Math.max(1, Number(keep) || 8)) safeUnlink(paths.shift());
    },
    /** 这一批用完了：全部删掉（下一批截图开始前调用）。 */
    dropAll() {
      for (const file of paths) safeUnlink(file);
      paths = [];
    },
    get size() { return paths.length; },
  };
}
