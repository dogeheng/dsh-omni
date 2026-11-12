# 群语音按人分离（Speaker Diarization）方案

> 目标：在 QQ 群语音里回答“谁说了什么”，让 Yuki 能按人接话，而不是把整段混音当成一个人。
> 状态：方案调研 + 分阶段计划；尚未改代码。

## 结论（先看这里）

- **先不要直接上 100M 的流式 diarization。** 最划算的是 Phase 1：用已有的 `sherpa-onnx-node` + 3D-Speaker CAM++，对每个 VAD 句子算 embedding、在线聚类，给 ASR 文本加 `SPEAKER_n`；1–2 天能出可听版本。
- **真正难的不是模型，是“标签 → QQ 昵称”。** 不认名字只要 1–2 天；要认张三/李四，得加 Phase 2 声纹注册（群友语音消息/1:1 通话），这是产品决策，也是隐私边界。
- **只有重叠说话/多人同时开口严重影响体验时，才上 Phase 3B 的 NVIDIA Nemotron 3 流式 diarization**（8 人、0.32–1.04s，Apple Silicon 有 CoreML/MLX）。
- 推荐顺序：Phase 0 录 5–10 段真实群语音做基线 → Phase 1 按句聚类 → Phase 2 声纹认人 → 看指标决定是否 Phase 3。

## 1. 先分清两件事

| 能力 | 产出 | 用途 | 难度 |
| --- | --- | --- | --- |
| **说话人分离 / diarization** | `谁在什么时间段说话`（SPEAKER_00/01…） | 给 ASR 文本加说话人标签，按人回复 | 中 |
| **声源分离 / source separation** | 把重叠的几个人拆成独立音轨 | 多人同时说话时分别送 ASR | 高，且会有音质损伤 |

群语音现在拿到的是 **QQ 混音后的一条 16k 单声道流**，没有每个人的独立音轨。所以第一步应该做 **diarization**；只有“多人同时说话且必须分别识别”时，才需要再上 source separation（Demucs / SepFormer / MossFormer2 这类）。

## 2. 现在的链路与缺口

```text
parec qq_out.monitor (16k mono)
  → VAD 切句（30ms 帧）
  → SenseVoice ASR
  → Smart Turn 判停
  → DSH prompt
```

缺口：

- VAD/ASR 只产出文本，没有说话人；
- 群语音是多人混音，VAD 可能把几个人连续的话并成一段；
- 即使加了说话人标签，还要解决 **标签 → QQ 昵称** 的映射（diarization 只给匿名 cluster）。

## 3. 现有成熟方案对比

### 3.1 本地 / 开源

| 方案 | 类型 | 说话人数 | 延迟 / 速度 | 许可 | 适合我们吗 |
| --- | --- | --- | --- | --- | --- |
| **sherpa-onnx + 3D-Speaker / pyannote** | 离线 diarization + speaker embedding | 由聚类决定 | CPU；官方示例 56.9s 音频 16.9s 处理完（RTF≈0.30） | Apache-2.0 / MIT / 3D-Speaker Apache-2.0 | **最优先**：`sherpa-onnx-node` 已经是现有依赖，Node 直接调用，无需新 Python 环境 |
| **3D-Speaker CAM++ / ERes2Net** | speaker embedding（用于聚类/注册） | 不限 | CAM++ 7.2M 参数，VoxCeleb1-O EER 0.65%；单段 embedding 约 10–30ms | Apache-2.0 | **最优先**：中文/英文说话人识别，适合做“按句 embedding + 在线聚类”和声纹注册 |
| **NVIDIA Nemotron 3 Diarization（Streaming Sortformer）** | 流式 diarization | 最多 8 人 | 100M 参数；输入缓冲最低 80ms，推荐 0.32s；10ms 输出 | OpenMDW-1.1 | **最像人的实时方案**；有 CoreML / MLX / ONNX / GGUF 转换，Apple Silicon 可跑；集成成本比 sherpa 高 |
| **NVIDIA Sortformer 4spk v2.1** | 流式 diarization | 4 人 | 117M；流式，按到达顺序编号 | NVIDIA Open Model License | Nemotron 3 的前代；4 人够用但上限低，优先 Nemotron 3 |
| **pyannote.audio 4.0 + community-1** | 离线 diarization | 不限 | PyTorch，GPU/CPU；高精度但偏慢 | 代码 MIT；模型需接受 HuggingFace 条款/令牌 | **评测基线**：离线批量算 DER 最合适；不建议直接做实时通话 |
| **Diart** | 流式 diarization（pyannote） | 不限 | 可调 0.5–5s 延迟，增量聚类 | MIT | 成熟的流式方案，但依赖 pyannote<3.1 的旧组合，维护节奏慢 |
| **WhisperX** | ASR + diarization 离线管线 | 不限 | 离线，非实时 | BSD / 依赖许可 | 适合离线转写，不适合通话 |
| **FluidAudio / speech-swift** | macOS 原生（CoreML/ANE） | 看模型 | CAM++ CoreML 约 12ms/20s 音频（M2 Max 基准） | 各自许可 | 如果走全 Swift/CoreML 路线可看；和当前 Node 链路距离较远 |

