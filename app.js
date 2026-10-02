import { API_BASE } from './config.js';

const API_URL = `${API_BASE.replace(/\/+$/, '')}/api/game`;
const SIZE = 15;
const SYMBOLS = ['', 'Ⅰ', 'Ⅱ'];
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

function nextPlayer() {
  return state ? (state.moves.length % 2) + 1 : 1;
}

function isDraw() {
  return state && state.moves.length === SIZE * SIZE && state.winner === 0;
}

function isFinished() {
  return state && (state.winner !== 0 || isDraw());
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
  element.textContent = SYMBOLS[player];
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

function renderState() {
  if (!state) return;
  const occupied = new Map(state.moves.map((move, index) => [move.y * SIZE + move.x, { ...move, index }]));
  const winning = new Set(state.line.map(({ x, y }) => y * SIZE + x));
  cells.forEach((cell, index) => {
    const move = occupied.get(index);
    const previous = cell.dataset.move;
    const signature = move ? `${move.player}:${move.index}:${state.colors[move.player - 1]}:${winning.has(index)}:${move.index === state.moves.length - 1}` : '';
    if (previous !== signature) {
      cell.replaceChildren();
      cell.dataset.move = signature;
      if (move) {
        const stone = document.createElement('span');
        stone.className = `stone${move.index === state.moves.length - 1 ? ' is-last' : ''}${winning.has(index) ? ' is-winning' : ''}`;
        stone.setAttribute('aria-hidden', 'true');
        styleStone(stone, move.player);
        cell.append(stone);
      }
    }
    const coordinate = positionName(index % SIZE, Math.floor(index / SIZE));
    cell.setAttribute('aria-label', move ? `${coordinate}，${NAMES[move.player]}，第 ${move.index + 1} 手${move.index === state.moves.length - 1 ? '，最后落子' : ''}` : `${coordinate}，空位`);
    cell.dataset.occupied = move ? 'true' : 'false';
  });

  for (const player of [1, 2]) {
    styleStone($(`player-stone-${player}`), player);
    $(`color-${player}`).value = state.colors[player - 1];
    $(`player-card-${player}`).classList.toggle('is-current', !isFinished() && nextPlayer() === player);
    for (const option of $(`color-options-${player}`).children) {
      option.setAttribute('aria-pressed', String(option.dataset.color.toLowerCase() === state.colors[player - 1].toLowerCase()));
    }
  }

  $('round').textContent = String(state.round).padStart(2, '0');
  $('move-count').replaceChildren(document.createTextNode(String(state.moves.length)));
  const moveUnit = document.createElement('small');
  moveUnit.textContent = '手';
  $('move-count').append(moveUnit);
  const player = state.winner || nextPlayer();
  styleStone($('turn-stone'), player);
  $('turn-stone').hidden = Boolean(isDraw());
  $('turn-heading').textContent = isFinished() ? '这一局，已见分晓' : '棋局进行时';
  $('turn-title').textContent = state.winner ? `${NAMES[state.winner]}获胜` : isDraw() ? '和棋，也是好棋' : `轮到${NAMES[player]}落子`;
  $('turn-description').textContent = state.winner ? `${SYMBOLS[state.winner]} 已连成五子 · 可以再来一局` : isDraw() ? '棋盘已满 · 再来一局吧' : `点击交叉点，落下第 ${state.moves.length + 1} 手`;
  $('game-status').textContent = state.winner ? '已有胜局' : isDraw() ? '和棋' : state.moves.length ? '对弈中' : '等待落子';
  const lastMove = state.moves.at(-1);
  $('last-move').textContent = lastMove ? `第 ${state.moves.length} 手 · ${NAMES[lastMove.player]} ${positionName(lastMove.x, lastMove.y)}` : '先手先行 · 从这里开始';
  board.style.setProperty('--preview-color', state.colors[nextPlayer() - 1]);
  $('board-loading').hidden = true;
  renderControls();
}

function renderControls() {
  const available = Boolean(state && connected && !saving);
  const canPlay = available && !isFinished();
  board.dataset.canPlay = String(canPlay);
  board.setAttribute('aria-busy', String(!state || saving));
  for (const cell of cells) {
    cell.setAttribute('aria-disabled', String(!canPlay || cell.dataset.occupied === 'true'));
  }
  $('reset-button').disabled = !available;
  $('undo-button').disabled = !available || !state.moves.length;
  $('dialog-confirm').disabled = !available;
  for (const player of [1, 2]) {
    $(`color-${player}`).disabled = !available;
    for (const option of $(`color-options-${player}`).children) option.disabled = !available;
  }
  const mode = saving ? 'saving' : connected ? 'online' : refreshPromise ? 'connecting' : 'offline';
  $('connection').dataset.mode = mode;
  $('connection-text').textContent = mode === 'saving' ? '正在同步' : mode === 'online' ? '棋局已同步' : mode === 'connecting' ? '连接棋盘中' : '棋盘未连接';
  $('retry-button').hidden = connected || saving;
  $('retry-button').disabled = Boolean(refreshPromise);
  $('sync-detail').textContent = connected && lastSync
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
      applyState(body.state);
      setHealth(true, sequence);
      if (uncertain) showMessage('已重新读取棋局，请查看落子结果后继续。');
      else if (manual) showMessage('已连接，棋局已更新。');
      return true;
    } catch {
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

async function submitAction(action, expectedRevision = state?.revision) {
  if (!state || !connected || saving) return;
  saving = true;
  renderControls();
  const sequence = ++requestSequence;
  let uncertain = false;
  let needsRefresh = false;
  try {
    const { response, body } = await requestJSON({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: expectedRevision, requestId: crypto.randomUUID(), action }),
    });
    if (response.status === 409) {
      applyState(body.state);
      setHealth(true, sequence);
      showMessage('棋局刚刚被其他设备更新，已为你刷新。请查看棋盘后重新操作。');
    } else if (!response.ok) {
      if (response.status >= 500) throw new Error(body.error || '保存结果未确认。');
      setHealth(true, sequence);
      showMessage(body.error || '这一步未能完成，请查看棋盘后重试。', 'error');
      needsRefresh = true;
    } else {
      applyState(body.state);
      setHealth(true, sequence);
      if (action.type === 'reset') showMessage('新的一局开始了，双方颜色已保留。');
      else if (action.type === 'undo') showMessage('已退回上一步，所有设备会同步更新。');
      else if (action.type === 'color') showMessage(`${NAMES[action.player]}的新颜色已同步。`, 'info', 2500);
    }
  } catch {
    uncertain = true;
    setHealth(false, sequence);
    showMessage('暂时无法确认操作结果，正在重新读取棋局，请稍候。', 'error');
  } finally {
    saving = false;
    // Restore native color inputs to the last confirmed server values as well.
    renderState();
    renderControls();
  }
  if (uncertain || needsRefresh) {
    if (refreshPromise) await refreshPromise;
    await refresh({ uncertain });
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
  const undo = type === 'undo';
  $('dialog-title').textContent = undo ? '退回刚刚的这一步？' : '重新开始这一局？';
  $('dialog-description').textContent = undo
    ? '最后落下的一颗棋子将被撤回，所有设备都会同步。请先与对手商量好。'
    : '当前棋盘将被清空，所有设备都会进入新的一局。双方颜色会保留。';
  $('dialog-confirm').textContent = undo ? '确认悔棋' : '确认重开';
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
$('undo-button').addEventListener('click', () => confirmAction('undo'));
$('retry-button').addEventListener('click', () => refresh({ manual: true }));
$('confirm-dialog').addEventListener('close', () => {
  const confirmation = pendingConfirmation;
  pendingConfirmation = null;
  if ($('confirm-dialog').returnValue === 'confirm' && confirmation) {
    submitAction({ type: confirmation.type }, confirmation.revision);
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('focus', () => refresh());
window.addEventListener('online', () => refresh());
window.addEventListener('offline', () => {
  setHealth(false, ++requestSequence);
});
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
refresh();
