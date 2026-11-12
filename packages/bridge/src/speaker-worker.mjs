// 说话人 embedding 子进程：由 SpeakerTracker 在通话接通时 fork，挂断即退出。
//
// 为什么单独进程：sherpa-onnx 的 ONNX Runtime 内存池不一定会把内存还给系统；
// 模型只有 ~27MB，但独立进程可以在挂断时完整回收，也不阻塞 call-loop 的事件循环。
//
// IPC（serialization:'advanced'，Float32Array 原样传递）：
//   父 → 子 { type:'init', model, numThreads }
//   子 → 父 { type:'ready', dim }
//   父 → 子 { type:'embed', id, samples }
//   子 → 父 { type:'result', id, embedding } | { type:'error', id, error }
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let extractor = null;

const send = (message) => {
  try { process.send?.(message); } catch {}
};

process.on('disconnect', () => process.exit(0));

async function init({ model, numThreads = 1 }) {
  try {
    const sherpa = require('sherpa-onnx-node');
    const t0 = Date.now();
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads });
    send({ type: 'ready', dim: extractor.dim, ms: Date.now() - t0 });
  } catch (error) {
    send({ type: 'fatal', error: String(error?.message ?? error) });
    process.exit(1);
  }
}

async function embed({ id, samples }) {
  try {
    if (!extractor) throw new Error('extractor 未初始化');
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    const embedding = extractor.compute(stream);
    send({ type: 'result', id, embedding });
  } catch (error) {
    send({ type: 'error', id, error: String(error?.message ?? error) });
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') void init(message);
  else if (message.type === 'embed') void embed(message);
});
