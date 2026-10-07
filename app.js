import { API_BASE } from './config.js?v=20261007-2';

const API_URL = `${API_BASE.replace(/\/+$/, '')}/api/game`;
const SIZE = 15;
const SYNC_INTERVAL_MS = 250;
const NAMES = ['', '先手', '后手'];
const PRESETS = [
  ['#222b38', '墨黑'], ['#edf0f4', '月白'], ['#718169', '苔绿'],
  ['#b77a55', '陶棕'], ['#647f9c', '雾蓝'], ['#a7777d', '藕粉'],
];

const $ = (id) => document.getElementById(id);
const board = $('board');
const intersections = $('intersections');
const cells = [];
let state = null;
let connected = false;
let saving = false;
let refreshPromise = null;
let requestSequence = 0;
let lastHealthSequence = 0;
let lastSync = null;
let focusedCell = 112;
let messageTimer;
let pendingConfirmation = null;
let pendingActions = [];
let reconciling = false;
let syncTimer = null;
let syncRetryMs = 0;

function buildBoard() {
  const coordinates = Array.from({ length: SIZE }, (_, i) => 24 + i * 48);
  const path = coordinates.map((p) => `M24 ${p}H696M${p} 24V696`).join('');
  const stars = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]];
  $('board-lines').innerHTML = `<path d="${path}"/>${stars.map(([x, y]) => `<circle cx="${coordinates[x]}" cy="${coordinates[y]}" r="3.2"/>`).join('')}`;

  for (let i = 0; i < SIZE; i += 1) {
    const horizontal = document.createElement('span');
    horizontal.textContent = String.fromCharCode(65 + i);
    $('horizontal-axis').append(horizontal);
    const vertical = document.createElement('span');
    vertical.textContent = String(SIZE - i);
    $('vertical-axis').append(vertical);
  }

  for (let y = 0; y < SIZE; y += 1) {
    const row = document.createElement('div');
    row.className = 'board-row';
    row.setAttribute('role', 'row');
    for (let x = 0; x < SIZE; x += 1) {
      const cell = document.createElement('button');
      const index = y * SIZE + x;
      cell.type = 'button';
      cell.className = 'intersection';
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      cell.dataset.index = String(index);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-rowindex', String(y + 1));
      cell.setAttribute('aria-colindex', String(x + 1));
      cell.setAttribute('aria-label', `${positionName(x, y)}，空位`);
      cell.setAttribute('aria-disabled', 'true');
      cell.tabIndex = index === focusedCell ? 0 : -1;
      cells.push(cell);
      row.append(cell);
    }
    intersections.append(row);
  }
}

function buildColors() {
  for (const player of [1, 2]) {
    for (const [color, name] of PRESETS) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'color-option';
      option.style.setProperty('--swatch-color', color);
      option.dataset.color = color;
      option.title = name;
      option.setAttribute('aria-label', `${NAMES[player]}选择${name}`);
      option.setAttribute('aria-pressed', 'false');
      option.disabled = true;
      option.addEventListener('click', () => changeColor(player, color));
      $(`color-options-${player}`).append(option);
    }
    $(`color-${player}`).addEventListener('change', (event) => changeColor(player, event.target.value));
  }
}

function positionName(x, y) {
  return `${String.fromCharCode(65 + x)}${SIZE - y}`;
}

function nextPlayer(current = state) {
  return current ? (current.moves.length % 2) + 1 : 1;
}

function isDraw(current = state) {
  return current && current.moves.length === SIZE * SIZE && current.winner === 0;
}

function isFinished(current = state) {
  return current && (current.winner !== 0 || isDraw(current));
}

function colorInk(color) {
  const values = color.slice(1).match(/.{2}/g).map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722 > 0.179 ? '#1c261f' : '#ffffff';
}

function styleStone(element, player) {
  const color = state ? state.colors[player - 1] : PRESETS[player - 1][0];
  const ink = colorInk(color);
  element.style.setProperty('--stone-color', color);
  element.style.setProperty('--stone-ink', ink);
  element.style.setProperty('--stone-border', ink === '#ffffff' ? '#17201e55' : '#7f887b66');
  element.textContent = '';
}

