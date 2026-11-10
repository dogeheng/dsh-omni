# call-audio：让容器里的 QQ 有麦克风和扬声器

> 配合 [docs/CALL.md](../../../docs/CALL.md) 使用。这些脚本在**容器里**执行。

容器里的 Linux QQ（3.2.32，带 `avsdk/libAVSDKPlugin.so`）本身支持语音通话，
但容器里**没有声卡**（`/dev/snd` 不存在），也缺 `libpulse-mainloop-glib.so.0`。
这里给它造两个 PulseAudio 虚拟设备：

| 设备 | 角色 |
| --- | --- |
| `qq_out`（null sink） | 她的话播到这里，我们抓 `qq_out.monitor` |
| `qq_in`（pipe source） | 我们写 PCM 进去，QQ 当麦克风发出去 |

## 跑

```bash
docker cp packages/bridge/scripts/call-audio snowluma:/b0

docker exec snowluma sh /b0/01-setup.sh     # 装包（唯一会改容器的步骤）
docker exec snowluma sh /b0/02-start-pa.sh  # 起 PA + 建设备 + 设默认
docker exec snowluma sh /b0/03-selftest.sh  # 管道自检，不碰 QQ
```

`03` 应该输出两行明显高于 −91 dB 的音量，例如：

```
cap-out: 306180 bytes  mean_volume: -23.3 dB  max_volume: -18.1 dB
cap-in : 288000 bytes  mean_volume: -21.1 dB  max_volume: -18.1 dB
```

## 通话中看状态

```bash
docker exec snowluma sh /b0/06-watch.sh 2    # 盯着看有没有流接上来
docker exec snowluma sh /b0/05-call-check.sh 10   # 抓 10 秒对方的声音
```

`06` 在来电瞬间应该看到 `sink-inputs` 从 0 变 1（铃声），接听后变成 2 个左右。

## 让对面听到一句测试语音

```bash
./scripts/call-audio/04-gen-voice.sh "喂，能听见吗？我试一下声音。"
```

用 macOS 自带的 `say`（不是 CosyVoice）合成，灌进 `qq_in`。
注意：**通话外**写 FIFO 会阻塞（没人录音时 pipe-source 会挂起），脚本会先起一个临时录音流。

## 已知行为

- QQ 是**来电时**才枚举音频设备，不是启动时。所以 PA 晚于 QQ 起来没关系，不用重启容器。
- 容器重启后 PA 就没了，重跑 `02` 即可（包还在）；镜像重建则要从 `01` 重来。
- `03` 里第一段抓包如果太短会显示 −91 dB——那是一次性脚本的时序问题，已经用 3 秒测试音规避。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `sink-inputs` 一直空 | QQ 没连上 PA | 确认 `/etc/pulse/client.conf` 里的 `default-server`；重启容器后重跑 02 |
| 有流但抓不到 | QQ 播到了别的 sink | `pactl list sink-inputs` 看 `Sink:`，再 `pactl move-sink-input <id> qq_out` |
| 对面听不到 | QQ 没在录 `qq_in` | `pactl list source-outputs`，再 `pactl move-source-output <id> qq_in` |
| 都不行 | — | VNC 进 QQ 设置，手动把麦克风/扬声器选成 `qq_in` / `qq_out` |
| 依赖缺失 | — | `docker exec snowluma ldd /opt/QQ/resources/app/avsdk/libAVSDKPlugin.so \| grep "not found"` |

日志：`docker exec snowluma tail -40 /tmp/pa.log`
