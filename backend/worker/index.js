const SIZE = 15;
const PUBLIC_ORIGIN = 'https://doctorabcdef.github.io';
const UUID = /^[a-zA-Z0-9_-]{16,80}$/;

export function initialState() {
  return { revision: 0, moves: [], colors: ['#222b38', '#edf0f4'], round: 1,
    winner: 0, line: [], updatedAt: new Date().toISOString(), recentRequests: [] };
}

export function findWin(moves) {
  if (!moves.length) return [];
  const last = moves.at(-1);
  const occupied = new Set(moves.filter(m => m.player === last.player).map(m => `${m.x},${m.y}`));
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const line = [{ x: last.x, y: last.y }];
    for (const sign of [-1, 1]) {
      for (let n = 1; n < SIZE; n++) {
        const x = last.x + n * dx * sign, y = last.y + n * dy * sign;
        if (!occupied.has(`${x},${y}`)) break;
        line.push({ x, y });
      }
    }
    if (line.length >= 5) return line;
  }
  return [];
}

function invalid(message) { const error = new Error(message); error.status = 400; throw error; }

export function applyAction(current, action) {
  if (!action || typeof action !== 'object') invalid('操作格式不正确。');
  const state = structuredClone(current);
  switch (action.type) {
    case 'move': {
      const { x, y } = action;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE)
        invalid('请选择棋盘上的交叉点。');
      if (state.winner || state.moves.length === SIZE * SIZE) invalid('本局已结束，请开始新的一局。');
      if (state.moves.some(m => m.x === x && m.y === y)) invalid('这里已经有棋子了。');
      state.moves.push({ x, y, player: state.moves.length % 2 + 1 });
      break;
    }
    case 'color':
      if (![1, 2].includes(action.player) || typeof action.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(action.color))
        invalid('请选择有效的棋子颜色。');
      state.colors[action.player - 1] = action.color.toLowerCase();
      break;
    case 'undo':
      if (!state.moves.length) invalid('当前没有可以撤回的棋步。');
      state.moves.pop();
      break;
    case 'reset':
      state.moves = [];
      state.round++;
      break;
    default: invalid('不支持的操作。');
  }
  state.line = findWin(state.moves);
  state.winner = state.line.length ? state.moves.at(-1).player : 0;
  state.revision++;
  state.updatedAt = new Date().toISOString();
  return state;
}

function publicState(state) {
  const { recentRequests, ...view } = state;
  return view;
}

function database(env) {
  if (!env.DB) throw new Error('Database binding unavailable');
  return env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
}

async function readState(db) {
  let row = await db.prepare('SELECT revision, state FROM game WHERE id = 1').first();
  if (!row) {
    const state = initialState();
    await db.prepare('INSERT OR IGNORE INTO game (id, revision, state) VALUES (1, 0, ?)').bind(JSON.stringify(state)).run();
    row = await db.prepare('SELECT revision, state FROM game WHERE id = 1').first();
  }
  return { ...JSON.parse(row.state), revision: row.revision };
}

const CHAT_COLUMNS = 'id, request_id AS requestId, sender_id AS senderId, name, text, created_at AS createdAt';

async function readMessages(db, params) {
  function integerParam(key, fallback) {
    if (!params.has(key)) return fallback;
    const raw = params.get(key), number = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 0) invalid('消息分页参数不正确。');
    return number;
  }
  const limit = integerParam('limit', 50);
  if (limit < 1 || limit > 100 || (params.has('before') && params.has('after'))) invalid('消息分页参数不正确。');
  const after = integerParam('after', null), before = integerParam('before', null);
  const forward = after !== null;
  const filter = forward ? ' WHERE id > ?' : before !== null ? ' WHERE id < ?' : '';
  const args = forward ? [after] : before !== null ? [before] : [];
  const { results } = await db.prepare(`SELECT ${CHAT_COLUMNS} FROM chat_messages${filter} ORDER BY id ${forward ? 'ASC' : 'DESC'} LIMIT ?`)
    .bind(...args, limit + 1).all();
  const messages = results.slice(0, limit);
  if (!forward) messages.reverse();
  return { messages, hasMore: results.length > limit };
}

