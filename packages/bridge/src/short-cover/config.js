// Short-cover configuration: local authorised library, cache/temp dirs, model commands.
import path from 'node:path';

export const COVER_DEFAULTS = Object.freeze({
  enabled: true,
  defaultDuration: 15,
  minDuration: 10,
  maxDuration: 20,
  libraryDir: '',
  cacheDir: '',
  tempDir: '',
  refAudio: '',
  pythonPath: '',
  seedVcDir: '',
  inferenceScript: '',
  demucsPython: '',
  demucsModel: 'htdemucs',
  demucsDevice: '',
  demucsTimeoutMs: 120000,
  seedvcSteps: 30,
  seedvcFp16: false,
  seedvcTimeoutMs: 180000,
  maxConcurrent: 1,
  maxQueue: 10,
  maxPerKey: 2,
  maxCacheFiles: 120,
  maxCacheBytes: 128 * 1024 * 1024,
  maxSourceBytes: 300 * 1024 * 1024,
  cacheTtlMs: 86400000,
  sourceCacheTtlMs: 86400000,
  tmpTtlMs: 3600000,
  previewTtlMs: 600000,
  ttsPreviewTtlMs: 600000,
  ttsDesignTtlMs: 30 * 86400000,
  maxRssMb: 6500,
  minFreeMb: 2500,
  maxMemoryRetries: 2,
  memoryRetryDelayMs: 30000,
  cooldownMs: 60000,
  cacheVersion: '1',
  queueFile: '',
  jamendoClientId: '',
  online: null,
  contextSeconds: 0.75,
  ffmpegPath: 'ffmpeg',
});

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v, fallback, { min = -Infinity, max = Infinity, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
};
const resolvePath = (root, value, fallback) => {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
};