### 3.2 云服务

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| pyannoteAI precision-2 | 开箱即用，精度高 | 付费、音频出本机、延迟/隐私 |
| Deepgram / AssemblyAI / Rev.ai diarization | 稳定 API、多语言 | 同上；群语音是私人聊天，不建议默认走云 |

群语音是私人内容，默认应 **本地**；云只作为评测对照或用户显式开启。

## 4. 推荐路线：先“按句 embedding + 在线聚类”，再决定要不要上流式 diarization

### Phase 0：基线与数据（0.5–1 天）

- 加一个**仅调试用**的群通话录音开关：保存 `parec` 的 16k PCM + VAD 切段 + 时间戳；默认关闭，录完自动清理。
- 找 3–5 个群友，录 5–10 段 2–5 人的群语音（或从已有通话里截），人工标“谁说了哪段”。
- 指标：DER、说话人归属准确率、端到端延迟、CPU/内存。
- 没有标注数据，后面所有模型选型都是拍脑袋。

### Phase 1：按句 speaker embedding + 在线聚类（1–2 天，建议先做）

`sherpa-onnx-node` 已经自带：

```js
const sherpa = require('sherpa-onnx-node');
const extractor = new sherpa.SpeakerEmbeddingExtractor({
  // 中文+英文混合、约 20 万说话人训练的 "advanced" 版本；纯中文可用 _zh-cn_16k-common
  model: 'data/models/speaker/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  numThreads: 1
});
const stream = extractor.createStream();
stream.acceptWaveform({ sampleRate: 16000, samples }); // samples: Float32Array
const embedding = extractor.compute(stream);           // Float32Array, dim=192
```

`SpeakerTracker`（新模块，Node）：

- 每个 VAD utterance 算一个 embedding；
- 与已有 cluster 质心算 cosine：
  - ≥ `threshold`（先 0.70）→ 归入该 cluster；
  - 否则新建 `SPEAKER_n`；
- 每个 cluster 维护质心、样本数、最近出现时间；
- 最多 8 人；短于 0.6s 的片段不建新 cluster，避免噪声造人；
- 输出 `{ id: 'SPEAKER_00', score, name? }`。

接入点：

```text
handleUtterance()
  → ASR 得到 text
  → SpeakerTracker.assign(pcm) 得到 speaker
  → pendingTurn 记录 { text, speaker }
  → prompt 里写 "[SPEAKER_00] 文本" 或 "[张三] 文本"
```

优点：延迟极低（每段 10–30ms）、不改现有 VAD/ASR、无需新运行时；对“大家轮流说话”的群语音已经能解决 80% 的问题。
缺点：重叠说话、极短句、多人同时开口时不可靠——先接受，Phase 3 再补。

### Phase 2：标签 → QQ 昵称（1–2 天）

diarization 只给匿名 cluster，要变成“张三”需要声纹注册：

