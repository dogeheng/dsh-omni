# 长期记忆（Long-term Memory）

> 给同一个 QQ 人格一条连续的命：换一天、换一个会话，它还是记得这些人、这些事、这些约定；
> 但 A 群的私事不会跑到 B 群，主人私聊的内容不会进群。

这套记忆系统是**加在桥接里的一个模块**，不改 DSH、不常驻新进程、不加载任何模型：

```
QQ 消息 ──► bridge.js（可信会话上下文）
              │
              ├─ Level 1  显式记忆   qq_memory_append(category=fact|…) ──┐
              ├─ Level 2  规则候选   appendSocialV2Message 里同步判断 ──┤
              └─ Level 3  批量提炼   （默认关闭，每日 ≤6 次 LLM）      │
                                                                      ▼
                                                        SQLite（data/memory/memory.sqlite）
                                                        ├─ memories + FTS5(中文双字)
                                                        ├─ people（QQ 号 = 身份）
                                                        ├─ candidates（候选缓冲）
                                                        ├─ llm_budget（每日预算）
                                                        └─ migration_log（迁移账本）
                                                                      │
     唤醒/投递提示词 ◄── 按轮判断「要不要查、查几条」── 检索 + 排序 + Token 裁剪（≤350）
```

设计取舍（和任务书一一对应）：

| 约束 | 做法 |
|---|---|
| 不新增常驻服务/数据库服务器 | Node 自带 `node:sqlite`（本机 Node 24.16 / SQLite 3.53，WAL + FTS5 可用） |
| 不常驻 Embedding | 第一版只有 FTS5 + 结构化索引；`embeddingEnabled` 配置项会被明确忽略 |
| 普通聊天不加 LLM 调用 | 写入靠规则候选；自动提炼默认关闭，且与巩固共用每日预算 |
| 平均 ≤150 tokens / 硬上限 350 | 分档预算 + 渲染时逐行试算 + `maxTokens` 代码钳制 |
| 新增 RAM <50MB | 单连接、prepared statement 缓存、32 条结果 LRU、指标环形缓冲；不把库读进内存 |
| 不破坏 QQ/TTS/翻唱 | 记忆只在 `reserved2` 的提示词尾部追加一段；异常一律降级为"无记忆聊天" |

---

## 1. 代码地图

| 文件 | 职责 |
|---|---|
| `src/memory/config.js` | 配置归一化与硬上限钳制（单轮 350 tokens、每日 6 次等） |
| `src/memory/text.js` | 中文双字分词、FTS 查询构造与转义、保守 Token 估算、去重归一、清洗 |
| `src/memory/scopes.js` | 6 种作用域与 ACL（纯函数 + SQL 过滤的单一实现） |
| `src/memory/store.js` | SQLite schema、CRUD、去重/取代/过期/删除、FTS 同步、候选、预算、备份 |
| `src/memory/retrieve.js` | 需求分档（要不要查）、打分排序、去重、渲染与 Token 裁剪 |
| `src/memory/capture.js` | Level 2 规则（计划/约定/边界/偏好/自我事实/事件/显式要求） |
| `src/memory/legacy.js` | `social-v2.json` → SQLite 迁移、备份、校验、回滚 |
| `src/memory/extract.js` | Level 3 批量提炼（计划/解析/应用）、本地巩固、每日预算 |
| `src/memory/manager.js` | 门面：懒加载、降级、指标、LRU、Session 退役、运维入口 |
| `scripts/memory-admin.mjs` | 运维 CLI：`status/migrate/verify/rollback/backup/forget` |
| `scripts/memory-bench.mjs` | 性能/内存实测（临时库，可重复） |
| `scripts/test-memory.mjs` | 存储/ACL/检索/预算/迁移/注入的单测与实测 |
| `scripts/test-memory-bridge.mjs` | 跑真实 `bridge.js`（VM + 假 DSH/QQ）的接线测试 |

桥接里的接触点只有 5 处（都带 try/catch）：

1. `loadConfig()` → `memory: normalizeMemoryConfig(...)`；
2. `main()` 里创建 `createMemoryManager`（懒打开 SQLite）；
3. `deliverPromptNow()` 投递前按轮注入（`memoryPromptBlockV2`）；
4. `appendSocialV2Message()` 里的规则候选捕获；
5. `retireIdleSessionV2()` 里把会话内状态提升到群/私聊作用域。

---

## 2. 数据模型

### 2.1 `memories`（核心表）

