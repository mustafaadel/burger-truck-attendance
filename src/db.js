import { DatabaseSync } from 'node:sqlite';

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS employees (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT,
      token       TEXT UNIQUE NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
    );

    -- A poster is the paper QR code stuck on the truck. Rotating it retires the old one.
    CREATE TABLE IF NOT EXISTS posters (
      id          INTEGER PRIMARY KEY,
      code        TEXT UNIQUE NOT NULL,
      short_code  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      retired_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS punches (
      id             TEXT PRIMARY KEY,
      employee_id    INTEGER NOT NULL REFERENCES employees(id),
      device_id      TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      type           TEXT NOT NULL CHECK (type IN ('in','out')),
      device_time    INTEGER NOT NULL,
      received_at    INTEGER NOT NULL,
      clock_skew_ms  INTEGER,
      lat            REAL,
      lng            REAL,
      accuracy       REAL,
      qr             TEXT,
      qr_status      TEXT NOT NULL,
      prev_hash      TEXT NOT NULL,
      hash           TEXT NOT NULL,
      flags          TEXT NOT NULL DEFAULT '[]',
      source         TEXT NOT NULL DEFAULT 'app',
      note           TEXT,
      UNIQUE (employee_id, device_id, seq)
    );
    CREATE INDEX IF NOT EXISTS punches_time ON punches(device_time);
  `);
  return db;
}
