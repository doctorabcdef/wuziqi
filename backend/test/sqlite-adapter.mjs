import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function connect(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql'))) {
    const existing = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game'").get();
    if (!existing) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const db = {
    sqlite,
    withSession() { return db; },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) ?? null; },
        async run() { return statement.run(...args); },
      };
    },
  };
  return db;
}
