import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Only these shipped, non-sensitive UI files are public. Never resolve request paths.
const ASSETS = new Map([
  ['/console-assets/experience.css', ['experience.css', 'text/css; charset=utf-8']],
  ['/console-assets/experience.js', ['experience.js', 'text/javascript; charset=utf-8']],
  ['/console-assets/companion-rig.js', ['companion-rig.js', 'text/javascript; charset=utf-8']],
  ['/console-assets/mascot.png', ['mascot.png', 'image/png']],
  ['/console-assets/mascot-body.png', ['mascot-body.png', 'image/png']],
  ['/console-assets/mascot-parts.png', ['mascot-parts.png', 'image/png']],
  ['/console-assets/mascot-expression.png', ['mascot-expression.png', 'image/png']],
]);

export function serveConsoleAsset(req, res, pathname, publicDir, headers = {}) {
  const asset = ASSETS.get(pathname);
  if (req.method !== 'GET' || !asset) return false;
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  try {
    const body = readFileSync(join(publicDir, 'console-assets', asset[0]));
    res.writeHead(200, { ...normalizedHeaders, 'content-type': asset[1], 'content-length': body.length,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(body);
  } catch {
    res.writeHead(404, { ...normalizedHeaders, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Console asset not found');
  }
  return true;
}
