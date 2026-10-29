#!/usr/bin/env node
// 用当前 socialV2.speak 的音色生成 Seed-VC 参考音频（20 秒左右）。
// 需要 TTS 已经配置好并可用；输出固定为 data/voice/dsh-ref.wav（44.1k 单声道）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTtsService } from '../src/voice-tts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const outPath = outArg >= 0 ? path.resolve(argv[outArg + 1]) : path.join(ROOT, '..', '..', 'assets', 'voices', 'dsh_reference.wav');
const text = argv.filter((a, i) => a !== '--out' && i !== outArg + 1).join(' ').trim()
  || '嗯，我在呢。今天群里好热闹呀，你们在聊什么？我一边听一边记，等会儿再慢慢跟你们说。对了，刚才那首歌我也听到了，旋律一直在脑子里转。等我有空唱给你们听，好不好？我现在先记住这个调子，免得等会儿忘了。你们要是想听什么，也可以直接点歌，我记下来。';
const svc = createTtsService({ getConfig: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).socialV2?.speak, root: ROOT });
const ready = svc.ready();
if (!ready.ok) {
  console.error(`[make-ref] TTS 未就绪：${ready.reason}`);
  process.exit(1);
}
const outDir = path.dirname(outPath);
fs.mkdirSync(outDir, { recursive: true });
const raw = path.join(outDir, `dsh-ref-raw.${Date.now()}.tmp`);
const out = outPath;
const synth = await svc.synthesize(text, { emotion: '', maxChars: 160 });
fs.writeFileSync(raw + '.' + synth.ext, synth.buffer);
const src = raw + '.' + synth.ext;
try {
  execFileSync('ffmpeg', ['-y', '-i', src, '-ar', '44100', '-ac', '1', out], { stdio: 'ignore' });
} finally {
  try { fs.rmSync(src, { force: true }); } catch {}
}
const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf8' });
console.log(JSON.stringify({ ok: true, file: out, seconds: Number(probe.trim()) || null, provider: synth.provider, chars: synth.chars }));
