// Local SQLite (Node's built-in node:sqlite) with the same async interface as db-d1.js.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

export function openNodeDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(migrationsDir + f, 'utf8'));
  }
  return {
    raw: db,
    all: async (sql, ...p) => db.prepare(sql).all(...p),
    get: async (sql, ...p) => db.prepare(sql).get(...p) ?? null,
    run: async (sql, ...p) => {
      const r = db.prepare(sql).run(...p);
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { for (const [sql, p] of stmts) db.prepare(sql).run(...p); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
