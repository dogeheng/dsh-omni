// 本地声纹库：data/voiceprints/<id>.json + samples/<id>.wav
//
// 只存 CAM++ embedding（192 维）和一小段用于试听的 WAV，不存原始通话/聊天音频。
// 这是生物特征数据：目录 0700、文件 0600；默认只在本机使用，可逐条删除。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_THRESHOLD = 0.72;
const DEFAULT_MARGIN = 0.05;
const MIN_SAMPLES = 1;
const MAX_NAME = 32;

function normalize(vec) {
  const out = new Float32Array(vec.length);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i]) || 0;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function cleanName(name) {
  const text = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text) throw new Error('名字不能为空');
  if (text.length > MAX_NAME) throw new Error(`名字不能超过 ${MAX_NAME} 字`);
  return text;
}

function cleanQq(qq) {
  const s = String(qq ?? '').trim();
  if (!s) return '';
  if (!/^\d{5,12}$/.test(s)) throw new Error('QQ 号必须是 5–12 位数字');
  return s;
}

export function voiceprintId({ name, qq } = {}) {
  const q = cleanQq(qq);
  if (q) return `qq_${q}`;
  const n = cleanName(name).toLowerCase();
  return `name_${crypto.createHash('sha1').update(n).digest('hex').slice(0, 12)}`;
}

function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function atomicWrite(file, data) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export class VoiceprintStore {
  constructor({ root, dir = null, log = () => {} } = {}) {
    this.root = root || process.cwd();
    this.dir = dir ? path.resolve(this.root, dir) : path.join(this.root, 'data', 'voiceprints');
    this.samplesDir = path.join(this.dir, 'samples');
    this.log = log;
  }

  _ensure() {
    fs.mkdirSync(this.samplesDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch {}
    try { fs.chmodSync(this.samplesDir, 0o700); } catch {}
  }

  _file(id) {
    if (!/^[a-z0-9_]+$/i.test(String(id))) throw new Error('声纹 id 无效');
    return path.join(this.dir, `${id}.json`);
  }

  _sampleFile(id) {
    if (!/^[a-z0-9_]+$/i.test(String(id))) throw new Error('声纹 id 无效');
    return path.join(this.samplesDir, `${id}.wav`);
  }

  _readFile(file) {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!record || typeof record !== 'object') return null;
      if (!record.id || !record.name || !Array.isArray(record.centroid) || record.centroid.length < 32) return null;
      return record;
    } catch {
      return null;
    }
  }

  all() {
    try {
      return fs.readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => this._readFile(path.join(this.dir, name)))
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch {
      return [];
    }
  }

  list() {
    return this.all().map((record) => ({
      id: record.id,
      name: record.name,
      qq: record.qq || '',
      samples: record.samples || 1,
      source: record.source || 'manual',
      createdAt: record.createdAt || null,
      updatedAt: record.updatedAt || null,
      hasSample: fs.existsSync(this._sampleFile(record.id))
    }));
  }

  get(id) {
    return this._readFile(this._file(id));
  }

  findByQq(qq) {
    const q = cleanQq(qq);
    return q ? this.all().find((r) => String(r.qq) === q) || null : null;
  }

  findByName(name) {
    const n = cleanName(name).toLowerCase();
    return this.all().find((r) => String(r.name).toLowerCase() === n) || null;
  }

  /**
   * 注册/追加一条声纹。已有同 QQ 或同名记录时做加权平均（few-shot）。
   */
  enroll({ name, qq = '', centroid, samples = 1, source = 'manual', samplePcm = null, sampleRate = 16000 } = {}) {
    const cleanN = cleanName(name);
    const cleanQ = cleanQq(qq);
    if (!Array.isArray(centroid) || centroid.length < 32) throw new Error('centroid 维度无效');
    const vec = normalize(centroid);
    const existing = (cleanQ && this.findByQq(cleanQ)) || this.findByName(cleanN);
    const id = existing?.id || voiceprintId({ name: cleanN, qq: cleanQ });
    const now = Date.now();
    let record;
    if (existing) {
      const old = Array.isArray(existing.centroid) ? normalize(existing.centroid) : null;
      if (old && old.length === vec.length) {
        const total = (existing.samples || 1) + Math.max(1, Number(samples) || 1);
        const merged = new Float32Array(vec.length);
        for (let i = 0; i < vec.length; i++) {
          merged[i] = (old[i] * (existing.samples || 1) + vec[i] * Math.max(1, Number(samples) || 1)) / total;
        }
        record = { ...existing, centroid: [...normalize(merged)], samples: total };
      } else {
        record = { ...existing, centroid: [...vec], samples: Math.max(1, Number(samples) || 1) };
      }
      record.name = cleanN;
      record.qq = cleanQ || existing.qq || '';
      record.source = source || existing.source || 'manual';
      record.updatedAt = now;
    } else {
      record = {
        id,
        name: cleanN,
        qq: cleanQ,
        centroid: [...vec],
        samples: Math.max(1, Number(samples) || 1),
        source: source || 'manual',
        createdAt: now,
        updatedAt: now,
        sampleRate
      };
    }
    this._ensure();
    atomicWrite(this._file(id), JSON.stringify(record, null, 2));
    if (samplePcm && Buffer.isBuffer(samplePcm) && samplePcm.length >= 3200) {
      const wav = Buffer.concat([wavHeader(samplePcm.length, sampleRate), samplePcm]);
      const sampleFile = this._sampleFile(id);
      const temp = `${sampleFile}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, wav, { mode: 0o600 });
      fs.renameSync(temp, sampleFile);
    }
    this.log('voiceprint', `${existing ? '更新' : '注册'}声纹 ${record.name}（${id}，${record.samples} 段）`);
    return record;
  }

  rename(id, name) {
    const record = this.get(id);
    if (!record) throw new Error('声纹不存在');
    const cleanN = cleanName(name);
    const clash = this.findByName(cleanN);
    if (clash && clash.id !== record.id) throw new Error(`名字已被 ${clash.id} 使用`);
    record.name = cleanN;
    record.updatedAt = Date.now();
    atomicWrite(this._file(id), JSON.stringify(record, null, 2));
    return record;
  }

  remove(id) {
    const record = this.get(id);
    if (!record) throw new Error('声纹不存在');
    try { fs.unlinkSync(this._file(id)); } catch {}
    try { fs.unlinkSync(this._sampleFile(id)); } catch {}
    this.log('voiceprint', `删除声纹 ${record.name}（${id}）`);
    return record;
  }

  samplePath(id) {
    const file = this._sampleFile(id);
    return fs.existsSync(file) ? file : null;
  }

  /** 与声纹库比，返回最佳命中（阈值 + 与第二名的间隔）。 */
  match(centroid, { threshold = DEFAULT_THRESHOLD, margin = DEFAULT_MARGIN } = {}) {
    if (!Array.isArray(centroid) || centroid.length < 32) return null;
    const vec = normalize(centroid);
    const scored = [];
    for (const record of this.all()) {
      if (!Array.isArray(record.centroid) || record.centroid.length !== vec.length) continue;
      scored.push({ record, score: cosine(vec, normalize(record.centroid)) });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < threshold) return null;
    const second = scored[1];
    if (second && best.score - second.score < margin) return null;
    return { ...best.record, score: best.score, secondScore: second?.score ?? null };
  }
}

export const VOICEPRINT_MATCH_DEFAULTS = Object.freeze({
  threshold: DEFAULT_THRESHOLD,
  margin: DEFAULT_MARGIN
});