- **声纹来源**（优先级从高到低）：
  1. 群友发的 QQ 语音消息：OneBot 能按 messageId 取 record，而且知道 sender QQ；每人取 3–10 条干净语音；
  2. 一对一通话：call-loop 已经有每段用户 PCM，可在获得同意后注册；
  3. 手动上传 5–10s 干净语音。
- 每人算一个 centroid，存 `data/voiceprints/<qq>.json`（本地，不上传）。
- 匹配：cluster centroid 与注册 centroid cosine ≥ `0.70–0.75` 才认名字，否则保持 `说话人N`；不要为了“像”而乱认。
- 隐私：声纹是生物特征；提供 `voiceprint delete <qq>`，默认只存本地、只用于本人群聊。
- 可选增强：群语音窗口里 QQ 会高亮当前说话人；截屏 OCR/头像识别可以做“匿名 cluster → 名字”的辅助确认，但 UI 不稳定，作为 fallback，不作为主路径。

### Phase 3：真正的 diarization（3–7 天，按 Phase 1 的效果决定）

如果 Phase 1 在真实群语音上的归属准确率 <85%，或者经常出现两人同时说话：

**方案 A（推荐先试）：sherpa-onnx `OfflineSpeakerDiarization` 滚动窗口**

- 模型：`sherpa-onnx-pyannote-segmentation-3-0` + `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`；
- 每 8–12s 滚动窗口跑一次，输出 speaker turns；用全局 `SpeakerTracker` 把局部 cluster 对齐到全局 cluster；
- 官方示例 RTF≈0.30（56.9s 音频 16.9s 处理），10s 窗口约 3s 处理；对“准实时”够用，对“接话”偏慢；
- 优点：Node 直接调用、CPU、模型小、Apache/MIT 组合；缺点：不是真流式，窗口边界可能抖。

**方案 B（最像人）：NVIDIA Nemotron 3 Diarization 流式**

- 8 人、0.32s（推荐）到 1.04s 延迟、10ms 输出、AOSC 保持说话人身份；
- Apple Silicon 有 CoreML / MLX 转换（FluidInference CoreML 约 190MB，`fast32` 2.88s / `low` 1.04s；`c128-split-w8a8` 95MB）；
- 适合“多人同时说话 + 需要低延迟”的场景；
- 代价：模型 95–190MB、集成 CoreML/MLX/ONNX 运行时、许可 OpenMDW-1.1 需要确认；比 sherpa 重。
- 如果决定走这条，建议单独进程 + 环形缓冲，输出 speaker activity，再和 ASR 段对齐；不要塞进现有 ASR 子进程。

**方案 C：pyannote.audio 4.0 community-1 离线**

- 只用于 Phase 0 的评测基线/离线转写，不建议实时通话；
- 需要 HuggingFace 令牌/接受条款；PyTorch 依赖重。

### Phase 4：群语音的“该不该接”（1–2 天）

有了说话人还不够，群语音的难点是 **turn-taking**：

- prompt 里带 `[张三]` / `[说话人2]`，要求 Yuki：
  - 知道名字才叫名字；不知道就用“刚才那位”，不猜；
  - 多人重叠时标 `[多人]`，不归因；
  - 不逐条接话；被点名/提问/话题相关才接；否则等一个人说完再判断；
- 群语音里每个人是独立 turn 还是同一 turn？建议按 speaker 分段，但回复策略仍是“整群”级别：不要对每个人的每句话都回。
- 可选：Yuki 对匿名 cluster 问一句“刚才说话的是谁？”——自然，也能收集标注。

### Phase 5：配置、降级与评测

```jsonc
"call": {
  "diarization": {
    "mode": "embedding",          // off | embedding | streaming
    "embeddingModel": "data/models/speaker/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "threshold": 0.70,
    "maxSpeakers": 8,
    "enrollDir": "data/voiceprints",
    "windowMs": 10000,            // streaming/rolling 模式
    "minSegmentMs": 600
  }
}
```

- `off`：完全回到现在的单说话人行为；
- `embedding`：Phase 1/2，推荐默认；
- `streaming`：Phase 3B（Nemotron）。
- 所有模式 fail-open：模型缺失/失败时退回无标签，不影响通话。

