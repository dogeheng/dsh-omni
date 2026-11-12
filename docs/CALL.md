# 打电话（通话回路）

> 状态：**能听、能想、能说**，支持语义判停、打断（取消在途推理）、一对一/群语音自动接听；屏幕共享还没接。
> 这就是 `docs` 里说的方案 B 的 B-2 阶段。

QQ 的通话走的是 NTRTC（AVSDK），OneBot 没有实时媒体通道，所以这条路不是"扩展协议"，
而是**让容器里那个真 QQ 自己接电话**，我们再从它的音频设备上把声音接出来。

## 它长什么样

```
容器 QQ ──播放──▶ qq_out ──monitor──▶ parec ──▶ VAD ──▶ SenseVoice ──▶ DSH 会话
                                                                          │
容器 QQ ◀──录音── qq_in ◀──FIFO── cat ◀── 48k PCM ◀── ffmpeg ◀── CosyVoice ◀┘
```

- `qq_out` 是我们建的虚拟扬声器：QQ 把对方的声音播到这里，我们抓它的 monitor。
- `qq_in` 是虚拟麦克风：我们往里面写 PCM，QQ 就当成"大肥鱼在说话"发出去。

## 前提

1. **容器音频就绪**（一次性；镜像重建后要重做）

   ```bash
   docker cp packages/bridge/scripts/call-audio snowluma:/b0
   docker exec snowluma sh /b0/01-setup.sh     # 装 PulseAudio
   docker exec snowluma sh /b0/02-start-pa.sh  # 起 PA + 建虚拟设备
   docker exec snowluma sh /b0/03-selftest.sh  # 两行 mean_volume 都不能是 -91
   ```

   细节和排障见 [scripts/call-audio/README.md](../packages/bridge/scripts/call-audio/README.md)。

2. **DSH 在跑**，`config.json` 的 `dsh.baseUrl` 可达（bridge 平时就在用它）。
3. **TTS 配好了**（`socialV2.speak`）。默认用 CosyVoice，音色跟 QQ 里发语音是同一个。

## 跑

```bash
cd packages/bridge

# 自测：不碰容器、不用打电话，用仓库自带的 zh.wav 走一遍整条链
npm run test:call

# 真跑：接容器 + 真通话
node scripts/call-loop.mjs
```

