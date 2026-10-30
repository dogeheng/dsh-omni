#!/usr/bin/env node
// Real rendered animation checks; only the isolated in-memory console fixture.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = resolve(process.argv.find(arg => arg.startsWith('--artifacts='))?.slice(12) || resolve(tmpdir(), 'dsh-character'));
await mkdir(artifacts, { recursive: true });
const fixture = await startConsoleFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, ...(process.argv.includes('--video') ? { recordVideo: { dir: artifacts, size: { width: 1440, height: 1000 } } } : {}) });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url);
  await page.waitForSelector('#companionStage[data-rig-ready="ready"]');
  assert.equal(await page.locator('#companionStage').getAttribute('data-expressions-ready'), 'ready');
  const frame = () => page.locator('.companion-canvas').evaluate(canvas => canvas.toDataURL());
  const shot = name => page.locator('#companionStage').screenshot({ path: resolve(artifacts, name + '.png') });
  await page.waitForSelector('#companionStage[data-pose="wave"]');
  const waveStart = await frame();
  await page.waitForTimeout(750); // Sample the middle of the two-joint greeting.
  assert.notEqual(await frame(), waveStart, 'Greeting must change rendered pixels, not only a CSS/data state');
  await shot('wave');
  await page.waitForSelector('#companionStage[data-pose="idle"]');
  await page.waitForTimeout(650);
  const idle = await frame();
  await shot('idle');
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.companion-canvas');
    const pixel = canvas.getContext('2d').getImageData(Math.round(395 / 1024 * canvas.width), Math.round(580 / 1536 * canvas.height), 1, 1).data;
    return document.getElementById('companionStage').dataset.pose === 'idle' && pixel[0] - pixel[2] > 20;
  }, undefined, { timeout: 6000 }); // Eyelid skin actually replaces the blue iris during an idle blink.
  await page.locator('[data-hotspot="eyes"]').hover();
  await page.waitForSelector('#companionStage[data-pose="cover"]');
  await page.waitForTimeout(800);
  assert.notEqual(await frame(), idle);
  await shot('cover-eyes');
  assert.equal(fixture.requests.length, 0, 'Hover gestures never write settings');
  for (const side of ['ears', 'ears-left']) {
    await page.locator(`[data-hotspot="${side}"]`).hover();
    await page.waitForSelector('#companionStage[data-pose="ears"]');
    const first = await frame();
    await page.waitForTimeout(160);
    assert.notEqual(await frame(), first, 'Ear joints must animate');
  }
  await shot('ears');
  for (const [hotspot, pose] of [['head', 'pat'], ['mouth', 'speak'], ['heart', 'heart'], ['memory', 'think']]) {
    await page.locator(`[data-hotspot="${hotspot}"]`).hover();
    await page.waitForSelector(`#companionStage[data-pose="${pose}"]`);
    await page.waitForTimeout(750);
    assert.notEqual(await frame(), idle, `${pose} must change the character's rendered pose`);
    await shot(pose);
  }
  for (const pose of ['cheer', 'yawn']) {
    if (pose === 'yawn') await page.locator('.companion-more>summary').click();
    await page.locator(`[data-mascot-action="${pose}"]`).click();
    await page.waitForSelector(`#companionStage[data-pose="${pose}"]`);
    await page.waitForTimeout(750);
    await shot(pose);
  }
  // Rapidly reverse a gesture, then leave. No queued pose should return later.
  await page.locator('[data-hotspot="eyes"]').hover();
  await page.mouse.move(900, 450);
  await page.waitForSelector('#companionStage[data-pose="idle"]');
  await page.waitForTimeout(750);
  assert.equal(await page.locator('#companionStage').getAttribute('data-pose'), 'idle');
  if (!await page.locator('[data-mascot-action="cover"]').isVisible()) await page.locator('.companion-more>summary').click();
  await page.locator('[data-mascot-action="cover"]').click();
  await page.waitForSelector('#companionStage[data-pose="cover"]');
  await page.locator('.mascot-motion-toggle').click();
  const stopped = await frame();
  await page.waitForTimeout(200);
  assert.equal(await frame(), stopped, 'Pause stops drawing and returns to a neutral pose');
  await page.locator('[data-hotspot="ears"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.body.dataset.consolePage), 'hearing', 'Keyboard navigation survives paused animation');
  await page.locator('[data-category="home"]').click();
  await page.locator('.mascot-motion-toggle').click();
  await page.locator('[data-mascot-action="wave"]').click();
  await page.locator('[data-category="system"]').click();
  const hidden = await frame();
  await page.waitForTimeout(200);
  assert.equal(await frame(), hidden, 'Hidden page must stop the render loop');
  const calm = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  const calmPage = await calm.newPage(); await calmPage.goto(fixture.url);
  await calmPage.waitForSelector('#companionStage[data-rig-ready="ready"]');
  assert.equal(await calmPage.locator('#companionStage').getAttribute('data-pose'), 'idle');
  assert(await calmPage.locator('[data-mascot-action="wave"]').isDisabled());
  const calmFrame = await calmPage.locator('.companion-canvas').evaluate(canvas => canvas.toDataURL());
  await calmPage.waitForTimeout(150);
  assert.equal(await calmPage.locator('.companion-canvas').evaluate(canvas => canvas.toDataURL()), calmFrame);
  await calm.close();
  const unavailable = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await unavailable.route('**/mascot-parts.png', route => route.abort());
  const unavailablePage = await unavailable.newPage(); await unavailablePage.goto(fixture.url);
  await unavailablePage.waitForSelector('#companionStage[data-rig-ready="fallback"]');
  assert(await unavailablePage.locator('.companion-art').isVisible(), 'Missing textures retain the complete original character');
  await unavailablePage.locator('[data-hotspot="eyes"]').click();
  assert.equal(await unavailablePage.evaluate(() => document.body.dataset.consolePage), 'vision');
  await unavailable.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(fixture.unknownRequests, []);
  assert.equal(fixture.requests.length, 0);
  console.log('PASS All nine gestures, idle blink, eye-cover, both ears, interruption, explicit controls, pause, hidden-page suspension, reduced motion, asset fallback and navigation. No settings writes.');
  console.log('Animation screenshots: ' + artifacts);
  if (page.video()) { await context.close(); await page.video().saveAs(resolve(artifacts, 'character-actions.webm')); }
} finally {
  await browser.close(); await fixture.close();
}