### 代码落点（如果按 Phase 1/2 做）

| 文件 | 作用 |
| --- | --- |
| `packages/bridge/src/speaker-tracker.js` | 包装 `SpeakerEmbeddingExtractor` + 在线聚类 + `SpeakerEmbeddingManager` 注册匹配 |
| `packages/bridge/scripts/setup-speaker.mjs` | 下载 CAM++ / pyannote segmentation 模型到 `data/models/speaker/`，`--status` 检查 |
| `packages/bridge/src/voiceprints.js` | `data/voiceprints/<qq>.json` 的读写、增删、隐私清理 |
| `packages/bridge/scripts/call-loop.mjs` | `handleUtterance`/`feedTurn` 里给 pendingTurn 附 `speaker`，prompt 前缀 `[张三]` / `[说话人1]` |
| `packages/bridge/config.json` | `call.diarization` 配置与 `off` 降级 |

`sherpa-onnx-node` 是原生 addon，建议把 embedding/diarization 放在**独立子进程**（像 `asr-worker.mjs` 一样）：
模型不大，但 ONNX Runtime 的内存池不一定会还给系统；子进程退出/挂断即可回收。

## 5. 需要先确认的产品问题

1. **要不要认名字？**
   - 只做匿名 `说话人1/2`：1–2 天，不需要声纹库；
   - 要做“张三/李四”：加 Phase 2，需要群友语音样本和隐私说明。
2. **要不要处理重叠说话？**
   - 不处理：Phase 1 够用；
   - 要处理：Phase 3B（Nemotron）或 source separation，成本和复杂度明显上升。
3. **群语音的回复策略**：按人回，还是仍然“整群一个 Yuki”？这决定 prompt 和 turn-taking 的设计，比模型选型更影响体感。

## 6. 风险与限制

- QQ 群语音是混音，且经过 QQ 的 AEC/AGC/降噪；声纹注册用语音消息、识别用通话音频，域不一致会掉分，需要实测校准。
- 短句、笑声、多人重叠、背景音乐/游戏声会让 embedding 聚类不稳。
- 声纹是生物特征：本地存储、可删除、不默认跨群共享。
- 模型许可：3D-Speaker Apache-2.0、sherpa-onnx Apache-2.0、pyannote 模型需接受 HF 条款、Nemotron 3 是 OpenMDW-1.1；商用/分发前逐项确认。
- 延迟：Phase 1 几乎无感；Phase 3A 滚动窗口约 2–3s；Phase 3B 0.32–1.04s，但模型更重。

## 7. 建议的下一步

先做 **Phase 1 + 2 的最小闭环**：

1. 用 `sherpa-onnx-node` + CAM++ 做 `SpeakerTracker`，给每段 ASR 加 `SPEAKER_n`；
2. 用群友语音消息注册 3–5 个声纹，能认出名字就带名字；
3. 找一段真实群语音回放，看“谁说了什么”的日志准不准；
4. 再决定要不要上 Phase 3 的流式 diarization。

这样 2–3 天能有一个可听的版本，而不是一上来就集成 100M 的流式模型。

## 参考

- [sherpa-onnx Speaker Diarization 文档](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html)
- [sherpa-onnx speaker recognition models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)
- [3D-Speaker（CAM++ / ERes2Net）](https://github.com/modelscope/3D-Speaker)
- [NVIDIA Nemotron 3 Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization)
- [Nemotron 3 CoreML for Apple Silicon](https://huggingface.co/FluidInference/nemotron-3-diarization-coreml)
- [Nemotron 3 MLX](https://huggingface.co/mlx-community/Nemotron-3-Diarization)
- [NVIDIA Streaming Sortformer 4spk v2.1](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)
- [pyannote.audio](https://github.com/pyannote/pyannote-audio) / [community-1 发布说明](https://www.pyannote.ai/blog/community-1)
- [Diart 实时 diarization](https://github.com/juanmc2005/diart)
- [WhisperX](https://github.com/m-bain/whisperX)
