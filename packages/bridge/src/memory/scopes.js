// 记忆作用域与访问控制（纯函数）。
//
// 铁律：
//   1. **scope 由桥接根据可信的会话上下文确定，绝不由模型指定**。模型只能提供
//      内容与主题；它拿到的 scope 一定是当前会话算出来的那一个。
//   2. A 群的记忆默认只在 A 群可见；私聊内容不自动进群；主人私聊内容不进任何群。
//   3. 唯一允许跨场景的是 `person_shared`：当事人自己在私聊里明确说"这个可以跟别人说"。
//      即便如此，也只有当这个人**正在当前会话里说话**时才会被检索出来。
//   4. 人物身份用 QQ 号（稳定），昵称/群名片只是别名；身份可以跨群关联，但**记忆不跟着走**。
//
// 这里的函数是 ACL 的单一实现：SQL 过滤（visibleScopeClause）与纯函数判定
// （isVisibleTo）必须保持一致，测试里会逐条对照（见 scripts/test-memory.mjs 的跨群隔离）。

export const SCOPE = Object.freeze({
  SELF_PUBLIC: 'self_public',
  OWNER_PRIVATE: 'owner_private',
  PERSON_SHARED: 'person_shared',
  GROUP: 'group',
  DM: 'dm',
  SESSION: 'session'
});

export const MEMORY_SCOPES = Object.freeze(Object.values(SCOPE));

export const KIND = Object.freeze({
  FACT: 'fact',
  PREFERENCE: 'preference',
  IMPRESSION: 'impression',
  EPISODE: 'episode',
  PROMISE: 'promise',
  STATE: 'state'
});

export const MEMORY_KINDS = Object.freeze(Object.values(KIND));

/** 不同 kind 的默认置信度：印象/偏好天然比明确事实弱。 */
export const DEFAULT_CONFIDENCE = Object.freeze({
  fact: 0.8,
  preference: 0.75,
  impression: 0.6,
  episode: 0.85,
  promise: 0.9,
  state: 0.7
});

/** 只有这些 kind 会用 subject_key 做「事实更新」（旧记录保留为 superseded 历史）。 */
export const SUPERSEDING_KINDS = Object.freeze(['fact', 'preference', 'state', 'promise']);

export const SCOPE_LABEL = Object.freeze({
  self_public: '公开身份',
  owner_private: '主人私聊',
  person_shared: '跨场景共享',
  group: '群',
  dm: '私聊',
  session: '本会话'
});

/** 解析 `group:123` / `private:456`；非法返回 null（与 bridge 的 canonicalV2Key 同义）。 */
export function parseConversationKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { kind: m[1], id: String(id) };
}

/**
 * 构造一次读取的上下文。
 * @param {object} p
 * @param {string} p.conversationKey  group:xxx / private:xxx
 * @param {string} p.personaId
 * @param {string|number} [p.ownerQQ]
 * @param {Array<{userId?:string|number, name?:string}>} [p.senders] 最近发言者（可信来源：桥接消息记录）
 * @param {boolean} [p.senderIsOwner] 当前说话人是否主人
 */
