import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL, via TEXT NOT NULL, ip TEXT NOT NULL,
  action TEXT NOT NULL, params TEXT NOT NULL, outcome TEXT NOT NULL, verified INTEGER, detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, source TEXT NOT NULL, severity TEXT NOT NULL, type TEXT NOT NULL,
  message TEXT NOT NULL, data TEXT NOT NULL, dedupe TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS prefs (user TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user, key));
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, proposer TEXT NOT NULL, proposer_role TEXT NOT NULL,
  action TEXT NOT NULL, params TEXT NOT NULL, params_hash TEXT NOT NULL, risk TEXT NOT NULL,
  preview TEXT NOT NULL, confirm_phrase TEXT, status TEXT NOT NULL,
  decided_by TEXT, decided_ts TEXT, result TEXT, expires TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, workflow TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL,
  started TEXT NOT NULL, finished TEXT, params TEXT NOT NULL, steps TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, model TEXT NOT NULL, server TEXT NOT NULL,
  suite TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  if (file !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.chmodSync(file + suffix, 0o600);
      } catch {
        /* sidecar may not exist yet */
      }
    }
  }
  return db;
}

export function kvGet<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    key,
    JSON.stringify(value),
  );
}
