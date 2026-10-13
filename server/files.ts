import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './types.ts';
import { redactString } from './redact.ts';

const DENY = [
  /(^|\/)\.env/i, /\.(key|pem|p12|pfx|crt)$/i, /\.sqlite(-wal|-shm)?$/i, /\.db$/i, /openclaw\.json/i,
  /(^|\/)(id_rsa|id_ed25519)/i, /secret/i, /credential/i, /(^|\/)auth[^/]*\.json$/i, /(^|\/)\.ssh(\/|$)/,
];
const MAX_READ = 256 * 1024;

export interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number | null;
  mtime: string;
  denied: boolean;
}

/**
 * Read-only workspace browser. Every path is resolved with realpath and must stay inside a
 * configured root, so `..`, absolute paths and symlinks cannot escape. No write/delete exists.
 */
export class Files {
  private roots: string[];

  constructor(roots: string[]) {
    this.roots = roots.map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return path.resolve(r);
      }
    });
  }

  rootList(): Array<{ index: number; path: string; exists: boolean }> {
    return this.roots.map((r, i) => ({ index: i, path: r, exists: fs.existsSync(r) }));
  }

  private resolve(rootIndex: number, rel: string): { abs: string; root: string } {
    const root = this.roots[rootIndex];
    if (!root) throw new AppError(404, 'no_root', 'Unknown root');
    if (rel.includes('\0')) throw new AppError(400, 'bad_path', 'Invalid path');
    const candidate = path.resolve(root, '.' + path.sep + rel);
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      throw new AppError(404, 'not_found', 'Not found');
    }
    if (real !== root && !real.startsWith(root + path.sep)) throw new AppError(403, 'outside_root', 'Path escapes the allowed directory');
    return { abs: real, root };
  }

  private denied(rel: string): boolean {
    return DENY.some((re) => re.test(rel));
  }

  list(rootIndex: number, rel: string): { path: string; entries: FileEntry[] } {
    const { abs, root } = this.resolve(rootIndex, rel);
    if (!fs.statSync(abs).isDirectory()) throw new AppError(400, 'not_dir', 'Not a directory');
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .slice(0, 1000)
      .map((d): FileEntry | null => {
        try {
          const full = path.join(abs, d.name);
          const real = fs.realpathSync(full);
          if (real !== root && !real.startsWith(root + path.sep)) return null; // symlink leaving the root: hide
          const st = fs.statSync(real);
          const relChild = path.relative(root, real);
          return { name: d.name, type: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : null, mtime: st.mtime.toISOString(), denied: this.denied(relChild) };
        } catch {
          return null;
        }
      })
      .filter((x): x is FileEntry => x !== null)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: path.relative(root, abs), entries };
  }

  read(rootIndex: number, rel: string): { path: string; size: number; truncated: boolean; text: string } {
    const { abs, root } = this.resolve(rootIndex, rel);
    const relReal = path.relative(root, abs);
    if (this.denied(relReal)) throw new AppError(403, 'denied', 'This file type is blocked (may contain credentials or databases)');
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new AppError(400, 'not_file', 'Not a regular file');
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (buf.includes(0)) throw new AppError(415, 'binary', 'Binary files are not previewed');
      return { path: relReal, size: st.size, truncated: st.size > MAX_READ, text: redactString(buf.toString('utf8')) };
    } finally {
      fs.closeSync(fd);
    }
  }
}