function validState(value) {
  const validPoint = (point) => point && Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= 0 && point.x < SIZE && point.y >= 0 && point.y < SIZE;
  return value && Number.isInteger(value.revision) && value.revision >= 0
    && Array.isArray(value.moves) && value.moves.length <= SIZE * SIZE
    && value.moves.every((move) => validPoint(move) && [1, 2].includes(move.player))
    && Array.isArray(value.colors) && value.colors.length === 2 && value.colors.every((color) => /^#[0-9a-f]{6}$/i.test(color))
    && [0, 1, 2].includes(value.winner)
    && Number.isInteger(value.round) && value.round >= 1
    && Array.isArray(value.line) && value.line.every(validPoint);
}

function applyState(nextState) {
  if (!validState(nextState)) throw new Error('服务器返回了无法读取的棋局。');
  if (state && nextState.revision <= state.revision) return;
  state = nextState;
  renderState();
}

// Preview queued actions without changing the confirmed revision. Only one write is sent at a time.
function previewState() {
  if (!state || !pendingActions.length) return state;
  const view = { ...state, moves: [...state.moves] };
  for (const { action } of pendingActions) {
    if (action.type === 'move') view.moves.push({ x: action.x, y: action.y, player: nextPlayer(view) });
    else if (action.type === 'undo') view.moves.pop();
  }
  view.line = previewWin(view.moves);
  view.winner = view.line.length ? view.moves[view.moves.length - 1].player : 0;
  return view;
}

function previewWin(moves) {
  const last = moves[moves.length - 1];
  if (!last) return [];
  const occupied = new Set(moves.filter(move => move.player === last.player).map(move => `${move.x},${move.y}`));
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

function renderState(view = previewState()) {
  if (!view) return;
  const occupied = new Map(view.moves.map((move, index) => [move.y * SIZE + move.x, { ...move, index }]));
  const winning = new Set(view.line.map(({ x, y }) => y * SIZE + x));
  cells.forEach((cell, index) => {
    const move = occupied.get(index);
    const previous = cell.dataset.move;
    const confirmed = move && state.moves[move.index];
    const isPending = move && (!confirmed || confirmed.x !== move.x || confirmed.y !== move.y || confirmed.player !== move.player);
    const signature = move ? `${Boolean(isPending)}:${move.player}:${move.index}:${view.colors[move.player - 1]}:${winning.has(index)}:${move.index === view.moves.length - 1}` : '';
    if (previous !== signature) {
      cell.replaceChildren();
      cell.dataset.move = signature;
      if (move) {
        const stone = document.createElement('span');
        stone.className = `stone${isPending ? ' is-pending' : ''}${move.index === view.moves.length - 1 ? ' is-last' : ''}${winning.has(index) ? ' is-winning' : ''}`;
        stone.setAttribute('aria-hidden', 'true');
        styleStone(stone, move.player);
        cell.append(stone);
      }
    }
    const coordinate = positionName(index % SIZE, Math.floor(index / SIZE));
    cell.setAttribute('aria-label', move ? `${coordinate}，${NAMES[move.player]}，第 ${move.index + 1} 手${move.index === view.moves.length - 1 ? '，最后落子' : ''}` : `${coordinate}，空位`);
    cell.dataset.occupied = move ? 'true' : 'false';
  });

  for (const player of [1, 2]) {
    styleStone($(`player-stone-${player}`), player);
    $(`color-${player}`).value = view.colors[player - 1];
    $(`player-card-${player}`).classList.toggle('is-current', !isFinished(view) && nextPlayer(view) === player);
    for (const option of $(`color-options-${player}`).children) {
      option.setAttribute('aria-pressed', String(option.dataset.color.toLowerCase() === view.colors[player - 1].toLowerCase()));
    }
  }

  $('round').textContent = String(view.round).padStart(2, '0');
  $('move-count').replaceChildren(document.createTextNode(String(view.moves.length)));
  const moveUnit = document.createElement('small');
  moveUnit.textContent = '手';
  $('move-count').append(moveUnit);
  const player = view.winner || nextPlayer(view);
  styleStone($('turn-stone'), player);
  $('turn-stone').hidden = Boolean(isDraw(view));
  $('turn-heading').textContent = isFinished(view) ? '这一局，已见分晓' : '棋局进行时';
  $('turn-title').textContent = view.winner ? `${NAMES[view.winner]}获胜` : isDraw(view) ? '和棋，也是好棋' : `轮到${NAMES[player]}落子`;
  $('turn-description').textContent = view.winner ? `${NAMES[view.winner]}已连成五子 · 可以再来一局` : isDraw(view) ? '棋盘已满 · 再来一局吧' : `点击交叉点，落下第 ${view.moves.length + 1} 手`;
  $('game-status').textContent = view.winner ? '已有胜局' : isDraw(view) ? '和棋' : view.moves.length ? '对弈中' : '等待落子';
  const lastMove = view.moves.at(-1);
  $('last-move').textContent = lastMove ? `第 ${view.moves.length} 手 · ${NAMES[lastMove.player]} ${positionName(lastMove.x, lastMove.y)}` : '先手先行 · 从这里开始';
  board.style.setProperty('--preview-color', view.colors[nextPlayer(view) - 1]);
  $('board-loading').hidden = true;
  renderControls();
}

function renderControls() {
  const view = previewState();
  const available = Boolean(state && connected && !reconciling);
  const idle = available && !saving;
  const canPlay = available && !isFinished(view);
  board.dataset.canPlay = String(canPlay);
  board.setAttribute('aria-busy', String(!state || saving));
  for (const cell of cells) {
    cell.setAttribute('aria-disabled', String(!canPlay || cell.dataset.occupied === 'true'));
  }
  $('reset-button').disabled = !idle;
  $('undo-button').disabled = !available || !view.moves.length;
  $('dialog-confirm').disabled = !idle;
  for (const player of [1, 2]) {
    $(`color-${player}`).disabled = !idle;
    for (const option of $(`color-options-${player}`).children) option.disabled = !idle;
  }
  const mode = saving ? 'saving' : connected ? 'online' : refreshPromise ? 'connecting' : 'offline';
  $('connection').dataset.mode = mode;
  $('connection-text').textContent = mode === 'saving' ? '正在同步' : mode === 'online' ? '棋局已同步' : mode === 'connecting' ? '连接棋盘中' : '棋盘未连接';
  $('retry-button').hidden = connected || saving;
  $('retry-button').disabled = Boolean(refreshPromise);
  $('sync-detail').textContent = saving ? `还有 ${pendingActions.length} 个操作待同步 · 可以继续落子或悔棋` : connected && lastSync
    ? `已同步 ${lastSync.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })} · 自动保存`
    : state ? '连接中断 · 正在保留当前画面' : '棋局保存在云端';
  if (!state) {
    $('board-loading').dataset.offline = String(!refreshPromise);
    $('loading-text').textContent = refreshPromise ? '正在读取棋局…' : '暂时无法连接，请点击「重新连接」';
  }
}

function setHealth(isConnected, sequence) {
  if (sequence < lastHealthSequence) return;
  lastHealthSequence = sequence;
  connected = isConnected;
  if (isConnected) lastSync = new Date();
  renderControls();
}

function showMessage(text, kind = 'info', duration = 5500) {
  clearTimeout(messageTimer);
  $('message').textContent = text;
  $('message').dataset.kind = kind;
  $('message').hidden = false;
  if (duration) messageTimer = setTimeout(() => { $('message').hidden = true; }, duration);
}

async function requestJSON(options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(API_URL, { ...options, cache: 'no-store', signal: controller.signal });
    const body = await response.json();
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function refresh({ manual = false, uncertain = false } = {}) {
  if (saving) return Promise.resolve(false);
  if (refreshPromise) return refreshPromise;
  const sequence = ++requestSequence;
  refreshPromise = (async () => {
    try {
      const { response, body } = await requestJSON();
      if (!response.ok) throw new Error(body.error || '暂时无法读取棋局。');
      // A read started before this write must not replace its immediate preview.
      if (saving || sequence < lastHealthSequence) return false;
      applyState(body.state);
      syncRetryMs = 0;
      setHealth(true, sequence);
      if (uncertain) showMessage('已重新读取棋局，请查看落子结果后继续。');
      else if (manual) showMessage('已连接，棋局已更新。');
      return true;
    } catch {
      if (saving || sequence < lastHealthSequence) return false;
      syncRetryMs = Math.min(10000, syncRetryMs ? syncRetryMs * 2 : 1000);
      setHealth(false, sequence);
      if (manual || uncertain) showMessage('暂时无法连接。当前画面已保留，请稍后重试。', 'error');
      return false;
    } finally {
      refreshPromise = null;
      renderControls();
    }
  })();
  renderControls();
  return refreshPromise;
}

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  if (document.hidden || navigator.onLine === false) return;
  syncTimer = setTimeout(pollSync, delay);
}

async function pollSync() {
  clearTimeout(syncTimer);
  if (document.hidden || navigator.onLine === false) return;
  const started = performance.now();
  await refresh();
  // Compensate for the GET duration, while refreshPromise prevents overlapping requests.
  scheduleSync(syncRetryMs || Math.max(0, SYNC_INTERVAL_MS - (performance.now() - started)));
}

function resumeSync() {
  syncRetryMs = 0;
  void pollSync();
}

function submitAction(action, expectedRevision = state?.revision) {
  if (!state || !connected || reconciling) return;
  const view = previewState();
  if (action.type === 'move' && (isFinished(view) || view.moves.some(move => move.x === action.x && move.y === action.y))) return;
  if (action.type === 'undo' && !view.moves.length) return;
  if (!['move', 'undo'].includes(action.type) && saving) return;
  pendingActions.push({ action, requestId: crypto.randomUUID(), expectedRevision });
  renderState();
  void drainActions();
}

async function drainActions() {
  if (saving || !pendingActions.length) return;
  saving = true;
  renderControls();
  let uncertain = false;
  let needsRefresh = false;
  try {
    while (pendingActions.length) {
      const entry = pendingActions[0];
      const sequence = ++requestSequence;
      try {
        const { response, body } = await requestJSON({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: entry.action.type === 'reset' ? entry.expectedRevision : state.revision,
            requestId: entry.requestId,
            action: entry.action,
          }),
        });
        if (response.status === 409) {
          pendingActions = [];
          applyState(body.state);
          setHealth(true, sequence);
          showMessage('其他设备更新了棋局，尚未同步的操作已撤回。请查看棋盘后继续。');
          break;
        }
        if (!response.ok) {
          if (response.status >= 500) throw new Error(body.error || '保存结果未确认。');
          pendingActions = [];
          setHealth(true, sequence);
          showMessage(body.error || '操作未保存，已撤回尚未同步的操作。', 'error');
          needsRefresh = true;
          break;
        }
        if (!validState(body.state)) throw new Error('服务器返回了无法读取的棋局。');
        pendingActions.shift();
        applyState(body.state);
        setHealth(true, sequence);
        if (entry.action.type === 'reset') showMessage('新的一局开始了，双方颜色已保留。');
        else if (entry.action.type === 'color') showMessage(`${NAMES[entry.action.player]}的新颜色已同步。`, 'info', 2500);
      } catch {
        // An ambiguous write must never cause dependent moves to be replayed on another board.
        pendingActions = [];
        uncertain = true;
        setHealth(false, sequence);
        showMessage('同步中断，尚未确认的操作已撤回。正在重新读取云端棋局。', 'error');
        break;
      }
    }
  } finally {
    reconciling = uncertain || needsRefresh;
    saving = false;
    renderState();
    renderControls();
  }
  if (reconciling) {
    try {
      if (refreshPromise) await refreshPromise;
      await refresh({ uncertain });
    } finally {
      reconciling = false;
      renderControls();
    }
  }
}