```sql
CREATE TABLE memories (
  id                  INTEGER PRIMARY KEY,
  persona_id          TEXT NOT NULL,       -- 人格命名空间（默认 default）
  scope               TEXT NOT NULL,       -- self_public / owner_private / person_shared / group / dm / session
  scope_key           TEXT NOT NULL DEFAULT '',  -- 群号 / 对方 QQ / 会话 key
  kind                TEXT NOT NULL,       -- fact / preference / impression / episode / promise / state
  subject_id          TEXT,                -- 人物稳定身份 = QQ 号（可为空 = 身份未确认）
  subject_label       TEXT,                -- 展示用昵称（只是别名）
  content             TEXT NOT NULL,
  grams               TEXT NOT NULL,       -- 中文双字 token（检索用，不是原文副本）
  source_message_id   TEXT,
  source_conversation TEXT,
  origin              TEXT NOT NULL DEFAULT 'explicit', -- explicit/candidate/extraction/legacy:social-v2/system
  confidence          REAL NOT NULL DEFAULT 0.8,
  status              TEXT NOT NULL DEFAULT 'active',   -- active/superseded/expired
  dedupe_key          TEXT NOT NULL,
  subject_key         TEXT,                -- 事实主题键：同键新事实会取代旧记录
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  valid_from          INTEGER,
  valid_until         INTEGER,
  expires_at          INTEGER,
  superseded_by       INTEGER,
  raw_json            TEXT                 -- 来源元数据（迁移类别、旧时间、是否身份未解析…）
);
CREATE UNIQUE INDEX memories_dedupe_active ON memories(dedupe_key) WHERE status='active';
CREATE INDEX memories_scope_idx  ON memories(persona_id, scope, scope_key, status);
CREATE INDEX memories_subject_idx ON memories(persona_id, subject_id, status, updated_at DESC);
CREATE INDEX memories_subject_key_idx ON memories(persona_id, scope, scope_key, subject_key) WHERE subject_key IS NOT NULL;
CREATE INDEX memories_expiry_idx ON memories(status, expires_at);

CREATE VIRTUAL TABLE memory_fts USING fts5(grams, tokenize='unicode61');
```

要点：

- **删除是真删**：`DELETE FROM memory_fts WHERE rowid=?` + `DELETE FROM memories`，同一事务。
- **事实更新不是 ADD-only**：同 `(persona, scope, scope_key, kind, subject_key)` 的旧 `active` 行改为
  `superseded`（保留历史、`valid_until`/`superseded_by` 有值），新行成为唯一 active。
  检索只取 `status='active'` 且未过期/未失效的行，所以旧状态不会再被当成现状。
- `dedupe_key` = `persona|scope|scope_key|kind|subject|归一化内容`；active 唯一索引保证重复写入不会膨胀。
- 过期（`expires_at`）是"保留历史但不再召回"；用户明确删除才是物理删除。

### 2.2 其他表

- `people(persona_id, qq_id, display_name, aliases JSON, first_seen_at, last_seen_at)` —— 身份只由 QQ 号决定；
  改名时旧昵称进 `aliases`，同一 QQ 在不同群仍是同一条档案。
- `candidates(...)` —— Level 2 缓冲；`status` pending/promoted/discarded/expired，pending 也有唯一去重索引。
- `llm_budget(persona_id, day, calls, last_call_at)` —— **提炼 + 巩固共用**的每日预算桶（原子 UPSERT）。
- `migration_log(...)` —— 每次迁移的源 hash、备份路径、导入/重复条数与完整报告。
- `self_state(persona_id, key, value, updated_at)` —— 允许变化的自我状态/调度水位（如上次提炼时间）。
- `meta(key, value)` —— `schema_version`（未来升级用；读到更高版本会拒绝写入）。

### 2.3 人格（Persona）与记忆的关系

- 人格载体仍然是 `roles/*.md` + `data/current-role.json`，**不复制进记忆库、不在记忆块里重复注入**。
  切换角色卡只换说话风格/设定，默认共享同一份经历（`personaId='default'`），因为 QQ 上仍是同一个人。
- 如果将来要做"多个独立角色、各自独立经历"，把 `memory.personaId` 设成不同值即可：
  所有表都以 `persona_id` 为前缀，身份、记忆、候选、预算、self_state 全部按人格隔离。
- 允许变化的自我认知用 `self_public` 作用域 + `self_state` 表；两者都**只有主人私聊能写**，
  模型无法自己改写人格核心，也没有任何自动流程会去改 `roles/*.md`。

### 2.4 作用域与可见性

