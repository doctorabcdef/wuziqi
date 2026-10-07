// Stable message markers keep voice history readable by earlier clients too.
// Only these bundled recordings can become playable voice messages.
export const VOICE_CLIPS = {
  slow: { id: 'slow', label: '太慢了太慢了', text: '[语音] 太慢了太慢了', src: './assets/voice/slow.m4a' },
  hurry: { id: 'hurry', label: '搞快点好不', text: '[语音] 搞快点好不', src: './assets/voice/hurry.m4a' },
};
