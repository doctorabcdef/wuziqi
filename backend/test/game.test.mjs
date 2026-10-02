import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker, { initialState, applyAction } from '../worker/index.js';
import { connect } from './sqlite-adapter.mjs';

const url = 'https://game.example/api/game';
async function call(db, body, extra = {}) {
  const response = await worker.fetch(new Request(url, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
  } : { headers: extra }), { DB: db });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
function payload(revision, action, requestId = crypto.randomUUID()) { return { revision, action, requestId }; }

test('two devices see the same moves and colors after closing and reopening storage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wuziqi-test-'));
  const file = join(directory, 'game.sqlite');
  let db = connect(file);
  try {
    assert.equal((await call(db)).body.state.moves.length, 0);
    await call(db, payload(0, { type: 'move', x: 7, y: 7 }));
    await call(db, payload(1, { type: 'color', player: 1, color: '#FF3366' }));
    db.sqlite.close();
    db = connect(file);
    const { state } = (await call(db)).body;
    assert.deepEqual(state.moves, [{ x: 7, y: 7, player: 1 }]);
    assert.equal(state.colors[0], '#ff3366');
    assert.equal(state.revision, 2);
    assert.equal(state.recentRequests, undefined);
  } finally { db.sqlite.close(); unlinkSync(file); rmdirSync(directory); }
});

test('concurrent moves accept exactly one operation and return the current snapshot on conflict', async () => {
  const db = connect();
  await call(db);
  const results = await Promise.all([
    call(db, payload(0, { type: 'move', x: 3, y: 4 })),
    call(db, payload(0, { type: 'move', x: 9, y: 8 })),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await call(db)).body.state.moves.length, 1);
  assert.equal(results.find(r => r.status === 409).body.state.revision, 1);
  db.sqlite.close();
});

test('retrying a saved action is idempotent; stale reset cannot erase new moves', async () => {
  const db = connect();
  const action = payload(0, { type: 'move', x: 0, y: 0 });
  await call(db, action);
  const repeated = await call(db, action);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.state.revision, 1);
  assert.equal((await call(db, payload(0, { type: 'reset' }))).status, 409);
  const reset = await call(db, payload(1, { type: 'reset' }));
  assert.equal(reset.body.state.round, 2);
  assert.equal(reset.body.state.revision, 2);
  db.sqlite.close();
});

test('all four five-in-a-row directions win, block further moves, and undo restores play', () => {
  for (const [dx, dy, x0, y0] of [[1, 0, 0, 0], [0, 1, 14, 0], [1, 1, 0, 0], [1, -1, 0, 14]]) {
    let state = initialState();
    for (let n = 0; n < 5; n++) {
      state = applyAction(state, { type: 'move', x: x0 + n * dx, y: y0 + n * dy });
      if (n < 4) state = applyAction(state, { type: 'move', x: n * 2, y: 7 });
    }
    assert.equal(state.winner, 1);
    assert.equal(state.line.length, 5);
    assert.throws(() => applyAction(state, { type: 'move', x: 10, y: 10 }));
    state = applyAction(state, { type: 'undo' });
    assert.equal(state.winner, 0);
    assert.equal(state.moves.length, 8);
  }
});

test('invalid and occupied coordinates and invalid colors cannot change the database', async () => {
  const db = connect();
  await call(db, payload(0, { type: 'move', x: 0, y: 0 }));
  for (const action of [
    { type: 'move', x: 0, y: 0 }, { type: 'move', x: 15, y: 0 },
    { type: 'move', x: 1.5, y: 3 }, { type: 'color', player: 3, color: '#ff0000' },
    { type: 'color', player: 1, color: 'red' }, { type: 'unknown' },
  ]) assert.equal((await call(db, payload(1, action))).status, 400);
  assert.equal((await call(db)).body.state.revision, 1);
  const accepted = await call(db, undefined, { Origin: 'https://doctorabcdef.github.io' });
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), 'https://doctorabcdef.github.io');
  assert.equal(accepted.headers.get('Cache-Control'), 'no-store');
  assert.equal((await call(db, undefined, { Origin: 'https://unrelated.example' })).status, 403);
  db.sqlite.close();
});