export function normalizeCoverConfig(raw = {}, root = process.cwd(), singing = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sv = singing && typeof singing === 'object' ? singing : {};
  const defaultPython = sv.pythonPath || path.resolve(root, '..', 'seed-vc', '.venv', 'bin', 'python');
  const seedVcDir = resolvePath(root, r.seedVcDir, sv.seedVcDir || path.resolve(root, '..', 'seed-vc'));
  const defaultInference = path.join(seedVcDir, 'inference.py');
  const refFallback = sv.refAudio || path.resolve(root, '..', '..', 'assets', 'voices', 'dsh_reference.wav');
  const minDur = num(r.minDuration, COVER_DEFAULTS.minDuration, { min: 5, max: 30, int: true });
  const maxDur = Math.max(minDur, num(r.maxDuration, COVER_DEFAULTS.maxDuration, { min: minDur, max: 30, int: true }));
  return {
    enabled: r.enabled !== false,
    defaultDuration: Math.min(maxDur, Math.max(minDur, num(r.defaultDuration, COVER_DEFAULTS.defaultDuration, { min: minDur, max: maxDur, int: true }))),
    minDuration: minDur,
    maxDuration: maxDur,
    libraryDir: resolvePath(root, r.libraryDir, path.join(root, 'data', 'singing', 'library')),
    cacheDir: resolvePath(root, r.cacheDir, path.join(root, 'data', 'singing', 'cache')),
    tempDir: resolvePath(root, r.tempDir, path.join(root, 'data', 'singing', 'tmp')),
    refAudio: resolvePath(root, r.refAudio, refFallback),
    pythonPath: resolvePath(root, r.pythonPath, defaultPython),
    seedVcDir,
    inferenceScript: resolvePath(root, r.inferenceScript, defaultInference),
    demucsPython: resolvePath(root, r.demucsPython, defaultPython),
    demucsModel: str(r.demucsModel, COVER_DEFAULTS.demucsModel) || COVER_DEFAULTS.demucsModel,
    demucsDevice: str(r.demucsDevice).trim(),
    demucsTimeoutMs: num(r.demucsTimeoutMs, COVER_DEFAULTS.demucsTimeoutMs, { min: 10000, max: 600000, int: true }),
    seedvcSteps: num(r.seedvcSteps, COVER_DEFAULTS.seedvcSteps, { min: 10, max: 50, int: true }),
    seedvcFp16: r.seedvcFp16 === true,
    seedvcTimeoutMs: num(r.seedvcTimeoutMs, COVER_DEFAULTS.seedvcTimeoutMs, { min: 60000, max: 600000, int: true }),
    maxConcurrent: num(r.maxConcurrent, COVER_DEFAULTS.maxConcurrent, { min: 1, max: 2, int: true }),
    maxQueue: num(r.maxQueue, COVER_DEFAULTS.maxQueue, { min: 0, max: 50, int: true }),
    maxPerKey: num(r.maxPerKey, COVER_DEFAULTS.maxPerKey, { min: 1, max: 10, int: true }),
    queueFile: resolvePath(root, r.queueFile, path.join(root, 'data', 'singing', 'queue.json')),
    maxCacheFiles: num(r.maxCacheFiles, COVER_DEFAULTS.maxCacheFiles, { min: 10, max: 2000, int: true }),
    maxCacheBytes: num(r.maxCacheBytes, COVER_DEFAULTS.maxCacheBytes, { min: 10 * 1024 * 1024, max: 4 * 1024 * 1024 * 1024, int: true }),
    maxSourceBytes: num(r.maxSourceBytes, COVER_DEFAULTS.maxSourceBytes, { min: 10 * 1024 * 1024, max: 8 * 1024 * 1024 * 1024, int: true }),
    cacheTtlMs: num(r.cacheTtlMs, COVER_DEFAULTS.cacheTtlMs, { min: 60000, max: 90 * 86400000, int: true }),
    sourceCacheTtlMs: num(r.sourceCacheTtlMs, COVER_DEFAULTS.sourceCacheTtlMs, { min: 60000, max: 90 * 86400000, int: true }),
    tmpTtlMs: num(r.tmpTtlMs, COVER_DEFAULTS.tmpTtlMs, { min: 60000, max: 86400000, int: true }),
    previewTtlMs: num(r.previewTtlMs, COVER_DEFAULTS.previewTtlMs, { min: 60000, max: 86400000, int: true }),
    ttsPreviewTtlMs: num(r.ttsPreviewTtlMs, COVER_DEFAULTS.ttsPreviewTtlMs, { min: 60000, max: 86400000, int: true }),
    ttsDesignTtlMs: num(r.ttsDesignTtlMs, COVER_DEFAULTS.ttsDesignTtlMs, { min: 86400000, max: 365 * 86400000, int: true }),
    maxRssMb: num(r.maxRssMb, COVER_DEFAULTS.maxRssMb, { min: 2000, max: 16000, int: true }),
    minFreeMb: num(r.minFreeMb, COVER_DEFAULTS.minFreeMb, { min: 500, max: 12000, int: true }),
    maxMemoryRetries: num(r.maxMemoryRetries, COVER_DEFAULTS.maxMemoryRetries, { min: 0, max: 5, int: true }),
    memoryRetryDelayMs: num(r.memoryRetryDelayMs, COVER_DEFAULTS.memoryRetryDelayMs, { min: 5000, max: 300000, int: true }),
    cooldownMs: num(r.cooldownMs, COVER_DEFAULTS.cooldownMs, { min: 0, max: 600000, int: true }),
    cacheVersion: str(r.cacheVersion, COVER_DEFAULTS.cacheVersion) || COVER_DEFAULTS.cacheVersion,
    jamendoClientId: str(r.jamendoClientId).trim(),
    contextSeconds: num(r.contextSeconds, COVER_DEFAULTS.contextSeconds, { min: 0, max: 2 }),
    ffmpegPath: str(r.ffmpegPath, COVER_DEFAULTS.ffmpegPath) || COVER_DEFAULTS.ffmpegPath,
    online: {
      enabled: r.online?.enabled !== false,
      qqmusic: r.online?.qqmusic !== false,
      qqmusicPython: resolvePath(root, r.online?.qqmusicPython, path.join(root, '.music-venv', 'bin', 'python')),
      qqmusicFileType: ['M500', 'M800', 'F000'].includes(String(r.online?.qqmusicFileType || '').toUpperCase()) ? String(r.online.qqmusicFileType).toUpperCase() : 'M500',
      neteaseBaseUrl: str(r.online?.neteaseBaseUrl).trim().replace(/\/+$/, ''),
      neteaseCookie: str(r.online?.neteaseCookie).trim(),
      neteaseLevel: str(r.online?.neteaseLevel, 'standard') || 'standard',
      thirdPartyResolverUrl: str(r.online?.thirdPartyResolverUrl).trim(),
      allowPaidMedia: r.online?.allowPaidMedia === true,
      previewFallback: r.online?.previewFallback === true,
      timeoutMs: num(r.online?.timeoutMs, 20000, { min: 3000, max: 60000, int: true }),
      retries: num(r.online?.retries, 1, { min: 0, max: 3, int: true }),
      searchCacheTtlMs: num(r.online?.searchCacheTtlMs, 6 * 60 * 60 * 1000, { min: 60000, max: 7 * 86400000, int: true }),
      maxBytes: num(r.online?.maxBytes, 60 * 1024 * 1024, { min: 1024 * 1024, max: 200 * 1024 * 1024, int: true }),
    },
    _singing: sv,
  };
}

export function coverStatusConfig(cfg) {
  const { _singing, ...rest } = cfg;
  return rest;
}
