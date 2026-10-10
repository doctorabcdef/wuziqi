import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import worker, { initialState } from '../backend/worker/index.js';
import { connect } from '../backend/test/sqlite-adapter.mjs';
import { VOICE_CLIPS } from '../voice-clips.js';

// The published frontend can be tested too: all game/chat requests are handled
// by the real Worker against this private SQLite database, never the live data.
const origin = process.env.WUZIQI_TEST_ORIGIN || 'http://127.0.0.1:4173';
const db = connect();
const historicalSender = crypto.randomUUID();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release(), reached: false };
}
async function seed(text) {
  const response = await worker.fetch(new Request('https://test.example/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: crypto.randomUUID(), senderId: historicalSender, name: '另一位棋友', text }),
  }), { DB: db });
  assert.equal(response.status, 201);
  return (await response.json()).message;
}
const oldest = await seed(VOICE_CLIPS.slow.text);
for (let i = 1; i <= 53; i++) await seed(`历史文字 ${i}`);
const latest = await seed(VOICE_CLIPS.hurry.text);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const contexts = [
  await browser.newContext({ viewport: { width: 1440, height: 1080 } }),
  await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }),
];
for (const context of contexts) {
  await context.addInitScript(() => {
    const allowed = new WeakSet();
    const play = HTMLMediaElement.prototype.play;
    window.broadcastEvents = [];
    window.broadcastAttempts = [];
    window.localVoicePlays = [];
    window.blockBroadcast = false;
    // Model mobile browsers that grant playback to the exact media element
    // touched in a user gesture, rather than granting every later audio node.
    document.addEventListener('click', event => {
      if (event.target.closest?.('#chat-enable-sound, .chat-voice-play')) {
        const player = document.querySelector('#chat-broadcast-audio');
        if (player) allowed.add(player);
      }
    }, true);
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.id === 'chat-broadcast-audio') {
        window.broadcastAttempts.push({ requestId: this.dataset.requestId || null, voice: this.dataset.voiceId || null });
        if (!allowed.has(this) || window.blockBroadcast) {
          return Promise.reject(new DOMException('This element needs a user gesture', 'NotAllowedError'));
        }
      } else if (this.closest('.chat-message')) {
        window.localVoicePlays.push(this.closest('.chat-message').dataset.requestId);
      }
      return play.apply(this, args);
    };
    for (const eventName of ['playing', 'ended']) document.addEventListener(eventName, event => {
      const player = event.target;
      if (player.id === 'chat-broadcast-audio' && player.dataset.requestId) {
        window.broadcastEvents.push({ event: eventName, requestId: player.dataset.requestId, voice: player.dataset.voiceId, position: player.currentTime });
      }
    }, true);
  });
}
const a = await contexts[0].newPage();
const b = await contexts[1].newPage();
const c = await contexts[0].newPage();
const pages = [a, b, c];
const errors = [];
const writes = [];
const readGates = new Map();
let closing = false;
let activeRequests = 0;
for (const page of pages) {
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/game', route => route.fulfill({ json: { state: initialState() } }));
  await page.route('**/api/chat*', async route => {
    activeRequests++;
    try {
      const request = route.request();
      const isWrite = request.method() === 'POST';
      if (isWrite) writes.push(request.postDataJSON());
      else if (readGates.has(page)) {
        const blocked = readGates.get(page);
        blocked.reached = true;
        await blocked.promise;
      }
      if (closing) return;
      const target = new URL(request.url());
      const response = await worker.fetch(new Request(`https://test.example${target.pathname}${target.search}`, {
        method: request.method(), headers: { 'Content-Type': 'application/json' },
        ...(isWrite ? { body: request.postData() } : {}),
      }), { DB: db });
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    } catch (error) {
      if (!closing) throw error;
    } finally { activeRequests--; }
  });
}
const message = (page, id) => page.locator(`.chat-message[data-message-id="${id}"]`);
async function waitUntil(condition, description, timeout = 15000) {
  const deadline = performance.now() + timeout;
  while (!await condition()) {
    assert.ok(performance.now() < deadline, description);
    await delay(40);
  }
}
const events = (page, type) => page.evaluate(eventName => window.broadcastEvents.filter(item => item.event === eventName).map(item => item.requestId), type);
async function finished(page, ids) {
  await waitUntil(async () => {
    const completed = await events(page, 'ended');
    return ids.every(id => completed.includes(id));
  }, 'Every received clip must finish playing in FIFO order', 25000);
}
async function sendVoice(key) {
  const before = new Set(await a.locator('.chat-message').evaluateAll(nodes => nodes.map(node => node.dataset.requestId)));
  await a.locator(`[data-chat-voice="${key}"]`).click();
  const ids = await a.locator('.chat-message').evaluateAll(nodes => nodes.map(node => node.dataset.requestId));
  const id = ids.find(value => !before.has(value));
  assert.ok(id, 'Voice click must immediately add its outgoing message');
  return id;
}
async function allSent() {
  await a.waitForFunction(() => !document.querySelector('.chat-message[data-delivery="queued"], .chat-message[data-delivery="sending"]'));
}

