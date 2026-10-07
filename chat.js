import { API_BASE } from './config.js?v=20261007-2';
import { VOICE_CLIPS } from './voice-clips.js?v=20261007-6';

const API_URL = API_BASE.replace(/\/+$/, '') + '/api/chat';
const POLL_MS = 250;
const $ = (id) => document.getElementById(id);
const scrollBox = $('chat-scroll');
const messageList = $('chat-messages');
const input = $('chat-input');
const nameInput = $('chat-name');
const messages = new Map();
const messageNodes = new Map();
const outgoing = new Map();
const failedRequests = new Map();
const sendQueue = [];
const quickButtons = [...document.querySelectorAll('[data-chat-quick]')];
const voiceButtons = [...document.querySelectorAll('[data-chat-voice]')];

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
let inputVersion = 0;
let activeAudio = null;

function nearBottom() {
  return scrollBox.scrollHeight - scrollBox.clientHeight - scrollBox.scrollTop < 60;
}

function scrollToLatest() {
  scrollBox.scrollTop = scrollBox.scrollHeight;
  $('chat-new').hidden = true;
}

function updateStatus() {
  let status = initialized ? '消息已同步' : '连接聊天中';
  if (sendNotice) status = sendNotice;
  if (syncError) status = syncError;
  if (historyError) status = historyError;
  const pendingCount = outgoing.size - failedRequests.size;
  if (pendingCount) status = '正在发送 ' + pendingCount + ' 条消息…';
  if (failedRequests.size) status = '有 ' + failedRequests.size + ' 条消息未确认，可点击重试';
  if (navigator.onLine === false) status = '网络已断开，联网后自动恢复聊天';
  $('chat-status').textContent = status;
  $('chat-status').dataset.error = String(Boolean(syncError || historyError || failedRequests.size));
  $('chat-retry').hidden = !syncError;
  $('chat-retry-send').hidden = !failedRequests.size;
  $('chat-older').hidden = !hasOlder;
  $('chat-older').disabled = loadingOlder;
  $('chat-older').textContent = loadingOlder ? '正在读取…' : historyError ? '重试读取更早消息' : '查看更早消息';
  $('chat-empty').hidden = messages.size + outgoing.size > 0;
  $('chat-empty').textContent = initialized ? '还没有消息，打个招呼吧。' : syncError ? '聊天记录暂时无法读取，请重新连接。' : '正在读取聊天记录…';
}

function voiceClip(text) {
  return Object.values(VOICE_CLIPS).find((clip) => clip.text === text);
}

function createVoiceBody(clip) {
  const body = document.createElement('div');
  body.className = 'chat-message-text chat-message-voice';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-voice-play';
  button.dataset.voiceId = clip.id;
  const icon = document.createElement('span');
  icon.className = 'chat-voice-icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = clip.label;
  button.append(icon, label);
  const audio = document.createElement('audio');
  audio.src = clip.src;
  audio.preload = 'metadata';
  audio.dataset.voiceId = clip.id;
  const status = document.createElement('span');
  status.className = 'chat-voice-status';
  let played = false;

  function updatePlayer(note = '') {
    const playing = !audio.paused && !audio.ended;
    icon.textContent = playing ? 'Ⅱ' : '▶';
    button.setAttribute('aria-label', (playing ? '暂停' : '播放') + '语音：' + clip.label);
    button.setAttribute('aria-pressed', String(playing));
    const duration = Number.isFinite(audio.duration) ? Math.max(1, Math.ceil(audio.duration)) + ' 秒 · ' : '';
    status.textContent = note || (playing ? '正在播放…' : duration + (played ? '点击重播' : '点击播放'));
  }

  // Keep each player on its stable DOM node: a server confirmation must not
  // replace an audio element that the visitor is already listening to.
  body.playVoice = (automatic = false) => {
    if (automatic && activeAudio && !activeAudio.paused) return;
    if (!automatic && !audio.paused) {
      audio.pause();
      return;
    }
    if (activeAudio && activeAudio !== audio) activeAudio.pause();
    activeAudio = audio;
    if (audio.error) audio.load();
    const playback = audio.play();
    if (playback) playback.catch((error) => {
      if (error.name === 'AbortError') {
        updatePlayer();
        return;
      }
      if (activeAudio === audio) activeAudio = null;
      updatePlayer(error.name === 'NotAllowedError' ? '点击播放语音' : '播放失败，点击重试');
    });
  };
  button.addEventListener('click', () => body.playVoice());
  audio.addEventListener('play', () => { played = true; updatePlayer(); });
  audio.addEventListener('pause', () => {
    if (activeAudio === audio) activeAudio = null;
    updatePlayer();
  });
  audio.addEventListener('ended', () => {
    if (activeAudio === audio) activeAudio = null;
    updatePlayer();
  });
  audio.addEventListener('loadedmetadata', () => updatePlayer());
  audio.addEventListener('error', () => updatePlayer('语音读取失败，点击重试'));
  updatePlayer();
  body.append(button, status, audio);
  return body;
}

