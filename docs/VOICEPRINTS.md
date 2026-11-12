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
