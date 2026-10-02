import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const origin = 'http://127.0.0.1:4173';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const desktop = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
const a = await desktop.newPage(), b = await phone.newPage();
const errors = [];
for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
async function ready(page) { await page.locator('#connection[data-mode="online"]').waitFor(); }
async function moveCount(page, count) { await page.waitForFunction(n => document.querySelectorAll('.intersection .stone').length === n, count); }
try {
  await a.goto(origin); await ready(a);
  await a.locator('#reset-button').click(); await a.locator('#dialog-confirm').click();
  await moveCount(a, 0); await ready(a);
  await a.locator('.intersection[data-x="7"][data-y="7"]').click();
  await moveCount(a, 1); await ready(a);
  await a.locator('#color-1').evaluate(el => { el.value = '#d64265'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await a.waitForFunction(() => document.querySelector('#color-1').value === '#d64265' && document.querySelector('#connection').dataset.mode === 'online');
  await b.goto(origin); await ready(b); await moveCount(b, 1);
  assert.equal(await b.locator('#color-1').inputValue(), '#d64265');
  await b.locator('.intersection[data-x="8"][data-y="7"]').click();
  await moveCount(a, 2); await moveCount(b, 2);
  await a.reload(); await ready(a); await moveCount(a, 2);
  assert.equal(await a.locator('#color-1').inputValue(), '#d64265');
  await b.locator('#color-2').evaluate(el => { el.value = '#397cc0'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await a.waitForFunction(() => document.querySelector('#color-2').value === '#397cc0');
  await desktop.setOffline(true);
  await a.waitForFunction(() => document.querySelector('#connection').dataset.mode === 'offline');
  assert.equal(await a.locator('.intersection .stone').count(), 2);
  await desktop.setOffline(false);
  await ready(a); await moveCount(a, 2);
  await b.locator('#undo-button').click(); await b.locator('#dialog-confirm').click();
  await moveCount(a, 1); await moveCount(b, 1);
  for (const page of [a, b]) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await mkdir('artifacts', { recursive: true });
  await a.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  await b.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: two isolated devices, move/color sync, reload, offline recovery, undo, responsive layout, no browser errors.');
} finally { await browser.close(); }
