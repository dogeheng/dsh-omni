// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - 搜索：优先走 **DSH 同一路 DeepSeek 联网搜索**（src/web-search.js：同一端点/模型/
//   服务端 web_search 工具，凭据取 config/env/DSH 的 .credentials.yaml），
//   不可用时回退 Bing（RSS 优先）。搜索词不再默认发给 Bing。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import path from 'node:path';
import { safeFetch } from './safe-fetch.js';
import { webSearch } from './web-search.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * 项目根目录（用于读 config.json 的 webSearch 段）。
 *
 * 不能用 `import.meta.url`：离线测试会把本文件塞进 vm 上下文执行（那里没有 import.meta，
 * 直接是语法错误）。DSH 以 `node <本文件绝对路径>` 启动 MCP，所以 argv[1] 就是本文件；
 * 取它的上一级 `src/` 的父目录即可。取不到时退回 cwd（测试环境正好从仓库根运行）。
 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const server = new McpServer({ name: 'web-search-safe', version: '0.2.0-r4' });

server.tool(
  'web_search',
  '只读联网搜索：优先使用与 DSH 相同的 DeepSeek 联网搜索（结果更准、不把群里的词发给搜索引擎广告网络），不可用时自动回退 Bing。返回标题/URL/摘要，不执行任何本地操作。适合查网络用语、梗、事实性问题和热点。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗/事实性问题') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await webSearch(clean, { root: projectRoot() });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

/**
 * 图片直链搜索（Bing 图片，adlt=strict）。
 *
 * 只返回外链 URL，不下载、不落盘 —— 真正发送时由 qq_send_image 走桥接的
 * safeFetchBuffer（SSRF / 体积 / 图片魔数校验）。Bing 的图片结果是异步片段，
 * 直接解析 HTML 里的 murl 字段；拿不到就返回空数组，由调用方决定换关键词。
 */
async function imageSearchBing(query, count) {
  const url = 'https://www.bing.com/images/async?q=' + encodeURIComponent(query)
    + '&first=0&count=35&adlt=strict&mmasync=1';
  const result = await safeFetch(url);
  const html = typeof result === 'string' ? result : (result.text || result.body || '');
  const out = [];
  const seen = new Set();
  const patterns = [
    /murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/g,
    /"murl":"(https?:\/\/[^"]+?)"/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(html)) && out.length < count) {
      const imageUrl = match[1].replace(/&amp;/g, '&').replace(/\\\//g, '/');
      if (!/^https?:\/\//.test(imageUrl) || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      out.push(imageUrl);
    }
  }
  return out;
}

server.tool(
  'web_image_search',
  '只读图片搜索：返回图片直链（Bing 图片，成人过滤 strict），不下载、不落盘。'
    + '适合找表情包/梗图/参考图。拿到 URL 后用 mcp__snowluma__qq_send_image 发到 QQ（桥接会再做一次 SSRF/体积/格式校验）。'
    + '不要发 NSFW、血腥、政治敏感或来路不明的图。',
  {
    query: z.string().describe('图片搜索关键词，例如“猫猫 表情包”'),
    count: z.number().optional().describe('返回几条直链（默认 8，最多 20）'),
  },
  async ({ query, count }) => {
    const clean = sanitizeQuery(query);
    const want = Math.min(20, Math.max(1, Math.round(Number(count) || 8)));
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const images = await imageSearchBing(clean, want);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query: clean, count: images.length, images }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `图片搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
