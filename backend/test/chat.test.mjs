import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker, { initialState } from '../worker/index.js';
import { connect } from './sqlite-adapter.mjs';

async function exchange(db, path = '/api/chat', init = {}) {
  const response = await worker.fetch(new Request(`https://game.example${path}`, init), { DB: db });
  return { status: response.status, headers: response.headers,
    body: response.status === 204 ? null : await response.json() };
}
function payload(overrides = {}) {
  return { requestId: crypto.randomUUID(), senderId: crypto.randomUUID(), name: '棋友', text: '太慢了', ...overrides };
}
function post(db, body, headers = {}) {
  return exchange(db, '/api/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wuziqi-chat-test-'));
  const file = join(directory, 'chat.sqlite');
  t.after(() => { unlinkSync(file); rmdirSync(directory); });
  return file;
}
function memoryDatabase(t) {
  const db = connect();
  t.after(() => db.sqlite.close());
  return db;
}

test('chat history survives reopening storage and starting a new game', async t => {
  const file = temporaryDatabase(t);
  let db = connect(file);
  try {
    assert.deepEqual((await exchange(db)).body, { messages: [], hasMore: false });
    const sent = payload({ name: '  小棋友  ', text: '  搞快点好不\n😀  ' });
    const saved = await post(db, sent);
    assert.equal(saved.status, 201);
    assert.deepEqual(Object.keys(saved.body.message).sort(),
      ['id', 'requestId', 'senderId', 'name', 'text', 'createdAt'].sort());
    assert.equal(saved.body.message.name, '小棋友');
    assert.equal(saved.body.message.text, '搞快点好不\n😀');
    assert.equal(saved.body.message.requestId, sent.requestId);
    assert.equal(saved.body.message.senderId, sent.senderId);
    assert.ok(Number.isSafeInteger(saved.body.message.id) && saved.body.message.id > 0);
    assert.ok(Number.isFinite(Date.parse(saved.body.message.createdAt)));
    db.sqlite.close();
    db = connect(file);
    assert.deepEqual((await exchange(db)).body.messages, [saved.body.message]);
    const game = await exchange(db, '/api/game');
    const reset = await exchange(db, '/api/game', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: game.body.state.revision,
        requestId: crypto.randomUUID(), action: { type: 'reset' } }) });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.state.round, 2);
    assert.deepEqual((await exchange(db)).body.messages, [saved.body.message]);
  } finally { db.sqlite.close(); }
});

test('older history and forward polling preserve message order while new messages arrive', async t => {
  const db = memoryDatabase(t);
  const messages = [];
  for (let n = 0; n < 8; n++) {
    const result = await post(db, payload({ text: `消息 ${n}` }));
    assert.equal(result.status, 201);
    messages.push(result.body.message);
  }
  const latest = await exchange(db, '/api/chat?limit=3');
  assert.deepEqual(latest.body, { messages: messages.slice(-3), hasMore: true });
  const newlyArrived = await Promise.all([
    post(db, payload({ text: '设备甲的新消息' })), post(db, payload({ text: '设备乙的新消息' })),
  ]);
  assert.deepEqual(newlyArrived.map(result => result.status), [201, 201]);
  messages.push(...newlyArrived.map(result => result.body.message).sort((a, b) => a.id - b.id));
  let older = latest.body.messages;
  let hasMore = latest.body.hasMore;
  while (hasMore) {
    const page = await exchange(db, `/api/chat?before=${older[0].id}&limit=2`);
    assert.equal(page.status, 200);
    assert.ok(page.body.messages.length > 0);
    older = [...page.body.messages, ...older];
    hasMore = page.body.hasMore;
  }
  assert.deepEqual(older, messages.slice(0, 8));
  let received = [];
  let cursor = latest.body.messages.at(-1).id;
  do {
    const page = await exchange(db, `/api/chat?after=${cursor}&limit=1`);
    assert.equal(page.status, 200);
    received.push(...page.body.messages);
    cursor = page.body.messages.at(-1)?.id ?? cursor;
    hasMore = page.body.hasMore;
  } while (hasMore);
  assert.deepEqual([...older, ...received], messages);
  assert.deepEqual((await exchange(db, `/api/chat?after=${cursor}`)).body, { messages: [], hasMore: false });
  assert.deepEqual((await exchange(db, '/api/chat?before=0')).body, { messages: [], hasMore: false });
});

test('simultaneous retries save one message and reject conflicting reuse of its request ID', async t => {
  const db = memoryDatabase(t);
  const sent = payload();
  const results = await Promise.all([post(db, sent), post(db, sent), post(db, sent)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 201]);
  for (const result of results) assert.deepEqual(result.body.message, results[0].body.message);
  assert.deepEqual((await exchange(db)).body.messages, [results[0].body.message]);
  for (const changed of [{ text: '另一条消息' }, { name: '别人' }, { senderId: crypto.randomUUID() }]) {
    assert.equal((await post(db, { ...sent, ...changed })).status, 409);
  }
  const normalized = await post(db, { ...sent, name: ` ${sent.name} `, text: ` ${sent.text}\n` });
  assert.equal(normalized.status, 200);
  assert.deepEqual(normalized.body.message, results[0].body.message);
  const identicalTextNewRequest = await post(db, { ...sent, requestId: crypto.randomUUID() });
  assert.equal(identicalTextNewRequest.status, 201);
  assert.equal((await exchange(db)).body.messages.length, 2);
});