| scope | scope_key | 谁能读到 |
|---|---|---|
| `self_public` | 空 | 当前人格的所有 QQ 场景（公开身份） |
| `owner_private` | 主人 QQ | **仅**主人私聊（群聊里主人在场也读不到） |
| `person_shared` | 当事人 QQ | 当事人**正在当前会话说话**时（跨场景共享的唯一形式） |
| `group` | 群号 | 仅该群 |
| `dm` | 对方 QQ | 仅与该人的私聊 |
| `session` | 会话 key（`group:x` / `private:y`） | 仅该会话（短期的进行中状态） |

写权限由 `authorizeWrite(ctx, {kind, scope, subjectId})` 判定：

- 群聊默认写 `group`；私聊写 `dm`；主人私聊默认写 `owner_private`；
- `self_public` / `owner_private` 只有主人私聊能写；
- `person_shared` 只能在当事人自己的私聊里、且 `subjectId === 对方 QQ` 时写；
- 模型**不能**传 scope 提升权限（`qq_memory_append` 根本没有 scope 参数；内部接口传了也会被拒）。

读取上下文由桥接构造：`senderIds` 只来自 `recentMessages`（桥接自己记录的可信 userId），
`conversationKind/Id` 只来自会话 key。SQL 过滤（`visibleScopeClause`）与纯函数
（`isVisibleTo`）是同一套规则的两种实现，测试逐条对照。

---

## 3. 写入：三级机制

### Level 1 · 显式记忆

`qq_memory_append(key, token, category, content, extra)`：

- `category ∈ {fact, preference, impression, episode, promise, state}` → 写 SQLite；
- `extra.target` 可以是昵称或 QQ 号：昵称只在**本会话 recentMessages 里唯一命中**时才解析成 QQ 号，
  否则 `subject_id` 留空（不猜身份、不跨群合并）；
- `extra.subjectKey`（如「实习进展」）用于事实更新：同键新事实取代旧事实；
- 旧的三个类别（`activeTopic`/`pendingThought`/`memberImpression`）行为完全不变，继续写 `social-v2.json`。

**本轮说话人是冻结的**：唤醒投递时把这一轮消息里的发送者 QQ 号与文本存成
`memoryActor` 快照；之后所有工具调用（写入/召回/删除）和注入都用它，**不现查 recentMessages**。
否则异步工具调用会把"唤醒之后才插话的人"当成当前用户（能删错人的记忆、把别人的
`person_shared` 内容拉进本轮）。非唤醒投递则取最近 3 条对方消息。快照 2 小时过期，
身份只来自桥接记录的消息 `userId`，模型无法指定。

### Level 2 · 规则候选

`appendSocialV2Message` 里对每条**对方消息**跑 `classifyCapture`，命中才落候选：

| 规则 | 例子 | kind |
|---|---|---|
| boundary | 「以后别提这个话题」 | preference |
| promise | 「答应帮你找那个项目」 | promise |
| plan | 「我下周五要面试」 | state |
| preference | 「我最近开始学日语了」 | preference |
| self_fact | 「我在北京上班/我是做设计的」 | fact |
| event | 「今天面试完了」 | episode |
| explicit | 「记住这件事」 | fact |

不命中就不写；另外这些一律跳过：自己说的话、纯表情/媒体、少于 4 字、纯提问、重复刷屏、
看起来像密钥/口令的内容。候选只存内容 + 来源 + 作用域 + 人物，**不存聊天原文全集**。

### Level 3 · 批量提炼（默认关闭）

`memory.capture.autoExtractionEnabled=false` 时永远不会调用模型。打开后还要同时满足：

```
候选 ≥ batchCandidateThreshold(15)  →  距上次 ≥ minExtractionIntervalMs(30min)
→  今日预算未用完(≤6，含巩固)  →  会话空闲(onlyWhenIdle)  →  （可检测时）插电
```

发请求前先原子占用额度（`reserveLlmCall`），失败/超时也计数——宁可少一次，不会多发。
模型输出只被当作**数据**：`id/keep/kind/content/subject_key/confidence`，其中 kind 必须在白名单，
**scope 与人物身份一律取候选行里桥接算好的值**。解析失败或模型没保留的候选标记 discarded，
不会让同一批永远卡在阈值上。

---

## 4. 检索

```
当前消息 ──► classifyMemoryNeed（要不要查？）
                │  纯表情/太短 → 不查（0 token）
                │  历史提问 → history 档（≤350）
                │  共同经历 → shared 档（≤250）
                │  熟人/被点名 → familiar 档（≤150）
                └─ 普通闲聊 → casual 档（≤50，命中不够也返回空）
                        ▼
        SQLite 结构化过滤（人/群/时间/状态/scope）+ FTS5（中文双字）
                        ▼
        覆盖率 + 归一化 bm25 + 时间新鲜度 + 置信度 + 人物相关 → 排序
                        ▼
        去重（同内容/子串）→ 逐行试算 Token → 渲染（或返回空串）
```

