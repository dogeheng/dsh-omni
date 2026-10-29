# 短翻唱（10–20 秒）— sing_short_cover

群友自然语言点歌，例如：

- 「大肥鱼，唱 15 秒雨爱」
- 「唱一下司凤版雨爱」
- 「鲸鱼，来一段起风了的副歌」

DSH 调用 `sing_short_cover`，后台完成：

```text
歌曲/版本匹配 → 授权音源定位 → 副歌/片段选择 → 截取 10–20 秒
→ Demucs 人声/伴奏分离 → Seed-VC 歌声转换（yuki 参考音色）
→ FFmpeg 与原伴奏混音 → QQ 原生语音
```

## 1. 音源政策（重要）

第一版**不会绕过会员、DRM 或风控**；在线源只使用平台 API 明确返回的可播放地址。可用音源：

1. **本地授权曲库**：`packages/bridge/data/singing/library/`（或 `libraryDir` 配置）；
2. **QQ 音乐**：可选，使用 `qqmusic-api-python` 做 search / resolve；只接受平台返回的可播放地址，不处理 `.mflac`/`.mgg` 等加密格式；
3. **网易云音乐**：可选，连接你自行运行的 `NeteaseCloudMusicApi`；只接受 API 返回的 URL；
4. **Jamendo**：配置 `jamendoClientId` 后，自动搜索并下载 **Creative Commons** 曲目；
5. **第三方解析服务**：完全可选，只有你显式配置 `thirdPartyResolverUrl` 才会作为兜底，且必须返回 https 音频地址。

**付费/会员门禁**：`online.allowPaidMedia` 默认 `false`。QQ 音乐标记 `pay_down/pay_play/月费/单曲购买` 或网易云 `fee>0` 的候选默认拒绝；只有你确认自己有相应授权并把该开关设为 `true` 才会尝试。`online.previewFallback` 可使用平台提供的试听片段（QQ 音乐常见 30–60 秒），只用于短翻唱，不冒充完整歌曲。

不会解密 `.qmc`/`.ncm`/`.mflac`，不会绕过付费墙或 DRM；平台没有返回 URL 时明确返回
`no_authorized_url` / `source_not_found`，不会假装生成。要唱《雨爱》，最稳妥仍是把合法音频放进曲库；在线源是可选的便利路径。

曲库结构（文件名即元数据，可选 sidecar）：

```text
data/singing/library/
  杨丞琳 - 雨爱.mp3
  杨丞琳 - 雨爱.lrc              # 可选：自动找副歌
  杨丞琳 - 雨爱.json             # 可选：meta / segments
  杨丞琳 - 雨爱 (司凤版).mp3     # 版本匹配靠文件名/标签
```

`<同名>.json` 示例：

```json
{
  "title": "雨爱",
  "artist": "杨丞琳",
  "version": "司凤版",
  "license": "self-owned",
  "segments": [
    { "start": 62.0, "duration": 15, "label": "chorus" }
  ]
}
```

预分离 stems（可选，优先于 Demucs）：

```text
song.instrumental.wav / song.no_vocals.wav
song.vocals.wav
```

## 2. 依赖

现有 Seed-VC 环境：

```bash
npm --prefix packages/bridge run setup:seedvc
cd packages/seed-vc
.venv/bin/pip install demucs
```

QQ 音乐检索（可选，独立 venv，不影响 Seed-VC）：

```bash
python3 -m venv packages/bridge/.music-venv
packages/bridge/.music-venv/bin/pip install qqmusic-api-python==0.2.0
```

网易云（可选）：自行运行 `NeteaseCloudMusicApi`，在配置里填 `online.neteaseBaseUrl`
（例如 `http://127.0.0.1:3000`）；需要账号自己的 Cookie 时填 `online.neteaseCookie`，
控制台/API 读取时会脱敏。第三方解析服务同理，只填 `online.thirdPartyResolverUrl`。

检查：

```bash
npm --prefix packages/bridge run setup:cover
```

当前机器是 **Apple M5 / 16GB，无 CUDA/RTX 5090**；Seed-VC 使用 MPS，Demucs 使用 CPU、
FFmpeg 混音。支持在配置里把 `demucsDevice`/Seed-VC 环境迁到 CUDA 机器，但当前未验证
RTX 5090。

## 3. 参考音色

```bash
npm --prefix packages/bridge run make-ref
```

