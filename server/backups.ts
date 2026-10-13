import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './types.ts';
import { redactDeep } from './redact.ts';
import { compactDiff, diffLines } from './diff.ts';

export interface BackupMeta {
  id: string;
  ts: string;
  label: string;
  sha256: string;
  bytes: number;
  by: string;
}

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Versioned snapshots of openclaw.json, stored privately (0600) in Mission Control's data dir.
 * Snapshots contain secrets, so they are never served: only redacted diffs are exposed.
 */
export class Backups {
  private dir: string;
  private indexFile: string;
  private target: string;

  constructor(dataDir: string, target: string) {
    this.dir = path.join(dataDir, 'backups');
    this.indexFile = path.join(this.dir, 'index.json');
    this.target = target;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private readIndex(): BackupMeta[] {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as BackupMeta[];
    } catch {
      return [];
    }
  }

  private writeIndex(list: BackupMeta[]): void {
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.indexFile);
  }

  list(): BackupMeta[] {
    return this.readIndex().sort((a, b) => b.ts.localeCompare(a.ts));
  }

  get(id: string): BackupMeta {
    const m = this.readIndex().find((b) => b.id === id);
    if (!m) throw new AppError(404, 'no_backup', `No backup ${id}`);
    return m;
  }

  currentSha(): string | null {
    try {
      return sha(fs.readFileSync(this.target));
    } catch {
      return null;
    }
  }

  snapshot(label: string, by: string, opts: { dedupe?: boolean } = {}): BackupMeta {
    let data: Buffer;
    try {
      data = fs.readFileSync(this.target);
    } catch {
      throw new AppError(404, 'no_config', `Cannot read ${this.target}`);
    }
    const hash = sha(data);
    const list = this.readIndex();
    const existing = list.find((b) => b.sha256 === hash);
    if (opts.dedupe && existing) return existing;
    const ts = new Date().toISOString();
    // Ids are second-resolution + checksum; identical content saved within the same second moves to the next free second.
    let stamp = Date.parse(ts);
    let id = '';
    do {
      id = `${new Date(stamp).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${hash.slice(0, 8)}`;
      stamp += 1000;
    } while (list.some((b) => b.id === id));
    fs.writeFileSync(path.join(this.dir, `${id}.json`), data, { mode: 0o600 });
    const meta: BackupMeta = { id, ts, label: label.slice(0, 80), sha256: hash, bytes: data.length, by };
    list.push(meta);
    this.writeIndex(list);
    return meta;
  }

  private content(id: string): Buffer {
    const m = this.get(id);
    const buf = fs.readFileSync(path.join(this.dir, `${m.id}.json`));
    if (sha(buf) !== m.sha256) throw new AppError(500, 'backup_corrupt', `Backup ${id} failed its checksum`);
    return buf;
  }

  private textFor(ref: string): { text: string; raw: string } {
    const buf = ref === 'current' ? fs.readFileSync(this.target) : this.content(ref);
    const raw = buf.toString('utf8');
    try {
      return { text: JSON.stringify(redactDeep(JSON.parse(raw)), null, 2), raw: JSON.stringify(JSON.parse(raw)) };
    } catch {
      return { text: '[unparseable config]', raw };
    }
  }

  /** Redacted diff. `secretsChanged` flags edits to credential values the redacted view cannot show. */
  diff(from: string, to: string): { from: string; to: string; changed: boolean; secretsChanged: boolean; lines: ReturnType<typeof compactDiff> } {
    const a = this.textFor(from);
    const b = this.textFor(to);
    const lines = diffLines(a.text, b.text);
    const visible = lines.some((l) => l.op !== ' ');
    const secretsChanged = !visible && a.raw !== b.raw;
    return { from, to, changed: visible || secretsChanged, secretsChanged, lines: compactDiff(lines) };
  }

  /** Atomically write a snapshot back over the live config; returns the checksum written. */
  writeBack(id: string): string {
    const buf = this.content(id);
    const tmp = `${this.target}.mc-restore.${process.pid}`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, this.target);
    return sha(buf);
  }
}
