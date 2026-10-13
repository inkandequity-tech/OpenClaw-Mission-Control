import crypto from 'node:crypto';
import type { Db } from './db.ts';
import type { AuditEntry, AuditRow } from './types.ts';
import { redactForAudit, redactString } from './redact.ts';

const GENESIS = '0'.repeat(64);

/**
 * Application-wide audit trail: who (actor), what (action + redacted params), whether it worked
 * (outcome + verification) and when. Rows are hash-chained so tampering is detectable.
 */
export class Audit {
  private db: Db;
  onRecord?: (row: AuditRow) => void;

  constructor(db: Db) {
    this.db = db;
  }

  record(e: AuditEntry): AuditRow {
    const last = this.db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
    const prev = last?.hash ?? GENESIS;
    const ts = new Date().toISOString();
    const params = JSON.stringify(redactForAudit(e.params ?? {}));
    const detail = redactString(e.detail ?? '').slice(0, 1000);
    const verified = e.verified === undefined || e.verified === null ? null : e.verified ? 1 : 0;
    const body = [ts, e.actor.name, e.actor.role, e.actor.via, e.actor.ip, e.action, params, e.outcome, verified, detail].join('␟');
    const hash = crypto.createHash('sha256').update(prev + body).digest('hex');
    const res = this.db
      .prepare(
        `INSERT INTO audit(ts,actor,role,via,ip,action,params,outcome,verified,detail,prev_hash,hash)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(ts, e.actor.name, e.actor.role, e.actor.via, e.actor.ip, e.action, params, e.outcome, verified, detail, prev, hash);
    const row = this.db.prepare('SELECT * FROM audit WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as AuditRow;
    this.onRecord?.(row);
    return row;
  }

  list(opts: { limit?: number; before?: number; action?: string; outcome?: string } = {}): AuditRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.before) (where.push('id < ?'), args.push(opts.before));
    if (opts.action) (where.push('action LIKE ?'), args.push(`%${opts.action}%`));
    if (opts.outcome) (where.push('outcome = ?'), args.push(opts.outcome));
    const sql = `SELECT id,ts,actor,role,via,ip,action,params,outcome,verified,detail,hash FROM audit
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(opts.limit ?? 100, 500)) as unknown as AuditRow[];
  }

  /** Recompute the chain; returns the first broken row id, or null if intact. */
  verify(): { ok: boolean; checked: number; brokenAt: number | null } {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY id ASC').all() as unknown as Array<AuditRow & { prev_hash: string }>;
    let prev = GENESIS;
    for (const r of rows) {
      const body = [r.ts, r.actor, r.role, r.via, r.ip, r.action, r.params, r.outcome, r.verified, r.detail].join('␟');
      const expect = crypto.createHash('sha256').update(prev + body).digest('hex');
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, checked: rows.length, brokenAt: r.id };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length, brokenAt: null };
  }
}
