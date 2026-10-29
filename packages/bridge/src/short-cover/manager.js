// Async short-cover job manager: search → segment → separate → sing → mix → send.
// One GPU/ML job at a time by default; cache and queue are file/Map based.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { normalizeCoverConfig } from './config.js';
import { listLibrary, resolveSource, searchLibrary } from './library.js';
import { runPipeline, hashFile } from './pipeline.js';
import { resolveOnlineSource } from './online.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeId = (s) => /^[\w\u4e00-\u9fff.-]{1,80}$/u.test(String(s)) && !String(s).includes('..');

function jobId() { return crypto.randomBytes(8).toString('hex'); }

function availableMemoryMb() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
      const page = Number((/page size of (\d+)/.exec(out) ?? [])[1]) || 16384;
      const get = (k) => Number((new RegExp(`${k}:\\s+(\\d+)`).exec(out) ?? [])[1]) || 0;
      const pages = get('Pages free') + get('Pages inactive') + get('Pages speculative');
      if (pages > 0) return Math.round((pages * page) / 1024 / 1024);
    }
    return Math.round(os.freemem() / 1024 / 1024);
  } catch { return Math.round(os.freemem() / 1024 / 1024); }
}

function normalizeQuery(q) {
  return {
    song: String(q.song ?? '').trim(),
    artist: String(q.artist ?? '').trim(),
    version: String(q.version ?? '').trim(),
    duration: Number(q.duration) || 15,
    segment: ['chorus', 'verse', 'random'].includes(q.segment) ? q.segment : 'chorus',
    start_time: (q.start_time === undefined || q.start_time === null || q.start_time === '')
      ? null
      : (Number.isFinite(Number(q.start_time)) ? Number(q.start_time) : null),
  };
}