然后手机给她打**语音**电话，在 VNC（`http://127.0.0.1:6081`）里手动点接听。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--container snowluma` | 容器名 |
| `--device qq_out.monitor` | 抓哪个设备 |
| `--preset qq-chat-v2` | 挂她的 QQ preset（会带来 QQ 工具，通话中她可能想发消息） |
| `--mic-noise 40` | 麦克风在没人说话时的本底噪声幅度（见下文） |
| `--no-tts` | 只识别和思考，不说话 |
| `--from-wav a.wav --out-wav out.raw --once` | 离线自测，不碰容器 |
| `--max-seconds 60` | 到点自动收尾 |

## 为什么早先每句开头会听不清

第一版跑真电话时，对方反馈「她回话的前几个字听不清，后面才逐渐清楚」。查下来是两个 bug，都不是"缺功能"：

**① 麦克风是断续的。** 旧实现只在要说话时写一段，两段话之间管道是空的。QQ 的采集链
（`rnnoise.so` 降噪 + AEC + AGC）在长时间没数据后要重新热身，每句开头半秒就被吃掉。
现在改成**常开的 20ms 帧泵**：没话说就写本底噪声，声音一直连续，采集链不用热身。

**② 管道会在没人听的时候囤数据。** PulseAudio 的 `pipe-source` 在没有录音者时会把
写进去的东西攒着。实测攒到 **5.5 秒**——等于她的话整体晚 5.5 秒才到。现在麦克风
只在检测到 QQ 真的在录 `qq_in` 时才开泵（每 3 秒查一次 `pactl list short source-outputs`），
并口从来没有积压。

如果重测后开头还是丢，那是 QQ 侧的 AGC/降噪在压轻声起头，可以试试换本底噪声：

```bash
node scripts/call-loop.mjs --mic-noise 0      # 纯数字静音
node scripts/call-loop.mjs --mic-noise 150    # 更明显的房间噪声
```

（幅度 0 会让降噪/AGC 把它当"完全安静"；太大又会盖住轻声。默认 40 是折中。）

## 进程清理

`docker exec` 的客户端被杀，**容器里的 `parec` 不会跟着退**。所以两个子进程都写了 pid 文件
（`/tmp/call-capture.pid`、`/tmp/call-mic.pid`），退出时按 pid 补一刀。
早先测试留下的 3 个孤儿 `parec` 就是这么来的，如果发现残留：

```bash
docker exec snowluma pkill -f '[p]arec --device=qq_out.monitor'
```

## 实测延迟（Apple M5，本机 CosyVoice）

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| VAD 收尾 | 0.30 s | 要等你停嘴，不能更短 |
| SenseVoice 识别（已加载） | 0.09–0.12 s | 本地 |
| DSH 一轮回复 | 1.2–2.6 s | 模型本身 |
| CosyVoice 首句 | 2.2 s（已预热） | 服务端首包，波动很大 |
| **说完到听见她开口** | **约 4 s** | 上面三项相加 |

两处已经压过：

- **按句流水线**：回复切成短句，第一句好了就开口，第二句在她念第一句的时候合成。
  早先要等整段合成完（2 句 ~4–5 s）才出声。
- **预热**：CosyVoice 的第一发请求要多花 ~2 s（建连 + 服务端冷启动），
  所以在通话开始和每句话开口时先打一发空的，把连接焐热（60 秒最多一次）。

再往下压得动的地方只有两个，都要另开工程：
换本地 TTS（GPT-SoVITS，首包可到 0.2–0.5 s）或换掉整条链路用语音直通模型。

## 自动接听

在**控制台**「通话（自动接听 · 只接指定的人）」里设置，存进 `config.json` 的 `call`：

| 字段 | 含义 |
| --- | --- |
| `autoAnswer` | 自动接听开关 |
| `allow` | 只接这些 QQ 号的好友来电 |
| `allowGroups` | 只接这些群号的**群语音**（OCR 邀请文案里的群名，再用 OneBot `get_group_list` 反查） |
| | 两个 `allow*` 都留空 = **谁都不接**（fail-closed） |
| `allowNames` | 额外允许的名字（匹配窗口标题），一般不用填 |
| `acceptX` / `acceptY` | 接听按钮坐标（窗口内）；**留空用实测默认值** |

改完要**重启 call-loop** 才生效（它启动时读一次配置）。

### 认人：头像比对

QQ 是 Electron，来电窗口没有可读的控件树，OneBot 也没有来电事件。唯一可靠的做法是看画出来的头像：

1. 来电时先给窗口截一张图（`ffmpeg -f x11grab`）
2. 按固定几何裁出浮层里的头像：**直径 116px，圆心在窗口中心上方 129px**
3. 缩成 32×32 灰度，和白名单里每个 QQ 号的头像（`https://q1.qlogo.cn/g?b=qq&nk=<qq>&s=640`，缓存 7 天）算**相关系数**
4. 超过 `0.6` 才接，否则不接并记一行日志

实测：本人截图 800×600 → 头像相关性 **1.000**；拿一个不相干的号当白名单 → **0.043**。区分度足够大。

**群语音**不能只靠头像：浮层显示的是**发起人头像**（比如「隐蔽猎手miku」）+「邀请您加入“群名”的语音通话」，
不是群头像，所以头像相关性会是负数。现在的顺序是：

1. 先按一对一的头像比对；命中就接；
2. 没命中就裁浮层中间文案，用 macOS Vision OCR 读出「邀请您加入“…”的语音通话」里的群名；
3. 用 OneBot `get_group_list` 把群名反查成群号，只有命中 `allowGroups` 才接；
4. 群语音的接听按钮比一对一更靠下，用 `call.groupGeometry`（默认 y +238，而不是 +186）。

