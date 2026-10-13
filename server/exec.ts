import { execFile } from 'node:child_process';
import os from 'node:os';

/**
 * The only way the backend runs external programs. There is no shell, the binary and the argument
 * vector are built by server code (never by concatenating browser input), output is capped and
 * every call has a timeout. Browser input reaches argv only after per-action validation.
 */

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  /** Set when the binary could not be started (e.g. ENOENT). */
  spawnError?: string;
}

export interface RunOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Accept partial stdout when the timeout kills a long-running/following command. */
  keepPartialOnTimeout?: boolean;
}

const EXTRA_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/Applications/Tailscale.app/Contents/MacOS'];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: os.homedir(),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    NO_COLOR: '1',
    PATH: [...new Set([...(process.env.PATH ?? '').split(':'), ...EXTRA_PATH])].filter(Boolean).join(':'),
  };
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OPENCLAW_') && v !== undefined) env[k] = v;
  }
  if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
  return env;
}

export function run(bin: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 30000;
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      { timeout, maxBuffer: opts.maxBytes ?? 4 * 1024 * 1024, env: childEnv(), shell: false, windowsHide: true, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const ms = Date.now() - started;
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (!e) return resolve({ ok: true, code: 0, stdout: String(stdout), stderr: String(stderr), ms, timedOut: false });
        const timedOut = Boolean(e.killed) && ms >= timeout - 50;
        if (e.code === 'ENOENT' || e.code === 'EACCES') {
          return resolve({ ok: false, code: null, stdout: '', stderr: '', ms, timedOut: false, spawnError: `${e.code}: cannot execute "${bin}"` });
        }
        resolve({
          ok: Boolean(timedOut && opts.keepPartialOnTimeout && String(stdout).length > 0),
          code: typeof e.code === 'number' ? e.code : null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ms,
          timedOut,
        });
      },
    );
  });
}

/** Parse JSON from CLI output that may be prefixed by log lines. Returns undefined if not JSON. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through: find first JSON document inside the text */
  }
  for (const open of ['{', '[']) {
    const i = t.indexOf(open);
    if (i < 0) continue;
    try {
      return JSON.parse(t.slice(i));
    } catch {
      const j = t.lastIndexOf(open === '{' ? '}' : ']');
      if (j > i) {
        try {
          return JSON.parse(t.slice(i, j + 1));
        } catch {
          /* try next */
        }
      }
    }
  }
  return undefined;
}

/** Strict token for ids passed to CLIs: no leading dash, no whitespace or shell metacharacters. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
