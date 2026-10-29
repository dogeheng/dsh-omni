# 听懂语音与开口说话（ASR / TTS）

这份文档说明 dsh-omni 二代仿真模式（reserved2）里的两项语音能力：**听懂群友发来的 QQ 语音**，以及**用自己的声音开口说话**。前者默认开启、完全本地运行、不花钱；后者默认关闭，需要你先选一个合成服务商并配置密钥。

| 能力 | 默认 | 引擎 | 成本 | 典型延迟（本机实测） |
| --- | --- | --- | --- | --- |
| 听懂语音（ASR） | 开 | 本地 SenseVoice-Small（sherpa-onnx int8，CPU） | 0 | 每条 0.7–1.0 s（网关转码约 0.5 s，识别约 0.1 s） |
| 开口说话（TTS） | 关 | 百炼 CosyVoice 3.5（默认）/ 小米 MiMo / 豆包语音 / OpenAI 兼容 / GPT-SoVITS | MiMo 目前限时免费；其余按服务商计费 | 取决于服务商（MiMo 社区实测 p50 约 5 s） |

## 一、听懂语音（ASR）

### 它做了什么

群友发来语音时，桥接会在把消息交给模型之前先转写，模型看到的不再是一个空洞的 `[语音]`，而是：

```text
[语音 6秒·语气开心] 不至于吧，还入戏太深，我们也得有时间陪他玩啊。
[语音 9秒·语气难过] 就当我们原养了一个大孙子，等真的有孙子了，没准还不适应。
[语音 2秒（没听清）]
```

SenseVoice 除了文字，还会识别说话人的情绪（开心、难过、生气、害怕、惊讶、嫌弃）和声学事件（笑声、掌声、背景音乐、咳嗽等）。这正是选择 2024-07-17 版模型而不是 2025-09-09 版的原因：后者不输出这些标签。

取音频按三级兜底，任何一级成功就返回。第一级请 SnowLuma 用 `get_record(out_format:'wav')` 在容器里把 QQ 的 SILK 转成 PCM WAV；第二级直接下载 record 段里的 QQ CDN 地址，用 `silk-wasm` 在本地解码；第三级（识别失败时可选）回退到 SnowLuma 的 `fetch_ptt_text`，也就是 QQ 自带的语音转文字。同一个语音文件只会识别一次，识别结果做了 Promise 级缓存，实时消息、引用解析、历史回看共用同一份结果。

### 快速上手

```bash
cd packages/bridge
npm install            # sherpa-onnx-node 与 silk-wasm 是 optionalDependencies，会一起装上
npm run setup:asr      # 下载 SenseVoice 模型（约 160MB 压缩包，解压到 data/models/，已 gitignore）
npm run test-voice:io  # 离线自检（含一次真实模型识别）
```

重启桥接后即可生效。模型或依赖缺失时，桥接只打一行提示，语音仍显示为 `[语音]`，不影响其它功能。

**按需加载（默认）**：识别跑在独立的子进程 `src/asr-worker.mjs` 里，桥接启动时**不加载**模型。第一条语音到来时才拉起子进程并加载模型，之后闲置 `idleUnloadMs`（默认 10 分钟）没有新语音，就结束子进程，内存整块还给系统；下一条语音来了再自动加载。子进程崩溃或单条识别超时时会被结束并在下一条时重建，不会拖垮桥接。2026-10-24 在 Apple Silicon 上用 macOS `footprint` 实测：

| 阶段 | 桥接进程 | 识别子进程 | 耗时 |
| --- | --- | --- | --- |
| 未加载（启动后、闲置释放后） | 21–25 MB | 无 | — |
| 第一条语音（含加载） | 24 MB | 855 MB | 约 1.1 s（其中加载 0.96 s） |
| 已加载时的后续语音 | 24 MB | 855 MB | 约 0.09 s / 条 |

想让第一条语音也不等加载，可以打开 `preload`（启动约 2 秒后预加载）；想一直常驻，把 `idleUnloadMs` 设为 `0`。磁盘占用约 229 MB（`model.int8.onnx` 228 MB）+ 依赖约 32 MB（`sherpa-onnx-darwin-arm64`）。不想用本地模型时可以改用 `engine: "qq"`（QQ 自带转写，没有情绪标签）。

