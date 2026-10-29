#!/usr/bin/env node
// Check the optional short-cover dependencies. The heavy Python environment is
// shared with Seed-VC; this script never downloads models or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = path.join(ROOT, '..', 'seed-vc', '.venv', 'bin', 'python');
const qqPy = path.join(ROOT, '.music-venv', 'bin', 'python');
const ref = path.resolve(ROOT, '..', '..', 'assets', 'voices', 'dsh_reference.wav');
const library = path.join(ROOT, 'data', 'singing', 'library');
const checks = [];
const exists = (p) => fs.existsSync(p);
checks.push(['Seed-VC Python', py, exists(py)]);
checks.push(['Seed-VC inference.py', path.join(ROOT, '..', 'seed-vc', 'inference.py'), exists(path.join(ROOT, '..', 'seed-vc', 'inference.py'))]);
checks.push(['DSH reference WAV', ref, exists(ref)]);
checks.push(['曲库目录', library, exists(library)]);
let demucs = false;
try { demucs = spawnSync(py, ['-c', 'import demucs; print(demucs.__version__)'], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch {}
checks.push(['Demucs', py, demucs]);
let ffmpeg = false;
try { ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 2000 }).status === 0; } catch {}
checks.push(['ffmpeg', 'PATH', ffmpeg]);
let qqmusic = false;
try { qqmusic = spawnSync(qqPy, ['-c', 'import qqmusic_api'], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch {}
checks.push(['QQ 音乐 qqmusic-api-python', qqPy, qqmusic]);
for (const [name, where, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}${where ? ` — ${where}` : ''}`);
if (!demucs) console.log('\n安装分离器：' + `"${py}" -m pip install demucs`);
if (!qqmusic) console.log('安装 QQ 音乐搜索：python3 -m venv packages/bridge/.music-venv && packages/bridge/.music-venv/bin/pip install qqmusic-api-python');
if (!exists(ref)) console.log('生成参考音频：npm run make-ref');
console.log('\n曲库格式：data/singing/library/<歌手 - 歌名>.mp3');
console.log('可选同目录 <同名>.lrc、<同名>.json（segments/meta）或 vocals.wav/instrumental.wav。');