function changeColor(player, color) {
  if (!state || color.toLowerCase() === state.colors[player - 1].toLowerCase()) return;
  submitAction({ type: 'color', player, color });
}

function confirmAction(type) {
  if (!state || !connected || saving) return;
  // Confirm the exact revision the visitor saw, so a later move is never silently erased.
  pendingConfirmation = { type, revision: state.revision };
  $('dialog-title').textContent = '重新开始这一局？';
  $('dialog-description').textContent = '当前棋盘将被清空，所有设备都会进入新的一局。双方颜色会保留。';
  $('dialog-confirm').textContent = '确认重开';
  $('confirm-dialog').returnValue = '';
  $('confirm-dialog').showModal();
  $('dialog-cancel').focus();
}

buildBoard();
buildColors();
for (const player of [1, 2]) styleStone($(`player-stone-${player}`), player);

intersections.addEventListener('click', (event) => {
  const cell = event.target.closest('.intersection');
  if (!cell || cell.getAttribute('aria-disabled') === 'true') return;
  submitAction({ type: 'move', x: Number(cell.dataset.x), y: Number(cell.dataset.y) });
});

intersections.addEventListener('focusin', (event) => {
  const cell = event.target.closest('.intersection');
  if (!cell) return;
  cells[focusedCell].tabIndex = -1;
  focusedCell = Number(cell.dataset.index);
  cells[focusedCell].tabIndex = 0;
});