- **中文分词**：索引期把连续汉字切成 bigram（"我下周五要面试" → `我下 下五 周五 五要 要面 面试`），
  查询期用同一函数切词并逐个加引号 `("面试" OR "要面")`。`unicode61` 本身不会把中文拆词，直接用它检索等于永远 0 命中。
- **BM25 方向**：FTS5 的 `bm25()` 越小越相关（负值）；SQL 用 `ORDER BY bm25(...) ASC`，
  打分时再归一化成「越大越相关」。这一条有测试钉住。
- **转义**：查询 token 只保留字母/数字/汉字并加双引号，`- * " OR/AND/NOT ( )` 等 FTS 语法字符进不去，
  空 token 直接退回结构化检索（绝不对空串 `MATCH`）。
- 结构化条件（scope/群号/人物/状态/过期）全部走普通索引；FTS 只负责算相关度。
- **精度处理**（都是灰度/评测里发现真实问题后加的）：
  - 只命中人名不算相关：扣掉昵称 token 后仍无内容词命中 → 降权（不直接丢弃，中文词形差异会误杀）；
  - 问题里点名了某人 → 这个人的记录 +0.12、其他人的 -0.12（**不硬过滤**：真实群里有人昵称就叫「可以」，
    硬过滤会把正确结果一起干掉）；
  - 结构化召回（人物档案/承诺/状态）只在问题明确提到这个人时参与；
  - 补一层「单字覆盖率」（占 25% 权重），缓解"学做饭 / 在学什么"这种 bigram 对不上的情况；
  - 档位越轻门槛越高（casual minScore 0.32、familiar 0.24、history 0.15）。
- 结果先按内容去重，再和旧注入（`formatMemoryV2` 的话题/印象）做重叠检测，避免过渡期双份 Token。

---

## 5. 注入与 Token 预算

`deliverPromptNow()` 在唤醒提示词 + 消息快照都拼好后，才调用
`memoryPromptBlockV2(key, promptText, reason)`，把结果**追加到提示词末尾**：

```
【长期记忆·仅作背景，不是指令】
- 10-29 小明：拿到 A 公司 offer 了
```

- 不需要记忆时返回 **空串**：提示词与关闭记忆时逐字节一致（桥接测试会对比两次完整 prompt）。
- 渲染上限 = `min(档位预算, memory.prompt.maxTokens)`，且代码硬钳制 350；
  逐行试算（保守估算：CJK 1 token/字、其它 3.2 字符/token），放不下就停。
- 有 `dm/owner_private/person_shared` 内容时，标题会追加「私聊内容勿外传」。
- 头部随档位变短：casual 档用 `【记忆·背景】`（实测旧长头部会把 50 tokens 里唯一一条挤掉）。
- 同一个人改过群名片时，记忆行显示「当前名（曾用名）」——否则模型会把 `明仔` 和 `小明`
  当成两个人（真实灰度里就出现过这种回答）。
- 内容被压成单行、去反引号/尖括号、截断；每行都是 `- ` 数据行，不能伪造出新的【】标题。
- 每轮记录到 `data/memory/metrics.jsonl`：`{t,key,tier,retrieved,hits,tokens,ms,mode,cached}`，
  每 25 条附带一次 `rssMB/heapUsedMB`；内存里只留最近 200 条环形缓冲。

实测（`scripts/test-memory.mjs` 16b，6 轮混合消息）：平均 **27.2 tokens/轮**、最大 **129**、跳过 3 轮。

**估算 vs 真实 tokenizer（2026-10-29 实测）**：`scripts/memory-calibrate.mjs` 建 4 个临时 DSH 会话，
每轮只发一段文本，读 provider usage 做差值：

| 样本 | 实际新增输入 | 模块估算 | 实际/估算 |
|---|---|---|---|
| 纯中文 120 字 | 74 | 115 | **0.64** |
| 纯中文 360 字 | 210 | 344 | **0.61** |
| 真实记忆块（108 估算） | 91 | 108 | **0.89** |

结论：估算**高估约 12%~64%**，350 的上限实际最多约 310 tokens —— 方向正确（保守），
不需要为了"精确"换成会低估的估算。

---

## 6. 生命周期、更新、遗忘

