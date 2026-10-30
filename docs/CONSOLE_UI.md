# 大肥鱼控制台界面

界面保留所有原有控件、事件和 API，前端只重组它们的位置。没有迁移配置格式，也没有改变聊天、唤醒、语音、记忆或权限策略。

## 导航

| 主分类 | 页内入口 |
| --- | --- |
| 总览 | 互动角色、连接摘要、会话与审批 |
| 聊天与性格 | 性格与角色、二代聊天习惯、一代仿真 |
| 感知与表达 | 视觉与视频、语音识别、声音与唱歌、表情、工具权限 |
| 记忆与学习 | 长期记忆、黑话词库 |
| 运行与安全 | 连接与模式、用量、访问安全、电源性能、调试维护 |

聊天习惯分成日常参与、回复节奏、边界资源、会话设置四个平行分区。性能参数、发送限制等次要选项折叠显示。每个原有配置控件仍常驻 DOM，切页不销毁草稿。

## 角色与帮助

首页头顶、眼睛、两侧耳朵、嘴巴、蝴蝶结和围裙是可键盘聚焦的按钮。悬停/聚焦显示说明并触发角色反应，点击或 Enter 前往设置；经过角色不会自动切页，也不会修改参数。

角色使用分层 2D 绑定：底图、表情、左右耳朵、两侧上臂和前臂分别绘制。两关节反向运动学控制手掌位置，临界阻尼弹簧让动作能中途转向。实际为自定义 Canvas 2D 角色绑定，未使用 Cubism SDK 或 `.moc3` 模型。

| 触发 | 角色反应 | 点击前往 |
| --- | --- | --- |
| 首次进入首页 / 打招呼 | 抬手挥动、微笑 | — |
| 头顶 | 闭眼、歪头、抬手贴近脸颊 | 模型与思考强度 |
| 眼睛 | 双手捂眼 | 视觉与视频 |
| 两侧耳朵 | 耳朵独立摆动 | 语音识别 |
| 嘴巴 | 嘴巴开合、抬手回应，仅视觉反馈 | 声音与唱歌 |
| 蝴蝶结 | 缩肩、收拢双手、脸红 | 性格与角色 |
| 围裙 | 歪头、抬手到下巴附近思考 | 长期记忆 |
| 开心一下 | 双手举起、闭眼笑、轻轻弹动 | — |
| 打哈欠 | 闭眼、一只手遮住嘴巴 | — |

待机时每隔约 3～5 秒自然眨眼。常用的打招呼、摸头与开心动作直接显示，其余集中在「更多互动」菜单；触屏同样可用。动作不会调用语音合成或发送 QQ 消息。

可暂停动态，系统减少动态效果设置优先。离开首页、移出视口或切到后台时暂停绘制。动作素材加载失败时退回完整的原立绘，设置入口仍可用。

参数旁的问号支持悬停、聚焦或点按，Escape 或点到别处关闭。说明也通过 `aria-describedby` 关联到输入框。冒泡概率等常用参数有直接可见的影响说明。搜索覆盖说明、技术字段名和“冒泡”等别名，能打开折叠分组与隐藏分区。支持 Cmd/Ctrl+K。

二代设置使用原来的完整序列化函数统一保存，包括跨页面的聊天、语音、表情和工具权限。草稿提示在其他分类也可见。功能总开关、长期记忆和角色等原本独立保存的设置继续使用各自按钮。

## 代码与兼容

- `packages/bridge/public/console-assets/experience.js`：信息结构、角色热点、参数帮助和草稿提示。
- `packages/bridge/public/console-assets/experience.css`：视觉、响应式、深浅主题与动效。
- `packages/bridge/public/console-assets/companion-rig.js`：贴图分层、手臂关节、耳朵摆动、动作状态与渲染生命周期。
- `packages/bridge/src/console-assets.js`：仅公开明确列出的 UI 文件，禁止按请求路径读取任意文件；Host 限制和管理 API 鉴权继续执行。
- `packages/bridge/public/console.html`：原有业务逻辑、表单与保存行为。

原本运行着的旧桥接尚未认识静态资源路由时，HTML 自动保留原版界面。更新后正常重启桥接即可使用新界面，无需修改用户配置。

修复了原代码 `collectVoiceIoForm()` 中 `speak` 未定义导致二代设置保存失败的问题，补全五种语音服务商的表单收集，保留凭证脱敏占位及所有单位换算。

## 验证

离线预览：`npm --prefix packages/bridge run preview:console`。监听 `127.0.0.1:4173`，数据全部为内存中的示例，保存及试发不会访问真实 QQ 或 DSH。

浏览器测试：`npm --prefix packages/bridge run test:console-ui`。如环境没有 Playwright，指定 `PLAYWRIGHT_MODULE` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。覆盖所有源 HTML 控件保留、历史载荷、现代语音字段、模式/角色/权限、17 个页面、手机和平板布局、深色、减少动态效果、热点、帮助、搜索、跨页保存及旧服务回退。

资源安全测试：`node packages/bridge/scripts/test-console-assets.mjs`。从真实控制台服务器验证 MIME、Host、路径、方法以及管理 API 鉴权。

动作测试：`node packages/bridge/scripts/test-console-character.mjs`，使用相同 Playwright 环境变量。检查实际画面变化、打招呼、捂眼、两侧耳朵、快速中断、暂停、后台停止绘制、减少动态效果及素材失败回退；加入 `--video` 保存动作录像。

全量审计在本机存在已在改版基线 `ce50ad9` 中复现的既有失败：`test-audit-bridge`（表情及 macOS 临时目录别名）、`test-voice`（目录别名）、`test-audit-setup-guards`（Windows CRLF）、`test-preset-prompt`（CRLF）、`test-voice-system`（旧断言及缺失文档）、`test-console-encoding`（macOS 无 chcp）、`test-preset-local-tools`（未配置 DSH 安装目录）。这些不计作通过，未为消除失败修改其业务实现。

设计参考：[Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout) 与 [Disclosure Controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)。角色由内置 imagegen 生成，提示词记录在 `console-assets/mascot-generation.json` 、`console-assets/mascot-rig-generation.json` 和 `console-assets/mascot-expression-generation.json`。原立绘、分层底图和部件图集均保留原始 PNG。