intersections.addEventListener('keydown', (event) => {
  let x = focusedCell % SIZE;
  let y = Math.floor(focusedCell / SIZE);
  if (event.key === 'ArrowLeft') x = Math.max(0, x - 1);
  else if (event.key === 'ArrowRight') x = Math.min(SIZE - 1, x + 1);
  else if (event.key === 'ArrowUp') y = Math.max(0, y - 1);
  else if (event.key === 'ArrowDown') y = Math.min(SIZE - 1, y + 1);
  else if (event.key === 'Home') { x = 0; if (event.ctrlKey) y = 0; }
  else if (event.key === 'End') { x = SIZE - 1; if (event.ctrlKey) y = SIZE - 1; }
  else return;
  event.preventDefault();
  cells[y * SIZE + x].focus();
});

$('reset-button').addEventListener('click', () => confirmAction('reset'));
$('undo-button').addEventListener('click', () => {
  if (previewState()?.moves.length) submitAction({ type: 'undo' });
});
$('retry-button').addEventListener('click', () => {
  syncRetryMs = 0;
  void refresh({ manual: true }).finally(() => scheduleSync(syncRetryMs || SYNC_INTERVAL_MS));
});
$('confirm-dialog').addEventListener('close', () => {
  const confirmation = pendingConfirmation;
  pendingConfirmation = null;
  if ($('confirm-dialog').returnValue === 'confirm' && confirmation) {
    submitAction({ type: confirmation.type }, confirmation.revision);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(syncTimer);
  else resumeSync();
});
window.addEventListener('focus', resumeSync);
window.addEventListener('online', resumeSync);
window.addEventListener('offline', () => {
  clearTimeout(syncTimer);
  setHealth(false, ++requestSequence);
});
resumeSync();
