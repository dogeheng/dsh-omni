// 零样本匿名说话人聚类（speaker diarization, anonymous mode）。
//
// 每个 VAD 句子算一个 CAM++ embedding，和已有 cluster 质心做 cosine：
//   - 够像 → 归入该 cluster；
//   - 不够像且还没到 maxSpeakers → 新建 cluster；
//   - 否则不标（宁可不认，也不要乱认）。
//
// 只有出现第 2 个 cluster 之后才输出 `说话人N` 标签：一对一通话永远只有一个人，
// 不会给 prompt 加无意义的标签；群语音从第二个人说话开始才有标签。
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  threshold: 0.65,
  maxSpeakers: 8,
  minSegmentMs: 600,
  minNewClusterMs: 1500,
  voiceprintThreshold: 0.72,
  voiceprintMargin: 0.05
};

function normalize(vector) {
  const out = new Float32Array(vector.length);
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = Number(vector[i]) || 0;
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

export class SpeakerTracker {
  constructor({
    modelPath,
    workerPath = path.join(HERE, 'speaker-worker.mjs'),
    threshold = DEFAULTS.threshold,
    maxSpeakers = DEFAULTS.maxSpeakers,
    minSegmentMs = DEFAULTS.minSegmentMs,
    minNewClusterMs = DEFAULTS.minNewClusterMs,
    voiceprints = [],
    voiceprintThreshold = DEFAULTS.voiceprintThreshold,
    voiceprintMargin = DEFAULTS.voiceprintMargin,
    log = () => {}
  }) {
    this.modelPath = modelPath;
    this.workerPath = workerPath;
    this.threshold = Math.min(0.95, Math.max(0.4, Number(threshold) || DEFAULTS.threshold));
    this.maxSpeakers = Math.min(8, Math.max(2, Math.round(Number(maxSpeakers) || DEFAULTS.maxSpeakers)));
    this.minSamples = Math.max(1, Math.round((Number(minSegmentMs) || DEFAULTS.minSegmentMs) * 16));
    // 短于这个长度的片段只做“认领已有 cluster”，不新建说话人：
    // 群语音里一声“嗯”“对”不该造出一个新人。
    this.minNewSamples = Math.max(this.minSamples, Math.round((Number(minNewClusterMs) || DEFAULTS.minNewClusterMs) * 16));
    this.log = log;
    this.voiceprintThreshold = Math.min(0.95, Math.max(0.5, Number(voiceprintThreshold) || DEFAULTS.voiceprintThreshold));
    this.voiceprintMargin = Math.min(0.3, Math.max(0, Number(voiceprintMargin) || DEFAULTS.voiceprintMargin));
    this.voiceprints = (Array.isArray(voiceprints) ? voiceprints : [])
      .filter((record) => record && Array.isArray(record.centroid) && record.centroid.length > 0)
      .map((record) => ({ ...record, centroid: normalize(record.centroid) }));
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.clusters = [];
  }

  async ensure() {
    if (this.child) return;
    if (this.ready) return this.ready;
    if (!fs.existsSync(this.modelPath)) throw new Error(`缺少说话人模型：${this.modelPath}`);
    if (!fs.existsSync(this.workerPath)) throw new Error(`缺少 speaker worker：${this.workerPath}`);
    this.ready = (async () => {
      const child = fork(this.workerPath, [], {
        serialization: 'advanced',
        // 不继承父进程的 --input-type=module（node -e 测试/诊断时会触发
        // ERR_INPUT_TYPE_NOT_ALLOWED，worker 直接起不来）。
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      });
      this.child = child;
      child.on('message', (message) => this._onMessage(message));
      child.on('error', (error) => this._failAll(new Error(`speaker worker 错误：${error.message}`)));
      child.on('exit', (code, signal) => {
        const error = new Error(`speaker worker 退出 code=${code} signal=${signal}`);
        this.child = null;
        this.ready = null;
        this._failAll(error);
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待说话人模型加载超时（20s）')), 20000);
        this.readyResolve = () => { clearTimeout(timer); resolve(); };
        this.readyReject = (error) => { clearTimeout(timer); reject(error); };
        child.send({ type: 'init', model: this.modelPath, numThreads: 1 });
      });
    })();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      this.close();
      throw error;
    }
  }

  _onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      this.log('speaker', `模型加载完成 dim=${message.dim} ${message.ms ?? 0}ms`);
      return;
    }
    if (message.type === 'fatal') {
      this.readyReject?.(new Error(message.error || 'speaker worker fatal'));
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message.embedding);
  }

  _failAll(error) {
    this.readyReject?.(error);
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  async embed(samples) {
    await this.ensure();
    if (!this.child) throw new Error('speaker worker 未启动');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('说话人 embedding 超时'));
      }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.send({ type: 'embed', id, samples });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _matchCluster(cluster) {
    if (!cluster || cluster.name || this.voiceprints.length === 0) return;
    const scored = [];
    for (const record of this.voiceprints) {
      if (record.centroid.length !== cluster.centroid.length) continue;
      scored.push({ record, score: cosine(cluster.centroid, record.centroid) });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < this.voiceprintThreshold) return;
    const second = scored[1];
    if (second && best.score - second.score < this.voiceprintMargin) return;
    cluster.name = best.record.name;
    cluster.qq = best.record.qq || '';
    cluster.voiceprintId = best.record.id;
    cluster.matchScore = best.score;
    this.log('speaker', `声纹命中：${cluster.name}${cluster.qq ? `（${cluster.qq}）` : ''} ${best.score.toFixed(3)}`);
  }

  _result(index, score) {
    const cluster = this.clusters[index];
    const label = cluster?.name || (this.clusters.length >= 2 ? `说话人${index + 1}` : null);
    return {
      id: `S${index + 1}`,
      label,
      score,
      index,
      name: cluster?.name || null,
      qq: cluster?.qq || '',
      voiceprintId: cluster?.voiceprintId || null,
      matchScore: cluster?.matchScore ?? null
    };
  }

  _cluster(id) {
    const match = /^S(\d+)$/.exec(String(id ?? ''));
    if (!match) return null;
    return this.clusters[Number(match[1]) - 1] || null;
  }

  getCentroid(id) {
    const cluster = this._cluster(id);
    return cluster ? [...cluster.centroid] : null;
  }

  setName(id, name, qq = '') {
    const cluster = this._cluster(id);
    if (!cluster) return false;
    cluster.name = String(name || '').trim();
    cluster.qq = String(qq || '').trim();
    cluster.matchScore = 1;
    return !!cluster.name;
  }

  /**
   * @param {Float32Array} samples 16k 单声道 [-1,1]
   * @returns {Promise<{id:string,label:string|null,score:number}|null>}
   */
  async assign(samples) {
    if (!samples || samples.length < this.minSamples) return null;
    const embedding = await this.embed(samples);
    if (!embedding || embedding.length === 0) return null;
    const vector = normalize(embedding);

    let best = -1;
    let bestIndex = -1;
    for (let i = 0; i < this.clusters.length; i++) {
      const score = cosine(vector, this.clusters[i].centroid);
      if (score > best) { best = score; bestIndex = i; }
    }

    if (bestIndex >= 0 && best >= this.threshold) {
      const cluster = this.clusters[bestIndex];
      const next = cluster.count + 1;
      const centroid = new Float32Array(vector.length);
      for (let i = 0; i < vector.length; i++) {
        centroid[i] = (cluster.centroid[i] * cluster.count + vector[i]) / next;
      }
      cluster.centroid = normalize(centroid);
      cluster.count = next;
      this._matchCluster(cluster);
      return this._result(bestIndex, best);
    }

    if (samples.length < this.minNewSamples) return null;
    if (this.clusters.length < this.maxSpeakers) {
      const cluster = { centroid: vector, count: 1 };
      this.clusters.push(cluster);
      const index = this.clusters.length - 1;
      this.log('speaker', `新说话人 S${index + 1}（当前 ${this.clusters.length} 人）`);
      this._matchCluster(cluster);
      return this._result(index, 1);
    }

    return null;
  }

  snapshot() {
    return this.clusters.map((cluster, index) => ({
      id: `S${index + 1}`,
      label: cluster.name || (this.clusters.length >= 2 ? `说话人${index + 1}` : null),
      name: cluster.name || null,
      qq: cluster.qq || '',
      count: cluster.count
    }));
  }

  reset() {
    this.clusters = [];
  }

  close() {
    this._failAll(new Error('speaker tracker 已关闭'));
    try { this.child?.kill('SIGTERM'); } catch {}
    this.child = null;
    this.ready = null;
    this.pending.clear();
  }
}
