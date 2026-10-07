import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function connect(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  const migrations = new URL('../drizzle/', import.meta.url);
  const legacy = !sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_local_migrations'").get()
    && sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game'").get();
  sqlite.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY NOT NULL)');
  // Pre-chat local previews had only the initial game migration and no journal.
  if (legacy) sqlite.prepare('INSERT INTO _local_migrations (name) VALUES (?)').run('0000_secret_wraith.sql');
  for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) {
    if (sqlite.prepare('SELECT name FROM _local_migrations WHERE name = ?').get(file)) continue;
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
      sqlite.prepare('INSERT INTO _local_migrations (name) VALUES (?)').run(file);
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); sqlite.close(); throw error; }
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
        async all() { return { results: statement.all(...args) }; },
        async run() { return statement.run(...args); },
      };
    },
  };
  return db;
}