export function buildReadContext({ conversationKey, personaId = 'default', ownerQQ = '', senders = [] } = {}) {
  const parsed = parseConversationKey(conversationKey);
  if (!parsed) return null;
  const owner = String(ownerQQ ?? '').trim();
  const ids = [];
  const names = [];
  for (const s of Array.isArray(senders) ? senders : []) {
    const uid = String(s?.userId ?? '').trim();
    if (/^\d+$/.test(uid) && !ids.includes(uid)) ids.push(uid);
    const name = String(s?.name ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
    if (ids.length >= 12) break;
  }
  const isOwnerConversation = parsed.kind === 'private' && !!owner && parsed.id === owner;
  return {
    personaId: String(personaId || 'default'),
    conversationKey: `${parsed.kind}:${parsed.id}`,
    conversationKind: parsed.kind,
    conversationId: parsed.id,
    ownerQQ: owner,
    isOwnerConversation,
    peerId: parsed.kind === 'private' ? parsed.id : '',
    groupId: parsed.kind === 'group' ? parsed.id : '',
    senderIds: ids,
    senderNames: names,
    // 跨群共享仅限 person_shared（当事人授权）；这里保留字段是为了审计输出可读。
    allowCrossGroup: false
  };
}

/** 纯函数版可见性判定。与 visibleScopeClause 必须逐条等价。 */
export function isVisibleTo(ctx, row) {
  if (!ctx || !row) return false;
  if (String(row.persona_id ?? row.personaId ?? '') !== String(ctx.personaId)) return false;
  const scope = String(row.scope ?? '');
  const scopeKey = String(row.scope_key ?? row.scopeKey ?? '');
  switch (scope) {
    case SCOPE.SELF_PUBLIC:
      return true;
    case SCOPE.OWNER_PRIVATE:
      return ctx.isOwnerConversation === true && scopeKey === ctx.ownerQQ;
    case SCOPE.PERSON_SHARED:
      // 只有当事人正在当前会话说话时才可见（不让 A 的授权内容出现在他不在的群里）。
      return ctx.senderIds.includes(scopeKey);
    case SCOPE.GROUP:
      return ctx.conversationKind === 'group' && scopeKey === ctx.groupId;
    case SCOPE.DM:
      return ctx.conversationKind === 'private' && scopeKey === ctx.peerId;
    case SCOPE.SESSION:
      return scopeKey === ctx.conversationKey;
    default:
      return false;
  }
}

/**
 * SQL 侧的可见性过滤（参数化）。列名固定，不接受外部输入。
 * @returns {{sql:string, params:Array<string>}}
 */
export function visibleScopeClause(ctx) {
  if (!ctx) return { sql: '0', params: [] };
  const parts = [`(scope = 'self_public')`];
  const params = [];
  if (ctx.isOwnerConversation && ctx.ownerQQ) {
    parts.push(`(scope = 'owner_private' AND scope_key = ?)`);
    params.push(ctx.ownerQQ);
  }
  if (ctx.conversationKind === 'group') {
    parts.push(`(scope = 'group' AND scope_key = ?)`);
    params.push(ctx.groupId);
  } else if (ctx.peerId) {
    parts.push(`(scope = 'dm' AND scope_key = ?)`);
    params.push(ctx.peerId);
  }
  const ids = (ctx.senderIds ?? []).filter((id) => /^\d+$/.test(String(id)));
  if (ids.length) {
    parts.push(`(scope = 'person_shared' AND scope_key IN (${ids.map(() => '?').join(',')}))`);
    params.push(...ids);
  }
  if (ctx.conversationKey) {
    parts.push(`(scope = 'session' AND scope_key = ?)`);
    params.push(ctx.conversationKey);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** 当前会话的默认写入作用域：群 → group；私聊主人 → owner_private；其它私聊 → dm。 */
export function defaultWriteScope(ctx, { selfOnly = false } = {}) {
  if (!ctx) return null;
  if (selfOnly) {
    // self_public 只允许主人私聊显式授权写入；其它场景降级为当前会话作用域。
    if (ctx.isOwnerConversation) return { scope: SCOPE.SELF_PUBLIC, scopeKey: '' };
  }
  if (ctx.conversationKind === 'group') return { scope: SCOPE.GROUP, scopeKey: ctx.groupId };
  if (ctx.isOwnerConversation) return { scope: SCOPE.OWNER_PRIVATE, scopeKey: ctx.ownerQQ };
  return { scope: SCOPE.DM, scopeKey: ctx.peerId };
}

/**
 * 写入授权。
 * @param {object} ctx
 * @param {object} request { scope?, kind, subjectId? }
 * @returns {{ok:boolean, scope?:string, scopeKey?:string, reason?:string}}
 */
export function authorizeWrite(ctx, request = {}) {
  if (!ctx) return { ok: false, reason: '缺少会话上下文' };
  const kind = String(request.kind ?? '');
  if (!MEMORY_KINDS.includes(kind)) return { ok: false, reason: `未知记忆类型：${kind}` };
  const subjectId = String(request.subjectId ?? '').trim();
  const requested = request.scope === undefined || request.scope === null || request.scope === ''
    ? null
    : String(request.scope);

  if (!requested) {
    const d = defaultWriteScope(ctx);
    return d ? { ok: true, ...d } : { ok: false, reason: '无法确定作用域' };
  }
  if (!MEMORY_SCOPES.includes(requested)) return { ok: false, reason: `未知作用域：${requested}` };

  if (requested === SCOPE.SELF_PUBLIC) {
    // 人格的公开身份只有主人能写（第 4 节：人格核心只有主人明确授权才能修改）。
    if (!ctx.isOwnerConversation) return { ok: false, reason: '只有主人私聊可以修改公开身份记忆' };
    return { ok: true, scope: SCOPE.SELF_PUBLIC, scopeKey: '' };
  }
  if (requested === SCOPE.OWNER_PRIVATE) {
    if (!ctx.isOwnerConversation) return { ok: false, reason: '只有主人私聊可以写入主人私有记忆' };
    return { ok: true, scope: SCOPE.OWNER_PRIVATE, scopeKey: ctx.ownerQQ };
  }
  if (requested === SCOPE.PERSON_SHARED) {
    // 「当事人已明确允许跨场景共享」：只在当事人本人的私聊里成立。
    if (ctx.conversationKind !== 'private') return { ok: false, reason: '跨场景共享只能在私聊里由当事人本人授权' };
    if (!subjectId || subjectId !== ctx.peerId) return { ok: false, reason: '跨场景共享只能由当事人本人授权' };
    return { ok: true, scope: SCOPE.PERSON_SHARED, scopeKey: subjectId };
  }
  if (requested === SCOPE.GROUP) {
    if (ctx.conversationKind !== 'group') return { ok: false, reason: '群作用域记忆只能在群里写入' };
    return { ok: true, scope: SCOPE.GROUP, scopeKey: ctx.groupId };
  }
  if (requested === SCOPE.DM) {
    if (ctx.conversationKind !== 'private') return { ok: false, reason: '私聊作用域记忆只能在私聊里写入' };
    return { ok: true, scope: SCOPE.DM, scopeKey: ctx.peerId };
  }
  if (requested === SCOPE.SESSION) {
    return { ok: true, scope: SCOPE.SESSION, scopeKey: ctx.conversationKey };
  }
  return { ok: false, reason: '作用域不被允许' };
}

/**
 * 删除授权：模型可以删掉「它在这个会话里读得到」的记忆；
 * 涉及他人的私有记忆（person_shared/owner_private）只能删掉当事人自己那条本人授权的记录。
 */
export function authorizeForget(ctx, row) {
  if (!ctx || !row) return { ok: false, reason: '缺少上下文' };
  if (!isVisibleTo(ctx, row)) return { ok: false, reason: '这条记忆不在当前会话的可见范围内' };
  const scope = String(row.scope ?? '');
  if (scope === SCOPE.SESSION || scope === SCOPE.SELF_PUBLIC) {
    // self_public 属于人格身份，只有主人能删。
    if (scope === SCOPE.SELF_PUBLIC && !ctx.isOwnerConversation) return { ok: false, reason: '公开身份记忆只有主人可以删除' };
    return { ok: true };
  }
  if (scope === SCOPE.OWNER_PRIVATE) {
    return ctx.isOwnerConversation ? { ok: true } : { ok: false, reason: '主人私有记忆只有主人可以删除' };
  }
  // group / dm / person_shared：当事人本人或主人可以删。
  const subject = String(row.subjectId ?? row.subject_id ?? '');
  if (ctx.isOwnerConversation && ctx.ownerQQ) return { ok: true };
  if (subject && (ctx.senderIds.includes(subject) || subject === ctx.peerId)) return { ok: true };
  return { ok: false, reason: '只有这条记忆的当事人或主人可以删除' };
}

/** 渲染到提示词时给作用域一个短标签（跨场景内容要让模型知道不能随便说出去）。 */
export function scopePromptTag(row) {
  const scope = String(row.scope ?? '');
  if (scope === SCOPE.DM) return '私聊';
  if (scope === SCOPE.OWNER_PRIVATE) return '主人私聊';
  if (scope === SCOPE.PERSON_SHARED) return '跨场景共享';
  if (scope === SCOPE.SELF_PUBLIC) return '公开身份';
  return '';
}