输出 `assets/voices/dsh_reference.wav`（当前约 21 秒）。Seed-VC 每次复用它，不重复调用
CosyVoice。这个 WAV 已在 `.gitignore` 中，不提交。

## 4. 配置

`config.json` 的 `socialV2.singing.cover`：

```json
{
  "enabled": true,
  "defaultDuration": 15,
  "minDuration": 10,
  "maxDuration": 20,
  "libraryDir": "data/singing/library",
  "cacheDir": "data/singing/cache",
  "tempDir": "data/singing/tmp",
  "refAudio": "assets/voices/dsh_reference.wav",
  "demucsModel": "htdemucs",
  "demucsDevice": "",
  "demucsTimeoutMs": 120000,
  "seedvcSteps": 30,
  "seedvcTimeoutMs": 180000,
  "maxConcurrent": 1,
  "maxQueue": 10,
  "maxPerKey": 2,
  "queueFile": "data/singing/queue.json",
  "maxRssMb": 6500,
  "minFreeMb": 2500,
  "maxMemoryRetries": 2,
  "memoryRetryDelayMs": 30000,
  "cooldownMs": 60000,
  "jamendoClientId": "",
  "contextSeconds": 0.75,
  "cacheVersion": "1",
  "cacheTtlMs": 86400000,
  "sourceCacheTtlMs": 86400000,
  "tmpTtlMs": 3600000,
  "previewTtlMs": 600000,
  "online": {
    "enabled": true,
    "qqmusic": true,
    "qqmusicPython": "packages/bridge/.music-venv/bin/python",
    "qqmusicFileType": "M500",
    "neteaseBaseUrl": "",
    "neteaseCookie": "",
    "neteaseLevel": "standard",
    "thirdPartyResolverUrl": "",
    "allowPaidMedia": false,
    "previewFallback": true,
    "timeoutMs": 20000,
    "retries": 1,
    "searchCacheTtlMs": 21600000,
    "maxBytes": 62914560
  }
}
```

同时需要打开 `socialV2.singing.enabled` 和 `socialV2.tools.sing`，并重启 DSH 注册工具。
现有 Seed-VC 的 `pythonPath`/`seedVcDir`/`inferenceScript` 会被复用。

## 5. 自动选段

优先级：

1. 用户 `start_time`；
2. `<同名>.json` 的 `segments`；
3. `<同名>.lrc`：重复歌词视为副歌，按行时间轴选 10–20 秒；
4. `scripts/segment_analyze.py`：librosa RMS 找高能量窗口；
5. 兜底从约 33% 位置截取。

最终在源片段前后多留 `contextSeconds`（默认 0.75s），转换后裁到目标时长，并加
120ms/160ms 淡入淡出，避免突然切断。

## 6. 异步与缓存

- 工具调用只负责启动任务，立即返回 `jobId`；完成后的语音自动发到原点歌会话。
- 同一时刻默认 1 个任务，队列最多 2；每群 `cooldownMs`（默认 60 秒）。
- 缓存 Key 包含：歌名/歌手/版本/片段类型/时长/起始时间/音源文件状态/参考音频 hash/
  Seed-VC 步数/`cacheVersion`。
- 命中缓存直接发音频；结果存 `data/singing/cache/<key>.mp3`，临时目录任务后删除。
- 失败会通过 QQ 文字说明阶段：找音源 / 分离环境 / 分离 / 换嗓 / QQ 发送。
- **接收即回执**：任务被接受后由 bridge 立刻发一条「已排队/开始处理」文字，不依赖模型记得回话。
- **不静默丢任务**：已接受任务写入 `data/singing/queue.json`；bridge 重启后 queued 任务恢复，running 任务明确失败并通知。队列满在入口拒绝，不会先接受再丢。
- **按群顺序回传**：每个群有 requestSeq/outbox；后完成的音频/失败说明要等前面的结果，按请求顺序发送。
- **回收**：任务临时目录在 `finally` 立即删除；结果 MP3 缓存默认 1 天/最多 120 个/128MB，下载源音频 1 天/300MB，试听 10 分钟；启动和每 10 分钟按 TTL/LRU 清理。
- **重负载**：翻唱 active 1、全局队列 10、每群 pending 2；ASR 队列 4，翻唱前会释放空闲 ASR worker（~850MB）；内存不足会退避重试 2 次。
- **语音发送兜底**：QQ 原生语音发送失败时，自动尝试 OneBot `upload_group_file` / `upload_private_file` 发 MP3 文件；文件 5 分钟后删除。
- **TTS 侧**：`qq_speak` / `autoConvert` 只把音频放在内存 Buffer 里，不产生每条消息的临时文件；控制台试听 `data/tts/last-preview.*` 10 分钟回收，MiMo 设计参考音频 30 天回收。

