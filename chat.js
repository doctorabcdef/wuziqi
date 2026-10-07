import { API_BASE } from './config.js?v=20261007-2';

const API_URL = `${API_BASE.replace(/\/+$/, '')}/api/chat`;
const POLL_MS = 750;
const $ = (id) => document.getElementById(id);
const scrollBox = $('chat-scroll');
const messageList = $('chat-messages');
const input = $('chat-input');
const nameInput = $('chat-name');
const messages = new Map();
const messageNodes = new Map();
const failedRequests = new Map();
const quickButtons = [...document.querySelectorAll('[data-chat-quick]')];

function preference(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Private browsing still supports this visit. */ }
}

const senderId = preference('wuziqi-chat-sender', crypto.randomUUID());
savePreference('wuziqi-chat-sender', senderId);
nameInput.value = preference('wuziqi-chat-name', '棋友').slice(0, 20);

let initialized = false;
let cursor = 0;
let oldestCursor = null;
let hasOlder = false;
let loadingOlder = false;
let historyError = '';
let syncError = '';
let sendNotice = '';
let sending = false;
let pollPromise = null;
let timer = null;
let retryDelay = 0;

function nearBottom() {
  return scrollBox.scrollHeight - scrollBox.clientHeight - scrollBox.scrollTop < 60;
}

function scrollToLatest() {
  scrollBox.scrollTop = scrollBox.scrollHeight;
  $('chat-new').hidden = true;
}

function updateStatus() {
  let status = '消息已同步';
  if (!initialized) status = '连接聊天中';
  if (sendNotice) status = sendNotice;
  if (syncError) status = syncError;
  if (historyError) status = historyError;
  if (failedRequests.size) status = `有 ${failedRequests.size} 条消息尚未确认，请重试发送`;
  if (navigator.onLine === false) status = '网络已断开，联网后自动恢复聊天';
  if (sending) status = '正在发送…';
  $('chat-status').textContent = status;
  $('chat-status').dataset.error = String(Boolean(syncError || historyError || failedRequests.size));
  $('chat-retry').hidden = !syncError;
  $('chat-retry-send').hidden = !failedRequests.size;
  $('chat-retry-send').disabled = sending;
  $('chat-send').disabled = sending;
  for (const button of quickButtons) button.disabled = sending;
  $('chat-older').hidden = !hasOlder;
  $('chat-older').disabled = loadingOlder;
  $('chat-older').textContent = loadingOlder ? '正在读取…' : historyError ? '重试读取更早消息' : '查看更早消息';
  $('chat-empty').hidden = messages.size > 0;
  $('chat-empty').textContent = initialized ? '还没有消息，打个招呼吧。' : syncError ? '聊天记录暂时无法读取，请重新连接。' : '正在读取聊天记录…';
}

function messageNode(message) {
  const item = document.createElement('article');
  item.className = `chat-message${message.senderId === senderId ? ' is-own' : ''}`;
  item.dataset.messageId = String(message.id);
  const meta = document.createElement('div');
  meta.className = 'chat-message-meta';
  const author = document.createElement('span');
  author.className = 'chat-author';
  author.textContent = `${message.senderId === senderId ? '我 · ' : ''}${message.name}`;
  const time = document.createElement('time');
  time.dateTime = message.createdAt;
  const date = new Date(message.createdAt);
  time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const body = document.createElement('p');
  body.className = 'chat-message-text';
  body.textContent = message.text;
  meta.append(author, time);
  item.append(meta, body);
  return item;
}

function mergeMessages(batch, { older = false, own = false, initial = false } = {}) {
  const oldHeight = scrollBox.scrollHeight;
  const oldTop = scrollBox.scrollTop;
  const follow = nearBottom();
  let added = false;
  for (const message of batch) {
    const confirmed = failedRequests.get(message.requestId);
    if (confirmed) {
      finishDraft(confirmed);
      sendNotice = '消息已发送';
    }
    failedRequests.delete(message.requestId);
    if (!messages.has(message.id)) {
      messages.set(message.id, message);
      messageNodes.set(message.id, messageNode(message));
      added = true;
    }
  }
  if (added) {
    // Reuse existing elements so polling does not disturb a selected message.
    const ordered = [...messages.values()].sort((a, b) => a.id - b.id);
    let nextNode = messageList.firstElementChild;
    for (const message of ordered) {
      const node = messageNodes.get(message.id);
      if (node === nextNode) nextNode = nextNode.nextElementSibling;
      else messageList.insertBefore(node, nextNode);
    }
    $('chat-empty').hidden = true;
    if (older) scrollBox.scrollTop = oldTop + scrollBox.scrollHeight - oldHeight;
    else if (initial || own || follow) scrollToLatest();
    else $('chat-new').hidden = false;
  } else if (own) scrollToLatest();
  updateStatus();
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { ...options, cache: 'no-store', signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '暂时无法连接聊天');
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function canPoll() {
  return document.visibilityState !== 'hidden' && navigator.onLine !== false;
}

function schedulePoll(delay = retryDelay || POLL_MS) {
  clearTimeout(timer);
  timer = null;
  if (canPoll()) timer = setTimeout(poll, delay);
}

async function poll() {
  if (!canPoll()) return;
  if (pollPromise) return pollPromise;
  clearTimeout(timer);
  timer = null;
  pollPromise = (async () => {
    try {
      let more = false;
      do {
        const initial = !initialized;
        const url = new URL(API_URL, location.href);
        url.searchParams.set('limit', '50');
        if (!initial) url.searchParams.set('after', String(cursor));
        const payload = await request(url);
        const batch = payload.messages;
        if (!Array.isArray(batch)) throw new Error('聊天记录格式异常');
        if (initial) {
          oldestCursor = batch[0]?.id ?? null;
          hasOlder = payload.hasMore;
        } else if (oldestCursor === null && batch.length) {
          oldestCursor = batch[0].id;
        }
        // Only fetched history advances this cursor. A POST acknowledgement may
        // arrive ahead of messages from another device that still need fetching.
        for (const message of batch) cursor = Math.max(cursor, message.id);
        initialized = true;
        syncError = '';
        retryDelay = 0;
        mergeMessages(batch, { initial });
        messageList.setAttribute('aria-live', 'polite');
        more = !initial && payload.hasMore && batch.length > 0;
      } while (more && canPoll());
    } catch {
      syncError = '聊天暂时无法连接，正在重试';
      retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 10000);
      updateStatus();
    } finally {
      pollPromise = null;
      schedulePoll();
    }
  })();
  return pollPromise;
}

