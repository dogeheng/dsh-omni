# 全双工对话（现状与路线）

> 结论：**音频链路是全双工，对话逻辑还不是。** 现在实现了“软打断/边听边判断”的 turn manager，真全双工还需要流式 ASR + 流式 TTS + 流式输出。

## 1. 现在是什么

```text
连续采集 qq_out.monitor ── VAD ── 离线 ASR（整句） ── DSH 整轮 ── 非流式 TTS ── 播放
                                  ↑
                          用户开口：软打断/应声判断
```

- 收、发可以同时进行；
- 她说话时你开口，不再“一律立刻掐掉”：
  - 先让 ASR 听完这一小句；
  - 如果只是“嗯/对/好/收到”这类应声（≤1.4s），继续说完；
  - 如果是“等等/不是/你先听我说”这类真插话，才停止播放、取消当前推理；
- 关掉「边听边判断」就回到原来的“一开口立即打断”。

配置：

```jsonc
"call": {
  "fullDuplex": { "softBarge": true }
}
```

控制台：「通话」→「边听边判断（软打断）」。

测试：`npm run test:call-barge`（应声/真插话/时长边界）。

## 2. 还不是真全双工

| 层 | 现状 | 真全双工需要 |
|---|---|---|
| ASR | SenseVoice 离线，VAD 整句后识别 | 流式/partial ASR，边听边出字 |
| TTS | CosyVoice HTTP 同步、GPT-SoVITS `streaming_mode:false` | 流式 TTS，边生成边播 |
| LLM | `Brain.ask` 等 `turn/end` 才拿完整文本 | token/句子流式喂给 TTS |
| 轮次 | 软打断，仍是单 turn 活动 | 允许重叠、backchannel、ducking |

所以现在能“边听边判断应声”，但不能“她边说边继续生成/同时回应”。

## 3. 路线

1. **流式 ASR**：换/加 streaming 模型，partial + endpoint；保留现有 VAD/Smart Turn 作为兜底；
2. **流式 TTS**：先做句子级（已有分句，可改成生成一句合成一句），再做 token 级；
3. **流式 LLM→TTS**：消费 `assistant/chunk`，按句触发 TTS，不等 `turn/end`；
4. **turn manager**：应声不打断、真插话取消、回声/ducking、重叠说话策略；
5. **真机测试**：1:1 与群语音分别测打断/应声/回声。

第 1–3 项都需要换模型/服务接口，不能靠当前 call-loop 小改完成。

## 4. 实测发现（2026-11-14）

- DSH 的实时事件流（WebSocket）实测只下发 `assistant/message`，**没有 `assistant/chunk` 的 `text-delta`**；
- 因此“边生成边喂 TTS”在当前 API 上做不了；需要 DSH 暴露流式文本事件，或改用另一个支持流式输出的接口；
- 这次试过 collector 的 `onTextDelta`，真实通话日志没有触发，已回滚，不保留无效开关。