function messageNode(message) {
  const item = document.createElement('article');
  item.className = 'chat-message' + (message.senderId === senderId ? ' is-own' : '');
  item.dataset.requestId = message.requestId;
  const meta = document.createElement('div');
  meta.className = 'chat-message-meta';
  const author = document.createElement('span');
  author.className = 'chat-author';
  const time = document.createElement('time');
  const clip = voiceClip(message.text);
  const body = clip ? createVoiceBody(clip) : document.createElement('p');
  if (!clip) {
    body.className = 'chat-message-text';
    body.textContent = message.text;
  }
  const delivery = document.createElement('div');
  delivery.className = 'chat-delivery-row';
  const status = document.createElement('span');
  status.className = 'chat-delivery';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'chat-message-retry text-button';
  retry.textContent = '重试';
  retry.addEventListener('click', () => {
    const record = outgoing.get(item.dataset.requestId);
    if (record?.status === 'failed') enqueue(record);
  });
  delivery.append(status, retry);
  meta.append(author, time);
  item.append(meta, body, delivery);
  return item;
}

function updateMessageNode(item, message) {
  const status = message.id ? 'sent' : message.status;
  if (item.dataset.delivery === status && (item.dataset.messageId || '') === (message.id ? String(message.id) : '')) return;
  item.dataset.delivery = status;
  if (message.id) item.dataset.messageId = String(message.id);
  item.querySelector('.chat-author').textContent = (message.senderId === senderId ? '我 · ' : '') + message.name;
  const time = item.querySelector('time');
  time.dateTime = message.createdAt;
  const date = new Date(message.createdAt);
  time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  item.querySelector('.chat-delivery').textContent = { queued: '待发送…', sending: '发送中…', failed: '未确认', sent: '已发送' }[status] || '';
  item.querySelector('.chat-message-retry').hidden = status !== 'failed';
  item.querySelector('.chat-delivery-row').hidden = message.senderId !== senderId;
}

function renderMessages({ older = false, own = false, initial = false, added = false } = {}) {
  const oldHeight = scrollBox.scrollHeight;
  const oldTop = scrollBox.scrollTop;
  const follow = nearBottom();
  const ordered = [...messages.values()].sort((a, b) => a.id - b.id).concat([...outgoing.values()]);
  let nextNode = messageList.firstElementChild;
  for (const message of ordered) {
    let node = messageNodes.get(message.requestId);
    if (!node) {
      node = messageNode(message);
      messageNodes.set(message.requestId, node);
    }
    updateMessageNode(node, message);
    if (node === nextNode) nextNode = nextNode.nextElementSibling;
    else if (node.isConnected && messageList.moveBefore) messageList.moveBefore(node, nextNode);
    else messageList.insertBefore(node, nextNode);
  }
  if (older) scrollBox.scrollTop = oldTop + scrollBox.scrollHeight - oldHeight;
  else if (initial || own || (added && follow)) scrollToLatest();
  else if (added) $('chat-new').hidden = false;
  updateStatus();
}