**控制台**：所有参数都在控制台「二代仿真 → 听懂语音 / 开口说话（ASR · TTS）」分组里，和本页面其它参数一起点「保存当前参数」写入 `config.json`，即时生效。分组里能看到模型 / 依赖是否就绪、当前是否已加载、何时自动释放、累计加载与释放次数，并提供「立即加载模型」「立即释放内存」按钮；「概览 → 大功能开关」里也有「听懂语音」「开口说话」两个总开关。

### 配置（`socialV2.asr`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `engine` | `sensevoice` | `sensevoice` 本地 / `qq` 只用 QQ 自带转写 / `off` 关闭 |
| `modelDir` | `data/models/sherpa-onnx-sense-voice-…-2024-07-17` | 相对 `packages/bridge/` |
| `numThreads` | `2` | 识别线程数 |
| `preload` | `false` | 启动时就加载模型（关闭 = 按需加载） |
| `idleUnloadMs` | `600000` | 闲置多久释放模型；`0` = 加载后一直常驻 |
| `maxSeconds` | `60` | 超过这个时长的语音不转写（QQ 单条上限 60 s） |
| `timeoutMs` | `15000` | 单条「取音频 + 识别」总预算，超时回退为 `[语音]` |
| `maxConcurrent` | `2` | 同时识别的条数上限 |
| `qqFallback` | `true` | 本地识别失败时回退 `fetch_ptt_text` |
| `showEmotion` / `showEvent` | `true` | 是否在标注里带情绪 / 声学事件 |

## 二、开口说话（TTS）

### 两种开口方式

dsh-omni 的触发策略直接借鉴了 MaiBot 生态语音插件的做法（出处见文末），把「什么时候说话」拆成两条互补的路径。

**模型主动说（`qq_speak` 工具）**。模型自己判断这句适合说出口，就调用 `qq_speak(text, emotion?, style?)`。这是 Liccsu/maibot-mimotts-voice、ZhaoCang-QWQ/doubao-tts、SengokuCola/aliyun-tts-plugin 的默认模式（MaiBot 里叫 LLM / Action 模式）。工具描述和 preset 第 18 条都写清了适合说的场景（回别人的语音、打招呼、吐槽、惊叹、撒娇）和不适合的场景（长解释、链接、代码、列表、数字密集）。情绪只给枚举，不给连续数值：这条原则来自 ZhaoCang-QWQ/doubao-tts，即「能选的才交给模型，语速音量这类数字交给模型不可预期」。

`qq_speak` 的成功回包以 `sent=true` 表示 OneBot 已接收；`verified` 只表示 `get_msg` 回读确认（`autoReadback=false` 时为 `null`，回读失败为 `false`），不要把 `verified=false/null` 当成发送失败。

**随机短句转语音（`autoConvert`）**。模型照常调用 `qq_send_message` 打字，系统以小概率把**单条、无引用、无 @ 的短句**改成语音条发出，返回 `spokenAsVoice: true`。这对应 SoulString-Dev/maibot-mimo-voice 与 Ling-LA/ling-tts-bot 的 `random` 模式、AstrBot 核心的 `trigger_probability`。默认概率 0.05、短句上限 40 字，取自 SoulString-Dev 的默认值（他们的结论是「语音集中在短句上更像真人随口插话」）。对方刚发过语音时（10 分钟内），概率提高到 `mirrorProbability`（默认 0.35），也就是「你发语音我也更可能回语音」，思路来自 CowAgent 的 `voice_reply_voice`，这里做成概率而不是硬开关。任何一步不满足（冷却中、含链接/代码/长数字/@/旁白、没抽中、合成失败或超时）都会安静地回退为文字，不让对话干等。

两条路径共用一套闸门：会话令牌、模式与白名单、静默模式、独立的语音限流（每分钟 / 每小时）、每日合成字数上限，以及合成前的敏感信息审计。

### 文本整理

模型写的是聊天文本，不是朗读稿，直接送 TTS 会把 emoji、颜文字、Markdown 符号、链接一起念出来。`prepareSpeechText` 的主体移植自 Liccsu/maibot-mimotts-voice 的 `text_processor.py`（MIT），并吸收了 SoulString-Dev 的实测结论：