OCR helper 是 `scripts/ocr.swift`：首次使用 `swiftc -O` 编译到 `data/bin/qq-ocr`；call-loop 启动时
`warmOcr()` 会预热（Vision 首次冷启动约十几秒，之后单次约 0.2s）。没有 Xcode CLT / OCR 失败时，
群语音自动接听会降级为「不接」，一对一头像接听不受影响。

用真实群邀请截图验证过：800×600 浮层能正确识别群 973614217；点击坐标按这张截图实测。真正的群通话
建议再验一次（QQ 换 UI 后需要重新标定 `call.groupGeometry`）。

顺带也会用窗口标题匹配一次昵称/备注，但**别指望它**：QQ 的昵称里繁简用字、特殊符号、长度都会飘（实测备注写的是「doge.恆」，来电浮层里显示「doge.恒」）。

### 几何（800×600 实测）

| 元素 | 位置 |
| --- | --- |
| 来电浮层头像 | 直径 116，圆心 = 窗口中心 +(0, −129) |
| 接听按钮（一对一） | 圆心 = 窗口中心 +(−68, +186) |
| 挂断按钮（一对一） | 圆心 = 窗口中心 +(+65, +187) |
| 群语音头像 | 直径 116，圆心 = 窗口中心 +(0, −83)（仅用于截图，识别走 OCR） |
| 群语音接听按钮 | 圆心 = 窗口中心 +(−65, +238) |

**全部按窗口中心算**，所以窗口被拖到哪都不影响；窗口大小变了，浮层也还是居中。

### 标定 / 诊断

```bash
# 拿一张已经截好的来电图，跑一遍认人（不需要打电话）
node scripts/call-loop.mjs --identify-shot shot.png --identify-size 800x600

# 学习模式：只截图不点，连拍三帧
node scripts/call-loop.mjs --auto-answer learn

# 自检：不打电话，走一遍"发现新窗口 → 截图"
node scripts/call-loop.mjs --auto-answer learn --simulate-call
```

### 挂断后的回收

- 通话结束（QQ 不再录 `qq_in`）→ 立刻 `kill` 识别子进程，**855MB 归还系统**；
  麦克风停泵并清空未播音频。
- 下次通话接通时（QQ 开始录音）→ 提前把识别进程拉起来（约 0.6 秒），不占用户的首句延迟。
- call-loop 启动时先扫一遍 `/tmp/call-capture.pid`、`/tmp/call-mic.pid`：
  上一轮要是被 `kill -9` 强杀，容器里可能留着 `parec` / `cat`，这里一并清掉。

### 风险，必须知道

- 任何新弹出的大窗口都会被当成来电候选；头像对不上就不点，答完 20 秒冷却。
- 头像换成新图后，缓存要 7 天才刷新；想立刻生效，删掉 `data/call-avatars/<qq>.raw`。
- 别配合 `--preset` 用：那等于把工具给来电的人。

## 语义端点检测（Smart Turn v3）

只靠 VAD 的 450ms 静音判“说完了”，中文思考中的停顿很容易被当成句尾：你说「你要记下我这周要去上海」，停一下想改口，她已经开始处理了。现在默认再加一层语义判停：

