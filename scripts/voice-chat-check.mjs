import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import worker, { initialState } from '../backend/worker/index.js';
import { connect } from '../backend/test/sqlite-adapter.mjs';
import { VOICE_CLIPS } from '../voice-clips.js';

// Both browsers use the real Worker and a private SQLite database. Even when
// pointed at the published frontend, no API call reaches the public board/chat.
const origin = process.env.WUZIQI_TEST_ORIGIN || 'http://127.0.0.1:4173';
const db = connect();
const historicalSender = crypto.randomUUID();
async function seed(text) {
  const response = await worker.fetch(new Request('https://test.example/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: crypto.randomUUID(), senderId: historicalSender, name: '另一位棋友', text }),
  }), { DB: db });
  assert.equal(response.status, 201);
  return (await response.json()).message;
}
const seeded = [await seed(VOICE_CLIPS.slow.text), await seed(VOICE_CLIPS.hurry.text)];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const contexts = [
  await browser.newContext({ viewport: { width: 1440, height: 1080 } }),
  await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }),
];
for (const context of contexts) {
  await context.addInitScript(() => {
    window.voicePlayCalls = [];
    window.denyVoicePlay = false;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      window.voicePlayCalls.push({ voice: this.dataset.voiceId, at: performance.now() });
      if (window.denyVoicePlay) return Promise.reject(new DOMException('User gesture required', 'NotAllowedError'));
      return play.apply(this, args);
    };
  });
}
const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
const errors = [];
const writes = [];
const reads = new Map([[a, []], [b, []]]);
const activeReads = new Map([[a, 0], [b, 0]]);
const maximumReads = new Map([[a, 0], [b, 0]]);
let writeDelay = 0, readDelay = 0, activeWrites = 0, maximumWrites = 0;
let failNextWrite = false, failReadsA = false, closing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(condition, description) {
  const deadline = performance.now() + 10000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, description);
    await delay(50);
  }
}
for (const page of [a, b]) {
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/game', route => route.fulfill({ json: { state: initialState() } }));
  await page.route('**/api/chat*', async route => {
    const request = route.request(), isWrite = request.method() === 'POST';
    if (isWrite) {
      writes.push(request.postDataJSON());
      maximumWrites = Math.max(maximumWrites, ++activeWrites);
    } else {
      reads.get(page).push(performance.now());
      activeReads.set(page, activeReads.get(page) + 1);
      maximumReads.set(page, Math.max(maximumReads.get(page), activeReads.get(page)));
    }
    try {
      if (!isWrite && page === a && failReadsA) {
        await route.fulfill({ status: 503, json: { error: 'Test read unavailable' } });
        return;
      }
      await delay(isWrite ? writeDelay : readDelay);
      if (closing) return;
      if (isWrite && failNextWrite) {
        failNextWrite = false;
        await route.fulfill({ status: 503, json: { error: 'Test send unavailable' } });
        return;
      }
      const target = new URL(request.url());
      const response = await worker.fetch(new Request(`https://test.example${target.pathname}${target.search}`, {
        method: request.method(), headers: { 'Content-Type': 'application/json' },
        ...(isWrite ? { body: request.postData() } : {}),
      }), { DB: db });
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    } catch (error) {
      if (!closing) throw error;
    } finally {
      if (isWrite) activeWrites--;
      else activeReads.set(page, activeReads.get(page) - 1);
    }
  });
}

const message = (page, id) => page.locator(`.chat-message[data-message-id="${id}"]`);
const requestMessage = (page, id) => page.locator(`.chat-message[data-request-id="${id}"]`);
async function allSent(page) {
  await page.waitForFunction(() => !document.querySelector('.chat-message[data-delivery="queued"], .chat-message[data-delivery="sending"]'));
}
async function pauseAudio(page) {
  await page.evaluate(() => document.querySelectorAll('audio').forEach(audio => audio.pause()));
}
async function immediateClick(selector) {
  return a.evaluate(value => {
    const start = performance.now();
    document.querySelector(value).click();
    const bubble = [...document.querySelectorAll('.chat-message')].at(-1);
    return {
      ms: performance.now() - start,
      requestId: bubble.dataset.requestId,
      delivery: bubble.dataset.delivery,
      confirmed: bubble.hasAttribute('data-message-id'),
      enabled: !document.querySelector('#chat-send').disabled,
    };
  }, selector);
}