try {
  // Open the first tab before the third so both intentionally share sender ID.
  await Promise.all([a.goto(origin), b.goto(origin)]);
  await Promise.all([message(a, latest.id).waitFor(), message(b, latest.id).waitFor()]);
  await c.goto(origin);
  await message(c, latest.id).waitFor();
  const senderIds = await Promise.all(pages.map(page => page.evaluate(() => localStorage.getItem('wuziqi-chat-sender'))));
  assert.equal(senderIds[0], senderIds[2], 'Third page must reproduce the same-browser-tab sender identity');
  assert.notEqual(senderIds[0], senderIds[1], 'Second page must represent an independent device');
  for (const page of pages) {
    assert.equal(await page.locator('#chat-broadcast-audio').count(), 1, 'Use one persistent incoming player per document');
    assert.deepEqual(await events(page, 'playing'), [], 'Opening message history must remain silent');
  }
  await b.locator('#chat-older').click();
  await message(b, oldest.id).waitFor();
  assert.deepEqual(await events(b, 'playing'), [], 'Loading older voice messages must remain silent');

  // A new message received before sound is enabled must survive autoplay denial.
  const initiallyBlocked = await seed(VOICE_CLIPS.slow.text);
  await Promise.all(pages.map(page => message(page, initiallyBlocked.id).waitFor()));
  await waitUntil(async () => (await b.evaluate(() => window.broadcastAttempts)).some(item => item.requestId === initiallyBlocked.requestId), 'Incoming audio should attempt playback and expose the enable control');
  assert.deepEqual(await events(b, 'playing'), []);
  for (const page of pages) await page.locator('#chat-enable-sound').click();
  await Promise.all(pages.map(page => finished(page, [initiallyBlocked.requestId])));
  for (const page of pages) await page.evaluate(() => { window.broadcastEvents = []; window.localVoicePlays = []; });

  // Hold each receiver's GET so three clicks arrive together in one response.
  // The original implementation selected only the final voice in such a batch.
  for (const page of [b, c]) readGates.set(page, gate());
  await waitUntil(() => [...readGates.values()].every(item => item.reached), 'Both receivers should be waiting for a batch');
  const burst = [await sendVoice('slow'), await sendVoice('slow'), await sendVoice('hurry')];
  await allSent();
  for (const blocked of readGates.values()) blocked.release();
  readGates.clear();
  await waitUntil(async () => (await events(b, 'playing')).includes(burst[0]), 'Receiver must begin the first clip of the batch');
  // Add a fourth message while the receiver is still playing the first batch.
  burst.push(await sendVoice('hurry'));
  await allSent();
  await Promise.all([finished(b, burst), finished(c, burst)]);
  await delay(600); // Additional polls and POST acknowledgements cannot replay it.
  assert.deepEqual(await events(b, 'playing'), burst, 'Independent device must play every received clip exactly once');
  assert.deepEqual(await events(c, 'playing'), burst, 'Another tab with the same sender ID must also receive every clip');
  assert.deepEqual(await events(b, 'ended'), burst, 'Each clip must finish before the next starts');
  assert.deepEqual(await events(a, 'playing'), [], 'Sender acknowledgements must not repeat its immediate local preview');
  assert.deepEqual(await a.evaluate(() => window.localVoicePlays), burst, 'Each sender click must have exactly one immediate preview');

  const replay = b.locator(`.chat-message[data-request-id="${burst[0]}"]`);
  const writeCount = writes.length;
  await replay.locator('.chat-voice-play').click();
  await replay.locator('audio').evaluate(audio => new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    const check = () => audio.currentTime > 0.05 ? resolve() : performance.now() > deadline ? reject(new Error('Manual replay did not start')) : setTimeout(check, 25);
    check();
  }));
  await delay(400);
  assert.equal(writes.length, writeCount, 'Manual history replay must not send another message');
  assert.deepEqual(await events(c, 'playing'), burst, 'Manual replay must not play on another device');
  await b.evaluate(() => document.querySelectorAll('audio').forEach(audio => audio.pause()));

  // Browsers can withdraw autoplay permission. Preserve the head and every
  // later item so one explicit enable click resumes the complete pending queue.
  await b.evaluate(() => { window.blockBroadcast = true; });
  const retryBatch = [await seed(VOICE_CLIPS.slow.text), await seed(VOICE_CLIPS.hurry.text)];
  await message(b, retryBatch[1].id).waitFor();
  await waitUntil(async () => (await b.evaluate(() => window.broadcastAttempts)).some(item => item.requestId === retryBatch[0].requestId), 'Blocked head must reach the media player');
  assert.deepEqual(await events(b, 'playing'), burst, 'Denied playback must not skip ahead or pretend it played');
  await b.evaluate(() => { window.blockBroadcast = false; });
  await b.locator('#chat-enable-sound').click();
  await finished(b, retryBatch.map(item => item.requestId));
  assert.deepEqual(await events(b, 'playing'), [...burst, ...retryBatch.map(item => item.requestId)], 'Enable must resume the blocked head and following clips in order');

  await b.reload();
  await message(b, retryBatch[1].id).waitFor();
  assert.deepEqual(await events(b, 'playing'), [], 'Reloading must not broadcast stored voice history');
  assert.deepEqual(await b.evaluate(() => window.broadcastAttempts), [], 'Even a remembered preference must not enqueue old recordings');

  // Enabling while listening to a historical recording must still grant the
  // shared player permission in the same gesture instead of waiting for it.
  const historicalReplay = message(b, retryBatch[1].id);
  await historicalReplay.locator('.chat-voice-play').click();
  await b.waitForFunction(id => {
    const audio = document.querySelector(`.chat-message[data-message-id="${id}"] audio`);
    return !audio.paused && audio.currentTime > 0.05;
  }, retryBatch[1].id);
  await b.locator('#chat-enable-sound').click();
  await b.waitForFunction(() => document.querySelector('#chat-enable-sound').disabled);
  assert.equal(await historicalReplay.locator('audio').evaluate(audio => audio.paused), true,
    'Enabling sound should pause the manual recording before authorizing incoming audio');

  // The pause control on an automatically playing bubble must pause the shared
  // audio and hold its position across polls, focus changes, and later arrivals.
  const afterReload = await seed(VOICE_CLIPS.hurry.text);
  await message(b, afterReload.id).waitFor();
  await b.waitForFunction(id => {
    const audio = document.querySelector('#chat-broadcast-audio');
    return audio.dataset.requestId === id && !audio.paused && audio.currentTime > 0.12;
  }, afterReload.requestId);
  const automaticButton = message(b, afterReload.id).locator('.chat-voice-play');
  assert.equal(await automaticButton.getAttribute('aria-pressed'), 'true');
  await automaticButton.click();
  const pausedPosition = await b.locator('#chat-broadcast-audio').evaluate(audio => {
    if (!audio.paused) throw new Error('The automatic bubble did not pause its shared audio');
    return audio.currentTime;
  });
  assert.ok(pausedPosition > 0.05);
  await b.evaluate(() => window.dispatchEvent(new Event('focus')));
  const behindPause = await seed(VOICE_CLIPS.slow.text);
  await message(b, behindPause.id).waitFor();
  await delay(250);
  const heldPosition = await b.locator('#chat-broadcast-audio').evaluate(audio => ({ paused: audio.paused, position: audio.currentTime }));
  assert.equal(heldPosition.paused, true, 'Polling and a new message must respect explicit pause');
  assert.ok(Math.abs(heldPosition.position - pausedPosition) < 0.03, 'Explicit pause must retain the playback position');
  assert.deepEqual(await events(b, 'playing'), [afterReload.requestId]);
  await automaticButton.click();
  await finished(b, [afterReload.requestId, behindPause.requestId]);
  assert.deepEqual(await events(b, 'playing'), [afterReload.requestId, afterReload.requestId, behindPause.requestId],
    'Resume should continue the same clip, then the next pending recording');
  const resumed = await b.evaluate(id => window.broadcastEvents.filter(item => item.event === 'playing' && item.requestId === id)[1], afterReload.requestId);
  assert.ok(resumed.position >= pausedPosition - 0.03,
    `Resuming must not restart the clip from zero (paused=${pausedPosition.toFixed(3)}, resumed=${resumed.position.toFixed(3)})`);
  assert.deepEqual(await events(b, 'ended'), [afterReload.requestId, behindPause.requestId], 'Paused clips must still finish exactly once');
  assert.equal(await message(b, afterReload.id).locator('audio').evaluate(audio => audio.currentTime), 0,
    'Pause/resume must reuse the shared player, not start an overlapping bubble player');
  assert.equal(writes.length, writeCount, 'Playback controls must not send duplicate voice messages');
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Sound enable controls must fit a phone');
  await b.screenshot({ path: 'artifacts/broadcast-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ independentDevices: true, sharedSenderTab: true, realAudioFIFO: burst.length,
    noDuplicateAcknowledgement: true, blockedQueueResumed: true, historySilent: true, manualReplayLocal: true,
    enableDuringManualReplay: true, pauseResumeWithoutRestart: true, mobileFits: true }));
} finally {
  closing = true;
  for (const blocked of readGates.values()) blocked.release();
  await browser.close();
  await waitUntil(() => activeRequests === 0, 'Test requests did not settle');
  db.sqlite.close();
}
