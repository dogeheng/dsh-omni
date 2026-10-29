// Async short-cover job manager v2.
//
// Differences from manager.js:
//   - accepted jobs are durable (data/singing/queue.json);
//   - every accepted job gets an immediate receipt;
//   - per-group result outbox sends final audio/failure strictly in request order;
//   - admission is bounded (global + per-group), so accepted jobs are never silently dropped;
//   - a bridge restart resumes queued jobs and reports running jobs as failed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { normalizeCoverConfig } from './config.js';
import { listLibrary, resolveSource } from './library.js';
import { runPipeline, hashFile } from './pipeline.js';
import { resolveOnlineSource } from './online.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
const TERMINAL = new Set(['succeeded', 'failed']);
const ACTIVE = new Set(['queued', 'running']);
const stageName = (s) => ({ source_not_found: '找音源', separation_unavailable: '人声分离环境', separation_failed: '人声分离', conversion_failed: '歌声转换', reference_missing: '音色参考', seedvc_unavailable: '唱歌引擎', memory: '内存', busy: '队列' }[s] || '处理');

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
    start_time: (q.start_time === undefined || q.start_time === null || q.start_time === '') ? null
      : (Number.isFinite(Number(q.start_time)) ? Number(q.start_time) : null),
  };
}
function queryKey(q, key) { return `${key}|${q.song}|${q.artist}|${q.version}|${q.segment}|${q.duration}|${q.start_time ?? ''}`.toLowerCase(); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function createShortCoverService({ getConfig, root = process.cwd(), log = () => {}, onAudio, onText, onAccepted, beforeRun, pipeline = runPipeline } = {}) {
  const cfgNow = () => {
    const raw = typeof getConfig === 'function' ? getConfig() : {};
    const cover = raw?.cover ?? raw?.shortCover ?? raw ?? {};
    return normalizeCoverConfig(cover, root, raw?.singing ?? {});
  };
  const jobs = new Map();                 // id -> job (including terminal, for status)
  const queue = [];                       // queued inference jobs, FIFO
  const outbox = new Map();               // key -> Map(seq -> terminal job)
  const nextSeq = new Map();              // key -> last assigned seq
  const sendSeq = new Map();              // key -> next seq allowed to send
  const flushLocks = new Map();           // key -> Promise
  let active = null;

  function removeOld(dir, maxAgeMs, { maxFiles = Infinity, maxBytes = Infinity, logCleanup = false } = {}) {
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
    entries.sort((a, b) => a.t - b.t);
    let total = entries.reduce((n, e) => n + (fs.statSync(e.p).size || 0), 0);
    for (const e of entries) {
      if (entries.length - removed <= maxFiles && total <= maxBytes) break;
      try { total -= fs.statSync(e.p).size || 0; fs.rmSync(e.p, { force: true }); removed++; } catch {}
    }
    if (removed && logCleanup) log(`[cover] 回收 ${dir} 中 ${removed} 个旧文件`);
    return removed;
  }
  function cleanupStorage(cfg, { startup = false } = {}) {
    removeOld(cfg.cacheDir, cfg.cacheTtlMs, { maxFiles: cfg.maxCacheFiles, maxBytes: cfg.maxCacheBytes, logCleanup: true });
    removeOld(path.join(cfg.cacheDir, 'sources'), cfg.sourceCacheTtlMs, { maxFiles: cfg.maxCacheFiles * 2, maxBytes: cfg.maxSourceBytes, logCleanup: true });
    removeOld(path.join(cfg.cacheDir, 'online-search'), Math.max(cfg.online.searchCacheTtlMs, 86400000), { maxFiles: 300 });
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
  function cacheLookup(key, cfg) {
    const f = cacheFile(key, cfg); const m = cacheMeta(key, cfg);
    if (!fs.existsSync(f) || fs.statSync(f).size < 1024) return null;
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(m, 'utf8')); } catch {}
    return { ...meta, file: f, buffer: fs.readFileSync(f), ext: 'mp3', mime: 'audio/mpeg', seconds: Number(meta.duration) || null, cached: true };
  }
  function cacheStore(key, cfg, result, query, candidate) {
    fs.mkdirSync(cfg.cacheDir, { recursive: true });
    fs.copyFileSync(result.file, cacheFile(key, cfg));
    fs.writeFileSync(cacheMeta(key, cfg), JSON.stringify({
      key, song: query.song, artist: query.artist, version: query.version, title: candidate.title,
      source: candidate.source, license: candidate.license, segment: query.segment,
      duration: result.seconds, window: result.window, createdAt: Date.now(), cacheVersion: cfg.cacheVersion,
    }, null, 2));
    trimCache(cfg);
  }
  function trimCache(cfg) {
    try {
      const files = fs.readdirSync(cfg.cacheDir).filter((n) => n.endsWith('.mp3'));
      if (files.length <= cfg.maxCacheFiles) return;
      files.map((n) => ({ n, t: fs.statSync(path.join(cfg.cacheDir, n)).mtimeMs }))
        .sort((a, b) => a.t - b.t).slice(0, files.length - cfg.maxCacheFiles)
        .forEach(({ n }) => { try { fs.rmSync(path.join(cfg.cacheDir, n), { force: true }); fs.rmSync(path.join(cfg.cacheDir, n.replace(/\.mp3$/, '.json')), { force: true }); } catch {} });
    } catch {}
  }
  function cacheKeyFor(query, candidate, cfg) {
    const voice = hashFile(cfg.refAudio);
    const stat = (() => {
      try {
        const s = fs.statSync(candidate.path); let lrc = '';
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

  function serializeJob(j) {
    return {
      id: j.id, key: j.key, seq: j.seq, query: j.query, keyHash: j.keyHash || '',
      status: j.status, stage: j.stage, title: j.title, candidate: j.candidate ? { path: j.candidate.path, lrc: j.candidate.lrc, title: j.candidate.title, duration: j.candidate.duration, source: j.candidate.source } : null,
      resultFile: j.resultFile || '', resultSeconds: j.resultSeconds || 0, failureText: j.failureText || '',
      createdAt: j.createdAt, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null, cached: j.cached === true, sent: j.sent === true,
    };
  }
  function persist() {
    try {
      const cfg = cfgNow();
      const pending = [...jobs.values()].filter((j) => !j.sent).map(serializeJob);
      atomicWrite(cfg.queueFile, { version: 1, nextSeq: Object.fromEntries(nextSeq), jobs: pending });
    } catch (e) { log(`[cover] 持久化队列失败（继续运行）：${e.message}`); }
  }
  function loadPersisted() {
    const cfg = cfgNow();
    const data = readJson(cfg.queueFile);
    if (!data || !Array.isArray(data.jobs)) return;
    for (const [k, n] of Object.entries(data.nextSeq || {})) if (Number.isFinite(Number(n))) nextSeq.set(k, Number(n));
    for (const raw of data.jobs) {
      if (!raw || !raw.id || !raw.key) continue;
      const job = { ...raw, query: normalizeQuery(raw.query || {}), status: raw.status, sent: false };
      jobs.set(job.id, job);
      if (!nextSeq.has(job.key) || Number(raw.seq) > nextSeq.get(job.key)) nextSeq.set(job.key, Number(raw.seq) || 1);
      if (job.status === 'running') {
        job.status = 'failed'; job.stage = 'restart'; job.error = '桥接重启，任务中断'; job.failureText = '这次翻唱在重启时中断了，请重点一次。';
        job.finishedAt = Date.now(); addOutbox(job);
      } else if (job.status === 'queued') {
        queue.push(job);
      } else if (TERMINAL.has(job.status)) {
        if (job.status === 'succeeded' && job.resultFile && fs.existsSync(job.resultFile)) {
          job.result = { file: job.resultFile, buffer: fs.readFileSync(job.resultFile), ext: 'mp3', mime: 'audio/mpeg', seconds: job.resultSeconds, cached: job.cached };
        } else if (job.status === 'succeeded') {
          job.status = 'failed'; job.failureText = '结果文件在重启后丢失，请重点一次。';
        }
        addOutbox(job);
      }
    }
    for (const [key] of nextSeq) {
      const unsent = [...jobs.values()].filter((j) => j.key === key && !j.sent).map((j) => j.seq).sort((a, b) => a - b);
      sendSeq.set(key, unsent.length ? unsent[0] : (nextSeq.get(key) || 0) + 1);
    }
    if (jobs.size) log(`[cover] 恢复队列：${queue.length} 个排队，${[...outbox.values()].reduce((n, m) => n + m.size, 0)} 个待发送`);
    // Re-flush after all sequence counters are restored.
    for (const key of [...outbox.keys()]) flush(key).catch(() => {});
  }

  function addOutbox(job) {
    if (!outbox.has(job.key)) outbox.set(job.key, new Map());
    outbox.get(job.key).set(job.seq, job);
    persist();
    flush(job.key).catch((e) => log(`[cover] 发送队列异常：${e.message}`));
  }
  function takeTerminal(key, seq) {
    const m = outbox.get(key); if (!m) return;
    m.delete(seq);
    if (!m.size) outbox.delete(key);
  }
  async function flush(key) {
    const existing = flushLocks.get(key); if (existing) return existing;
    const p = (async () => {
      while (true) {
        const m = outbox.get(key); if (!m || !m.size) break;
        const desired = sendSeq.get(key) || 1;
        const first = m.get(desired);
        // Preserve request order: a later cached/failed item must not overtake a
        // still-running earlier request for the same conversation.
        if (!first || !TERMINAL.has(first.status)) break;
        try {
          if (first.status === 'succeeded') {
            const result = { ...first.result, song: { title: first.candidate?.title || first.title }, query: first.query, candidate: first.candidate };
            await withTimeout(onAudio?.(key, result), 120000, '发送超时');
            first.sent = true; first.stage = 'done';
          } else {
            const text = first.failureText || `这次翻唱失败：${first.error || '未知错误'}`;
            await withTimeout(onText?.(key, text), 30000, '发送超时');
            first.sent = true; first.stage = 'done';
          }
        } catch (e) {
          first.sent = true; first.stage = 'send-failed'; first.error = e?.message ?? String(e);
          log(`[cover] 结果发送失败 ${first.id}: ${first.error}`);
          // Never lose the user-visible outcome: if audio/file delivery fails,
          // try one short text explaining it, then advance the ordered queue.
          try { await withTimeout(onText?.(key, `翻唱完成但发送失败：${String(first.error).slice(0, 120)}`), 15000, '发送失败通知超时'); } catch {}
        }
        takeTerminal(key, first.seq);
        sendSeq.set(key, desired + 1);
        persist();
      }
    })().finally(() => { flushLocks.delete(key); });
    flushLocks.set(key, p);
    return p;
  }
  function drain() {
    if (active || !queue.length) return;
    const job = queue.shift();
    runJob(job).catch(() => {});
  }
  async function resolveJobSource(job, cfg) {
    try { return (await resolveSource(job.query, cfg)).candidate; }
    catch (localError) {
      if (!cfg.online?.enabled) throw localError;
      try { return (await resolveOnlineSource(job.query, cfg, log)).candidate; }
      catch (onlineError) {
        if (onlineError?.stage && onlineError.stage !== 'source_not_found') throw onlineError;
        throw onlineError?.stage === 'source_not_found' ? onlineError : localError;
      }
    }
  }
  async function runJob(job) {
    const cfg = cfgNow();
    active = job; job.status = 'running'; job.startedAt = Date.now(); persist();
    let work = '';
    try {
      job.stage = 'source';
      const candidate = job.candidate?.path && fs.existsSync(job.candidate.path) ? job.candidate : await resolveJobSource(job, cfg);
      job.candidate = candidate; job.title = candidate.title; persist();
      const keyHash = cacheKeyFor(job.query, candidate, cfg);
      job.keyHash = keyHash;
      const hit = cacheLookup(keyHash, cfg);
      if (hit) {
        job.status = 'succeeded'; job.cached = true; job.stage = 'cache'; job.result = { ...hit, song: { title: candidate.title }, query: job.query, candidate };
        job.resultFile = hit.file; job.resultSeconds = hit.seconds; job.finishedAt = Date.now();
        addOutbox(job); log(`[cover] cache ${job.id} ${candidate.title}`); return;
      }
      job.stage = 'memory';
      if (typeof beforeRun === 'function') { try { await beforeRun(job); } catch (e) { log(`[cover] 资源预处理失败（继续）：${e.message}`); } }
      const free = availableMemoryMb();
      if (free < cfg.minFreeMb) throw Object.assign(new Error(`可用内存不足：${free}MB < ${cfg.minFreeMb}MB`), { stage: 'memory' });
      job.stage = 'segment';
      fs.mkdirSync(cfg.tempDir, { recursive: true });
      work = fs.mkdtempSync(path.join(cfg.tempDir, 'cover-'));
      const result = await pipeline({ source: candidate.path, candidate, query: job.query, cfg, workDir: work, log });
      job.stage = 'cache';
      cacheStore(keyHash, cfg, result, job.query, candidate);
      job.result = result; job.resultFile = cacheFile(keyHash, cfg); job.resultSeconds = result.seconds;
      job.status = 'succeeded'; job.stage = 'ready'; job.finishedAt = Date.now();
      addOutbox(job);
      log(`[cover] done ${job.id} ${candidate.title} ${result.seconds.toFixed(1)}s (${job.finishedAt - job.startedAt}ms)`);
    } catch (error) {
      job.status = 'failed'; job.finishedAt = Date.now(); job.error = error?.message ?? String(error); job.stage = error?.stage || job.stage || 'unknown';
      job.attempts = (job.attempts || 0) + 1;
      if (job.stage === 'memory' && job.attempts <= cfg.maxMemoryRetries) {
        job.status = 'queued'; job.stage = 'waiting-memory';
        log(`[cover] 内存不足，${cfg.memoryRetryDelayMs / 1000}s 后重试 (${job.attempts}/${cfg.maxMemoryRetries})`);
        persist();
        setTimeout(() => {
          if (job.status !== 'queued') return;
          queue.push(job); persist(); drain();
        }, cfg.memoryRetryDelayMs).unref?.();
      } else {
        job.failureText = `这次翻唱卡在「${stageName(job.stage)}」：${String(job.error).slice(0, 160)}`;
        log(`[cover] failed ${job.id} at ${job.stage}: ${job.error}`);
        addOutbox(job);
      }
    } finally {
      if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} }
      active = null; persist(); drain();
    }
  }

  async function start(input, key = '') {
    const cfg = cfgNow();
    if (!cfg.enabled) throw Object.assign(new Error('短翻唱功能未开启（socialV2.singing.cover.enabled=false）'), { stage: 'disabled' });
    if (!cfg.ffmpegPath) throw Object.assign(new Error('缺少 ffmpeg'), { stage: 'config' });
    const query = normalizeQuery(input);
    if (!query.song) throw Object.assign(new Error('song 不能为空'), { stage: 'input' });
    query.duration = Math.min(cfg.maxDuration, Math.max(cfg.minDuration, query.duration));
    const qk = queryKey(query, key);
    if (!sendSeq.has(key)) {
      const unsent = [...jobs.values()].filter((j) => j.key === key && !j.sent).map((j) => j.seq).sort((a, b) => a - b);
      sendSeq.set(key, unsent.length ? unsent[0] : (nextSeq.get(key) || 0) + 1);
    }
    const duplicate = [...jobs.values()].find((j) => j.key === key && j.queryKey === qk && !j.sent && (ACTIVE.has(j.status) || TERMINAL.has(j.status)));
    if (duplicate) return { jobId: duplicate.id, status: duplicate.status, cached: duplicate.cached === true, title: duplicate.title, duration: query.duration, duplicate: true };
    const pendingForKey = [...jobs.values()].filter((j) => j.key === key && !j.sent && (ACTIVE.has(j.status) || TERMINAL.has(j.status))).length;
    if (pendingForKey >= cfg.maxPerKey) throw Object.assign(new Error(`这个会话已有 ${pendingForKey} 个翻唱在排队，稍后再点`), { stage: 'busy' });
    if (queue.length >= cfg.maxQueue) throw Object.assign(new Error(`翻唱队列已满（前面还有 ${queue.length} 个），稍后再点`), { stage: 'busy' });
    const seq = (nextSeq.get(key) || 0) + 1; nextSeq.set(key, seq);
    const ahead = (active ? 1 : 0) + queue.length;
    const job = { id: jobId(), key, query, queryKey: qk, seq, candidate: null, title: query.song, status: 'queued', stage: 'queued', createdAt: Date.now(), cached: false };
    jobs.set(job.id, job); queue.push(job); persist();
    if (typeof onAccepted === 'function') {
      try { await onAccepted(key, { jobId: job.id, title: job.title, position: ahead + 1, queued: ahead, duration: query.duration }); } catch (e) { log(`[cover] 回执发送失败：${e.message}`); }
    }
    drain();
    return { jobId: job.id, status: 'queued', cached: false, title: job.title, duration: query.duration, position: ahead + 1 };
  }

  function getJob(id) {
    const j = jobs.get(String(id ?? '')); if (!j) return null;
    const status = j.status === 'succeeded' && j.sent ? 'done' : j.status;
    return { id: j.id, key: j.key, status, stage: j.stage, title: j.title, error: j.error, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, cached: j.cached, sent: j.sent, position: j.seq };
  }
  function status() {
    const cfg = cfgNow();
    return {
      enabled: cfg.enabled,
      config: { ...cfg, _singing: undefined, online: { ...cfg.online, neteaseCookie: cfg.online?.neteaseCookie ? '********' : '', thirdPartyResolverUrl: cfg.online?.thirdPartyResolverUrl ? '********' : '' } },
      jobs: [...jobs.values()].slice(-50).map((j) => ({ id: j.id, key: j.key, seq: j.seq, status: j.status, stage: j.stage, title: j.title, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error?.slice(0, 300), cached: j.cached, sent: j.sent })),
      active: active ? active.id : null,
      queue: queue.length,
      outbox: [...outbox.values()].reduce((n, m) => n + m.size, 0),
      library: listLibrary(cfg.libraryDir).length,
    };
  }
  function songs() { return listLibrary(cfgNow().libraryDir); }

  try { cleanupStorage(cfgNow(), { startup: true }); } catch {}
  const cleanupTimer = setInterval(() => { try { cleanupStorage(cfgNow()); } catch {} }, 10 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();
  try { loadPersisted(); } catch (e) { log(`[cover] 恢复队列失败（忽略）：${e.message}`); }
  setTimeout(() => { try { drain(); for (const key of outbox.keys()) flush(key).catch(() => {}); } catch {} }, 0).unref?.();

  return { start, getJob, status, songs, normalize: cfgNow };
}
