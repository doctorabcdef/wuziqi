import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { initialState, applyAction } from '../backend/worker/index.js';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const origin = process.env.WUZIQI_TEST_ORIGIN || 'http://127.0.0.1:4173';
const aContext = await browser.newContext();
const bContext = await browser.newContext();
const a = await aContext.newPage(), b = await bContext.newPage();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let state = initialState();
let readDelay = 40;
let fail = false;
let savedAt = 0;
const stats = [a, b].map(() => ({ active: 0, max: 0, reads: [], failures: [] }));
for (const [index, page] of [a, b].entries()) {
  await page.route('**/api/game', async route => {
    if (route.request().method() === 'POST') {
      await delay(40);
      const payload = route.request().postDataJSON();
      assert.equal(payload.revision, state.revision);
      state = applyAction(state, payload.action);
      savedAt = performance.now();
      await route.fulfill({ json: { state } });
      return;
    }
    const stat = stats[index];
    stat.reads.push(performance.now());
    stat.active++;
    stat.max = Math.max(stat.max, stat.active);
    const snapshot = structuredClone(state);
    const failed = fail;
    if (failed) stat.failures.push(performance.now());
    await delay(readDelay);
    stat.active--;
    await route.fulfill(failed ? { status: 503, json: { error: 'Test failure' } } : { json: { state: snapshot } });
  });
}
async function ready(page) { await page.locator('#connection[data-mode="online"]').waitFor(); }
try {
  await Promise.all([a.goto(origin), b.goto(origin)]);
  await Promise.all([ready(a), ready(b)]);
  const latencies = [];
  for (const [i, phase] of [15, 70, 130, 210, 10, 160].entries()) {
    await delay(phase);
    await a.locator(`.intersection[data-x="${i}"][data-y="7"]`).click();
    await b.waitForFunction(count => document.querySelectorAll('.intersection .stone').length === count, i + 1);
    latencies.push(Math.round(performance.now() - savedAt));
    await ready(a);
  }
  assert.ok(Math.max(...latencies) < 500, `Cross-device latency too high: ${latencies}`);

  readDelay = 600;
  await delay(1900);
  assert.ok(stats.every(stat => stat.max === 1), 'Slow GET requests must never overlap');
  await b.evaluate(() => {
    window.testHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await delay(650);
  const hiddenReads = stats[1].reads.length;
  await delay(600);
  assert.equal(stats[1].reads.length, hiddenReads, 'Hidden page must stop polling');
  readDelay = 40;
  await b.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await b.waitForResponse(response => response.url().endsWith('/api/game'));
  assert.ok(stats[1].reads.length > hiddenReads);

  fail = true;
  const deadline = performance.now() + 7000;
  while (stats[1].failures.length < 3 && performance.now() < deadline) await delay(100);
  assert.ok(stats[1].failures.length >= 3, 'Expected failed reads for retry checks');
  const failures = stats[1].failures;
  assert.ok(failures[1] - failures[0] >= 1000);
  assert.ok(failures[2] - failures[1] >= 2000);
  fail = false;
  await b.evaluate(() => window.dispatchEvent(new Event('focus')));
  await ready(b);
  const resumed = stats[1].reads.length;
  await delay(800);
  assert.ok(stats[1].reads.length >= resumed + 2, 'Success must restore fast polling');
  await bContext.setOffline(true);
  await delay(100);
  const offlineReads = stats[1].reads.length;
  await delay(600);
  assert.equal(stats[1].reads.length, offlineReads, 'Offline page must stop automatic polling');
  await bContext.setOffline(false);
  await ready(b);
  console.log(JSON.stringify({ crossDeviceMs: latencies, averageMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length), maxConcurrentReads: stats.map(stat => stat.max), hiddenPause: true, offlinePause: true, retryBackoff: true }));
} finally { await browser.close(); }