## 7. 工具参数

`sing_short_cover(song, artist?, version?, duration?, segment?, start_time?)`

- `duration` 默认 15，夹在 10–20；
- `segment`：`chorus`（默认）/`verse`/`random`；
- `version` 用于「司凤版」「某某翻唱版」精确匹配；
- 不需要 `/sing` 命令，不执行 Shell，不允许 LLM 拼接命令。

## 8. 许可证与参考

- **Seed-VC**：GPL-3.0，独立进程调用，不 vendor；
- **Demucs**：MIT，独立 Python 命令；
- **SoulX-Singer**：Apache-2.0，作为未来 SVC 备选，当前未接入；
- [matsuko_cover](https://github.com/sdfsfsk/matsuko_cover)（AGPL-3.0）与
  [astrbot_plugin_rvc_svc](https://github.com/CCYellowStar2/astrbot_plugin_rvc_svc)（AGPL-3.0）
  只作为「搜索/选段/异步/缓存」流程参考，**没有复制其代码**；它们依赖的 AMD 中间层
  不能直接用于本机。

## 8.5 本机实测

Apple M5 / 16GB、无 NVIDIA CUDA：

- Demucs htdemucs 分离 15 秒：约 **9.7 秒**，峰值 footprint 约 **2.25GB**；
- Seed-VC + Demucs + 混音，10 秒输出：约 **34–47 秒**（取决缓存/步数）；
- 参考音色为 21 秒 CosyVoice `yuki` 语音；
- 子进程 RSS/footprint 守卫上限 6500MB，空闲无 Python 进程。

这些是技术链路实测。2026-10-27 另外做了在线链路验证：

- QQ 音乐搜索：`雨爱` / `雨爱 司凤版` / `起风了` / `青花瓷` 都能返回候选；
- `雨爱` 普通版只返回平台 60 秒试听（`previewFallback=true`），下载后 LRC 定位到 38.78 秒副歌，Demucs + Seed-VC + FFmpeg 输出 15.0 秒；
- 通过 bridge `/api/socialV2/cover` 向**主人私聊**真实发送了一条「雨爱 15.0s」语音（activity 日志 `[cover] 雨爱 15.0s`），这是私聊端到端，不是群聊；
- 「司凤版」精确候选被标记付费，`allowPaidMedia=false` 时返回 403 `no_authorized_url`，没有退回普通版；
- 不存在的歌名返回 404 `source_not_found`；重复请求命中缓存。

## 8.6 自检

```bash
npm --prefix packages/bridge run setup:cover
npm --prefix packages/bridge run test-short-cover
npm --prefix packages/bridge run test-online-cover
npm --prefix packages/bridge run test-cover-queue
```

`test-cover-queue` 覆盖接收回执、队列上限、持久化、同群结果顺序和缓存命中。

`test-online-cover` 用本地 HTTP mock + 假 QQMusic 子进程覆盖搜索、精确版本、免费优先、
付费候选拒绝、下载校验、LRC 和网易云适配器；真实 QQ 搜索/试听下载另做本地验证。

`test-short-cover` 覆盖曲库搜索/版本匹配、LRC 选段、无音源错误、异步队列和缓存命中；
真实 Demucs+Seed-VC 链路用本地测试音频单独验证，不随仓库分发音频。

## 9. 当前限制

- 没有真实 QQ 群里的《雨爱》授权音源；QQ 音乐《雨爱》普通版只返回试听片段，**「司凤版」精确版本是付费/会员候选**，默认被 `allowPaidMedia=false` 拒绝，因此「司凤版雨爱」真实端到端尚未通过。要看完整版/司凤版，需你确认授权后开启 `allowPaidMedia`，或把合法音频放进曲库。
- 网易云需要你自己运行 `NeteaseCloudMusicApi`；本机没有该服务，只有 mock 测试。
- 第三方解析服务未配置；它只是可选兜底，不能保证所有歌可下载。
- 没有 NVIDIA CUDA/RTX 5090；当前用 MPS/CPU，速度与显存策略未在 NVIDIA 上验证。
- 自动选段对无 LRC 的歌曲使用 RMS 近似，不保证一定落在副歌。
- 第一版不做整首、不做 RVC 训练、不做 NetEase/QQ 音频下载。