- 模型：[Pipecat Smart Turn v3.2](https://github.com/pipecat-ai/smart-turn)，Whisper Tiny 骨干 + 线性分类头，int8 ONNX 约 8 MB，支持 23 种语言（含中文）；
- 只在 VAD 判出静音后跑一次，CPU 约 10–30ms；输出「这一轮说完了」的概率；
- 概率 ≥ `threshold` → 立即提交给 DSH；
- 概率 < `threshold` → 不提交，等 `continuationWindowMs`（默认 1.2s）看有没有下文；有就把 ASR 文本和音频拼起来重新判，没有就按超时提交；
- 连续拼接最多到 `maxWaitMs`（默认 2.5s），避免用户一直说、她一直不答。

实测（`zh.wav` 切成两段）：

```text
vad  一句话 1.68s
asr  「开放时间早。」
turn Smart Turn 0.46（阈值 0.5）→ 这句还没完，等 1200ms
asr  「早上9点至下午5点。」
turn Smart Turn 0.99 → 提交累积的一句（16 字）
```

如果只看句末标点，第一段「开放时间早。」带句号，会被误判成完整；语义模型把它拦下来了。

**安装**：

```bash
cd packages/bridge
npm run setup:turn          # 建 .turn-venv + 装 onnxruntime/numpy/transformers + 下模型
node scripts/setup-turn.mjs --status
```

**配置**（`config.json` 的 `call.turnDetection`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `smart` | `smart` / `punctuation` / `vad` |
| `threshold` | `0.5` | 完成概率阈值；误判多就调高，反应慢就调低 |
| `continuationWindowMs` | `1200` | 判为“没说完”后等下文的时间 |
| `maxWaitMs` | `2500` | 连续拼接的上限 |
| `pythonPath` | `.turn-venv/bin/python` | 可选覆盖 |
| `modelPath` | `data/models/smart-turn/smart-turn-v3.2-cpu.onnx` | 可选覆盖 |

**降级**：`.turn-venv` 或模型缺失时自动回退 `punctuation`（句末标点 + “但是/然后/因为…”等连接词）；模型运行失败也会回退并打日志，不会让通话哑掉。想完全回到旧行为，设 `mode: "vad"`。

模型是音频模型，不是万能的：口音、背景噪声、极短句仍可能判错；阈值和等待窗口都可以按体感调。

## 打断（barge-in）

她说话或思考时你开口，现在按这个顺序处理：

1. `speechEpoch++`，`mic.flush()` 丢掉还没播出去的音频；
2. `brain.cancelCurrentTurn()` → DSH `session/cancel`，把在途回合标成 `aborted`，不再等它生成完；
3. 记录已经说出口的文本（`lastSpokenText`），下一轮 prompt 里告诉模型「你只说到……，后面的没有生效」；
4. 如果打断发生在「还在生成、还没开口」阶段，下一轮提示「上一句没有说出口」。

实测：取消后 DSH 不会把半截 assistant 文本写进下一轮上下文（数数被打断后问「刚才数到几」，回答「不知道」）。这比只掐本地音频少烧一次完整 turn，也不会让模型误以为说过没说过的话。

**限制**：如果回复已经生成完、正在播放时被打断，DSH 历史里仍是完整回复（append-only）。我们只能用「你说出口的只有……」在 prompt 里校正，没法像 OpenAI Realtime 的 `conversation.item.truncate` 那样直接改历史。要做到逐字精确，需要 DSH 提供历史截断，或者在打断时用「实际听到的 transcript」重建会话。

通话会话没有 QQ 的会话令牌，`qq_memory_*`、`qq_send_*` 这类工具本来就会失败；电话模式的 prompt 也明确要求不要调用它们，避免把半截话写成长期记忆。

**还没做的调优**：目前 VAD 一检测到开口就打断，允许「嗯/对」这类 backchannel 误触发。LiveKit 的 `interruption.min_duration` / `min_words`、Pipecat 的 `MinWordsUserTurnStartStrategy` 和 Vocode 的 `interrupt_sensitivity` 都是可借鉴的做法；需要先加一个短语音分类，避免 200ms 的「嗯」也把她掐掉。

参考（成熟方案怎么处理同一件事）：

- [Pipecat Interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)：`InterruptionFrame` 取消 LLM/TTS、清空未播音频，并且**只把真正播放出来的文字写进上下文**；支持取消函数调用。
- [LiveKit turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning)：`interruption.mode=adaptive`、`min_duration`、`min_words`、false-interruption timeout + resume。
- [pydantic-ai #8757](https://github.com/pydantic/pydantic-ai/pull/8757)：专门修「回复已经生成完、用户才打断」的情况，用 `conversation.item.truncate` 截断 provider 侧的历史。
- [Vocode conversational dials](https://docs.vocode.dev/conversational-dials)：`interrupt_sensitivity` 区分 low/high，low 会忽略「嗯/好」这类 backchannel。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 打断是"粗暴"的 | 一开口就停止播放并取消在途回合；回复若已生成完、正在播放，DSH 历史仍是完整回复，只能用 prompt 校正（append-only） |
| 没有回声消除 | 你外放时她的话会被你的麦克风收进去，QQ 侧有 AEC 但不一定够；戴耳机 |
| 默认挂 preset | `config.call.preset` 默认 `qq-chat-v2`；人格由 `roles/<当前角色>.md` 首句注入。通话里没有会话令牌，QQ 工具会失败，prompt 要求不要调用 |
| 自动接听 | 一对一：白名单 + 头像比对；群语音：邀请文案 OCR + 群名反查，接听坐标在 `call.geometry` / `call.groupGeometry`；对不上就 fail-closed |
| 屏幕共享没有 | 见 `docs` 里的 B-4 |
| 容器重建 | PA/虚拟设备由 `call-loop` 自动补；`/b0` 的包丢了要重跑 01 |

## 常驻（不用手动开脚本）

```bash
npm run install:call     # 装成 LaunchAgent：登录自启、挂了自起
npm run uninstall:call   # 卸载
tail -f data/call-loop.log
```

常驻的只是那个几十 MB 的看门进程；识别、TTS、麦克风泵仍然是**按需拉起、挂断回收**。
同一时刻只允许一个实例（`data/call-loop.lock`），手动再起一个会被拒绝并提示先停守护进程。
DSH 重启换了端口会连不上——loop 会自己退出，LaunchAgent 15 秒后带着新配置重起。

## 迁移到另一台机器

**能迁，但不是复制粘贴就完事。** 分成「代码」和「环境」两块：

| 部分 | 怎么迁 |
| --- | --- |
| 代码 | `git clone` + `npm --prefix packages/bridge install` |
| 容器音频 | `scripts/call-audio/` 三个脚本在新容器里跑一遍（装 PulseAudio + 虚拟设备 + 自检） |
| QQ 登录 | **不能迁**：容器里的登录态跟设备绑定，新机器要重新扫码 |
| 配置 | `config.json` 里的 `dsh.baseUrl`、`snowluma`、`speak`（TTS 密钥）、`call`（白名单） |
| 宿主依赖 | `docker` CLI、`ffmpeg`、Node ≥ 22；容器里 `xdotool`、`ffmpeg` |

**写死的只有这些，而且都给了出口：**

| 项 | 出口 |
| --- | --- |
| 容器名 `snowluma` | `--container` |
| 设备名 `qq_out.monitor`、FIFO `/tmp/qqin.pcm` | `--device` / `--fifo` |
| 浮层几何（头像 116px、接听按钮偏移） | `config.json` 的 `call.geometry` / `call.groupGeometry`，QQ 换界面时改这里，不用改代码 |
| 采样率 48k / 16k | 跟 PulseAudio 设备一致，换设备时改 `02-start-pa.sh` 与 `--device` |

**做不到「换机零改动」的地方，说清楚：**

1. 浮层几何是对着**这一个 QQ 版本**量的（3.2.32）。QQ 换 UI 就要重新标定一次。
2. 认人靠头像；换号、换头像要清 `data/call-avatars/` 缓存。
3. 群语音浮层已按真实截图加了 OCR 识别（发起人头像 + 群名文案），但**真群通话的点击还要再验一次**；QQ 换 UI 后重新标定 `call.groupGeometry`。
4. 宿主的环境变量在 LaunchAgent 里是干净的，`PATH` 由安装脚本按当前机器的
   `docker` / `ffmpeg` 位置写进 plist；换机器要重跑 `npm run install:call`。

## 排障

- `parec 退出`：容器里没有 PA，或者设备名不对 → `docker exec snowluma pactl list short sources`
- `注入进程退出`：`qq_in` 没建起来，或者没有读者（通话外写 FIFO 会阻塞）→ 先跑 02
- 她能听见但没声音：看 `tts` 那行有没有报错，服务商 key 在 `socialV2.speak`
- 等回复超时：DSH 侧没回事件。检查 `dsh.baseUrl`，以及会话有没有被 follow（日志里应该有 `会话 session-…`）
