import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import worker, { initialState } from '../backend/worker/index.js';
import { connect } from '../backend/test/sqlite-adapter.mjs';

// Exercise the real chat Worker and SQLite through two independent browsers.
// All API traffic is intercepted: this never changes the public game or chat.
const origin = process.env.WUZIQI_TEST_ORIGIN || 'http://127.0.0.1:4173';
const db = connect();
const sender = crypto.randomUUID();
async function seed(text) {
  const response = await worker.fetch(new Request('https://test.example/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: crypto.randomUUID(), senderId: sender, name: '另一位棋友', text }),
  }), { DB: db });
  assert.equal(response.status, 201);
  return (await response.json()).message;
}
for (let i = 1; i <= 65; i++) await seed(`历史消息 ${i}`);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const aContext = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const bContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const a = await aContext.newPage(), b = await bContext.newPage();
const errors = [];
const writes = [];
let loseNextResponse = false;
let failReadsA = false;
for (const page of [a, b]) {
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/game', route => route.fulfill({ json: { state: initialState() } }));
  await page.route('**/api/chat*', async route => {
    const request = route.request();
    const isWrite = request.method() === 'POST';
    if (!isWrite && page === a && failReadsA) return route.fulfill({ status: 503, json: { error: 'Test unavailable' } });
    if (isWrite) writes.push(request.postDataJSON());
    const target = new URL(request.url());
    const response = await worker.fetch(new Request(`https://test.example${target.pathname}${target.search}`, {
      method: request.method(), headers: { 'Content-Type': 'application/json' },
      ...(isWrite ? { body: request.postData() } : {}),
    }), { DB: db });
    if (page === a && isWrite && loseNextResponse) {
      loseNextResponse = false;
      failReadsA = true;
      await route.abort('failed');
      return;
    }
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
}
const texts = page => page.locator('.chat-message-text');
const hasText = (page, text) => page.locator('.chat-message-text').filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
async function shown(page, text) {
  await page.waitForFunction(value => [...document.querySelectorAll('.chat-message[data-delivery="sent"] .chat-message-text')]
    .some(node => node.textContent === value), text);
}
async function idle(page) {
  await page.waitForFunction(() => !document.querySelector('.chat-message[data-delivery="queued"], .chat-message[data-delivery="sending"]'));
}
try {
  await Promise.all([a.goto(origin), b.goto(origin)]);
  await Promise.all([shown(a, '历史消息 65'), shown(b, '历史消息 65')]);
  assert.equal(await texts(a).count(), 50);
  assert.equal(await texts(a).first().textContent(), '历史消息 16');
  await a.locator('#chat-older').click();
  await shown(a, '历史消息 1');
  assert.equal(await texts(a).count(), 65);
  assert.equal(await a.locator('#chat-older').isVisible(), false);
  await a.locator('#chat-name').fill('先手棋友');
  await a.locator('#chat-input').fill('尚未发送的草稿');
  for (const text of ['太慢了', '搞快点好不', '👍']) {
    await idle(a);
    await a.locator(`[data-chat-quick="${text}"]`).click();
    await Promise.all([shown(a, text), shown(b, text)]);
    assert.equal(await a.locator('#chat-input').inputValue(), '尚未发送的草稿');
  }
  await idle(a);
  await a.locator('#chat-input').fill('测试输入法');
  const beforeIme = writes.length;
  await a.locator('#chat-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  assert.equal(writes.length, beforeIme, 'IME confirmation must not submit');
  await a.locator('#chat-input').press('Shift+Enter');
  assert.equal(writes.length, beforeIme, 'Shift+Enter must only insert a newline');
  const unsafe = '<img src=x onerror="window.chatXss=true">';
  await a.locator('#chat-input').fill(unsafe);
  await a.locator('#chat-input').press('Enter');
  await Promise.all([shown(a, unsafe), shown(b, unsafe)]);
  assert.equal(await a.locator('#chat-messages img').count(), 0);
  assert.equal(await b.evaluate(() => Boolean(window.chatXss)), false);
  await idle(a);
  assert.equal(await a.locator('#chat-input').inputValue(), '');

  // A committed POST whose response was lost must retry the same request ID.
  loseNextResponse = true;
  await a.locator('#chat-input').fill('只发送一次');
  await a.locator('#chat-send').click();
  await a.locator('#chat-retry-send').waitFor();
  assert.equal(await a.locator('#chat-input').inputValue(), '只发送一次');
  const failedId = writes.at(-1).requestId;
  await a.locator('#chat-retry-send').click();
  await shown(a, '只发送一次');
  assert.equal(writes.at(-1).requestId, failedId);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE text = ?').get('只发送一次').count, 1);
  await idle(a);
  assert.equal(await a.locator('#chat-input').inputValue(), '');
  failReadsA = false;
  await a.evaluate(() => window.dispatchEvent(new Event('focus')));

  // Polling can confirm a saved message even before the user retries it.
  loseNextResponse = true;
  await a.locator('#chat-input').fill('通过历史确认送达');
  await a.locator('#chat-send').click();
  await a.locator('#chat-retry-send').waitFor();
  failReadsA = false;
  await a.evaluate(() => window.dispatchEvent(new Event('focus')));
  await shown(a, '通过历史确认送达');
  await a.waitForFunction(() => document.querySelector('#chat-input').value === '');
  assert.equal(await a.locator('#chat-retry-send').isVisible(), false);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE text = ?').get('通过历史确认送达').count, 1);

  // Independent devices can send and reopening restores the shared history.
  await b.locator('#chat-name').fill('后手棋友');
  await b.locator('#chat-input').fill('手机也能聊');
  await b.locator('#chat-send').click();
  await Promise.all([shown(a, '手机也能聊'), shown(b, '手机也能聊')]);
  await b.reload();
  await shown(b, '手机也能聊');
  assert.equal(await b.locator('#chat-name').inputValue(), '后手棋友');
  assert.equal(await b.locator('.chat-message.is-own').last().locator('.chat-message-text').textContent(), '手机也能聊');
  assert.equal(await hasText(b, '只发送一次').count(), 1);
  await b.locator('.chat-panel').scrollIntoViewIfNeeded();
  const fits = await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  assert.ok(fits, 'Mobile page must not overflow horizontally');
  await b.screenshot({ path: 'artifacts/chat-mobile.png', fullPage: true });
  await a.screenshot({ path: 'artifacts/chat-desktop.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ history: true, earlierHistory: true, quickPhrases: true, emoji: true,
    twoDevices: true, reload: true, idempotentRetry: true, draftPreserved: true, ime: true, xss: false, mobileFits: fits }));
} finally {
  await browser.close();
  db.sqlite.close();
}