export function createShortCoverService({ getConfig, root = process.cwd(), log = () => {}, onAudio, onText, pipeline = runPipeline } = {}) {
  const cfgNow = () => {
    const raw = typeof getConfig === 'function' ? getConfig() : {};
    const cover = raw?.cover ?? raw?.shortCover ?? raw ?? {};
    return normalizeCoverConfig(cover, root, raw?.singing ?? {});
  };
  const jobs = new Map();
  const queue = [];
  let active = null;

  function removeOld(dir, maxAgeMs, { maxFiles = Infinity, logCleanup = false } = {}) {
    if (!dir || !fs.existsSync(dir)) return 0;
    let removed = 0;
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    const entries = [];
    for (const ent of files) {
      const p = path.join(dir, ent.name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && Date.now() - st.mtimeMs > maxAgeMs) { fs.rmSync(p, { force: true }); removed++; }
        else if (st.isFile()) entries.push({ p, t: st.mtimeMs });
      } catch {}
    }
    if (entries.length > maxFiles) {
      entries.sort((a, b) => a.t - b.t).slice(0, entries.length - maxFiles).forEach(({ p }) => { try { fs.rmSync(p, { force: true }); removed++; } catch {} });
    }
    if (removed && logCleanup) log(`[cover] 回收 ${dir} 中 ${removed} 个旧文件`);
    return removed;
  }

  function cleanupStorage(cfg, { startup = false } = {}) {
    const cacheDir = cfg.cacheDir;
    // Result MP3 + metadata: keep a small LRU for repeat requests, expire by age.
    removeOld(cacheDir, cfg.cacheTtlMs, { maxFiles: cfg.maxCacheFiles, logCleanup: true });
    removeOld(path.join(cacheDir, 'sources'), cfg.sourceCacheTtlMs, { maxFiles: cfg.maxCacheFiles * 2, logCleanup: true });
    removeOld(path.join(cacheDir, 'online-search'), Math.max(cfg.online.searchCacheTtlMs, 86400000), { maxFiles: 300 });
    // Temp directories are created per job; remove stale directories as a whole.
    if (fs.existsSync(cfg.tempDir)) {
      for (const ent of fs.readdirSync(cfg.tempDir, { withFileTypes: true })) {
        const p = path.join(cfg.tempDir, ent.name);
        try {
          const st = fs.statSync(p);
          if (startup || Date.now() - st.mtimeMs > cfg.tmpTtlMs) { fs.rmSync(p, { recursive: true, force: true }); log(`[cover] 回收临时文件 ${ent.name}`); }
        } catch {}
      }
    }
    removeOld(path.join(root, 'data', 'singing', 'preview'), cfg.previewTtlMs, { logCleanup: true });
  }

  function cacheFile(key, cfg) { return path.join(cfg.cacheDir, `${key}.mp3`); }
  function cacheMeta(key, cfg) { return path.join(cfg.cacheDir, `${key}.json`); }

  // Run once at service creation, then periodically; this also handles an idle bot.
  try { cleanupStorage(cfgNow(), { startup: true }); } catch {}
  const cleanupTimer = setInterval(() => { try { cleanupStorage(cfgNow()); } catch {} }, 10 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  function cacheLookup(key, cfg) {
    const f = cacheFile(key, cfg);
    const m = cacheMeta(key, cfg);
    if (!fs.existsSync(f) || fs.statSync(f).size < 1024) return null;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(m, 'utf8')); } catch {}
    return { ...meta, file: f, buffer: fs.readFileSync(f), ext: 'mp3', mime: 'audio/mpeg', seconds: Number(meta.duration) || null, cached: true };
  }

  function cacheStore(key, cfg, result, query, candidate) {
    fs.mkdirSync(cfg.cacheDir, { recursive: true });
    fs.copyFileSync(result.file, cacheFile(key, cfg));
    fs.writeFileSync(cacheMeta(key, cfg), JSON.stringify({
      key, song: query.song, artist: query.artist, version: query.version,
      title: candidate.title, source: candidate.source, license: candidate.license,
      segment: query.segment, duration: result.seconds, window: result.window,
      createdAt: Date.now(), cacheVersion: cfg.cacheVersion,
    }, null, 2));
    trimCache(cfg);
  }

  function trimCache(cfg) {
    try {
      const files = fs.readdirSync(cfg.cacheDir).filter((n) => n.endsWith('.mp3'));
      if (files.length <= cfg.maxCacheFiles) return;
      files.map((n) => ({ n, t: fs.statSync(path.join(cfg.cacheDir, n)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .slice(0, files.length - cfg.maxCacheFiles)
        .forEach(({ n }) => { try { fs.rmSync(path.join(cfg.cacheDir, n), { force: true }); fs.rmSync(path.join(cfg.cacheDir, n.replace(/\.mp3$/, '.json')), { force: true }); } catch {} });
    } catch {}
  }

  function status() {
    const cfg = cfgNow();
    return {
      enabled: cfg.enabled,
      config: { ...cfg, _singing: undefined, online: { ...cfg.online, neteaseCookie: cfg.online?.neteaseCookie ? '********' : '', thirdPartyResolverUrl: cfg.online?.thirdPartyResolverUrl ? '********' : '' } },
      jobs: [...jobs.values()].map(({ id, key, status, stage, title, createdAt, startedAt, finishedAt, error, cached }) => ({ id, key, status, stage, title, createdAt, startedAt, finishedAt, error: error?.slice(0, 300), cached })),
      active: active ? active.id : null,
      queue: queue.length,
      library: listLibrary(cfg.libraryDir).length,
    };
  }

  function cacheKeyFor(query, candidate, cfg) {
    const voice = hashFile(cfg.refAudio);
    const stat = (() => {
      try {
        const s = fs.statSync(candidate.path);
        let lrc = '';
        if (candidate.lrc) { try { const l = fs.statSync(candidate.lrc); lrc = `:${l.size}:${Math.round(l.mtimeMs)}`; } catch {} }
        return `${candidate.path}:${s.size}:${Math.round(s.mtimeMs)}${lrc}`;
      } catch { return candidate.path; }
    })();
    return crypto.createHash('sha256').update(JSON.stringify({
      song: query.song, artist: query.artist, version: query.version, segment: query.segment,
      duration: query.duration, start: query.start_time, source: stat, voice,
      backend: 'seed-vc', steps: cfg.seedvcSteps, cacheVersion: cfg.cacheVersion,
    })).digest('hex').slice(0, 32);
  }

  async function runJob(job) {
    const cfg = cfgNow();
    active = job;
    job.status = 'running';
    job.startedAt = Date.now();
    fs.mkdirSync(cfg.tempDir, { recursive: true });
    let work = '';
    try {
      job.stage = 'memory';
      const free = availableMemoryMb();
      if (free < cfg.minFreeMb) throw Object.assign(new Error(`可用内存不足：${free}MB < ${cfg.minFreeMb}MB`), { stage: 'memory' });
      job.stage = 'segment';
      work = fs.mkdtempSync(path.join(cfg.tempDir, 'cover-'));
      const result = await pipeline({ source: job.candidate.path, candidate: job.candidate, query: job.query, cfg, workDir: work, log });
      job.stage = 'cache';
      cacheStore(job.keyHash, cfg, result, job.query, job.candidate);
      cleanupStorage(cfg);
      job.stage = 'sending';
      if (typeof onAudio === 'function') await onAudio(job.key, { ...result, song: { title: job.candidate.title }, query: job.query, candidate: job.candidate });
      job.status = 'done';
      job.finishedAt = Date.now();
      log(`[cover] done ${job.id} ${job.candidate.title} ${result.seconds.toFixed(1)}s (${job.finishedAt - job.startedAt}ms)`);
    } catch (error) {
      job.status = 'failed';
      job.finishedAt = Date.now();
      job.error = error?.message ?? String(error);
      job.stage = error?.stage || job.stage || 'unknown';
      log(`[cover] failed ${job.id} at ${job.stage}: ${job.error}`);
      if (typeof onText === 'function') {
        const stageName = { source_not_found: '找音源', separation_unavailable: '人声分离环境', separation_failed: '人声分离', conversion_failed: '歌声转换', reference_missing: '音色参考', seedvc_unavailable: '唱歌引擎' }[job.stage] || '处理';
        try { await onText(job.key, `这次翻唱卡在「${stageName}」：${String(job.error).slice(0, 160)}`); } catch {}
      }
    } finally {
      if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} }
      active = null;
      drain();
    }
  }

  function drain() {
    if (active || !queue.length) return;
    const job = queue.shift();
    runJob(job).catch(() => {});
  }

  async function start(input, key = '') {
    const cfg = cfgNow();
    if (!cfg.enabled) throw Object.assign(new Error('短翻唱功能未开启（socialV2.singing.cover.enabled=false）'), { stage: 'disabled' });
    if (!cfg.ffmpegPath) throw Object.assign(new Error('缺少 ffmpeg'), { stage: 'config' });
    const query = normalizeQuery(input);
    cleanupStorage(cfg);
    if (!query.song) throw Object.assign(new Error('song 不能为空'), { stage: 'input' });
    query.duration = Math.min(cfg.maxDuration, Math.max(cfg.minDuration, query.duration));
    let resolved;
    try {
      resolved = await resolveSource(query, cfg);
    } catch (localError) {
      if (!cfg.online?.enabled) throw localError;
      try {
        resolved = await resolveOnlineSource(query, cfg, log);
      } catch (onlineError) {
        // If the online adapters found the song but the URL was not authorised,
        // preserve that more useful stage/message; otherwise keep the local error.
        if (onlineError?.stage && onlineError.stage !== 'source_not_found') throw onlineError;
        throw onlineError?.stage === 'source_not_found' ? onlineError : localError;
      }
    }
    const { candidate } = resolved;
    const keyHash = cacheKeyFor(query, candidate, cfg);
    const hit = cacheLookup(keyHash, cfg);
    if (hit) {
      const memo = { id: jobId(), key, query, candidate, status: 'cached', stage: 'sending', title: candidate.title, createdAt: Date.now(), cached: true };
      jobs.set(memo.id, memo);
      if (typeof onAudio === 'function') await onAudio(key, { ...hit, song: { title: candidate.title }, query, candidate });
      memo.status = 'done'; memo.finishedAt = Date.now();
      return { jobId: memo.id, status: 'cached', cached: true, title: candidate.title, duration: query.duration };
    }
    if (jobs.size > 0 && [...jobs.values()].some((j) => j.keyHash === keyHash && (j.status === 'queued' || j.status === 'running'))) {
      const existing = [...jobs.values()].find((j) => j.keyHash === keyHash && (j.status === 'queued' || j.status === 'running'));
      return { jobId: existing.id, status: existing.status, cached: false, title: candidate.title };
    }
    if (queue.length >= cfg.maxQueue) throw Object.assign(new Error('翻唱队列已满，稍后再点'), { stage: 'busy' });
    const job = { id: jobId(), key, keyHash, query, candidate, status: 'queued', stage: 'queued', title: candidate.title, createdAt: Date.now(), cached: false };
    jobs.set(job.id, job);
    queue.push(job);
    drain();
    return { jobId: job.id, status: 'queued', cached: false, title: candidate.title, source: candidate.source, duration: query.duration };
  }

  function getJob(id) {
    const j = jobs.get(String(id ?? ''));
    if (!j) return null;
    return { id: j.id, key: j.key, status: j.status, stage: j.stage, title: j.title, error: j.error, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, cached: j.cached };
  }

  function songs() { return listLibrary(cfgNow().libraryDir); }

  return { start, getJob, status, songs, normalize: cfgNow };
}
