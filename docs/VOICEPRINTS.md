# 声纹认人（Voiceprints）

> 目标：把“声音 → 人”存在本地，让群语音/一对一通话从 `[说话人N]` 升级到 `[张三]`。
> 是 one-shot / few-shot，不是“只给名字就能认”的 zero-shot；模型不需要训练。

## 1. 文件在哪里

```text
data/voiceprints/
├── qq_12345678.json
├── name_ab12cd34ef56.json
└── samples/
    ├── qq_12345678.wav
    └── name_ab12cd34ef56.wav
```

- `qq_<QQ>.json`：知道 QQ 的声纹；
- `name_<hash>.json`：只知道名字、暂时不知道 QQ；
- `samples/<id>.wav`：注册时截的 5 秒试听样本，供控制台试听；
- 目录 `0700`、文件 `0600`；只在本机，不上传、不写 memory DB。

一条记录：

```json
{
  "id": "qq_12345678",
  "name": "张三",
  "qq": "12345678",
  "centroid": [192 维向量],
  "samples": 1,
  "source": "manual | call",
  "sampleRate": 16000,
  "createdAt": 0,
  "updatedAt": 0
}
```

## 2. CLI

```bash
cd packages/bridge

# 注册（3–5 秒干净语音最稳；支持任意 ffmpeg 能读的格式）
node scripts/voiceprints.mjs enroll --name 张三 --audio ./zhangsan.wav --qq 12345678

# 只用名字、不知道 QQ
node scripts/voiceprints.mjs enroll --name 张三 --audio ./zhangsan.wav

# 列表 / 重命名 / 删除
node scripts/voiceprints.mjs list
node scripts/voiceprints.mjs rename --id qq_12345678 --name 张三丰
node scripts/voiceprints.mjs remove --id qq_12345678
```

或者 `npm run voiceprints -- list`。

- 同 QQ / 同名再次 enroll 会做加权平均（few-shot），不会无限新增；
- 删除会同时删 JSON 和试听 WAV；
- `--dir` 可指定临时目录（测试/迁移用），默认 `data/voiceprints`。

## 2.5 已接入：说话人标签

- call-loop 在**通话接通**时读取 `data/voiceprints/`（不在启动/空闲时加载）；
- 每个 cluster 的 centroid 与声纹库匹配，命中后 `SpeakerTracker` 直接返回 `name`；
- prompt 里会从 `[说话人2]` 变成 `[张三]`；一对一通话只有一个人时，命中声纹也会直接标名字；
- 未命中保持 `[说话人N]`，短片段不会硬认；
- 配置：

```jsonc
"call": {
  "voiceprints": {
    "enabled": true,
    "threshold": 0.72,
    "margin": 0.05
  }
}
```

- `threshold`：cosine 下限；`margin`：best 与 second 的最小差距；
- 声纹库为空时行为与之前的匿名模式完全一样。

## 3. 匹配

- 每个 diarization cluster 的 centroid 与声纹库做 cosine；
- 默认阈值 `0.72`，且要求 `best - second_best ≥ 0.05`；
- 命中才输出 `[张三]`；否则保持 `[说话人N]`；
- 匹配只在**通话接通时**把 JSON 读进内存，挂断释放；不打电话不加载。

阈值/间隔在 `src/voiceprints.js` 的 `VOICEPRINT_MATCH_DEFAULTS`，后续会暴露到控制台。

## 3.5 通话内 one-shot 注册

在通话里说明确句式，Yuki 会把**上一个说话人**的 cluster 和那段音频绑定：


```text
刚才说话的是张三
说话人2是李四
S3是王五
记一下，说话人2是李四
记住我的声线          # 仅一对一：把当前说话人注册成主人
```

流程：

1. call-loop 保留最近 8 段说话人音频（每段最多 5s）；
2. ASR 命中控制句 → 取上一个 speaker cluster（或指定 `说话人N`）；
3. 用该 cluster 的 centroid + 那段音频 POST `/api/call/voiceprint/enroll`；
4. 写入 `data/voiceprints/` 并立即 `setName`，本次通话后续标 `[张三]`；
5. Yuki 用语音确认“记住了，刚才说话的是张三”；
6. 这句话本身不进 brain、不写长期记忆。

注意：

- 只在明确句式下触发；疑问句（“刚才说话的是不是张三”“是谁”）不触发；
- 一对一里说“记住我的声线”会把当前说话人注册成主人（`ownerName`，默认“主人”）；
- 群通话没有 QQ 身份时，说“记住我的声线”只会提示改说“说话人N是X”，不会把匿名声音硬认成主人；
- 一对一通话里绑定会用主人 QQ（只有对方一个人）；
- 失败会语音提示，不会静默写错。

### API

`POST /api/call/voiceprint/enroll`（console token；call-loop 专用）：

```json
{
  "name": "张三",
  "qq": "12345678",
  "centroid": [192 维],
  "samplePcmBase64": "16k 单声道 s16le 的 base64（0.1–10s）",
  "source": "call"
}
```

## 3.6 挂断后写确认事实

通话内每成功绑定一次，call-loop 记一条 `callBindings`；挂断时 POST bridge `/api/call/summary`：

```json
{ "key": "group:973614217", "bindings": [{ "name": "张三", "qq": "12345678" }] }
```

bridge 用 `memory.remember` 写**身份事实**（不是原文、不是音频）：

```text
已确认声纹：张三（QQ 12345678）
```

- key 决定 scope：私聊 `owner_private`，群 `group`；
- `subjectKey=voiceprint:<name>`：同名再次确认会取代旧事实，不膨胀；
- 没有 QQ 时 subject 为空，只写群/私聊 scope 里的名字事实；
- 和 Phase 2 的逐句记忆独立：这里只写“声纹已确认”，不重复通话内容；
- 记忆关闭时接口返回 409，call-loop 只记日志，不影响通话。

测试：`npm run test:call-memory` 覆盖挂断绑定写 group scope 事实；`/api/call/summary` 实测写入后已删除。

## 3.7 控制台声纹库

设置页 →「声纹库（本地 · 一对一/群语音认人）」：

- **启用声纹匹配**、阈值、与第二名间隔；
- **刷新列表**：名字、QQ、样本数、来源、是否有试听；
- **试听**：播放注册时保存的 5 秒 WAV（`/api/voiceprints/sample`，控制台令牌鉴权）；
- **重命名**：只改显示名，ID 不变；
- **删除**：同时删 JSON 和试听 WAV；
- 「保存声纹参数并重启」会写 `call.voiceprints` 并重启 call-loop，正在通话会断开。

注册入口仍是 CLI 或通话内“刚才说话的是 X”；控制台不提供上传音频（避免误传/隐私扩散）。

## 4. 迁移与隐私

- 代码在 git；声纹 JSON/WAV 在 `data/`（被 gitignore），迁移时连同 `data/voiceprints/` 一起复制；
- 不依赖旧电脑绝对路径，ID 由 QQ/名字生成；
- 声纹是生物特征：默认只在本机、只用于本人群聊/私聊；支持逐条删除；
- 不要把 `data/voiceprints/` 提交到仓库或发给别人。

## 5. 测试

```bash
npm run test:voiceprints
```

覆盖：注册、WAV 样本、匹配、同 QQ few-shot 合并、重命名、删除、重名拒绝。
