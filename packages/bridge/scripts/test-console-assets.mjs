// Exercise public UI resources through the real console server and auth guards.
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const harness = await bridgeHarness({ files: {
  'public/console-assets/experience.js': 'window.consoleAssetFixture = true;',
  'public/console-assets/experience.css': 'body { color: navy; }',
  'public/console-assets/companion-rig.js': 'window.fixtureRig = true;',
  'public/console-assets/mascot.png': 'fixture-png',
  'public/console-assets/mascot-body.png': 'fixture-png',
  'public/console-assets/mascot-parts.png': 'fixture-png',
  'public/console-assets/mascot-expression.png': 'fixture-png',
} });
const server = harness.startConsoleServer();
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;
const request = (path, { method = 'GET', host = `127.0.0.1:${port}`, token } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path, method,
    headers: { Host: host, ...(token ? { 'x-console-token': token } : {}) } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject); req.end();
});
try {
  for (const [name, type] of [['experience.js', 'text/javascript'], ['companion-rig.js', 'text/javascript'], ['experience.css', 'text/css'], ['mascot.png', 'image/png'], ['mascot-body.png', 'image/png'], ['mascot-parts.png', 'image/png'], ['mascot-expression.png', 'image/png']]) {
    const response = await request('/console-assets/' + name);
    assert.equal(response.status, 200, name);
    assert(response.headers['content-type'].startsWith(type));
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert(!response.body.includes('fixture-console-token'), 'Assets must contain no credentials');
  }
  for (const path of ['/', '/api/status', '/console-assets/config.json', '/console-assets/../config.json', '/console-assets/%2e%2e/config.json']) {
    assert.equal((await request(path)).status, 401, path + ' must retain authentication');
  }
  assert.equal((await request('/console-assets/experience.js', { method: 'POST' })).status, 401);
  assert.equal((await request('/console-assets/experience.js', { host: 'evil.example' })).status, 403);
  assert.equal((await request('/api/status', { token: 'fixture-console-token' })).status, 200);
  console.log('PASS Shipped assets load without credentials; Host, API auth, method and path boundaries remain intact.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await harness.close();
}
