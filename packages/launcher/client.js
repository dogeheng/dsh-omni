/**
 * dsh-omni-launcher —— 浏览器半端
 *
 * 在「设置」里加一页「dsh-omni」，三个按钮直接打开本机的三个服务：
 *   · QQ 扫码桌面（noVNC，VNC 密码写进 URL，打开即连）
 *   · SnowLuma 管理面板（浏览器登录态会记住）
 *   · 桥接控制台（令牌写进 URL，页面会存进 localStorage）
 *
 * 三个服务都只监听 127.0.0.1，这个页面不代理、不转发任何请求。
 * 地址/凭据变了，只改下面三个常量即可。
 */
window.__ModuleLoader__.load({
  id: 'dsh-omni-launcher',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState } = React;

    // ── 入口常量（改这里就行）──────────────────────────────────────────────
    // 安装脚本（scripts/install.mjs）会把这两个占位符替换成本机实际地址。
    // 仓库里永远不写死密码/token。
    const VNC_URL = '__DSH_OMNI_VNC_URL__';
    const SNOWLUMA_URL = 'http://127.0.0.1:5099/';
    const CONSOLE_URL = '__DSH_OMNI_CONSOLE_URL__';

    const ITEMS = [
      {
        id: 'desktop',
        title: 'QQ 扫码桌面',
        port: '6081',
        desc: '容器里的 QQ 登录桌面。二维码过期就点窗口里的「刷新」，手机 QQ 扫码即可登录。',
        note: 'VNC 密码不写进链接；用部署时 .env 里的 VNC_PASSWD 手动输入一次。',
        url: VNC_URL,
      },
      {
        id: 'snowluma',
        title: 'SnowLuma 管理面板',
        port: '5099',
        desc: '看账号状态、OneBot 连接、实时日志和运行配置。',
        note: '浏览器会记住登录态；首次需要你用自己设的面板密码登录一次。',
        url: SNOWLUMA_URL,
      },
      {
        id: 'console',
        title: '桥接控制台',
        port: '3100',
        desc: '白名单、唤醒参数、人格、令牌与花费看板。',
        note: '控制台令牌不写进链接；从 data/console-token 读出后粘贴一次，页面会记住。',
        url: CONSOLE_URL,
      },
    ];

    const CSS = [
      '.qqb-page{max-width:840px;padding:4px 2px 28px;font-size:13px;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.qqb-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:18px}',
      '.qqb-logo{flex:0 0 auto;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2,#f3f4f6)}',
      '.qqb-title{font-size:16px;font-weight:600;margin:0 0 4px}',
      '.qqb-sub{margin:0;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.65}',
      '.qqb-list{display:grid;gap:10px}',
      '.qqb-card{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:10px;padding:14px 16px;display:flex;gap:14px;justify-content:space-between;align-items:flex-start}',
      '.qqb-main{min-width:0;flex:1}',
      '.qqb-card-title{font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:8px}',
      '.qqb-port{font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#6b7280);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:999px;padding:2px 7px}',
      '.qqb-desc{color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.6;margin:0 0 6px}',
      '.qqb-url{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-all;margin:0}',
      '.qqb-actions{display:flex;flex-direction:column;gap:6px;flex:0 0 auto}',
      '.qqb-btn{border:0;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:500;cursor:pointer;background:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-bg-base,#fff);white-space:nowrap}',
      '.qqb-btn:hover{filter:brightness(1.06)}',
      '.qqb-btn.qqb-ghost{background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);border:1px solid var(--dsw-alias-border-l1,#e5e7eb)}',
      '.qqb-note{margin-top:16px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.75;font-size:12px}',
      '.qqb-note code{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border-radius:4px;padding:1px 5px}',
    ].join('\n');

    function Logo() {
      return h('svg', {
        width: 40, height: 40, viewBox: '0 0 40 40', 'aria-hidden': true,
      },
      h('rect', { x: 0, y: 0, width: 40, height: 40, rx: 10, fill: '#12B7F5' }),
      h('path', {
        d: 'M11 15.5c0-3 3.2-5.5 7.2-5.5h3.6c4 0 7.2 2.5 7.2 5.5S25.8 21 21.8 21h-1.1l-3.2 3v-3.2c-3.6-.4-6.5-2.6-6.5-5.3z',
        fill: '#fff',
      }),
      h('circle', { cx: 17, cy: 15.5, r: 1.5, fill: '#12B7F5' }),
      h('circle', { cx: 23, cy: 15.5, r: 1.5, fill: '#12B7F5' }),
      );
    }

    function Card({ item }) {
      const [copied, setCopied] = useState(false);
      const open = () => {
        try { window.open(item.url, '_blank', 'noopener,noreferrer'); } catch (error) { /* 浏览器拦截时用户可手动复制 */ }
      };
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(item.url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (error) { /* 剪贴板不可用时忽略 */ }
      };
      return h('div', { className: 'qqb-card' },
        h('div', { className: 'qqb-main' },
          h('div', { className: 'qqb-card-title' }, item.title, h('span', { className: 'qqb-port' }, ':' + item.port)),
          h('p', { className: 'qqb-desc' }, item.desc),
          h('p', { className: 'qqb-url' }, item.url),
        ),
        h('div', { className: 'qqb-actions' },
          h('button', { type: 'button', className: 'qqb-btn', onClick: open }, '打开'),
          h('button', { type: 'button', className: 'qqb-btn qqb-ghost', onClick: copy }, copied ? '已复制' : '复制地址'),
        ),
      );
    }

    function Panel() {
      return h('div', { className: 'qqb-page' },
        h('div', { className: 'qqb-head' },
          h('div', { className: 'qqb-logo' }, h(Logo)),
          h('div', null,
            h('h3', { className: 'qqb-title' }, 'QQ 桥接'),
            h('p', { className: 'qqb-sub' }, '本机的三个入口：扫码登录、SnowLuma 管理面板、桥接控制台。凭据已内置，点「打开」即可。'),
          ),
        ),
        h('div', { className: 'qqb-list' }, ITEMS.map((item) => h(Card, { key: item.id, item }))),
        h('p', { className: 'qqb-note' },
          '三个服务都只监听 ', h('code', null, '127.0.0.1'), '，这个页面只提供快捷入口，不代理任何请求。',
          '地址或密码变了，改插件 ', h('code', null, 'client.js'), ' 顶部的三个常量即可。',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'dsh-omni-launcher');
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'dsh-omni-launcher: styles');
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-omni-launcher', order: 18, label: 'dsh-omni' },
          () => h(Panel),
        ));
      },
    };
  },
});