- **事实更新**：同 `subject_key` 新事实 → 旧行 `superseded`（历史保留）+ `valid_until` + `superseded_by`；
  检索/注入只看 active，所以「拿 offer 后不会再说他在找实习」。
- **过期**：带 `expires_at` 的行到期后由 `expireDue` 标记为 `expired`（保留历史，不再召回）。
- **承诺/进行中的事**：候选与显式记忆可写 `promise/state`；带 TTL 的短期状态到期自动失效。
- **Session 退役**：`retireIdleSessionV2` 会把**不带 TTL** 的 `session` 作用域 `promise/state/episode`
  提升到 `group/dm` 作用域，DSH 会话重建后仍能检索（带 TTL 的"想说未说"保持会话内，符合语义）。
- **遗忘**：
  - 模型：`qq_memory_remove(memoryId=…)` 或 `category="longTerm"` + 关键词；
  - 用户/运维：`node scripts/memory-admin.mjs forget --id 12` / `--content "蝴蝶酥"`；
  - 都是**物理删除**（DB + FTS 同一事务），并写一条**删除墓碑**。
- **防复活（重要）**：只删 SQLite 不够 —— 旧 `formatMemoryV2` 仍会从 `social-v2.json` 注入
  topics/thoughts/impressions（SQLite 打不开的降级路径也是这一条）。所以删除时会：
  1. 用墓碑把**同一作用域**的旧 `social-v2` 记录物理清掉（`saveSocialV2State`）；
  2. 迁移/提炼/候选遇到墓碑一律不写回（`blocked`），只有用户再次明确要求记住
     （`origin='explicit'`）才覆盖墓碑；
  3. 每次唤醒前按"墓碑签名"对账一次，CLI 删除后无需重启桥接，下一次唤醒即清理旧副本。
- 备份/回滚副本里仍可能留有旧内容，见 §8 的保留策略。

---

## 7. 迁移、备份与回滚

旧数据 `data/social-v2.json` **不会被修改或删除**，迁移是"复制到新库"：

```bash
cd packages/bridge
node scripts/memory-admin.mjs migrate     # 备份 → 导入 → 记账；同一份文件重复跑会跳过
node scripts/memory-admin.mjs verify      # 逐条核对：内容/作用域/kind 是否真的落库
node scripts/memory-admin.mjs rollback    # 先在线备份当前库，再删掉本次迁移导入的行
```

迁移内容：

| 旧字段 | 新记录 |
|---|---|
| `activeTopics[]` | `promise`（含答应/约定/提醒）或 `state`，作用域 = 该群/该私聊 |
| `pendingThoughts[]` | `state`，作用域 = `session`（带原 TTL） |
| `memberImpressions{}` | `impression`，作用域 = 该群/该私聊；昵称能**唯一**解析到 QQ 号才写 `subject_id` |

- 备份：`data/memory/backups/social-v2.<时间戳>.<hash前8位>.json` + `.sha256`；
- 幂等：按源文件 sha256 + 内容去重，同一份文件不会重复导入；文件改了只补新增；
- 身份未解析（同名多人/从没在消息里出现过）→ `subject_id=NULL`、`raw_json.legacy.unresolvedIdentity=true`，
  **只在原会话作用域**可见，绝不跨群合并；
- 回滚入口是删"本次迁移导入的行"（按 `origin='legacy:social-v2'`），并先把当前库
  `VACUUM INTO` 备份一份；`social-v2.json` 自始至终没被动过。

本机真实数据迁移结果（2026-10-29）：

```
导入 18 条（activeTopics 4、memberImpressions 14），重复 0，身份未解析 11
verify: ok=true total=18 missing=[] mismatched=[]
people: 3 个可解析身份建档
```

---

## 8. 配置

`config.json`（默认值，代码里钳制；写大了也不生效）：

```json
{
  "memory": {
    "enabled": true,
    "backend": "sqlite",
    "dbPath": "data/memory/memory.sqlite",
    "personaId": "default",
    "maxAdditionalRamMB": 50,
    "cache": { "maxEntries": 32, "ttlMs": 60000 },
    "retrieval": {
      "mode": "live",
      "embeddingEnabled": false,
      "maxResults": 5,
      "candidateLimit": 40,
      "targetP95Ms": 20,
      "minScore": 0.18,
      "halfLifeDays": 30
    },
    "prompt": { "targetAverageTokens": 150, "maxTokens": 350, "includeSessionState": false },
    "capture": {
      "explicitMemoryEnabled": true,
      "candidateBufferEnabled": true,
      "autoExtractionEnabled": false,
      "batchCandidateThreshold": 15,
      "maxExtraCallsPerDay": 6,
      "minExtractionIntervalMs": 1800000,
      "candidateTtlMs": 604800000,
      "maxCandidates": 500
    },
    "consolidation": { "enabled": false, "onlyWhenIdle": true, "idleMs": 900000, "preferACPower": true, "intervalMs": 3600000 },
    "security": { "crossGroupPrivateMemory": false },
    "migrate": { "legacySource": "social-v2.json" }
  }
}
```

