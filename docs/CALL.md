# 打电话（通话回路）

> 状态：**能听、能想、能说**。打断、屏幕共享、人格 preset、自动接听都还没接。
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

## 打断

她说话时你只要开口，就：

1. 立刻清空还没播完的音频（`mic.flush()`）
2. 作废正在跑的那一轮——它算完也不念了（`speechEpoch` 不匹配）
3. 把你这句话当成新的一轮

判断依据是 VAD 的语音起点，所以**必须戴耳机或者让对方开免提时的回声别太强**，
否则你自己的扬声器里她的声音会被 VAD 当成"你开口了"，自己打断自己。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 打断是"粗暴"的 | 你一开口就立刻停止播放并作废在途那一轮；她不会说"好，你讲"再停 |
| 没有回声消除 | 你外放时她的话会被你的麦克风收进去，QQ 侧有 AEC 但不一定够；戴耳机 |
| 默认不挂 preset | 会话是空的 DSH agent，没有 QQ 工具、没有长期记忆；`--preset` 可开 |
| 自动接听没有 | 来电要人工在 VNC 里点接听 |
| 屏幕共享没有 | 见 `docs` 里的 B-4 |
| 容器重建要重做 | 包和 PA 都在容器里；重建后重跑 01/02 |

## 排障

- `parec 退出`：容器里没有 PA，或者设备名不对 → `docker exec snowluma pactl list short sources`
- `注入进程退出`：`qq_in` 没建起来，或者没有读者（通话外写 FIFO 会阻塞）→ 先跑 02
- 她能听见但没声音：看 `tts` 那行有没有报错，服务商 key 在 `socialV2.speak`
- 等回复超时：DSH 侧没回事件。检查 `dsh.baseUrl`，以及会话有没有被 follow（日志里应该有 `会话 session-…`）
