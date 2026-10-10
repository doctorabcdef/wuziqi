// Mobile browsers grant playback permission to an individual audio element.
// Reuse this element for the permission gesture and every incoming voice.
function permissionSound() {
  const bytes = new Uint8Array(844);
  const view = new DataView(bytes.buffer);
  const word = (offset, value) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  word(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  word(8, 'WAVE');
  word(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  word(36, 'data');
  view.setUint32(40, bytes.length - 44, true);
  bytes.fill(128, 44);
  return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...bytes));
}

export function createVoiceBroadcast({ onState = () => {}, onMessage = () => {}, canPlay = () => true } = {}) {
  const audio = document.createElement('audio');
  audio.id = 'chat-broadcast-audio';
  audio.preload = 'auto';
  audio.hidden = true;
  audio.muted = false;
  audio.setAttribute('playsinline', '');
  document.body.append(audio);

  const queue = [];
  const seen = new Set();
  let enabled = false;
  let blocked = false;
  let muted = false;
  let held = false;
  let error = '';
  let generation = 0;
  let active = null;

  function notify() {
    onState({ enabled, blocked, muted, pending: queue.length, error });
  }

  function allowedToStart() {
    return !muted && !held && navigator.onLine !== false && canPlay();
  }

  function clearActive() {
    generation++;
    if (active) {
      audio.removeEventListener('ended', active.ended);
      audio.removeEventListener('error', active.failed);
      active = null;
    }
  }

  function pause({ hold = false, preservePermission = false } = {}) {
    if (hold) held = true;
    if (!active || (preservePermission && !active.entry)) return;
    const entry = active.entry;
    if (entry && Number.isFinite(audio.currentTime)) entry.position = audio.currentTime;
    clearActive();
    audio.pause();
    if (entry) onMessage(entry.requestId, held ? 'paused' : 'queued');
    notify();
  }

  function start(entry = null) {
    const token = ++generation;
    const current = () => active?.token === token;
    const fail = (failure) => {
      if (!current()) return;
      clearActive();
      audio.pause();
      if (entry) entry.position = 0;
      blocked = failure?.name === 'NotAllowedError';
      if (blocked) enabled = false;
      error = blocked || !entry ? '' : '语音播放失败，点击重试';
      if (entry) onMessage(entry.requestId, blocked ? 'blocked' : 'error');
      notify();
    };
    const ended = () => {
      // A queued event from a replaced source must not finish the next voice.
      if (!current() || !audio.ended) return;
      clearActive();
      if (entry) {
        queue.shift();
        onMessage(entry.requestId, 'played');
      } else {
        enabled = true;
      }
      notify();
      pump();
    };
    const failed = () => {
      if (audio.error) fail(audio.error);
    };
    active = { token, entry, ended, failed };

    if (entry) {
      audio.dataset.requestId = entry.requestId;
      audio.dataset.voiceId = entry.clip.id;
    } else {
      delete audio.dataset.requestId;
      delete audio.dataset.voiceId;
    }

    try {
      const src = entry ? new URL(entry.clip.src, document.baseURI).href : permissionSound();
      const continuing = Boolean(entry?.position) && audio.src === src && !audio.error
        && Math.abs(audio.currentTime - entry.position) < 0.05;
      if (audio.src !== src) audio.src = src;
      else if (audio.error) audio.load();
      // Continuing the same paused media needs no seek. Some streamed M4A
      // responses cannot seek yet and would jump back to zero here.
      if (!continuing) audio.currentTime = entry?.position || 0;
      audio.addEventListener('ended', ended);
      audio.addEventListener('error', failed);
      // Do not defer this call: enable() runs inside the visitor's gesture.
      const playback = audio.play();
      Promise.resolve(playback).then(() => {
        if (!current()) return;
        enabled = true;
        blocked = false;
        error = '';
        if (entry) onMessage(entry.requestId, 'playing');
        else {
          // Grant permission to this element, then release it immediately.
          // Do not wait for an inaudible clip to finish while manual audio plays.
          clearActive();
          audio.pause();
        }
        notify();
        if (!entry) pump();
      }, fail);
    } catch (failure) {
      fail(failure);
    }
  }

  function pump() {
    if (active || !queue.length || blocked || error || !allowedToStart()) return;
    start(queue[0]);
  }

  function enqueue({ requestId, clip }) {
    if (!requestId || !clip?.src || seen.has(requestId)) return;
    seen.add(requestId);
    queue.push({ requestId, clip, position: 0 });
    onMessage(requestId, 'queued');
    notify();
    // Let an in-flight permission attempt settle; it will drain this queue.
    pump();
  }

  function enable() {
    muted = false;
    held = false;
    blocked = false;
    error = '';
    if (!active && allowedToStart()) {
      if (queue.length) start(queue[0]);
      else if (!enabled) start();
    }
    notify();
  }

  // Ordinary page interactions can grant media permission without a separate
  // sound control. They must not cancel a deliberate pause or interrupt audio.
  function unlock() {
    if (active || held || muted || (enabled && !blocked && !error) || !allowedToStart()) return;
    blocked = false;
    error = '';
    // Authorize without starting a queued voice that a manual player could
    // immediately interrupt in the same gesture. Success drains the queue.
    start();
    notify();
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (muted) pause();
    else pump();
    notify();
  }

  notify();
  return { enqueue, enable, unlock, resume: pump, pause, setMuted };
}