灰度期的覆盖值（当前 `config.json`）：

```json
{
  "memory": {
    "retrieval": { "mode": "live" },
    "capture": {
      "autoExtractionEnabled": true,
      "maxExtraCallsPerDay": 2,
      "batchCandidateThreshold": 15,
      "minExtractionIntervalMs": 1800000,
      "extractionConversations": ["private:952866364"]
    }
  }
}
```

`retrieval.mode`：

- `off`：完全不查（`enabled=false` 等价）；
- `shadow`（`config.example.json` 用它做上线前对照）：照常检索、记账、算 Token，但**不修改提示词**；
- `live`：真正注入。

代码里的默认是 `enabled=false`（完全不动线上行为）；`config.example.json` 是"准备好启用"的示例。
本机 `config.json` 已在迁移校验通过后设为 `enabled=true` + `mode=live`（见 §10 的实测记录）。

`security.crossGroupPrivateMemory=true` 会被忽略并打警告：跨群放开需要改代码并过测试，不是一个开关。

---

## 9. 启用 / 停用 / 回滚

**启用（推荐顺序）**

1. 备份 `config.json`，加 `memory` 段，先设 `"enabled": true, "retrieval": { "mode": "shadow" }`；
2. `node scripts/memory-admin.mjs migrate` → `verify`；
3. 重启桥接（`config.json` 只在启动时读取），观察 `data/memory/metrics.jsonl` 里的
   `retrieved/hits/tokens` 与实际聊天是否自然；
4. 确认后把 `retrieval.mode` 改成 `"live"`，再重启一次。

**停用（不删数据）**

- 把 `retrieval.mode` 改成 `"shadow"`（保留候选/显式写入）或 `"off"`；要彻底停：
  `"enabled": false`。旧 `qq_memory_*` 轻量记忆与 `social-v2.json` 一直可用，不受影响。

**回滚**

- 迁移回滚：`node scripts/memory-admin.mjs rollback`（只删迁移导入的行，先备份当前库）；
- 完全回滚：停桥接 → 把 `config.json` 换成 `data/config.json.bak-*` → （可选）删除
  `data/memory/` 或整体换回备份的 sqlite 文件；`social-v2.json` 无需恢复，因为没被改过；
- SQLite 坏掉：无需人工干预，桥接启动后会降级为无记忆聊天，60 秒后自动重试打开。

**备份保留策略**：`data/memory/backups/` 里的旧状态副本不会被自动清理（用于事故恢复）。
如果用户要求"彻底忘掉"，需同时处理这些副本：
`rm data/memory/backups/*`；`data/memory/metrics.jsonl` 只含计数不含内容。

---

## 10. 实测结果（Apple M5 / 16GB / macOS 26.5.2 / Node 24.16.0 / SQLite 3.53.0）

命令与结果都可重复（临时库，不碰真实数据）：

```bash
cd packages/bridge
node scripts/memory-bench.mjs --count 5000 --queries 500
node scripts/memory-bench.mjs --count 5000 --queries 500 --scale   # 5000 + 20000
```

| 规模 | 写入 | DB 体积 | P50 | P95 | P99 | 堆增量 | RSS 增量 | 注入均值/最大 |
|---|---|---|---|---|---|---|---|---|
| 5,000 条 | 333 ms | 3.12 MB | 0.029 ms | **0.337 ms** | 0.845 ms | **1.48 MB** | 16.45 MB | 72.3 / 128 tokens |
| 20,000 条 | 1395 ms | 12.28 MB | 0.030 ms | **2.112 ms** | 3.634 ms | **3.58 MB** | 3.28 MB | 72.7 / 129 tokens |