function mergeMessages(batch, options = {}) {
  let added = false;
  let confirmed = false;
  let incomingVoice = null;
  for (const message of batch) {
    const pending = outgoing.get(message.requestId);
    if (pending) {
      confirmed = true;
      finishDraft(pending);
      sendNotice = '消息已发送';
    }
    outgoing.delete(message.requestId);
    failedRequests.delete(message.requestId);
    if (!messages.has(message.id)) {
      messages.set(message.id, message);
      added = true;
      if (!options.initial && !options.older && message.senderId !== senderId && voiceClip(message.text)) incomingVoice = message.requestId;
    }
  }
  if (added || confirmed) renderMessages({ ...options, added });
  else updateStatus();
  // Autoplay may require a prior gesture. A blocked message retains an explicit
  // playback control, and opening or paginating history never starts playback.
  if (incomingVoice && document.visibilityState !== 'hidden') {
    messageNodes.get(incomingVoice)?.querySelector('.chat-message-voice')?.playVoice(true);
  }
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
  const startedAt = performance.now();
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
        // Only fetched history advances the cursor: POST acknowledgements can
        // arrive ahead of a peer's message that this device has not fetched yet.
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
      schedulePoll(retryDelay || Math.max(0, POLL_MS - (performance.now() - startedAt)));
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

function changeDraft(value) {
  input.value = value;
  inputVersion += 1;
  $('chat-count').textContent = value.length + ' / 500';
}

function finishDraft(record) {
  // Clear only a draft restored after failure, never newer writing.
  if (record.restoredVersion === inputVersion && input.value === record.draft) changeDraft('');
}

function restoreDraft(record) {
  if (record.draft !== null && !input.value && record.restoreVersion === inputVersion) {
    changeDraft(record.draft);
    record.restoredVersion = inputVersion;
  }
}

async function drainQueue() {
  if (sending) return;
  sending = true;
  try {
    while (sendQueue.length) {
      const requestId = sendQueue.shift();
      const record = outgoing.get(requestId);
      if (!record || record.status !== 'queued') continue;
      record.status = 'sending';
      renderMessages();
      try {
        if (navigator.onLine === false) throw new Error('网络已断开');
        const { senderId: authorId, name, text } = record;
        const payload = await request(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, senderId: authorId, name, text }),
        });
        if (!payload.message || payload.message.requestId !== requestId) throw new Error('发送结果未确认');
        mergeMessages([payload.message]);
        sendNotice = '消息已发送';
      } catch {
        // A successful POST may lose its response. A concurrent history read
        // also confirms delivery; retries retain the original request ID.
        if (outgoing.has(requestId)) {
          record.status = 'failed';
          failedRequests.set(requestId, record);
          restoreDraft(record);
        }
      } finally {
        renderMessages();
        schedulePoll(0);
      }
    }
  } finally {
    sending = false;
    updateStatus();
  }
}

function enqueue(record) {
  if (record.status === 'queued' || record.status === 'sending') return;
  finishDraft(record);
  record.restoreVersion = inputVersion;
  record.status = 'queued';
  outgoing.set(record.requestId, record);
  failedRequests.delete(record.requestId);
  sendQueue.push(record.requestId);
  sendNotice = '';
  renderMessages({ own: true, added: true });
  void drainQueue();
}

function sendText(text, draft = null) {
  const trimmed = text.trim();
  if (!trimmed) {
    sendNotice = '写点内容再发送吧';
    updateStatus();
    input.focus();
    return null;
  }
  const name = (nameInput.value.trim() || '棋友').slice(0, 20);
  nameInput.value = name;
  savePreference('wuziqi-chat-name', name);
  const previous = [...failedRequests.values()].find((record) => record.text === trimmed && record.name === name);
  const record = previous || { requestId: crypto.randomUUID(), senderId, name, text: trimmed, createdAt: new Date().toISOString(), draft: null };
  if (draft !== null) {
    record.draft = draft;
    if (input.value === draft) changeDraft('');
  }
  enqueue(record);
  return messageNodes.get(record.requestId);
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
  inputVersion += 1;
  $('chat-count').textContent = input.value.length + ' / 500';
});
nameInput.addEventListener('change', () => savePreference('wuziqi-chat-name', nameInput.value.trim() || '棋友'));
for (const button of quickButtons) button.addEventListener('click', () => sendText(button.dataset.chatQuick));
for (const button of voiceButtons) button.addEventListener('click', () => {
  const clip = VOICE_CLIPS[button.dataset.chatVoice];
  if (clip) sendText(clip.text)?.querySelector('.chat-message-voice')?.playVoice();
});
$('chat-older').addEventListener('click', loadOlder);
$('chat-new').addEventListener('click', scrollToLatest);
scrollBox.addEventListener('scroll', () => { if (nearBottom()) $('chat-new').hidden = true; }, { passive: true });
$('chat-retry-send').addEventListener('click', () => {
  for (const record of [...failedRequests.values()]) enqueue(record);
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