async function saveMessage(db, payload, json) {
  if (!payload || typeof payload.requestId !== 'string' || !UUID.test(payload.requestId) ||
    typeof payload.senderId !== 'string' || !UUID.test(payload.senderId) ||
    typeof payload.name !== 'string' || typeof payload.text !== 'string') invalid('消息格式不正确。');
  const name = payload.name.trim(), text = payload.text.trim();
  if (!name || [...name].length > 20) invalid('昵称请填写 1 至 20 个字。');
  if (!text || [...text].length > 500) invalid('消息请填写 1 至 500 个字。');
  const message = await db.prepare(`INSERT INTO chat_messages (request_id, sender_id, name, text, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING RETURNING ${CHAT_COLUMNS}`)
    .bind(payload.requestId, payload.senderId, name, text, new Date().toISOString()).first();
  if (message) return json({ message }, 201);
  const previous = await db.prepare(`SELECT ${CHAT_COLUMNS} FROM chat_messages WHERE request_id = ?`).bind(payload.requestId).first();
  if (!previous) throw new Error('Saved message unavailable');
  if (previous.senderId !== payload.senderId || previous.name !== name || previous.text !== text)
    return json({ error: '这条请求已用于其他消息，请重新发送。' }, 409);
  return json({ message: previous });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = origin === PUBLIC_ORIGIN || origin === url.origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
      ...(allowed ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } : {}),
    };
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
    if (origin && !allowed) return json({ error: '此来源不可访问棋盘。' }, 403);
    if (!['/api/game', '/api/chat', '/health'].includes(url.pathname)) return json({ error: 'Not found' }, 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    try {
      const db = database(env);
      if (url.pathname === '/api/chat' && request.method === 'GET') return json(await readMessages(db, url.searchParams));
      const current = url.pathname === '/api/chat' ? null : await readState(db);
      if (url.pathname === '/health') return json({ ok: true });
      if (request.method === 'GET') return json({ state: publicState(current) });
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
        return json({ error: '请求必须使用 JSON。' }, 415);
      const declaredLength = Number(request.headers.get('Content-Length') || 0);
      if (declaredLength > 4096) return json({ error: '请求过大。' }, 413);
      const reader = request.body?.getReader();
      if (!reader) return json({ error: '请求格式不正确。' }, 400);
      let size = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return json({ error: '请求过大。' }, 413); }
        chunks.push(value);
      }
      let payload;
      try {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch { return json({ error: '请求格式不正确。' }, 400); }
      if (url.pathname === '/api/chat') return await saveMessage(db, payload, json);
      if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
        typeof payload.requestId !== 'string' || !UUID.test(payload.requestId))
        return json({ error: '请求格式不正确，请刷新页面。' }, 400);
      if (current.recentRequests.includes(payload.requestId)) return json({ state: publicState(current) });
      if (current.revision !== payload.revision) return json({ error: '棋盘已更新，请确认最新局面后再操作。', state: publicState(current) }, 409);
      const next = applyAction(current, payload.action);
      next.recentRequests = [...current.recentRequests.slice(-63), payload.requestId];
      const saved = await db.prepare('UPDATE game SET revision = ?, state = ? WHERE id = 1 AND revision = ? RETURNING revision, state')
        .bind(next.revision, JSON.stringify(next), current.revision).first();
      if (!saved) {
        const latest = await readState(db);
        if (latest.recentRequests.includes(payload.requestId)) return json({ state: publicState(latest) });
        return json({ error: '另一台设备刚刚更新了棋盘，请重试。', state: publicState(latest) }, 409);
      }
      return json({ state: publicState(next) });
    } catch (error) {
      if (error.status === 400) return json({ error: error.message }, 400);
      console.error('Storage operation failed:', error.message);
      return json({ error: url.pathname === '/api/chat' ? '暂时无法连接聊天，请稍后重试。' : '暂时无法连接云端棋盘，请稍后重试。' }, 503);
    }
  },
};