- `targetP95Ms=20` 是目标不是保证；两种规模都在 20ms 内（20k 时 P95 升到 ~2.1ms，仍有余量）。
- 新增常驻堆内存 1.4~3.3MB，远低于 50MB 上限；RSS 增量包含 SQLite 页缓存与 V8 增长，仍在 20MB 内。
- Token：混合消息（闲聊/历史提问/表情）平均 72~82，最大 129；单轮硬上限 350 由渲染器实测守住。
- 2000 条单测（`test-memory.mjs` 16a）实测 median 0.03ms / p95 0.05ms / 堆增量 0.90MB。
- **一次真实批量提炼（15 条候选，DSH deepseek-flash）**：7.6 秒，**17,645 输入 + 1,156 输出 tokens**，
  写入 8 条、丢弃 7 条；其中同一批里 `音色偏好` 被后一条自动取代（事实更新在提炼路径也生效）。
  按 2 次/天算约 3.8 万 tokens/天；这是"辅助会话带着完整工具面"的成本，后续可用更瘦的 preset 降下来。

---

## 11. 测试

```bash
cd packages/bridge
node scripts/test-memory.mjs          # 存储/ACL/检索/预算/迁移/注入（22 个用例）
node scripts/test-memory-bridge.mjs   # 真实 bridge.js + 假 DSH/QQ（14 个用例）
node scripts/memory-eval.mjs          # 50 个场景的质量评测（43 个问题 + 12 条无关闲聊）
npm run test:audit                    # 既有全量回归（已包含上面两个文件）
npm run test:memory                   # 只跑上面两个
node scripts/memory-eval.mjs          # 50 个真实场景的质量评测（离线，不花钱）
node scripts/memory-eval.mjs --live   # 额外让真实模型带注入块回答，算答案正确率/人格
node scripts/memory-calibrate.mjs     # 用真实模型 usage 校准 350 token 估算
```

`test-memory.mjs` 覆盖（22 个用例）：A 群事件可回忆、B 群读不到 A 群（含诱导泄漏）、跨群同人身份关联但记录隔离、
改名不丢身份、主人私聊不进群、跨场景共享（person_shared）只能在当事人私聊授权、重启后仍可召回、
事实更新与重复写入幂等、真删除（DB+FTS）、普通聊天零 LLM 调用、不需要记忆时不加块、
shadow 模式不改提示词、350 token 上限、跨天提炼预算、SQLite 降级、迁移备份/幂等/无丢失/回滚后重迁、
恶意 Prompt 不能提权/改人格、FTS 特殊字符/超长/emoji 查询不抛错、P95 与堆内存实测、Token 统计。

`test-memory-bridge.mjs` 覆盖：真实唤醒提示词注入、无关时与关闭记忆逐字节一致、
B 群提示词无 A 群内容、主人私聊不进群、真实提示词 ≤350 tokens、SQLite 坏掉时 QQ 投递仍成功、
候选捕获、会话退役提升、`memory-append/recall/forget/status` 端到端、跨会话令牌拒绝、
群里传 `personShared` 被拒绝、**异步插话者不能冒充本轮发言者**、**删除后旧 social-v2 副本
被清除且不会从降级路径回到提示词**。

本机最终回归（2026-10-29）：`test:memory` 20+11 全绿；`test:audit` 与改动前的干净 worktree
逐条对比，失败集合完全相同（9 个既有环境/CRLF/缺 docs 的问题），**无新增失败**。

---

## 12. 未完成 / 已知限制

1. **没有向量检索**。中文同义改写（"找实习" ↔ "求职"）召回不到；这是第一版的明确取舍。
   评测里 43 个问题的条件召回是 100%，但那是"记忆已经写进去 + 问题与原文有词面重叠"的前提下；
   换成纯同义词提问（例如只说"求职"）仍会漏。
   需要时的扩展点是 `retrieval.mode` 之外再加一个可选 `embedding` 适配器（本次未安装模型）。
2. **Level 3 的 LLM 巩固只做到"本地整理"**：过期清理、候选裁剪、同主题合并；没有"每晚总结人物档案"
   这类需要额外 LLM 的反思（任务书也要求不无条件每晚全量反思）。
3. **提炼会话**复用 `slang.learnerPreset` 的辅助会话机制，需要 DSH 在线；离线时提炼失败并保留候选，
   不影响聊天。
4. **人物身份解析**只信本会话 recentMessages 的唯一昵称匹配；旧数据里 11 条印象因昵称无法唯一对应而
   保持 `subject_id=NULL`。它们的可见范围没有变宽（仍只在原群），只是不能跨群关联。
5. **删除不会追溯清理已导出的备份**（`.json`/`.sqlite` 备份）；见 §9 的保留策略，需要彻底清除时要手动删备份。
6. **Token 计数仍非精确 tokenizer**：已用真实模型用量抽样校准（估算高估 12%~64%，方向安全），
   但没有内置分词器；如果以后要卡得更紧，需要引入一个不常驻的 tokenizer 或继续抽样。