try {
  await Promise.all([a.goto(origin), b.goto(origin)]);
  for (const page of [a, b]) {
    await message(page, seeded[1].id).waitFor();
    assert.equal(await page.locator('.chat-voice-play').count(), 2, 'Stored voice markers must render as replayable voice messages');
    assert.deepEqual(await page.evaluate(() => window.voicePlayCalls.filter(call => call.voice)), [], 'Opening history must not automatically play it');
  }

  const durations = {};
  for (const [index, key] of ['slow', 'hurry'].entries()) {
    const bubble = message(a, seeded[index].id);
    await bubble.locator(`.chat-voice-play[data-voice-id="${key}"]`).click();
    await a.waitForFunction(id => {
      const audio = document.querySelector(`.chat-message[data-message-id="${id}"] audio`);
      return Number.isFinite(audio?.duration) && audio.duration > 0 && audio.currentTime > 0.05;
    }, seeded[index].id);
    durations[key] = await bubble.locator('audio').evaluate(audio => audio.duration);
    assert.ok((await bubble.locator('audio').getAttribute('src')).endsWith(`assets/voice/${key}.m4a`));
    await pauseAudio(a);
  }

  // A full second before each acknowledgement must not delay the local bubble
  // or block a second/third send. The queue preserves the order in the database.
  writeDelay = 1000;
  await a.locator('#chat-input').fill('不等网络也能立即显示');
  const optimistic = [await immediateClick('#chat-send')];
  assert.equal(await a.locator('#chat-input').inputValue(), '');
  optimistic.push(await immediateClick('[data-chat-voice="slow"]'));
  optimistic.push(await immediateClick('[data-chat-voice="hurry"]'));
  for (const result of optimistic) {
    assert.ok(result.ms < 100, `Local send feedback took ${result.ms} ms`);
    assert.ok(['queued', 'sending'].includes(result.delivery));
    assert.equal(result.confirmed, false, 'Unacknowledged messages must not look confirmed');
    assert.equal(result.enabled, true, 'A pending send must not block the next message');
  }
  await a.evaluate(ids => {
    window.optimisticVoiceNodes = ids.map(id => document.querySelector(`.chat-message[data-request-id="${id}"] audio`));
  }, optimistic.slice(1).map(result => result.requestId));
  await allSent(a);
  const rows = db.sqlite.prepare('SELECT id, text FROM chat_messages ORDER BY id').all();
  assert.deepEqual(rows.slice(-3).map(row => row.text), ['不等网络也能立即显示', VOICE_CLIPS.slow.text, VOICE_CLIPS.hurry.text]);
  assert.equal(maximumWrites, 1, 'Chat writes must remain ordered with a single POST in flight');
  assert.equal(writes.length, 3);
  assert.equal(await a.locator('.chat-message').count(), 5, 'POST/poll acknowledgements must not duplicate optimistic bubbles');
  assert.equal(await a.evaluate(ids => ids.every((id, index) => window.optimisticVoiceNodes[index] ===
    document.querySelector(`.chat-message[data-request-id="${id}"] audio`)), optimistic.slice(1).map(result => result.requestId)), true,
  'Acknowledgements must preserve audio nodes and ongoing playback');
  await message(b, rows.at(-1).id).waitFor();
  await b.reload();
  await message(b, rows.at(-1).id).waitFor();
  assert.equal(await b.locator('.chat-message').count(), 5);
  assert.equal(await b.locator('.chat-voice-play').count(), 4);
  assert.deepEqual(await b.evaluate(() => window.voicePlayCalls.filter(call => call.voice)), [], 'Reopening voice history must remain silent');

  // A browser denying autoplay must still offer a usable manual play button.
  await pauseAudio(b);
  await b.evaluate(() => { window.denyVoicePlay = true; });
  const received = await seed(VOICE_CLIPS.slow.text);
  await message(b, received.id).waitFor();
  await b.waitForFunction(id => document.querySelector(`.chat-message[data-message-id="${id}"] .chat-voice-status`)?.textContent.includes('点击播放'), received.id);
  assert.ok(await message(b, received.id).locator('.chat-voice-play').isEnabled());
  await b.evaluate(() => { window.denyVoicePlay = false; });
  await message(b, received.id).locator('.chat-voice-play').click();
  await b.waitForFunction(id => {
    const audio = document.querySelector('#chat-broadcast-audio');
    return audio?.dataset.requestId === id && audio.currentTime > 0.05;
  }, received.requestId);
  await pauseAudio(b);

  // Retry the failed voice bubble itself; preserve its request identity and save
  // exactly once instead of appending another optimistic copy.
  writeDelay = 0;
  failReadsA = true;
  failNextWrite = true;
  const failed = await immediateClick('[data-chat-voice="hurry"]');
  await requestMessage(a, failed.requestId).locator('.chat-message-retry').waitFor();
  assert.equal(await requestMessage(a, failed.requestId).getAttribute('data-delivery'), 'failed');
  const failedWrite = writes.at(-1);
  await requestMessage(a, failed.requestId).locator('.chat-message-retry').click();
  await a.waitForFunction(id => document.querySelector(`.chat-message[data-request-id="${id}"]`)?.dataset.delivery === 'sent', failed.requestId);
  assert.equal(writes.at(-1).requestId, failedWrite.requestId);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE request_id = ?').get(failed.requestId).count, 1);
  assert.equal(await requestMessage(a, failed.requestId).count(), 1);
  failReadsA = false;
  await a.evaluate(() => window.dispatchEvent(new Event('focus')));

  // Measure idle foreground polling independently of the audio/network tests.
  const startCount = reads.get(b).length;
  await b.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitUntil(() => reads.get(b).length >= startCount + 5, 'Foreground polling did not resume');
  const samples = reads.get(b).slice(startCount + 1, startCount + 5);
  const intervals = samples.slice(1).map((time, index) => time - samples[index]);
  const medianPollMs = intervals.toSorted((left, right) => left - right)[1];
  assert.ok(medianPollMs < 500, `Foreground message polling took ${medianPollMs} ms between reads`);
  readDelay = 600;
  const slowCount = reads.get(b).length;
  await waitUntil(() => reads.get(b).length >= slowCount + 3, 'Slow chat polling stopped');
  assert.equal(maximumReads.get(a), 1, 'Slow chat reads must not overlap');
  assert.equal(maximumReads.get(b), 1, 'Slow mobile chat reads must not overlap');
  readDelay = 0;

  await b.locator('.chat-panel').scrollIntoViewIfNeeded();
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Voice controls must fit the mobile viewport');
  await b.screenshot({ path: 'artifacts/voice-chat-mobile.png', fullPage: true });
  await a.screenshot({ path: 'artifacts/voice-chat-desktop.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ voiceDecodeSeconds: durations, immediateFeedbackMs: optimistic.map(result => result.ms),
    orderedQueue: true, retryWithoutDuplicate: true, historyReplay: true, autoplayFallback: true,
    medianPollMs: Math.round(medianPollMs), maximumConcurrentReads: maximumReads.get(b), mobileFits: true }));
} finally {
  closing = true;
  await browser.close();
  await waitUntil(() => activeWrites === 0 && [...activeReads.values()].every(count => count === 0), 'Test network requests did not settle');
  db.sqlite.close();
}