| 处理 | 例子 | 出处 |
| --- | --- | --- |
| 去 Markdown、链接、代码、CQ 码、emoji、颜文字 | `**真的假的**？看这个 https://…` → `真的假的？看这个你就懂了。` | Liccsu |
| 短括号保留为音频标签，长括号旁白剔除 | `（叹气）行吧` 保留；`（他一边说一边把手机递了过来…）` 删除 | Liccsu |
| MiMo 风格标签提到开头，`emotion` 参数并入 | `好困（慵懒）` → `(慵懒)好困。` | Liccsu、MiMo 官方文档 |
| `～` 与省略号折成逗号、去引号 | `笑死我了～～` → `笑死我了，` | SoulString-Dev（实测会让音高漂移 2–4 个半音并带来长尾静音） |
| 超长无标点片段补换气逗号，优先断在语气词后 | 每约 30 字补一个「，」 | Liccsu `_soft_break` |
| 句末补标点 | `你也太离谱了吧` → `你也太离谱了吧。` | Liccsu `_ensure_terminal` |

不认标签的服务商（豆包、OpenAI 兼容、GPT-SoVITS）会把所有括号段剔除，避免念出「括号叹气」。

### 服务商

| `provider` | 适合 | 音色一致性 | 情绪控制 | 备注 |
| --- | --- | --- | --- | --- |
| `mimo` | 想要最自然、可复刻、目前免费 | 预置音色天然一致；`cloneAudio` 用固定参考音频复刻；`voiceDesign` 只设计一次并缓存为参考音频 | 风格标签 + 句内音频标签 + 自然语言 `style` | MaiBot 生态当前最主流的后端（4 个独立插件） |
| `doubao` | 国内稳定、情感音色多 | 预置或复刻音色（`S_` 开头用 `seed-icl-2.0`） | `emotion` 映射到 V3 的 `audio_params.emotion` | 请求格式取自 ZhaoCang-QWQ/doubao-tts |
| `openai` | 已有 OpenAI / 硅基流动 / 本地 mlx-audio 等兼容端点 | 取决于 `voice` | 可选 `instructTemplate`，如 CosyVoice2 的 `用{emotion}的语气说<|endofprompt|>{text}` | 走 `/audio/speech` |
| `gptsovits` | 完全本地、想要特定角色声线 | 固定参考音频 | 按情绪切换参考音频（`refs.开心`、`refs.default`） | 需要自己跑 GPT-SoVITS api_v2 |

| `cosyvoice` | 想用百炼 CosyVoice 3.5 的可爱/情绪声线，不想本地跑模型 | 声音设计/复刻创建固定 `voiceId` | `instruction` 支持情绪、角色、方言等自然语言控制 | 远程 API，不占本机模型内存；Flash 0.8 元/万字符、Plus 1.5 元/万字符；只说话、不唱歌 |

关于 `voiceDesign`：MiMo 的音色设计模型每次调用都会重新生成声线，直接用它合成会让每条语音听起来像不同的人。所以这里第一次用 `voicedesign` 生成一段参考音频，存到 `data/tts/mimo-design-<hash>.wav`，之后一律走 `voiceclone` 复刻。这个「固定参考音频保证音色一致」的做法来自 SoulString-Dev 与 Ling-LA。MiMo 的风格指令放在 user 消息里（默认值见 `DEFAULT_MIMO_STYLE`），SoulString-Dev 实测这能把同一句话多次合成的音高离散度从 σ≈35 Hz 降到 σ≈6–14 Hz。

合成结果会做时长与体积校验，WAV 会裁掉首尾静音并加 8 ms 淡入淡出（阈值 -45 dBFS，两端各留 80 ms）。只对 408/425/429/5xx 重试一次，超时和 4xx 不重试（SoulString-Dev 的做法，避免把总耗时翻倍）。

发送时用 `base64://` 的 record 段：SnowLuma 常跑在 Docker 里，宿主机路径在容器内不可见；而合成音频是自己生成的，不存在「借发语音外泄本机文件」的风险。非 SILK 音频由网关自带的 ffmpeg 转成 QQ 的 SILK。

### 快速上手（以 MiMo 为例）

下面的每一步都可以直接在控制台「听懂语音 / 开口说话」分组里完成（填 Key、选音色、合成试听、试发到群、打开总开关），命令行写法供脚本化使用。

