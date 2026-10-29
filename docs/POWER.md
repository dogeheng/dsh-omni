# 电源与省电（离电策略）

> 目标：**插电时全部能力可用；离电时只放行你勾选的能力**，其余工具调用直接拒绝并告诉 AI
> 「省电模式关了」。核心聊天（收发文字、读消息、等待）永远可用，不受影响。

## 它解决什么，不解决什么

dsh-omni 的常驻开销主要来自三处：

| 开销 | 量级 | 处理方式 |
|---|---|---|
| Docker + SnowLuma（QQ 网关） | 常驻，唯一大头 | **不自动停**：离电也要保持 QQ 在线 |
| 本地重活（Seed-VC 唱歌、SenseVoice、本地 TTS） | 按需，峰值高 | 离电白名单默认关闭，调用期拒绝 |
| 额外 LLM 轮次（主动冒泡、工具试错） | 每次调用都算 | 离电暂停主动机会；`qq_get_prompt` 里提前告知禁用项 |

所以这份策略的定位是 **行为约束 + 防突发重活**，不是「把续航翻倍」的开关。真正省电的大头是
推理档位：离电在**进程内**把档位覆盖成 `low`，插电撤销覆盖。这一步不写 `config.json`：
拔插不会改你的用户配置，桥接崩溃也不会把档位永久留在 low。

## 三层模型

```
实际可用 = 用户手动开关（大功能开关 / 工具开关） AND (插电 ? 全放行 : 离电白名单)
```

- **插电 ≠ 打开一切**：插电只是「解除离电限制」，不会把你手动关掉的语音/表情重新打开。
- **核心能力永远放行**：`chat`（send-message / reply / wait / unread / mark-read …）。
- **检测失败一律放行**（fail-open）：读不到 `pmset`、状态文件过期、平台不支持，都按插电处理。
  省电是优化，不能因为一次采样失败把机器人锁死。

## 配置

`config.json`：

```json
"power": {
  "enabled": true,
  "pollMs": 15000,
  "debounceMs": 10000,
  "battery": {
    "allow": ["sticker", "memory"],
    "reasoningEffort": "low",
    "pauseProactive": true
  }
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关；关掉后一律全放行（不改别的配置） |
| `pollMs` | 采样间隔，5s–600s |
| `debounceMs` | 插拔去抖，0–300s；默认 10s，避免 PD 协商抖动导致反复切档 |
| `battery.allow` | 离电放行的能力 id；空数组会回退默认 `["sticker","memory"]` |
| `battery.reasoningEffort` | 离电自动切到的档位：`""`（不切）/ `low` / `high` / `max` |
| `battery.pauseProactive` | 离电暂停主动冒泡调度（不打断正在跑的回合） |

> `battery.reasoningEffort` 只覆盖**进程内**的生效值：拔电时 `modelSelectionEpoch + 1`，
> 会话在下一条消息重新 `selectModel`；插电时撤销覆盖。`config.json` 里的
> `dsh.reasoningEffort` 始终是你自己的设置，不会被电源事件改写。

### 能力 id

| id | 覆盖 |
|---|---|
| `voice` | `qq_send_voice` / `qq_list_voices` |
| `speak` | `qq_speak` |
| `asr` | 入站语音的本地 SenseVoice 转写（关闭后回退 QQ 自带转写） |
| `sing` | `qq_sing` / `sing_short_cover` |
| `images` | `qq_get_message_images` |
| `sticker` | 表情收藏、标注、发送 |
| `memory` | `qq_memory_*` |
| `webSearch` | `web_search` / `web_fetch` / 图片搜索（独立 MCP 进程读 `data/power-state.json`） |

## 控制台

「运行总览 → 电源与省电」：

- 显示当前电源、电量、采样时间；离电时标红。
- 勾选离电放行的能力；保存即生效（写回 `config.json` 的 `power` 段）。
- **模拟离电 / 模拟插电**：不用真的拔电就能验证闸门和提示词。
- 刷新电源状态：立刻重新采样一次。

## 状态文件

桥接每轮采样后原子写 `data/power-state.json`（0600）：

```json
{
  "source": "battery",
  "percent": 82,
  "charging": false,
  "lowPowerMode": false,
  "sampledAt": "2026-10-29T12:00:00.000Z",
  "committedAt": "2026-10-29T12:00:00.000Z",
  "simulated": false
}
```

独立进程（联网搜索 MCP）只读这个文件；读不到或 `committedAt` 超过 10 分钟就按「未知」放行。
桥接进程自己用内存状态，不读文件。

## 自动启服务（DSH 打开就绪）

`config.json`：

```json
"stack": {
  "autoStart": true,
  "docker": true,
  "container": "snowluma",
  "composeFile": "docker-compose.snowluma.yml",
  "dockerWaitMs": 120000
}
```

两层保障：

1. **DSH 插件 kick**：`dsh-omni-mode-console` 的 `apply()` 在 DSH 启动时（2.5s / 12s 各一次）
   detached 跑一遍 `scripts/ensure-bridge.mjs`。插件是符号链接安装时自动生效；复制安装找不到
   脚本就安静跳过（可用 `DSH_OMNI_ROOT` 指定仓库根，`DSH_OMNI_NODE` 指定 node 路径）。
2. **LaunchAgent 兜底**：`install-watchdog.mjs` 装的 LaunchAgent 每 20 秒跑同一个脚本，
   负责 Docker 启动、容器拉起、桥接跟随 DSH 端口。冷启动立即拉起；端口抖动要求连续两次
   探测一致，且两次重启间隔至少 90 秒。

`ensure-bridge.mjs` 的顺序：**Docker → 容器 → 桥接**。桥接健康时只补容器，不动桥接进程。

## 验证

```bash
# 单测（纯函数 + 状态机）
npm --prefix packages/bridge run test:power

# 控制台：模拟离电后调 qq_sing / qq_speak，应返回 code=POWER_SAVING
# 真拔电：等 20s 去抖，看 data/bridge.log 里的 [power] 电源变化
tail -f packages/bridge/data/bridge.log | grep '\[power\]'

# 自动拉起：退出 DSH 再打开，60 秒内 QQ 恢复
tail -f packages/bridge/data/watchdog.log
```

## 已知边界

- 只实现了 macOS 的 `pmset` 采样；Linux/Windows 会得到 `unknown` → 全放行，不会误伤。
- B 站 MCP（`bili_video_info` / `bili_subtitle`）是独立 Python 服务，当前不在闸门内。
- 拒答是**调用期**判定，不需要重启 DSH；MCP 工具列表在进程启动时就固定了。
