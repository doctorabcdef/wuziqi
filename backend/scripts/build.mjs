import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = resolve(from, entry.name), target = resolve(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else await copyFile(source, target);
  }
}
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await copyFile('worker/index.js', 'dist/server/index.js');
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
await copyTree('drizzle', 'dist/.openai/drizzle');
const worker = await import(pathToFileURL(resolve('worker/index.js')).href);
if (typeof worker.default?.fetch !== 'function') throw new Error('Missing Worker fetch export');
console.log('Worker and database migrations built.');