test('emoji limits count code points and content stays literal through storage', async t => {
  const db = memoryDatabase(t);
  const atLimit = payload({ name: '😀'.repeat(20), text: '🎉'.repeat(500) });
  assert.equal((await post(db, atLimit)).status, 201);
  assert.equal((await post(db, payload({ name: '😀'.repeat(21) }))).status, 400);
  assert.equal((await post(db, payload({ text: '🎉'.repeat(501) }))).status, 400);
  const literal = payload({ name: '<棋友>', text: '<img src=x onerror=alert(1)>\n\' OR 1=1; -- 👍' });
  const saved = await post(db, literal);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.message.text, literal.text);
  assert.deepEqual((await exchange(db)).body.messages.map(message => message.text), [atLimit.text, literal.text]);
});

test('invalid message types, blank values and identifiers cannot save messages', async t => {
  const db = memoryDatabase(t);
  const invalid = [null, [], true, 'message', 42, {},
    ...[{ text: '' }, { text: ' \n\t ' }, { text: 12 }, { text: {} }, { text: null },
      { name: '' }, { name: ' \n ' }, { name: false }, { name: [] },
      { requestId: '' }, { requestId: 'a'.repeat(15) }, { requestId: 'a'.repeat(81) },
      { requestId: 'invalid/id-long-enough' }, { requestId: 1234567890123456 },
      { senderId: 'short' }, { senderId: 'x'.repeat(81) }, { senderId: null },
      { senderId: 'identity with spaces' }].map(change => payload(change))];
  for (const value of invalid) {
    const result = await post(db, value);
    assert.equal(result.status, 400, JSON.stringify(value));
    assert.equal(typeof result.body.error, 'string');
  }
  assert.deepEqual((await exchange(db)).body, { messages: [], hasMore: false });
  assert.equal((await post(db, payload({ requestId: 'a'.repeat(16), senderId: 'x'.repeat(80) }))).status, 201);
});

test('pagination validates cursor and page-size boundaries', async t => {
  const db = memoryDatabase(t);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=-1', 'limit=',
    'limit=hello', 'after=-1', 'before=1.1', 'before=wat', 'after=',
    'after=9007199254740992', 'before=0&after=0', 'after=1e3']) {
    assert.equal((await exchange(db, `/api/chat?${query}`)).status, 400, query);
  }
  for (const query of ['', '?limit=1', '?limit=100', '?after=0', '?before=0']) {
    assert.equal((await exchange(db, `/api/chat${query}`)).status, 200, query);
  }
});

test('chat enforces CORS, JSON and body limits without creating messages', async t => {
  const db = memoryDatabase(t);
  const accepted = await exchange(db, '/api/chat', { headers: { Origin: 'https://doctorabcdef.github.io' } });
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), 'https://doctorabcdef.github.io');
  assert.equal(accepted.headers.get('Cache-Control'), 'no-store');
  const options = await exchange(db, '/api/chat', { method: 'OPTIONS',
    headers: { Origin: 'https://doctorabcdef.github.io', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(options.status, 204);
  assert.ok(options.headers.get('Access-Control-Allow-Methods').includes('POST'));
  const blocked = await post(db, payload(), { Origin: 'https://unrelated.example' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await exchange(db, '/api/chat', { method: 'DELETE' })).status, 405);
  assert.equal((await exchange(db, '/api/chat', { method: 'POST', body: '{}' })).status, 415);
  for (const body of ['', '{broken-json']) {
    assert.equal((await exchange(db, '/api/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body })).status, 400);
  }
  assert.equal((await exchange(db, '/api/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '4097' }, body: '{}' })).status, 413);
  assert.equal((await exchange(db, '/api/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(4097) })).status, 413);
  assert.deepEqual((await exchange(db)).body.messages, []);
});

test('unavailable chat storage returns a retryable error without exposing details', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const broken = { prepare() { throw new Error('internal-storage-secret'); } };
  for (const db of [undefined, broken]) {
    for (const result of [await exchange(db), await post(db, payload())]) {
      assert.equal(result.status, 503);
      assert.equal(typeof result.body.error, 'string');
      assert.ok(result.body.error.includes('聊天'));
      assert.ok(!JSON.stringify(result.body).includes('internal-storage-secret'));
    }
  }
  assert.equal(logged.length, 4);
});

test('legacy game-only storage gains chat once and preserves the existing board', async t => {
  const file = temporaryDatabase(t);
  const legacy = new DatabaseSync(file);
  const state = { ...initialState(), revision: 7, moves: [{ x: 3, y: 4, player: 1 }], round: 3 };
  legacy.exec(readFileSync(new URL('../drizzle/0000_secret_wraith.sql', import.meta.url), 'utf8'));
  legacy.prepare('INSERT INTO game (id, revision, state) VALUES (1, ?, ?)').run(state.revision, JSON.stringify(state));
  legacy.close();
  let db = connect(file);
  try {
    const game = (await exchange(db, '/api/game')).body.state;
    assert.equal(game.revision, 7);
    assert.equal(game.round, 3);
    assert.deepEqual(game.moves, state.moves);
    const saved = await post(db, payload());
    assert.equal(saved.status, 201);
    const migrations = readdirSync(new URL('../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort();
    assert.deepEqual(db.sqlite.prepare('SELECT name FROM _local_migrations ORDER BY name').all().map(row => row.name), migrations);
    db.sqlite.close();
    db = connect(file);
    assert.deepEqual((await exchange(db, '/api/game')).body.state, game);
    assert.deepEqual((await exchange(db)).body.messages, [saved.body.message]);
    assert.deepEqual(db.sqlite.prepare('SELECT name FROM _local_migrations ORDER BY name').all().map(row => row.name), migrations);
  } finally { db.sqlite.close(); }
});
