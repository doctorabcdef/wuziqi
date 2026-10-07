import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { initialState, applyAction } from '../backend/worker/index.js';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
let state = initialState();
let outcome = 'success';
let releaseWrite;
let writeStarted;
let readGate;
let readStarted;
let requests = 0;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/game', async route => {
  const snapshot = structuredClone(state);
  if (route.request().method() === 'GET') {
    if (readGate) { const gate = readGate; readGate = null; readStarted(); await gate; }
    return route.fulfill({ json: { state: snapshot } });
  }
  requests++;
  const payload = route.request().postDataJSON();
  await new Promise(resolve => { releaseWrite = resolve; writeStarted(); });
  if (outcome === 'failure') return route.fulfill({ status: 503, json: { error: 'Test unavailable' } });
  if (outcome === 'conflict') {
    state = applyAction(state, { type: 'move', x: 0, y: 0 });
    return route.fulfill({ status: 409, json: { state, error: 'Conflict' } });
  }
  assert.equal(payload.revision, state.revision);
  state = applyAction(state, payload.action);
  return route.fulfill({ json: { state } });
});
async function ready() { await page.locator('#connection[data-mode="online"]').waitFor(); }
async function clickImmediate(action, expectedCount) {
  const immediate = await page.evaluate(({ action, expectedCount }) => {
    const start = performance.now();
    document.querySelector(action).click();
    return { count: document.querySelectorAll('.intersection .stone').length,
      ms: performance.now() - start, dialog: document.querySelector('#confirm-dialog').open };
  }, { action, expectedCount });
  assert.equal(immediate.count, expectedCount);
  assert.equal(immediate.dialog, false);
  assert.ok(immediate.ms < 250, `Immediate feedback took ${immediate.ms} ms`);
  return immediate.ms;
}
async function start(action, expectedCount) {
  const started = new Promise(resolve => { writeStarted = resolve; });
  const latency = await clickImmediate(action, expectedCount);
  await started;
  return latency;
}
async function finishAndWaitForNext() {
  const started = new Promise(resolve => { writeStarted = resolve; });
  releaseWrite();
  await started;
}
try {
  await page.goto('http://127.0.0.1:4173'); await ready();
  let releaseRead;
  readGate = new Promise(resolve => { releaseRead = resolve; });
  const reading = new Promise(resolve => { readStarted = resolve; });
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await reading;
  const latency = await start('.intersection[data-x="7"][data-y="7"]', 1);
  assert.equal(await page.locator('.is-pending').count(), 1);
  releaseRead();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.is-pending').count(), 1);
  await clickImmediate('.intersection[data-x="8"][data-y="7"]', 2);
  await clickImmediate('.intersection[data-x="8"][data-y="7"]', 2);
  await clickImmediate('#undo-button', 1);
  await clickImmediate('#undo-button', 0);
  assert.equal(requests, 1, 'Only the first write can be in flight; later actions stay queued');
  await finishAndWaitForNext();
  await finishAndWaitForNext();
  await finishAndWaitForNext();
  releaseWrite(); await ready();
  assert.equal(state.moves.length, 0);
  assert.equal(requests, 4, 'Two moves and two undos must save exactly once in order');
  assert.equal(state.revision, 4);
  assert.equal(await page.locator('.is-pending').count(), 0);

  outcome = 'conflict';
  await start('.intersection[data-x="7"][data-y="7"]', 1);
  await clickImmediate('.intersection[data-x="8"][data-y="7"]', 2);
  releaseWrite(); await ready();
  assert.equal(await page.locator('.intersection[data-x="7"][data-y="7"] .stone').count(), 0);
  assert.equal(await page.locator('.intersection[data-x="8"][data-y="7"] .stone').count(), 0);
  assert.equal(await page.locator('.intersection[data-x="0"][data-y="0"] .stone').count(), 1);

  outcome = 'failure';
  await start('#undo-button', 0);
  await clickImmediate('.intersection[data-x="4"][data-y="4"]', 1);
  releaseWrite();
  await page.waitForFunction(() => document.querySelectorAll('.intersection .stone').length === 1);
  await ready();
  assert.equal(state.moves.length, 1, 'Failed undo must restore the confirmed board');
  assert.equal(requests, 6, 'Conflict/failure must discard dependent queued operations without replay');
  assert.equal(await page.locator('.intersection[data-x="4"][data-y="4"] .stone').count(), 0);
  await page.locator('#reset-button').click();
  assert.equal(await page.locator('#confirm-dialog').evaluate(el => el.open), true);
  await page.locator('#dialog-cancel').click();
  assert.deepEqual(errors, []);
  console.log(`PASS: continuous moves (${latency.toFixed(1)} ms), repeated undo before save, ordered revisions, stale read, duplicate click, queued conflict/failure rollback, reset confirmation.`);
} finally { await browser.close(); }