7. **一次真实提炼 ≈ 1.8 万输入 tokens**（辅助会话带着完整工具面）。按 2 次/天灰度是约 3.8 万/天；
   要长期开到 6 次/天，建议先给提炼换一个不带工具面的瘦 preset（本次未做，避免动 DSH 安装）。
8. **MCP 工具 schema 需要 DSH 重启才会刷新**：桥接端已支持长期记忆类别，但 09:49 启动的
   `mcp-snowluma-safe` 进程仍持有旧 schema；在 DSH 重启前，模型只能用旧类别
   （`qq_get_prompt` 已经能看到 `longTermMemory` 段，桥接侧写入/召回接口是通的）。
9. **RSS 无法在代码里硬限制**，只能通过"不整库加载 + 有界缓存 + LIMIT"控制；实测增量见 §10。
10. 记忆块目前只在 `reserved2`（二代仿真）注入；一代 `reserved` 模式仍用旧轻量记忆，刻意不改，避免影响在跑的行为。

---

## 13. 灰度记录（2026-10-29）

**上线顺序**

1. 代码提交 `3dc2a4c`（P0–P3 + 测试 + 文档），`config.json` 备份两次（`data/config.json.bak-*`）。
2. `retrieval.mode=shadow` → `bash start-mac.sh` 重启（pid 8929）。校验：
   `/api/memory/status` 正常、WAL=true、库 18 条、`openError=null`、目录 700/文件 600。
3. `retrieval.mode=live` → 再次重启（pid 9167）。真实唤醒投递时记忆块注入、`metrics.lastInjection` 有记录。
4. 打开自动提炼但**只作用于测试私聊**、每日上限 2：
   `capture.autoExtractionEnabled=true`、`maxExtraCallsPerDay=2`、
   `extractionConversations=["private:952866364"]` → 重启（pid 14596）。

**真实提炼验证（同一晚）**

- 手工放入 15 条候选（测试私聊）→ `POST /api/memory/extract {"force":true}`；
- 结果：**7.6 秒，写入 8 条、丢弃 7 条**；预算 `1/2`；其中「音色偏好」在同一批里被后一条自动取代；
- 实际 token（从 `data/token-usage.jsonl` 按 memory 会话汇总）：**17,645 输入 + 1,156 输出**。

**真实注入验证**

- 重启后测试私聊有一次唤醒，`lastInjection`：`tier=casual, hits=1, tokens=45, ms=3, mode=live`；
- 注入内容就是之前写入的 owner_private 记忆（`主人让我把之前的语音在 973614217 这个群里再发一遍`），
  45 tokens 没有超过 50 的 casual 预算。

**质量评测（`scripts/memory-eval.mjs`，50 个场景）**

| 指标 | 结果 |
|---|---|
| 写入率（规则或显式路径） | **93.6%**（44/47；未捕获的 3 条都是隐私类事实，留给显式工具/提炼） |
| Recall@5（条件：记忆已写入） | **100%**（43/43） |
| 错误记忆率（张冠李戴） | **0%** |
| 无关注入率（12 条闲聊） | **0%** |
| 跨群/主人私聊泄漏 | **0%** |
| live 答案正确率（真实 deepseek-flash） | **97.7%**（42/43，唯一失败是"明仔/小明"昵称措辞，见下） |
| live 人格稳定率 | **100%**（43/43 没有 AI 自曝/提提示词/复述清单） |

live 评测里发现并修掉的真实问题（修完后 43 题里仍有 1 题因昵称措辞被判失败；
同一条用例单独跑时能答对，属于模型偶发混淆，不是权限/检索问题）：
1. 头部 + 一条记忆超过 casual 50 tokens → 改成短头部（否则"命中了却不注入"）；
2. 只命中人名就召回 → 加内容 token 校验 + 单字覆盖率；
3. 问题里点名的人被常用词昵称（真实数据里有人叫「可以」）误过滤 → 过滤前排除常用词；
4. 同一人换群名片后被当成两个人 → 渲染"问题里用的名字（曾用名）"；
5. 问题句没有问号/历史词就不查 → 把"什么/为什么/几点…"纳入直接提问档。

**尚未完成的手工步骤**

- 真实 QQ 双向验证需要**另一个 QQ 账号发消息**（我只能以机器人身份发，不能冒充群友）。建议在
  一个测试群 + 主人私聊里各发 3 条：一条事实、一条更新、一条删除，然后看
  `data/memory/metrics.jsonl` 与 `/api/memory/status`。桥接侧与评测侧均已验证通过。
- 新 MCP 工具 schema 需要重启 DSH（会中断当前 Web 会话，所以没有替用户执行）。