1. 在小米 MiMo 开放平台申请 API Key，写进环境变量（推荐，不进 `config.json`）：`export MIMO_API_KEY=sk-...`；也可以在控制台的 API Key 输入框里填写。
2. 先试听，确认音色满意（只合成、不发送，音频写到 `data/tts/last-preview.wav`；控制台的「合成试听」会直接在页面里播放）：

   ```bash
   curl -s -X POST http://127.0.0.1:3100/api/voice/speak \
     -H "x-console-token: $(cat packages/bridge/data/console-token)" \
     -H 'content-type: application/json' \
     -d '{"text":"（轻笑）你们又在聊什么呀","emotion":"俏皮","dryRun":true}'
   ```

   去掉 `dryRun` 并加上 `"target":"group:群号"`，就会真的发到白名单里的群（操作者通道不受 `speak.enabled` 限制，方便先调好音色再开放给 AI）。
3. 在 `config.json` 里打开：

   ```json
   "socialV2": {
     "speak": {
       "enabled": true,
       "provider": "mimo",
       "mimo": { "voice": "冰糖" },
       "autoConvert": { "enabled": true }
     }
   }
   ```

4. **重启 DSH**（MCP 工具清单在启动时读取，`qq_speak` 只在 `speak.enabled=true` 时注册），再重启桥接。

`GET /api/voice/io-status` 可以随时查看 ASR 模型是否加载、何时自动释放、TTS 服务商是否就绪、今日已合成字数；`POST /api/voice/asr {"action":"load"|"unload"}` 手动加载 / 释放识别模型。

### CosyVoice 3.5（百炼远程 TTS）

