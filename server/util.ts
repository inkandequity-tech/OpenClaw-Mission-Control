import type { Result } from './types.ts';
import { redactString } from './redact.ts';

export async function timed<T>(fn: () => Promise<T | { error: { code: string; message: string; hint?: string } }>): Promise<Result<T>> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    if (out && typeof out === 'object' && 'error' in out && Object.keys(out).length === 1) {
      return { ok: false, error: (out as { error: { code: string; message: string; hint?: string } }).error, ms };
    }
    return { ok: true, data: out as T, ms };
  } catch (e) {
    return { ok: false, error: { code: 'exception', message: redactString((e as Error).message) }, ms: Date.now() - t0 };
  }
}

export function fail(code: string, message: string, hint?: string): { error: { code: string; message: string; hint?: string } } {
  return { error: { code, message: redactString(message), hint } };
}

/** First defined value among candidate keys. Used to read CLI JSON whose exact shape varies by version. */
export function pick(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Find an array in a CLI result: the value itself, or the first of the named keys. */
export function findArray(v: unknown, keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  const hit = pick(v, keys);
  return Array.isArray(hit) ? hit : [];
}

/** Depth-limited search for the first object matching a predicate. */
export function findDeep(v: unknown, pred: (o: Record<string, unknown>, key: string) => boolean, depth = 0, key = ''): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || depth > 6) return undefined;
  if (!Array.isArray(v) && pred(v as Record<string, unknown>, key)) return v as Record<string, unknown>;
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  for (const [k, x] of entries) {
    const hit = findDeep(x, pred, depth + 1, k);
    if (hit) return hit;
  }
  return undefined;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

export async function fetchJson(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; method?: string; body?: unknown } = {},
): Promise<{ status: number; ok: boolean; json?: unknown; text: string; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      redirect: 'error',
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, ok: res.ok, json, text: text.slice(0, 20000), ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code ?? (err.name === 'TimeoutError' ? 'ETIMEDOUT' : err.name);
    return { status: 0, ok: false, text: '', ms: Date.now() - t0, error: code };
  }
}

/** Tiny TTL cache with in-flight de-duplication, so several widgets share one slow CLI call. */
export class Memo {
  private store = new Map<string, { at: number; value?: unknown; pending?: Promise<unknown> }>();

  async get<T>(key: string, ttlMs: number, fn: () => Promise<T>, force = false): Promise<T> {
    const hit = this.store.get(key);
    if (hit && !force) {
      if (hit.pending) return hit.pending as Promise<T>;
      if (Date.now() - hit.at < ttlMs) return hit.value as T;
    }
    const pending = fn().then(
      (v) => { this.store.set(key, { at: Date.now(), value: v }); return v; },
      (e) => { this.store.delete(key); throw e; },
    );
    this.store.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
    return pending;
  }

  clear(): void {
    this.store.clear();
  }
}