async function loadOlder() {
  if (loadingOlder || !hasOlder || oldestCursor === null) return;
  loadingOlder = true;
  historyError = '';
  updateStatus();
  try {
    const url = new URL(API_URL, location.href);
    url.searchParams.set('limit', '50');
    url.searchParams.set('before', String(oldestCursor));
    const payload = await request(url);
    if (!Array.isArray(payload.messages)) throw new Error('聊天记录格式异常');
    if (payload.messages.length) oldestCursor = payload.messages[0].id;
    hasOlder = payload.hasMore;
    // Older entries are available to the reader without announcing them as new.
    messageList.setAttribute('aria-live', 'off');
    mergeMessages(payload.messages, { older: true });
    messageList.setAttribute('aria-live', 'polite');
  } catch {
    historyError = '更早的消息读取失败，请重试';
  } finally {
    loadingOlder = false;
    updateStatus();
  }
}

function finishDraft(record) {
  if (record.draft !== null && input.value === record.draft) {
    input.value = '';
    $('chat-count').textContent = '0 / 500';
  }
}

async function sendRecord(record) {
  if (sending) return;
  sending = true;
  sendNotice = '';
  updateStatus();
  try {
    if (navigator.onLine === false) throw new Error('网络已断开');
    const { draft, ...body } = record;
    const payload = await request(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!payload.message) throw new Error('发送结果未确认');
    failedRequests.delete(record.requestId);
    mergeMessages([payload.message], { own: true });
    finishDraft(record);
    sendNotice = '消息已发送';
  } catch {
    // A successful POST can lose its response; a concurrent history read is
    // enough to confirm delivery, and a retry keeps the same request identity.
    if ([...messages.values()].some((message) => message.requestId === record.requestId)) {
      failedRequests.delete(record.requestId);
      finishDraft(record);
      sendNotice = '消息已发送';
    } else {
      failedRequests.set(record.requestId, record);
    }
  } finally {
    sending = false;
    updateStatus();
    schedulePoll(0);
  }
}

function sendText(text, draft = null) {
  if (sending) return;
  const trimmed = text.trim();
  if (!trimmed) {
    sendNotice = '写点内容再发送吧';
    updateStatus();
    input.focus();
    return;
  }
  const name = nameInput.value.trim() || '棋友';
  nameInput.value = name;
  savePreference('wuziqi-chat-name', name);
  const previous = [...failedRequests.values()].find((record) => record.text === trimmed && record.name === name);
  const record = previous || { requestId: crypto.randomUUID(), senderId, name, text: trimmed, draft };
  if (draft !== null) record.draft = draft;
  void sendRecord(record);
}

$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendText(input.value, input.value);
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendText(input.value, input.value);
  }
});
input.addEventListener('input', () => {
  $('chat-count').textContent = `${input.value.length} / 500`;
});
nameInput.addEventListener('change', () => savePreference('wuziqi-chat-name', nameInput.value.trim() || '棋友'));
for (const button of quickButtons) button.addEventListener('click', () => sendText(button.dataset.chatQuick));
$('chat-older').addEventListener('click', loadOlder);
$('chat-new').addEventListener('click', scrollToLatest);
scrollBox.addEventListener('scroll', () => { if (nearBottom()) $('chat-new').hidden = true; }, { passive: true });
$('chat-retry-send').addEventListener('click', () => {
  const record = failedRequests.values().next().value;
  if (record) void sendRecord(record);
});
$('chat-retry').addEventListener('click', () => { retryDelay = 0; void poll(); });

function resume() {
  clearTimeout(timer);
  timer = null;
  updateStatus();
  if (canPoll()) {
    retryDelay = 0;
    void poll();
  }
}

document.addEventListener('visibilitychange', resume);
window.addEventListener('online', resume);
window.addEventListener('offline', resume);
window.addEventListener('focus', resume);
updateStatus();
void poll();
