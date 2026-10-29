# 唱歌（Seed-VC）— 15–20 秒短片段

这是一套**按需启动、用完退出**的唱歌服务：不在 DSH 常驻模型，不在 Mac 上做人声分离。
只从曲库取已经分离好的 15–20 秒干声，用 Seed-VC 换成 DSH 的声音，混上伴奏后发回 QQ。

> Seed-VC 是 GPL-3.0 的独立项目。本仓库**不包含**它的代码或权重，只通过 CLI 调用；
> 这样 dsh-omni 可以继续保持 MIT。Seed-VC 的模型权重另有 HuggingFace 条款。

## 1. 准备引擎

```bash
# 在 dsh-omni 根目录
npm --prefix packages/bridge run setup:seedvc
cd packages/seed-vc
python3.12 -m venv .venv
.venv/bin/pip install -r requirements-mac.txt   # macOS；Windows/Linux 用 requirements.txt
.venv/bin/pip install torchcodec                  # 当前 torchaudio 保存 wav 需要
node ../bridge/scripts/patch-seedvc-mps.mjs --dir .   # Apple Silicon：F0 float64 -> float32（setup:seedvc 已自动打）
```

- 首次推理会从 HuggingFace 下载约 1.4GB 权重；国内可先 `export HF_ENDPOINT=https://hf-mirror.com`。
- 磁盘：venv 约 6GB + 权重 1.4GB + 中间文件；建议至少 25GB 空闲。
- Seed-VC 官方支持 Apple Silicon；本方案只跑 15–20 秒片段，不做整首、不做运行时分离。

## 2. 曲库

```text
packages/bridge/data/singing/songs/
  雨爱/
    vocal.wav          # 15–20 秒干净干声，必需
    instrumental.wav   # 同长度伴奏，可选
    meta.json          # {"title":"雨爱","source":"...","license":"..."}，可选
```

- 运行时只做 Seed-VC 换嗓 + ffmpeg 混音；**不会在 Mac 上分离原曲**。
- 干声越干净，换嗓越稳；带 BGM 的片段会把人声和伴奏一起换，效果差。
- 公开发布翻唱前确认词曲/录音授权；曲库默认只做本地/群内使用。

## 3. 参考音频

`data/voice/dsh-ref.wav`：用当前 TTS 音色生成 **约 20 秒**干净语音：

```bash
npm --prefix packages/bridge run make-ref
```

如果你把日常 TTS 从 MiMo 切到 CosyVoice，或者换了 `voiceId`，要重新跑一次 `make-ref`。
Seed-VC 用它来定音色；说话和唱歌是两个模型，音色会接近但不会 100% 相同。

## 4. 控制台

「二代仿真 → 开口说话 → 唱歌（Seed-VC，本地按需）」：

- 启用唱歌（同时注册 `qq_sing`，保存后需重启 DSH）；
- 单首最长时间（默认 20 秒）；
- 峰值内存上限（默认 6500MB）；
- 最低可用内存（默认 3000MB）；
- diffusion steps（默认 30；片段可降到 20 提速）；
- 超时、队列、冷却、半音移调、fp16；
- Seed-VC 目录 / Python / 参考音频 / 曲库路径；
- 刷新状态：显示引擎是否就绪、曲库数量、当前是否在唱、可用内存、上次峰值/耗时。

## 5. 内存管理

```text
空闲：没有 Python 进程，没有模型常驻；只有 bridge 的一个轻量服务对象。
点歌：启动独立 Python 子进程 → 加载 Seed-VC → 处理 15–20 秒 → 混音 → 发送 → 进程退出。
```

- 一次只跑一首；队列默认 1；
- 每 500ms 采样子进程内存（macOS 用 footprint，避免 MPS 分配不计入 RSS），超过 `maxRssMb` 立即杀进程组；
- 超时 `timeoutMs` 杀进程；
- 开始前检查可用内存，低于 `minFreeMb` 直接拒绝；
- `nice -n 10` 降低 CPU 抢占；
- 不预热、不 launchd keepalive、不后台训练；
- 曲库和参考音频在磁盘，不占内存。

本机实测（M5 / 16GB，14 秒片段、20 steps、模型已缓存）：约 **32 秒**完成换嗓+混音，
峰值 footprint 约 **4.1GB**；首次运行还要下载模型，可能多花几分钟。15–20 秒片段
预计 35–50 秒，峰值仍在 6500MB 上限内；如果第一条很慢，是模型下载/首次加载，不是每次。

如果实测峰值超过 6500MB，先把 `diffusionSteps` 降到 20、确认参考音频不超过 25 秒，
或者把 `maxRssMb` 调到 6000 后重测；仍然不够就只在云 GPU 上跑唱歌。

## 6. QQ 用法

```text
@Yuki 唱《雨爱》
```

→ 从曲库取《雨爱》15–20 秒干声 → Seed-VC 换嗓 → 混音 → 发语音。

- 曲库没有会回复可用歌单；
- 不是「给歌词就唱」；必须先准备干声；
- 只支持短片段，唱不了整首；
- 每群有冷却（默认 180 秒），同时只唱一首；
- 首次冷启动会先回一句“在开嗓”，然后等结果。

## 7. 成本与许可

- Seed-VC：软件免费（GPL-3.0）；只花本机电费/时间；没有官方付费 API。
- 云 GPU 兜底：4090 约 2–5 元/小时；15–20 秒片段通常几分钟内完成。
- 本仓库不 vendor Seed-VC 代码/权重；不要把 GPL 代码复制进 MIT 仓库。
- 参考音频、歌曲、角色音色都要确认使用权。