1. 在[百炼控制台](https://bailian.console.aliyun.com/)用「声音设计」或「声音复刻」创建一个音色，拿到 `voiceId`；
2. 控制台「二代仿真 → 开口说话 → 服务商 百炼 CosyVoice 3.5」填业务空间 ID、API Key（或 `DASHSCOPE_API_KEY`）、`voiceId`；
3. `provider: "cosyvoice"` 时 `qq_speak` 调用百炼 HTTP API，不加载本地模型；`flash` 约 0.8 元/万字符，`plus` 约 1.5 元/万字符；
4. 它只负责说话，不支持 Seed-VC 那种唱歌。

没有本地 GPU 时，日常语音优先用这个；唱歌单独走 [SINGING.md](SINGING.md)。

### 配置（`socialV2.speak`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关（AI 通道） |
| `provider` | `cosyvoice` | `cosyvoice` / `mimo` / `doubao` / `openai` / `gptsovits` |
| `maxChars` | `80` | 单条语音最多念多少字（清洗后、不计标签与标点） |
| `maxSeconds` | `30` | 合成结果时长上限 |
| `maxPerMinute` / `maxPerHour` | `2` / `20` | 每个会话的语音限流（与文字限流、语音库限流分开计数） |
| `dailyCharBudget` | `0` | 每日合成字数上限，0 为不限；按量计费的服务商用它兜底成本 |
| `allowEmotion` | `true` | 是否接受 `emotion` 参数 |
| `autoConvert.enabled` | `false` | 随机短句转语音 |
| `autoConvert.probability` | `0.05` | 普通情况下的概率 |
| `autoConvert.mirrorProbability` | `0.35` | 对方 `mirrorWindowMs`（10 分钟）内发过语音时的概率 |
| `autoConvert.minChars` / `maxChars` | `2` / `40` | 只有这个长度区间的短句才会被转 |
| `autoConvert.cooldownMs` | `180000` | 同一会话两次随机语音的最小间隔 |
| `autoConvert.privateOnly` | `false` | 只在私聊里随机转语音 |
| `autoConvert.timeoutMs` | `15000` | 随机转换的合成预算，超时就照常发文字 |
| `mimo.voice` | `冰糖` | 预置音色：冰糖、茉莉（女），苏打、白桦（男），Mia、Chloe、Milo、Dean（英文） |
| `mimo.cloneAudio` | `""` | 参考音频（mp3/wav，≤7 MB）。设置后改用 voiceclone |
| `mimo.voiceDesign` | `""` | 音色描述。设置后先设计一次、再一直复刻 |
| `mimo.styleInstruction` | 见代码 | 放在 user 消息里的默认风格指令 |
| `cosyvoice.workspaceId` / `region` | 空 / `cn-beijing` | 百炼业务空间 ID 与地域；也可直接填 `baseUrl` |
| `cosyvoice.apiKey` / `apiKeyEnv` | 空 / `DASHSCOPE_API_KEY` | 百炼 API Key；控制台读取时脱敏 |
| `cosyvoice.model` | `cosyvoice-v3.5-flash` | `flash` 或 `plus` |
| `cosyvoice.voiceId` | 空 | 在百炼控制台用声音设计/复刻创建的固定音色 ID |
| `cosyvoice.instruction` | 见代码 | 默认自然语言指令，例如可爱、活泼、撒娇；情绪会叠加 |
| `singing.*` | 见 [SINGING.md](SINGING.md) | 15–20 秒 Seed-VC 唱歌服务；默认关闭、用完退出、有 RSS/超时/可用内存守卫 |
| `singing.cover.*` | 见 [SHORT_COVER.md](SHORT_COVER.md) | 自然语言短翻唱：授权曲库/Jamendo、自动选段、Demucs 分离、Seed-VC、异步缓存 |
| `*.apiKeyEnv` | `MIMO_API_KEY` 等 | 从哪个环境变量读密钥；也可以写 `apiKey`，控制台读取配置时会脱敏 |

### 唱歌（MiMo 预置音色）

MiMo 的 `mimo-v2.5-tts` 预置音色支持唱歌：**必须在 assistant 文本最开头加 `(唱歌)` 标签**，例如 `(唱歌)一闪一闪亮晶晶，满天都是小星星。`。只把 `style` 写成「唱歌」不会触发唱歌，只会用唱歌的语气说话。

`qq_speak` / 操作者试听接口现在会把 `style: "唱歌"` 自动补成 `(唱歌)` 前缀；也可以直接在 text 里写 `(唱歌)`。限制：

- `mimo-v2.5-tts-voicedesign` / `mimo-v2.5-tts-voiceclone` 官方**不支持唱歌**；要唱歌必须用预置音色（`voiceDesign` 和 `cloneAudio` 置空）。如果配置了自定义音色又要求唱歌，桥接会明确报错，而不是静默降级。
- 只适合一两句歌词；受 `maxChars`（默认 80）与 `maxSeconds`（默认 30）限制，**整首歌不行**，复杂歌曲需要 MIDI/SVS/RVC 等单独的歌声合成流程。
- `(唱歌)` 标签是 MiMo 官方格式；标签标识 `唱歌` / `sing` / `singing` 等效。



## 三、安全边界

- 转写文本会进入模型上下文，所以会压掉换行和控制字符、限长 300 字，避免一条语音伪造出新的「【系统】」段落。
- 只下载 QQ 自己的媒体域名，并先过 `safe-fetch` 的私网 / 回环地址校验（防 SSRF）；`redirect: 'error'`。
- 实时消息里自己发的语音不转写（引用到的语音会转写，便于理解上下文）；`qq_speak` 的文本在合成前做与文字消息相同的敏感信息与会话令牌审计。
- `qq_speak` 路由与 `send-voice` 同一套闸门：agent 令牌、reserved2 模式、白名单、静默模式、工具开关。操作者试听接口 `/api/voice/speak` 不看 `speak.enabled`、不限会话，所以只要请求带 `x-agent-call` 或 `x-agent-token` 就直接 403，防止 AI 借操作者通道绕过总闸。
- 控制台专用的 `/api/voice/asr`（加载 / 释放）与 `/api/voice/preview-audio`（试听音频）同样在最前面拒绝任何 agent 调用。试听音频只返回最近一次试听合成的文件，不接受路径参数。
- `GET /api/socialV2/config` 与保存接口的回包都会把 `speak.*.apiKey` 脱敏为 `********`；控制台回写 `********` 时保留原密钥。

## 四、测试

```bash
npm run test-voice:io     # 39 项：文本整理、随机转换判断、WAV 裁剪、五个服务商的请求格式（假 fetch）、
                          #       重试与额度、ASR 降级与缓存、真实模型识别、按需加载 / 闲置释放 / 重新加载、
                          #       大功能开关、桥接接入与闸门、sent/verified 语义、保存回包脱敏、唱歌标签、CosyVoice HTTP、qq_sing 闸门
npm run test-singing      # Seed-VC 按需 worker：曲库、配置、峰值/内存守卫、混音与退出
npm run test:console-ui   # 控制台 UI（需要 Playwright）：含「听懂语音 / 开口说话」面板的回显、切换、
                          #       加载释放、试听试发与保存载荷
npm run test-voice        # 既有语音库测试（新增 toolFlags 含 speak 的断言）
npm run test:token        # 默认关闭时唤醒 prompt 一个字都不多
```

2026-10-24 在 Apple Silicon 上用真实 SnowLuma 网关做了只读端到端检查：白名单群历史里的 4 条真实语音全部正确转写，单条 0.7–1.0 s，并识别出「语气开心」「语气难过」。TTS 因为本机没有服务商密钥，只做了假 fetch 的协议级测试；配好密钥后请先用试听接口验证一次。

## 五、致谢与引用

语音策略主要学习自 MaiBot 生态的语音插件，其次是 AstrBot 核心。凡是 MIT 许可的项目，相关思路做了 JavaScript 移植并在源码注释里标明出处；AGPL / GPL 项目只参考设计、未复制代码。

| 项目 | 许可 | 借鉴了什么 | 在本项目的位置 |
| --- | --- | --- | --- |
| [Liccsu/maibot-mimotts-voice](https://github.com/Liccsu/maibot-mimotts-voice)（Emilia-awa/maibot-mimotts-voice 的分支） | MIT | 文本清洗、短括号保留为音频标签、风格标签归位、语气词优先断句、句末补标点；MiMo 请求格式；「LLM 主动调用」的工具描述写法 | `voice-tts.js` `prepareSpeechText`、`qq_speak` 描述 |
| [SoulString-Dev/maibot-mimo-voice](https://github.com/SoulString-Dev/maibot-mimo-voice) | MIT | 随机模式默认值（0.05、短句上限）；`～`/省略号/引号对音高的实测影响；风格指令放 user 稳定音高；固定参考音频保证音色一致；可重试状态码；空音频判定 | `autoConvert` 默认值、`DEFAULT_MIMO_STYLE`、`voiceDesign → voiceclone`、`trimWavSilence` |
| [Ling-LA/ling-tts-bot](https://github.com/Ling-LA/ling-tts-bot) | MIT | `llm_trigger` / `random` 双模式；参考音频裁首尾静音；代码、网址、表格保留文字 | `autoSpeakable` |
| [ZhaoCang-QWQ/doubao-tts](https://github.com/ZhaoCang-QWQ/doubao-tts) | MIT | 豆包 V3 单向流式请求格式与 NDJSON 解析；情感映射；「枚举交给模型、数值留给人」；失败降级文字 | `synthDoubao`、`emotion` 只给枚举 |
| [SengokuCola/aliyun-tts-plugin](https://github.com/SengokuCola/aliyun-tts-plugin)（MaiBot 核心作者） | MIT | 工具式调用、Markdown 过滤、长度上限 | 工具模式整体设计 |
| [xuqian13/tts_voice_plugin](https://github.com/xuqian13/tts_voice_plugin) | AGPL-3.0 | 多后端策略模式、概率门控默认关闭（仅参考设计） | `provider` 抽象 |
| [CGl123/gpt-sovits-voice-plugin](https://github.com/CGl123/gpt-sovits-voice-plugin) | AGPL-3.0 | 多风格各自参考音频、缺失回退 default（仅参考设计） | `gptsovits.refs` |
| [A-Dawn/A_TTS_Plugin](https://github.com/A-Dawn/A_TTS_Plugin) | GPL | 会话级开关、失败回退文字（仅参考设计） | 回退策略 |
| [DMJXMJ/maibot-sensevoice-stt](https://github.com/DMJXMJ/maibot-sensevoice-stt) | MIT | MaiBot 生态的本地 SenseVoice 识别 | ASR 选型 |
| [AstrBotDevs/AstrBot](https://github.com/AstrBotDevs/AstrBot) | AGPL-3.0 | 核心 `provider_tts_settings.trigger_probability` / `dual_output`；SenseVoice 自部署与情绪标签（仅参考设计） | 随机概率、ASR 情绪标注 |
| [Mai-with-u/MaiBot](https://github.com/Mai-with-u/MaiBot) 与 [插件中心](https://github.com/Mai-with-u/plugin-repo) | GPL-3.0 | 语音插件生态调研入口 | — |
| [FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice) | 模型许可见仓库 | 识别模型本体 | 默认 ASR |
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | Node 推理运行时与 int8 模型包 | `sherpa-onnx-node` |
| [silk-wasm](https://www.npmjs.com/package/silk-wasm) | MIT | SILK 解码（取音频第二级兜底） | `voice-asr.js` |
| [小米 MiMo 语音合成文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5) | — | 请求格式、预置音色、风格与音频标签词表 | `synthMimo`、`MIMO_STYLE_WORDS` |
| [SnowLuma `get_record`](https://snowluma.github.io/zh/docs/api/extended/get_record) | — | 网关侧 SILK → WAV 转码 | 取音频第一级 |
