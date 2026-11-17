// Exercise public UI resources through the real console server and auth guards.
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const harness = await bridgeHarness({ files: {
  'public/console.html': '<!doctype html><title>Authenticated console fixture</title>',
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

  // Execute the actual unauthenticated landing page: saved credentials must still
  // pass server authentication, and stale credentials must not redirect forever.
  const runLogin = (html, { saved = null, search = '', answer = null, storageBlocked = false } = {}) => {
    const storage = new Map(saved === null ? [] : [['consoleToken', saved]]);
    const redirects = [];
    let prompts = 0;
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
      URLSearchParams,
      location: { search, hash: '#roles', replace: url => redirects.push(url) },
      localStorage: {
        getItem: key => { if (storageBlocked) throw new Error('Storage blocked'); return storage.get(key) ?? null; },
        removeItem: key => { if (storageBlocked) throw new Error('Storage blocked'); storage.delete(key); },
      },
      prompt: () => { prompts++; return answer; },
    });
    return { redirects, prompts, storage };
  };
  const landing = await request('/');
  assert.equal(landing.status, 401);
  assert(!landing.body.includes('fixture-console-token'), 'Login page must not embed server credentials');
  const remembered = runLogin(landing.body, { saved: 'fixture-console-token' });
  assert.equal(remembered.prompts, 0, 'Remembered login should not prompt');
  assert.deepEqual(remembered.redirects, ['/?token=fixture-console-token#roles']);
  const consolePage = await request(remembered.redirects[0].split('#')[0]);
  assert.equal(consolePage.status, 200, 'Saved token must authenticate through the server');
  assert(consolePage.body.includes('Authenticated console fixture'));

  const stalePage = await request('/?token=expired-token');
  assert.equal(stalePage.status, 401);
  const expired = runLogin(stalePage.body, { saved: 'expired-token', search: '?token=expired-token' });
  assert.equal(expired.prompts, 1);
  assert.equal(expired.storage.has('consoleToken'), false);
  assert.deepEqual(expired.redirects, [], 'Cancelled expired login must not loop');
  const firstLogin = runLogin(landing.body, { answer: '  fixture-console-token  ' });
  assert.equal(firstLogin.prompts, 1);
  assert.deepEqual(firstLogin.redirects, remembered.redirects);
  const blockedStorage = runLogin(landing.body, { storageBlocked: true, answer: 'fixture-console-token' });
  assert.equal(blockedStorage.prompts, 1);
  assert.deepEqual(blockedStorage.redirects, remembered.redirects);
  assert.deepEqual(runLogin(landing.body, { answer: '  ' }).redirects, []);
  console.log('PASS Saved console login, expired-token recovery, first login and blocked storage.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await harness.close();
}
