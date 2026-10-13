import { EventEmitter } from 'node:events';
import type { Db } from './db.ts';
import type { EventInput, EventRow, EventSource, Severity } from './types.ts';
import { redactForAudit, redactString } from './redact.ts';

const MAX_ROWS = 5000;

/** Unified, searchable, timestamped event timeline fed by every integration. */
export class Events extends EventEmitter {
  private db: Db;
  private inserts = 0;

  constructor(db: Db) {
    super();
    this.db = db;
  }

  add(e: EventInput): EventRow | null {
    const ts = e.ts ?? new Date().toISOString();
    const message = redactString(e.message).slice(0, 600);
    const data = JSON.stringify(redactForAudit(e.data ?? {}));
    try {
      const res = this.db
        .prepare('INSERT INTO events(ts,source,severity,type,message,data,dedupe) VALUES(?,?,?,?,?,?,?)')
        .run(ts, e.source, e.severity, e.type, message, data, e.dedupeKey ?? null);
      const row: EventRow = { id: Number(res.lastInsertRowid), ts, source: e.source, severity: e.severity, type: e.type, message, data };
      if (++this.inserts % 200 === 0) this.prune();
      this.emit('event', row);
      return row;
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) return null; // already imported
      throw err;
    }
  }

  list(opts: { q?: string; source?: EventSource; severity?: Severity; since?: string; before?: number; limit?: number } = {}): EventRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.q) {
      where.push("(message LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')");
      const like = `%${opts.q.replace(/[%_]/g, (c) => '\\' + c)}%`;
      args.push(like, like, like);
    }
    if (opts.source) (where.push('source = ?'), args.push(opts.source));
    if (opts.severity) (where.push('severity = ?'), args.push(opts.severity));
    if (opts.since) (where.push('ts >= ?'), args.push(opts.since));
    if (opts.before) (where.push('id < ?'), args.push(opts.before));
    const sql = `SELECT id,ts,source,severity,type,message,data FROM events
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(opts.limit ?? 200, 1000)) as unknown as EventRow[];
  }

  private prune(): void {
    this.db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(MAX_ROWS);
  }
}
