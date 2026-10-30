/* Presentation only. Existing controls, listeners and serializers remain mounted. */
window.createConsoleExperience = function ({ navigate, refreshVoice }) {
  const $ = id => document.getElementById(id);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const icons = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
    chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path d="M8 9h8M8 13h5"/>',
    senses: '<path d="M3 12s3-7 9-7 9 7 9 7-3 7-9 7-9-7-9-7Z"/><circle cx="12" cy="12" r="3"/>',
    memory: '<path d="M4 4h6a3 3 0 0 1 3 3v14a5 5 0 0 0-4-2H4ZM20 4h-4a3 3 0 0 0-3 3v14a5 5 0 0 1 4-2h3Z"/>',
    system: '<rect x="3" y="4" width="18" height="14" rx="3"/><path d="M8 22h8M12 18v4m-5-11 3-3 3 5 4-3"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    whale: '<path d="M3 12c0 5 4 8 9 8 6 0 9-4 9-10-2 2-4 2-5 0 0 3-2 5-4 5-3 0-5-2-5-5-2 0-4 1-4 2Z"/><path d="M8 6V3m3 4 2-3"/><circle cx="7" cy="13" r=".6"/>',
  };
  const icon = name => {
    const span = make('span', 'ui-icon');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
    return span;
  };
  const groups = [
    ['home', '总览', '和大肥鱼打个照面', ['overview', 'sessions']],
    ['chat', '聊天与性格', '她是谁，怎样参与聊天', ['persona', 'social-v2', 'social-v1']],
    ['senses', '感知与表达', '看见、听懂、说出心意', ['vision', 'hearing', 'voice', 'expression', 'reference']],
    ['memory', '记忆与学习', '记住相处，读懂大家', ['memory', 'slang']],
    ['system', '运行与安全', '连接、用量与访问边界', ['runtime', 'usage', 'access', 'power', 'operations']],
  ];
  const pages = {
    overview: ['总览', '今天，也和大肥鱼一起。', '一眼了解她的状态，轻松调整相处方式。'],
    sessions: ['会话与审批', '正在发生的对话', '查看每个群和私聊的会话，处理等待你回复的请求。'],
    persona: ['性格与角色', '让她成为熟悉的那个她。', '选择角色、调整表达方式，或写下你想要的性格。'],
    'social-v2': ['聊天习惯', '把聊天节奏，调得刚刚好。', '从主动冒泡到等待回复，用你喜欢的方式参与群聊。仅在二代仿真模式生效。'],
    'social-v1': ['一代仿真', '熟悉的聊天策略，完整保留。', '为一代模式调整触发概率、活跃周期和分条发送。'],
    vision: ['视觉与视频', '陪她一起，看见更多。', '管理图片理解、B 站卡片和联网能力。'],
    hearing: ['听懂语音', '每一句话，都好好听。', '把收到的 QQ 语音转成文字，让她听懂内容和语气。'],
    voice: ['声音与唱歌', '给文字，一点声音。', '选择音色、调整语音表达，也可以试听或管理唱歌能力。'],
    expression: ['表情与动作', '不止文字，也有小表情。', '管理收藏表情、发送概率与互动方式。'],
    reference: ['工具权限', '她可以做什么，由你决定。', '按用途管理工具权限。工具清单的变化可能需要重启 DSH。'],
    memory: ['长期记忆', '把一起经历的事，慢慢记住。', '管理事实、偏好与经历；群和私聊的记忆按作用域隔离。'],
    slang: ['黑话词库', '懂你们才懂的那些话。', '确认群里的新词和梗，让她逐渐熟悉大家的表达习惯。'],
    runtime: ['连接与模式', '让每一段连接，安稳运行。', '选择运行模式、配置思考强度，管理各项能力的总开关。'],
    usage: ['用量与花费', '每一次思考，都算得清楚。', '查看 token 消耗和花费，按会话了解使用情况。'],
    access: ['访问与安全', '谁可以和她聊天？', '设置白名单、管理员和控制台访问凭证。'],
    power: ['电源与性能', '合适的状态，合适的消耗。', '为离电场景选择可用能力，减少电量与资源消耗。'],
    operations: ['调试与维护', '需要排查时，从这里开始。', '查看日志、检查会话状态、测试消息或维护桥接进程。'],
  };
  const pageGroup = Object.fromEntries(groups.flatMap(([key,,, views]) => views.map(view => [view, key])));
  const grid = document.querySelector('main > .grid');
  function section(id, page, title, intro = '') {
    const node = make('section', 'card span-all');
    node.id = id; node.dataset.page = page;
    node.append(make('h2', '', title));
    if (intro) node.append(make('p', 'section-intro', intro));
    grid.append(node); return node;
  }
  function jumpButton(text, page, target = '') {
    const button = make('button', 'soft-link', text);
    button.type = 'button'; button.dataset.view = page;
    if (target) button.dataset.target = target;
    button.append(icon('arrow')); return button;
  }

  // Keep IDs and event handlers; only relocate the corresponding views.
  for (const id of ['section-mode', 'section-features', 'section-dsh']) $(id).dataset.page = 'runtime';
  $('section-power').dataset.page = 'power';
  $('section-activity').dataset.page = 'operations';
  $('section-silent').dataset.page = 'runtime';
  $('section-social-v2').querySelector('h2').textContent = '聊天习惯';
  $('section-social-v2').querySelector(':scope > .meta').textContent = '这里的设置会影响二代仿真。跨页修改会一起保存；切换页面不会丢失未保存内容。';
  $('section-features').querySelector('h2').textContent = '能力总开关';
  $('section-reference').querySelector('h2').textContent = '工具用途参考';
  const detailFor = id => $(id).closest('details');
  const moveDetail = (id, parent, title, intro, open = false) => {
    const detail = detailFor(id);
    detail.classList.add('settings-group');
    detail.querySelector(':scope > summary').textContent = title;
    if (intro) {
      const summary = detail.querySelector(':scope > summary');
      summary.append(make('small', 'group-description', intro));
    }
    detail.open = open; parent.append(detail); return detail;
  };
  const vision = section('section-vision', 'vision', '看图、看视频、查资料', '总开关控制这项能力是否可用；工具权限控制她是否能主动调用。');
  const featureCards = make('div', 'v2-tool-list'); vision.append(featureCards);
  // Reuse real feature checkboxes rather than maintaining a second synchronized form.
  ['images', 'biliCard', 'webSearch'].forEach(key => featureCards.append(document.querySelector(`[data-feature="${key}"]`).closest('label')));
  const featureSaveProxy = make('button', 'primary', '保存视觉与联网开关');
  featureSaveProxy.type = 'button'; featureSaveProxy.addEventListener('click', () => $('featureSave').click());
  const featureStatus = make('span', 'meta'); featureStatus.setAttribute('role', 'status');
  const featureActions = make('div', 'row'); featureActions.append(featureSaveProxy, featureStatus); vision.append(featureActions);
  new MutationObserver(() => { featureStatus.textContent = $('featureMsg').textContent; }).observe($('featureMsg'), { childList: true, subtree: true });
  vision.append(jumpButton('查看相关工具权限', 'reference', 'v2Tools'));

  const hearing = section('section-hearing', 'hearing', '语音识别 · ASR');
  const voice = section('section-voice', 'voice', '语音合成 · TTS', '试听使用已保存的参数。调整音色后，请先保存，再试听。');
  const voiceGroup = detailFor('v2AsrEnabled');
  const voiceContent = voiceGroup.querySelector(':scope > .settings-content');
  const ttsHeading = [...voiceContent.children].find(node => node.tagName === 'H3' && node.textContent.includes('TTS'));
  const ttsContent = make('div', 'voice-settings');
  let next = ttsHeading;
  while (next) { const following = next.nextSibling; ttsContent.append(next); next = following; }
  voice.append(ttsContent);
  function disclosure(parent, title, description) {
    const detail = make('details', 'settings-group');
    const summary = make('summary', '', title); summary.append(make('small', 'group-description', description));
    const content = make('div', 'settings-content'); detail.append(summary, content); parent.append(detail);
    return { detail, content };
  }
  const asrAdvanced = disclosure(voiceContent, '性能与资源', '模型加载、并发、转写上限与缓存');
  for (const id of ['v2AsrPreload', 'v2AsrMaxSeconds', 'v2AsrModelDir']) asrAdvanced.content.append($(id).closest('.row'));
  const voiceLimits = disclosure(ttsContent, '发送限制', '控制语音长度、发送频率与合成用量');
  for (const id of ['v2SpeakMaxChars', 'v2SpeakPerMin', 'v2SpeakTrim']) voiceLimits.content.append($(id).closest('.row'));
  const autoVoice = disclosure(ttsContent, '偶尔用语音回复', '把合适的短句，按概率转换成语音条');
  for (const id of ['v2SpeakAutoEnabled', 'v2SpeakAutoMirrorMin', 'v2SpeakAutoMinChars']) autoVoice.content.append($(id).closest('.row'));
  // Keep the selected voice service next to the provider picker, previews before advanced options.
  ttsContent.querySelectorAll(':scope > .meta').forEach(node => {
    if (node.textContent.includes('短句随机转语音')) autoVoice.content.prepend(node);
  });
  moveDetail('v2AsrEnabled', hearing, '识别设置', '收到语音后，如何转写和理解', true);
  voiceGroup.classList.add('unfolded-group');
  // Singing becomes a sibling, never a disclosure inside another disclosure.
  moveDetail('v2SingEnabled', voice, '唱歌与曲库', '本地按需运行，配置资源限制与参考声音');
  moveDetail('v2VoiceEnabled', voice, '语音库', '管理已有音频，校验或试发语音条');
  const expression = section('section-expression', 'expression', '表情包与互动');
  moveDetail('v2StickerEnabled', expression, '表情包', '收藏、备注与发送频率', true);
  const tools = section('section-tool-permissions', 'reference', '工具权限', '关闭权限后调用会被拒绝；部分工具在重启 DSH 后才从清单移除。');
  moveDetail('v2Tools', tools, '可用工具', '按用途分组，原有权限完整保留', true).classList.add('unfolded-group');
  grid.insertBefore(tools, $('section-reference'));
  moveDetail('v2MemoryKey', $('section-memory'), '短期印象与话题', '当前话题、待说的话与成员印象；与长期记忆独立');
  const diagnostics = section('section-ai-diagnostics', 'operations', 'AI 反馈与工具日志');
  moveDetail('v2FeedbackMaxLength', diagnostics, '反馈设置', '查看她遇到的问题');
  moveDetail('v2ToolLogLoad', diagnostics, '工具调用日志', '查看调用参数及成功或失败原因');

  // Four shallow sections replace the long list of unrelated disclosures.
  const behavior = $('section-social-v2');
  const behaviorNav = make('div', 'segmented behavior-nav');
  behaviorNav.setAttribute('role', 'tablist'); behaviorNav.setAttribute('aria-label', '聊天习惯分区');
  const paneDefs = [
    ['daily', '日常参与', [['v2ProactiveEnabled', '冷场时主动冒泡', '群里安静下来时，偶尔找点话题', true], ['v2RecSleepMin', '默认参与方式', '给 AI 的推荐值，AI 可以自主调整', false]]],
    ['rhythm', '回复节奏', [['v2BurstEnabled', '消息与分条', '控制消息长度、条数与发送间隔', true], ['v2WaitDefaultMs', '等对方说完', '减少抢话，并在发言后检查回复', false]]],
    ['rules', '边界与资源', [['v2SleepMinMs', '唤醒硬限制', '桥接强制执行，AI 不能绕过', true], ['v2ContextRecentLimit', '上下文用量', '决定每次能读取多少最近消息', false]]],
    ['conversations', '会话设置', [['v2SessionSelect', '选择会话', '选择后自动带入下面的会话输入框', true], ['v2InitPromptKey', '首次见面的背景', '只在该会话首次唤醒时提供', false], ['v2StateKey', '当前会话状态', '查看状态或立即唤醒', false], ['v2WakeKey', '下次唤醒条件', '查看倒计时和触发条件', false]]],
  ];
  const paneButtons = new Map();
  const panes = new Map();
  for (const [key, label, details] of paneDefs) {
    const button = make('button', '', label); button.type = 'button';
    button.id = `behavior-tab-${key}`; button.dataset.pane = key;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `behavior-pane-${key}`);
    behaviorNav.append(button); paneButtons.set(key, button);
    const pane = make('div', 'behavior-pane'); pane.id = `behavior-pane-${key}`; pane.dataset.settingPane = key;
    pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', button.id);
    behavior.append(pane); panes.set(key, pane);
    for (const [id, title, intro, open] of details) moveDetail(id, pane, title, intro, open);
    button.addEventListener('click', () => selectPane(key));
    button.addEventListener('keydown', event => {
      const keys = [...paneButtons.keys()]; const index = keys.indexOf(key);
      const target = event.key === 'ArrowRight' ? keys[(index + 1) % keys.length] : event.key === 'ArrowLeft' ? keys[(index - 1 + keys.length) % keys.length] : event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : '';
      if (target) { event.preventDefault(); selectPane(target); paneButtons.get(target).focus(); }
    });
  }
  behavior.insertBefore(behaviorNav, panes.get('daily'));
  function selectPane(key) {
    for (const [name, pane] of panes) {
      pane.hidden = name !== key;
      const button = paneButtons.get(name);
      button.classList.toggle('active', name === key);
      button.setAttribute('aria-selected', String(name === key)); button.tabIndex = name === key ? 0 : -1;
    }
  }
  selectPane('daily');
  const core = disclosure(panes.get('rules'), '模式与预设', '二代模式开关、使用的预设与推荐值策略');
  for (const id of ['v2Enabled', 'v2ProvideRecommendations']) core.content.append($(id).closest('.row'));
  panes.get('rules').prepend(core.detail);
  const presetLabel = $('v2AgentPreset').previousElementSibling;
  presetLabel.textContent = '使用的智能体预设';
  diagnostics.insertBefore($('v2PauseBtn').closest('.row'), diagnostics.children[1]);
  $('v2ConfigSaveTop').textContent = '保存二代参数';

  // Persistent save dock uses the original save action and its original feedback node.
  const dock = $('v2ConfigSave').closest('.save-bar');
  dock.id = 'sharedSettingsSave'; dock.classList.add('shared-save');
  dock.querySelector(':scope > .meta').textContent = '统一保存聊天习惯、语音、表情和工具权限。';
  $('v2ConfigSave').textContent = '保存设置';
  const dirtyLabel = make('strong', 'save-draft-label', '设置已同步');
  const dirtyDetail = make('span', 'meta save-draft-detail', '切换页面会保留本次修改');
  const dirtyCopy = make('div', 'save-draft-copy'); dirtyCopy.append(dirtyLabel, dirtyDetail);
  dock.prepend(dirtyCopy);
  document.querySelector('.page-footer').before(dock);
  const v2Pages = new Set(['social-v2', 'hearing', 'voice', 'expression', 'reference', 'operations']);
  // The lightweight memory panel also participates in the same serializer.
  v2Pages.add('memory');
  const dirty = new Set();
  let selectedPage = 'overview';
  const tracked = new Set([...document.querySelectorAll('input[id^="v2"],select[id^="v2"],textarea[id^="v2"],[data-v2-tool]')].filter(input => !['v2InitPromptKey', 'v2InitPromptText', 'v2MemoryKey', 'v2WakeKey', 'v2StateKey', 'v2SessionSelect'].includes(input.id)));
  const valueOf = input => input.type === 'checkbox' ? String(input.checked) : input.value;
  let savedValues = new Map();
  const snapshotValues = () => { savedValues = new Map([...tracked].map(input => [input, valueOf(input)])); };
  function updateDirty() {
    dirtyLabel.textContent = dirty.size ? `${dirty.size} 项未保存` : '设置已同步';
    dock.classList.toggle('is-dirty', dirty.size > 0);
    dock.hidden = !v2Pages.has(selectedPage) && dirty.size === 0;
    $('v2ConfigSave').classList.add('primary');
  }
  document.addEventListener('focusin', event => { if (tracked.has(event.target) && !savedValues.size) snapshotValues(); });
  const track = event => {
    const input = event.target;
    if (!tracked.has(input)) return;
    if (valueOf(input) === savedValues.get(input)) dirty.delete(input); else dirty.add(input);
    updateDirty();
  };
  document.addEventListener('input', track); document.addEventListener('change', track);
  new MutationObserver(() => {
    if (/^✅/.test($('v2ConfigMsg').textContent)) { dirty.clear(); snapshotValues(); updateDirty(); }
  }).observe($('v2ConfigMsg'), { childList: true, subtree: true });
  window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });

  const brand = document.querySelector('.brand'); brand.replaceChildren(icon('whale'));
  const brandText = make('span', '', '大肥鱼'); brandText.append(make('small', '', 'DSH OMNI · 控制台')); brand.append(brandText);
  document.querySelector('.sidebar > .nav-label').textContent = '我的伙伴';
  const nav = $('mainNav'); const pendingCount = $('pendingCount'); nav.replaceChildren();
  const subnav = make('nav', 'page-nav'); subnav.id = 'pageNav'; subnav.setAttribute('aria-label', '当前分类页面');
  document.querySelector('.page-heading').after(subnav);
  const lastPage = new Map();
  for (const [key, label, caption, views] of groups) {
    const button = make('button', 'nav-item category-button'); button.type = 'button'; button.dataset.category = key;
    const copy = make('span', 'nav-copy', label); copy.append(make('small', '', caption)); button.append(icon(key), copy); nav.append(button);
    button.addEventListener('click', () => navigate(lastPage.get(key) || views[0], { focus: true }));
    const subGroup = make('div', 'page-nav-group'); subGroup.dataset.navGroup = key;
    for (const view of views) {
      const subButton = make('button', '', pages[view][0]); subButton.type = 'button'; subButton.dataset.view = view;
      if (view === 'sessions') subButton.append(pendingCount);
      subGroup.append(subButton);
    }
    subnav.append(subGroup);
  }
  document.querySelector('.eyebrow').textContent = 'DA FEI YU / YOUR COMPANION';
  $('consoleSearch').placeholder = '搜索设置，例如「冒泡」';
  $('consoleSearch').setAttribute('aria-keyshortcuts', 'Meta+K Control+K');
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('consoleSearch').focus(); $('consoleSearch').select(); }
  });

  // Interactive illustration. The hotspots are shortcuts, never parameter changes.
  const hero = section('companionHome', 'overview', '认识一下，你的大肥鱼。');
  hero.className = 'companion-home span-all';
  const heroCopy = make('div', 'companion-copy');
  heroCopy.append(make('div', 'hero-kicker', 'A LITTLE COMPANION, A LOT OF POSSIBILITIES'), make('h2', '', '心有灵犀，\n从一点点设置开始。'), make('p', '', '她怎样看世界、听你说话、记住日常，\n都可以在这里慢慢调整。'));
  heroCopy.append(jumpButton('调整她的聊天习惯', 'social-v2'));
  const hint = make('div', 'companion-hint'); hint.append(make('span', 'hint-dot'), make('span', '', '摸摸头、碰一碰蝴蝶结，看看她的小反应'));
  heroCopy.append(hint);
  const stage = make('div', 'companion-stage'); stage.id = 'companionStage'; stage.setAttribute('aria-label', '大肥鱼互动设置导航');
  const glow = make('div', 'companion-glow'); glow.setAttribute('aria-hidden', 'true'); stage.append(glow);
  const puppet = make('div', 'companion-puppet');
  const art = make('img', 'companion-art'); art.src = '/console-assets/mascot.png'; art.alt = '长发蓝眼睛、鲸鱼女仆装的大肥鱼'; art.width = 1024; art.height = 1536; art.draggable = false;
  puppet.append(art); stage.append(puppet);
  const hotspotSpecs = [
    ['head', '思考与反应', '轻轻摸摸头；点击调整模型与思考强度。', 'runtime', 'section-dsh'],
    ['eyes', '视觉与视频', '用眼睛看图，也一起看 B 站。', 'vision', 'section-vision'],
    ['ears', '听懂语音', '听懂你发来的语音和语气。', 'hearing', 'v2AsrEnabled'],
    ['ears-left', '听懂语音', '听懂你发来的语音和语气。', 'hearing', 'v2AsrEnabled'],
    ['mouth', '声音与表达', '选一个声音，让她开口说话。', 'voice', 'v2SpeakEnabled'],
    ['heart', '性格与角色', '慢热还是活泼，由你慢慢了解。', 'persona', 'section-persona'],
    ['memory', '记忆与学习', '把一起经历的小事记下来。', 'memory', 'section-memory'],
  ];
  const hotspotCaption = make('div', 'hotspot-caption'); hotspotCaption.id = 'hotspotCaption';
  hotspotCaption.append(make('strong', '', '碰一碰，看看她的反应'), make('span', '', '悬停互动 · 点击进入设置'));
  const reaction = make('div', 'companion-reaction'); reaction.hidden = true;
  reaction.setAttribute('role', 'status'); reaction.setAttribute('aria-live', 'polite');
  stage.append(reaction);
  const rig = typeof createCompanionRig === 'function' ? createCompanionRig({
    host: puppet, stage, fallback: art,
    onReaction(text) { reaction.textContent = text; reaction.hidden = !text; },
  }) : null;
  const actionFor = key => ({ head: 'pat', eyes: 'cover', ears: 'ears', 'ears-left': 'ears', mouth: 'speak', heart: 'heart', memory: 'think' })[key];
  for (const [key, title, description, view, target] of hotspotSpecs) {
    const button = make('button', `mascot-hotspot hotspot-${key}`); button.type = 'button';
    button.dataset.view = view; button.dataset.target = target; button.dataset.hotspot = key;
    button.setAttribute('aria-label', title + '：' + description); button.setAttribute('aria-describedby', 'hotspotCaption');
    button.append(make('span', 'hotspot-ring')); puppet.append(button);
    const showHint = () => { hotspotCaption.children[0].textContent = title; hotspotCaption.children[1].textContent = description + ' 点击前往 →'; stage.dataset.activeHotspot = key; rig?.hover(actionFor(key)); };
    const clearHint = () => { hotspotCaption.children[0].textContent = '碰一碰，看看她的反应'; hotspotCaption.children[1].textContent = '悬停互动 · 点击进入设置'; delete stage.dataset.activeHotspot; rig?.hover(''); };
    button.addEventListener('pointerenter', showHint); button.addEventListener('focus', showHint);
    button.addEventListener('pointerleave', clearHint); button.addEventListener('blur', clearHint);
  }
  stage.append(hotspotCaption);
  const gestureButtons = [];
  const gestures = make('div', 'companion-gestures'); gestures.setAttribute('aria-label', '和大肥鱼互动');
  const moreGestures = make('details', 'companion-more');
  moreGestures.append(make('summary', '', '更多互动'));
  const morePanel = make('div', 'companion-more-panel'); moreGestures.append(morePanel);
  for (const [action, label, primary] of [
    ['wave', '打个招呼', true], ['pat', '摸摸头', true], ['cheer', '开心一下', true],
    ['cover', '捂眼睛'], ['ears', '动动耳朵'], ['speak', '听我说'], ['heart', '害羞一下'], ['think', '想一想'], ['yawn', '打个哈欠'],
  ]) {
    const button = make('button', '', label); button.type = 'button'; button.dataset.mascotAction = action;
    button.addEventListener('click', () => {
      rig?.play(action);
      if (!primary) { moreGestures.open = false; moreGestures.querySelector('summary').focus({ preventScroll: true }); }
    });
    (primary ? gestures : morePanel).append(button); gestureButtons.push(button);
  }
  gestures.append(moreGestures);
  moreGestures.addEventListener('keydown', event => { if (event.key === 'Escape') { moreGestures.open = false; moreGestures.querySelector('summary').focus(); } });
  document.addEventListener('pointerdown', event => { if (!moreGestures.contains(event.target)) moreGestures.open = false; });
  heroCopy.append(gestures);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motionPaused = false;
  try { motionPaused = localStorage.getItem('qq-console-mascot-paused') === 'true'; } catch {}
  const motionButton = make('button', 'mascot-motion-toggle'); motionButton.type = 'button';
  const syncMotion = () => {
    const pause = motionPaused || motion.matches;
    stage.classList.toggle('motion-paused', pause);
    motionButton.textContent = pause ? '动态已关闭' : '暂停形象动态';
    motionButton.setAttribute('aria-pressed', String(pause)); puppet.style.transform = '';
    rig?.setPaused(pause);
    gestureButtons.forEach(button => { button.disabled = pause || stage.dataset.rigReady !== 'ready'; });
  };
  motionButton.addEventListener('click', () => { motionPaused = !motionPaused; try { localStorage.setItem('qq-console-mascot-paused', String(motionPaused)); } catch {} syncMotion(); });
  motion.addEventListener('change', syncMotion); syncMotion(); stage.append(motionButton);
  new MutationObserver(syncMotion).observe(stage, { attributes: true, attributeFilter: ['data-rig-ready'] });
  stage.addEventListener('pointermove', event => {
    if (motion.matches || motionPaused || event.pointerType !== 'mouse') return;
    const rect = stage.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
    rig?.look(x, y);
  });
  stage.addEventListener('pointerleave', () => { rig?.look(0, 0); });
  hero.replaceChildren(heroCopy, stage); grid.prepend(hero);
  const quick = section('section-home-shortcuts', 'overview', '从这里，开始调整'); quick.className = 'home-shortcuts span-all';
  const quickGrid = make('div', 'quick-grid'); quick.append(quickGrid);
  for (const [key, title, desc, view] of [
    ['chat', '更懂你的聊天习惯', '主动一点，还是安静陪伴？', 'social-v2'],
    ['senses', '打开她的感官', '看图、听语音、开口说话', 'vision'],
    ['memory', '留住日常的小事', '记忆与群里的新词', 'memory'],
  ]) {
    const button = make('button', 'quick-card'); button.type = 'button'; button.dataset.view = view;
    const copy = make('span', 'quick-copy'); copy.append(make('strong', '', title), make('small', '', desc));
    button.append(icon(key), copy, icon('arrow')); quickGrid.append(button);
  }
  const homeStatus = make('div', 'home-status-actions'); homeStatus.dataset.page = 'overview';
  homeStatus.append(jumpButton('连接与运行模式', 'runtime'), jumpButton('管理会话与审批', 'sessions'), jumpButton('查看活动日志', 'operations', 'section-activity'));
  grid.append(homeStatus);

  // Human-readable tool names; technical names remain searchable in their own captions.
  const toolNames = { getPrompt: '读取角色与规则', getUnread: '查看未读消息', getRecent: '回看聊天记录', socialState: '了解当前状态', sendGroup: '发群消息', sendPrivate: '发私聊消息', reply: '引用回复', sendBurst: '分条发送', sendMessage: '发送消息', sendPoke: '拍一拍', waitMessages: '等待新消息', feedback: '报告问题', wakeConfig: '安排下次唤醒', getImages: '理解聊天图片', getMessageImages: '理解聊天图片', getStickerImage: '看懂收藏表情', sendSticker: '发送收藏表情', sendImage: '发送网络图片', collectSticker: '收藏群友表情', addSticker: '收藏网络图片', getSelfImage: '查看自己的形象', stickerNote: '记录表情含义', setStickerRemark: '修改表情备注', sendVoice: '发送语音库音频', speak: '合成语音' };
  const toolList = $('v2Tools');
  const toolSections = new Map();
  for (const label of [...toolList.children]) {
    const input = label.querySelector('input'); if (!input) continue;
    const key = input.dataset.v2Tool;
    const category = /Sticker|Image|Images/.test(key) ? '图片与表情' : /Voice|speak|sing/.test(key) ? '语音与声音' : /send|reply|wait/.test(key) ? '聊天与互动' : '状态与管理';
    if (!toolSections.has(category)) {
      const group = make('div', 'tool-category'); group.append(make('h3', '', category));
      const list = make('div', 'v2-tool-list'); group.append(list); toolSections.set(category, list);
    }
    const technical = label.querySelector('b');
    if (technical && toolNames[key]) { technical.before(make('strong', 'tool-friendly-name', toolNames[key])); technical.classList.add('tool-technical-name'); }
    toolSections.get(category).append(label);
  }
  toolList.classList.remove('v2-tool-list'); toolList.replaceChildren(...[...toolSections.values()].map(list => list.parentElement));

  // Parameter help is tied to real fields, so search, keyboard and mobile share the same explanations.
  const help = {
    v2ProactiveEnabled: '开启后，群安静一段时间，她会有机会主动醒来参与。仍受能力总开关和省电策略影响。',
    v2ProactiveProbability: '冷场时主动参与的基础概率。0.2 表示 20%。调高更容易获得主动发言机会；实际还会受夜间、近期活跃程度等影响，唤醒后也可能选择不说话。',
    v2ProactiveIdleThreshold: '群里连续多久没有新消息，才算冷场。调小会更早给她主动参与的机会。单位：分钟。',
    v2ProactiveIntervalMin: '主动机会检查间隔的下限。间隔从上下限中随机取值；越短检查越频繁，但不代表每次都会说话。单位：分钟。',
    v2ProactiveIntervalMax: '主动机会检查间隔的上限。与左侧下限一起决定随机检查的频率。单位：分钟。',
    v2Enabled: '允许二代仿真运行。实际参与聊天还取决于当前运行模式、白名单和能力总开关。',
    v2AgentPreset: '二代仿真使用的 DSH 预设名称。它决定加载哪套智能体规则；需与已安装的预设名称一致。',
    v2ProvideRecommendations: '开启后把下面的推荐值告诉 AI；这些值是建议。硬限制仍由桥接强制执行。',
    v2RecProb: '普通消息唤醒的推荐概率，0.05 表示 5%。它是给 AI 的建议，AI 可以另设自己的唤醒条件。',
    v2RecSleepMin: '推荐潜水时长的下限。调大建议她更久不参与；它是建议，和下面的硬限制不同。单位：分钟。',
    v2RecSleepMax: '推荐潜水时长的上限。AI 可以选择别的时长，但仍受唤醒硬限制约束。单位：分钟。',
    v2RecDefaultInfinite: '默认不设定时唤醒；仍可能按已启用的关键词、点名等事件唤醒。',
    v2RecKeywords: '建议在这些词出现时醒来看看。用逗号分隔；只有普通概率与关键词的配置口径不同，不要混为必回承诺。',
    v2SleepMinMs: '最短潜水时间。硬限制由桥接执行；输入单位是秒，保存时自动转为毫秒。',
    v2SleepMaxMs: '限制单次潜水最长时间。0 表示不设上限；输入单位是秒。',
    v2MaxWakeMin: '一分钟内最多允许唤醒多少次，避免过于频繁触发。0 表示不限制。',
    v2MaxWakeHour: '一小时内最多允许唤醒多少次。调低更克制，也可能延后参与。0 表示不限制。',
    v2BatchWindowMs: '把短时间内的新消息合并处理。调大可减少频繁唤醒，但参与会稍晚。单位：毫秒。',
    v2PreSleepWaitMin: '进入潜水前先观察这么久，给群友留出回复时间。0 表示不限制。单位：分钟。',
    v2PreSleepWaitEnabled: '要求 AI 在沉睡前先等待观察，避免刚说完话就立刻潜水。',
    v2NoActionLimit: 'AI 被唤醒后连续没有行动时，桥接触发兜底的次数门槛。',
    v2MaxWakeConfigReminders: 'AI 没有设置收尾唤醒条件时，最多提醒它几次。',
    v2BurstEnabled: '允许一轮回复拆成多条。二代需要 AI 显式传数组或调用分条工具，不按空格自动拆分。',
    v2BurstMax: '一次分条回复最多发几条。调低可以减少连续刷屏。',
    v2BurstMin: '两条消息间的随机等待下限。调大更像慢慢打字，发送也会更慢。单位：毫秒。',
    v2BurstMaxMs: '两条消息间的随机等待上限。与下限一起决定分条节奏。单位：毫秒。',
    v2LongGapProb: '偶尔使用更长发送间隔的概率。0.1 表示 10%，调高会更常停顿。',
    v2MaxSendMin: '每分钟发送条数上限。调低减少刷屏；0 表示不限制。',
    v2MaxSendHour: '每小时发送条数上限。0 表示不限制，调低可能使发送被限流。',
    v2MaxMsgChars: '每条消息允许的最大字符数，避免单条回复过长。',
    v2MaxGapMs: '发送间隔的硬上限，避免停顿过久。单位：毫秒。',
    v2GapBaseMs: '按字数计算发送间隔时使用的基础等待时间。单位：毫秒。',
    v2GapPerCharMs: '每多一个字追加多少发送等待时间。调高会使长消息发得更慢。单位：毫秒。',
    v2WaitDefaultMs: '等待新消息工具的默认超时时长。没有新消息时，等到这里才返回。单位：毫秒。',
    v2WaitDefaultQuietMs: '新消息后等待一段安静时间，减少在别人还没说完时抢话。单位：毫秒。',
    v2MinQuietAfterNewMs: '收到新消息后，最少再等多久才返回。调高更耐心，也会稍慢。单位：毫秒。',
    v2AutoReplyCheckSec: '发言后隔多久回来检查有没有人回复。调小检查更及时，但可能增加调用。单位：秒。',
    v2AsrEnabled: '把收到的 QQ 语音转成文字，供她理解。需要同时启用「听懂语音」能力总开关。',
    v2AsrEngine: 'SenseVoice 在本地识别并可标注语气；QQ 转写使用 QQ 能力；关闭则不转写。',
    v2AsrPreload: '启动桥接时就加载模型，首条语音更快；也会更早占用内存。',
    v2AsrIdleUnloadMin: '连续闲置这么久后释放模型内存，下次用到再加载。0 表示一直常驻。单位：分钟。',
    v2AsrThreads: '本地识别使用的 CPU 线程数。更多线程可能更快，也会增加资源占用。',
    v2AsrMaxConcurrent: '同时处理的语音数。调高可减少排队，也会增加资源消耗。',
    v2AsrMaxSeconds: '每条语音最多转写多少秒；超长音频会受此限制。',
    v2AsrTimeoutSec: '单条识别最多等待多少秒，避免识别任务长期卡住。',
    v2AsrShowEmotion: '在转写结果中附带识别到的情绪，帮助 AI 理解语气；结果可能有误。',
    v2AsrShowEvent: '在转写中标注笑声、掌声等声学事件。',
    v2AsrQqFallback: '本地识别失败时尝试 QQ 自带转写，提高可用性。',
    v2AsrLanguage: '指定语音识别语言；自动适合多种语言混用，明确语言可减少歧义。',
    v2AsrUseItn: '整理转写中的标点、数字等书面格式，提高可读性。',
    v2AsrCacheSize: '最多缓存多少条转写结果。调大可减少重复识别，也会多占内存。',
    v2SpeakEnabled: '允许 AI 把文字合成语音。还需要开启「开口说话」总开关和合成语音工具权限。',
    v2SpeakProvider: '选择负责把文字变成声音的服务。切换只展示该服务的参数；请确认地址、音色和凭证。',
    v2SpeakDailyBudget: '一天最多合成多少字符，帮助控制费用。0 表示不限制。',
    v2SpeakTrim: '裁掉语音开头和结尾的静音，让语音条更紧凑。',
    v2SpeakAllowEmotion: '允许 AI 在合成时指定情绪；实际效果取决于服务商是否支持。',
    v2SpeakAutoEnabled: '把符合长度要求的文字短句按概率换成语音条。不是每条回复都变成语音。',
    v2SpeakAutoProb: '普通短句转成语音的概率。填 5 表示 5%，调高会更常听到她说话。',
    v2SpeakAutoMirrorProb: '对方刚发过语音时，使用这个转换概率。调高更容易以语音回应语音。',
    v2SpeakAutoCooldownMin: '同一会话两次随机转语音之间至少等多久，避免连续语音刷屏。单位：分钟。',
    v2SpeakAutoPrivateOnly: '随机转换只在私聊生效，群聊仍以文字为主。',
    v2VoiceEnabled: '允许发送音频库中已有的文件；这与把文字合成语音是两种能力。',
    v2VoiceAutoReadback: '发送后自动读取回执，帮助确认 QQ 侧的语音发送结果。',
    v2StickerEnabled: '启用收藏表情的同步、备注和发送；仍受能力总开关与工具权限影响。',
    v2StickerSendProbability: 'AI 决定发表情后，再按这个概率放行。填 30 表示 30%，100 表示每次都放行。',
    v2StickerSyncTtlSec: '收藏表情列表缓存多久。调小更新更及时，但会更频繁查询 QQ。单位：秒。',
    v2StickerPromptMax: '向 AI 主动展示多少个常用表情。更多选择会增加上下文消耗。',
    v2StickerIncludePrompt: '主动把表情摘要放进上下文。关闭后仍可通过工具查找表情。',
    v2StickerCollectEnabled: '允许 AI 收藏群友发来的表情，仍受收藏频率限制。',
    v2StickerNudgeAfterSend: '文字回复满足字数或情绪条件时，提醒 AI 可以补一张表情；不会保证一定发送。',
    v2ContextRecentLimit: '读取最近聊天记录时最多返回多少条。调高可以看到更多历史，也会增加上下文消耗。',
    v2ContextUnreadLimit: '一次最多返回多少条未读消息。调高可覆盖更多未读，也会增加上下文消耗。',
    v2ContextWindow: '附带给 AI 的聊天上下文条数。调高有助于连贯理解，也会增加 token 消耗。',
    sProactiveProb: '一代仿真在满足冷场条件后主动开话题的成功概率。0.2 表示 20%，调高更容易开口。',
    sTrigger: '观望期遇到普通消息时进入活跃的概率。调高会更积极参与一代群聊。',
    sSkipProb: '普通消息选择不回复的概率。调高会更安静，仅作用于一代仿真。',
    sSurrenderProb: '发生抬杠时选择退让的概率。调高更少继续争论，仅作用于一代仿真。',
    roleInjectMax: '每次最多注入多少角色文本。调高可保留更多设定，也会增加上下文用量。',
    powerPauseProactive: '离电时暂停主动冒泡，减少后台唤醒。插电后按原策略恢复。',
    powerEnabled: '离电时按此页选择的能力执行省电策略。文字核心聊天始终可用。',
    powerBatteryEffort: '离电时临时降低或调整思考强度，插电后恢复已配置档位。',
  };
  const fieldLabel = input => input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim() || input.placeholder || input.id;
  let helpCounter = 0;
  let syncProactiveImpact = () => {};
  const tooltip = make('div', 'parameter-tooltip'); tooltip.id = 'parameterTooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true; document.body.append(tooltip);
  let tooltipAnchor, tooltipTimer;
  function hideHelp() { tooltip.hidden = true; tooltipAnchor?.setAttribute('aria-expanded', 'false'); tooltipAnchor = null; }
  function showHelp(button, text) {
    clearTimeout(tooltipTimer); tooltipAnchor = button; tooltip.textContent = text; tooltip.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const rect = button.getBoundingClientRect();
    const top = rect.bottom + 8;
    tooltip.style.left = Math.max(12, Math.min(innerWidth - tooltip.offsetWidth - 12, rect.left - 12)) + 'px';
    tooltip.style.top = (top + tooltip.offsetHeight > innerHeight - 12 ? Math.max(12, rect.top - tooltip.offsetHeight - 8) : top) + 'px';
  }
  function helpFor(input) {
    if (help[input.id]) return help[input.id];
    const label = fieldLabel(input);
    if (input.type === 'password') return '服务访问凭证。留空保持已保存的值；控制台不会回显完整凭证。';
    if (/ApiKeyEnv$/.test(input.id)) return '从该环境变量读取凭证，减少把密钥直接写进配置文件的需要。';
    if (/Url$|Endpoint$/.test(input.id)) return '服务的请求地址。修改后会连接到这个服务；请与所选引擎或服务商的地址对应。';
    if (/probability|概率/i.test(label)) return label.includes('%') ? '按百分比填写。0 表示不触发，100 表示每次都触发；还需满足当前分组的其他条件。' : '按 0 到 1 填写。0.1 表示 10%，调高更容易触发当前行为；还需满足其他条件。';
    if (/timeout|超时/i.test(label)) return '等待这项操作完成的最长时间。调大更能容忍慢任务，也会在失败时等待更久。' + (/秒/.test(label) ? '单位：秒。' : '请按字段标注的单位填写。');
    if (/缓存/.test(label)) return '控制此分组的缓存量或缓存时长。增大可减少重复处理，也可能增加资源占用或延迟刷新。';
    if (/每分钟|每小时|上限|最多|最大/.test(label)) return '限制「' + label.replace(/（.*?）/g, '') + '」。调低更节制，达到上限时相关操作会受限。' + (input.min === '0' ? '0 的含义以字段标注为准。' : '');
    if (/目录|路径|Python/.test(label)) return '此功能读取的本机资源位置。修改前确认文件或目录存在；不会自动下载或创建模型。';
    if (/启用|允许/.test(label)) return '控制当前分组中的「' + label + '」。能力总开关、工具权限与当前模式仍共同决定是否可用。';
    return '此项用于「' + (input.closest('details')?.querySelector('summary')?.childNodes[0]?.textContent || input.closest('section')?.querySelector('h2')?.textContent || '当前功能') + '」。' + (input.type === 'number' ? '按标注单位填写，修改后需要保存才会生效。' : '修改后使用本分组的保存按钮应用。');
  }
  function enhanceHelp() {
    // Run after the legacy accessible-name pass, so paired limits retain precise names.
    document.querySelectorAll('.settings-content .row,.voice-settings .row,#section-social-v2 > .row,#section-social-v1 > .row').forEach(row => {
      const labels = [...row.children].filter(child => child.tagName === 'LABEL' && !child.querySelector('input,select,textarea'));
      if (!labels.length) return;
      const fields = [];
      for (const label of labels) {
        const nodes = [label];
        let node = label.nextSibling;
        while (node && !(node.nodeType === 1 && node.tagName === 'LABEL')) { nodes.push(node); node = node.nextSibling; }
        const controls = nodes.filter(node => node.nodeType === 1 && node.matches('input,select,textarea'));
        if (!controls.length) continue;
        const field = make('div', 'setting-field');
        if (controls.length === 1 && controls[0].type === 'checkbox') field.classList.add('is-switch');
        label.before(field); field.append(...nodes); fields.push(field);
      }
      if (fields.length) { row.classList.add('setting-row'); if (fields.length === 1) row.classList.add('single-field'); }
    });
    document.querySelectorAll('section input,section select,section textarea').forEach(input => {
      if (input.dataset.helpReady || input.closest('.v2-tool-item') || !input.id) return;
      input.dataset.helpReady = 'true';
      const text = helpFor(input);
      const helpId = `setting-help-${++helpCounter}`;
      const description = make('span', 'sr-only', text); description.id = helpId;
      input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), helpId].filter(Boolean).join(' '));
      const button = make('button', 'help-trigger', '?'); button.type = 'button';
      button.setAttribute('aria-label', '了解' + fieldLabel(input)); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-describedby', helpId);
      input.after(button, description);
      button.addEventListener('pointerenter', () => { clearTimeout(tooltipTimer); tooltipTimer = setTimeout(() => showHelp(button, text), 220); });
      button.addEventListener('pointerleave', () => { clearTimeout(tooltipTimer); if (document.activeElement !== button) hideHelp(); });
      button.addEventListener('focus', () => showHelp(button, text)); button.addEventListener('blur', hideHelp);
      button.addEventListener('click', () => showHelp(button, text));
      if (['v2ProactiveProbability', 'v2AsrIdleUnloadMin', 'v2SpeakAutoProb', 'v2StickerSendProbability'].includes(input.id)) {
        const note = make('p', 'inline-impact', text); input.closest('.row')?.after(note);
      }
    });
    const probability = $('v2ProactiveProbability');
    const preview = make('div', 'probability-preview'); preview.id = 'proactiveImpact';
    const meter = make('span', 'probability-meter'); const fill = make('i'); meter.append(fill);
    const copy = make('span'); preview.append(meter, copy); probability.closest('.row').after(preview);
    const sync = () => { const pct = Math.round(Math.max(0, Math.min(1, Number(probability.value) || 0)) * 100); fill.style.transform = `scaleX(${pct / 100})`; copy.textContent = `基础机会 ${pct}% · ${pct === 0 ? '不由主动机会唤醒' : pct < 25 ? '偏安静地陪伴' : pct < 60 ? '偶尔主动找话题' : '更积极地参与'}`; };
    syncProactiveImpact = sync;
    probability.addEventListener('input', sync);
    new MutationObserver(sync).observe($('v2ActivityStatus'), { childList: true, subtree: true }); sync();
  }
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { clearTimeout(tooltipTimer); hideHelp(); } });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.help-trigger')) hideHelp(); });
  window.addEventListener('scroll', hideHelp, true); window.addEventListener('resize', hideHelp);
  const aliases = { v2ProactiveProbability: '冒泡 冷群 冷场 主动 说话 概率', v2AsrEngine: '耳朵 听力 ASR 语音 转文字', v2SpeakProvider: '嘴巴 TTS 声音 音色', v2StickerSendProbability: '表情 发送 概率', v2RecSleepMin: '潜水 休息 安静' };
  return {
    pages,
    enhanceHelp,
    configLoaded() { if (!dirty.size) snapshotValues(); syncProactiveImpact(); },
    searchText(input) { return [help[input.id] || '', aliases[input.id] || ''].join(' '); },
    reveal(input) {
      const pane = input.closest('[data-setting-pane]'); if (pane) selectPane(pane.dataset.settingPane);
      let ancestor = input.closest('details');
      while (ancestor) { ancestor.open = true; ancestor = ancestor.parentElement.closest('details'); }
    },
    show(page, target) {
      hideHelp();
      selectedPage = page;
      if (page !== 'overview') moreGestures.open = false;
      rig?.setVisible(page === 'overview');
      const category = pageGroup[page]; lastPage.set(category, page);
      document.querySelectorAll('[data-category]').forEach(button => { const selected = button.dataset.category === category; button.classList.toggle('active', selected); if (selected) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current'); });
      document.querySelectorAll('[data-nav-group]').forEach(group => { group.hidden = group.dataset.navGroup !== category; });
      subnav.querySelectorAll('[data-view]').forEach(button => { const selected = button.dataset.view === page; button.classList.toggle('active', selected); if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
      dock.hidden = !v2Pages.has(page) && dirty.size === 0;
      document.body.dataset.consolePage = page;
      if (target && $(target)) this.reveal($(target));
      if (page === 'hearing' || page === 'voice') refreshVoice?.();
    },
  };
};
