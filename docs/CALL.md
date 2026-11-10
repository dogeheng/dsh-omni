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
| `--no-tts` | 只识别和思考，不说话 |
| `--from-wav a.wav --out-wav out.raw --once` | 离线自测，不碰容器 |
| `--max-seconds 60` | 到点自动收尾 |

## 实测延迟（Apple M5，本机 CosyVoice）

| 阶段 | 耗时 |
| --- | --- |
| SenseVoice 识别（已加载） | 85–115 ms |
| DSH 一轮回复 | 1.4–2.6 s |
| CosyVoice 合成 | 2.2–4.0 s |
| **说完到听见她开口** | **4.0–6.3 s** |

合成占了小一半。下一步把 TTS 按句流式化能压到 2 s 上下——现在是一整段合成完才发。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 没有打断 | 她说话时你插话，要等这句放完才处理；下一版做半双工闸门 |
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
