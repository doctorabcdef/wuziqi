import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import worker from '../backend/worker/index.js';
import { connect } from '../backend/test/sqlite-adapter.mjs';
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
const db = connect(fileURLToPath(new URL('../artifacts/local-game.sqlite', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'chat.js': 'text/javascript', 'voice-clips.js': 'text/javascript', 'config.js': 'text/javascript', 'styles.css': 'text/css', 'favicon.svg': 'image/svg+xml',
  'assets/voice/slow.m4a': 'audio/mp4', 'assets/voice/hurry.m4a': 'audio/mp4' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (['/api/game', '/api/chat', '/health'].includes(url.pathname)) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await worker.fetch(new Request(url, { method: req.method, headers: req.headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }), { DB: db });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!types[name]) { res.writeHead(404); res.end(); return; }
    const content = name === 'config.js' ? "export const API_BASE = '';" : await readFile(new URL(`../${name}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': types[name].startsWith('audio/') ? types[name] : types[name] + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch (error) { console.error(error); res.writeHead(500); res.end('Local server error'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${port}`));
