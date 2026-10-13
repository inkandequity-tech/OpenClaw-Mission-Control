import crypto from 'node:crypto';
import type { Db } from './db.ts';
import type { Events } from './events.ts';
import type { Inference } from './integrations/inference.ts';
import type { Telemetry } from './integrations/telemetry.ts';
import { redactString } from './redact.ts';
import { AppError } from './types.ts';

export const SUITE_VERSION = 'v1';

interface Task {
  id: string;
  prompt: string;
  check: (answer: string) => boolean;
  describe: string;
}

const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/** Fixed prompts + deterministic sampling = comparable runs. Bump SUITE_VERSION if you edit them. */
export const SUITE: Task[] = [
  { id: 'arithmetic', prompt: 'What is 17 multiplied by 23? Answer with just the number.', describe: 'exact number 391', check: (a) => /\b391\b/.test(stripThinking(a)) },
  {
    id: 'json', prompt: 'Output only valid JSON: an object with key "name" set to "Ada" and key "year" set to the number 1815.', describe: 'parseable JSON with the right values',
    check: (a) => {
      try {
        const t = stripThinking(a).replace(/^```(?:json)?\s*|\s*```$/g, '');
        const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
        return j.name === 'Ada' && j.year === 1815;
      } catch {
        return false;
      }
    },
  },
  { id: 'instructions', prompt: 'List exactly three fruits, one per line, with no other text.', describe: 'exactly 3 non-empty lines', check: (a) => stripThinking(a).split('\n').map((l) => l.trim()).filter(Boolean).length === 3 },
  { id: 'logic', prompt: 'All bloops are razzies and all razzies are lazzies. Are all bloops lazzies? Answer yes or no.', describe: 'answers yes', check: (a) => /\byes\b/i.test(stripThinking(a)) && !/\bno\b/i.test(stripThinking(a).slice(0, 5)) },
  { id: 'throughput', prompt: 'Write a paragraph of about 200 words about the ocean.', describe: '120-320 words (also the speed sample)', check: (a) => { const n = stripThinking(a).split(/\s+/).filter(Boolean).length; return n >= 120 && n <= 320; } },
];

export interface TaskResult {
  id: string;
  ok: boolean;
  pass: boolean;
  error?: string;
  ttftMs: number | null;
  totalMs: number;
  completionTokens: number | null;
  tokensEstimated: boolean;
  tokensPerSec: number | null;
  sample: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export class Benchmarks {
  private db: Db;
  private events: Events;
  private inf: Inference;
  private tel: Telemetry;
  private running: string | null = null;

  constructor(db: Db, events: Events, inf: Inference, tel: Telemetry) {
    this.db = db;
    this.events = events;
    this.inf = inf;
    this.tel = tel;
  }

  current(): string | null {
    return this.running;
  }

  list(limit = 50): Array<{ id: string; ts: string; model: string; server: string; suite: string; summary: unknown }> {
    return (this.db.prepare('SELECT id,ts,model,server,suite,summary FROM benchmarks ORDER BY ts DESC LIMIT ?').all(limit) as any[]).map((r) => ({ ...r, summary: JSON.parse(r.summary) }));
  }

  get(id: string): unknown {
    const r = this.db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(id) as any;
    if (!r) throw new AppError(404, 'not_found', 'No such benchmark');
    return { ...r, summary: JSON.parse(r.summary), detail: JSON.parse(r.detail) };
  }

  /** Starts a run in the background; the result is stored and announced on the event timeline. */
  start(model: string): string {
    if (this.running) throw new AppError(409, 'busy', 'A benchmark is already running');
    const id = crypto.randomUUID();
    this.running = id;
    void this.execute(id, model).catch((e) => this.events.add({ source: 'model', severity: 'error', type: 'benchmark.failed', message: `Benchmark failed: ${(e as Error).message}` })).finally(() => (this.running = null));
    return id;
  }

  private async streamOnce(baseUrl: string, headers: Record<string, string>, model: string, t: Task): Promise<TaskResult> {
    const t0 = Date.now();
    let first: number | null = null;
    let text = '';
    let usageTokens: number | null = null;
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: t.prompt }], temperature: 0, seed: 42, max_tokens: 700, stream: true, stream_options: { include_usage: true } }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok || !res.body) return { id: t.id, ok: false, pass: false, error: `HTTP ${res.status}`, ttftMs: null, totalMs: Date.now() - t0, completionTokens: null, tokensEstimated: false, tokensPerSec: null, sample: '' };
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta;
            const piece = (delta?.content ?? '') + (delta?.reasoning_content ?? '');
            if (piece && first === null) first = Date.now();
            if (delta?.content) text += delta.content;
            if (typeof j.usage?.completion_tokens === 'number') usageTokens = j.usage.completion_tokens;
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
    } catch (e) {
      return { id: t.id, ok: false, pass: false, error: (e as Error).message, ttftMs: null, totalMs: Date.now() - t0, completionTokens: null, tokensEstimated: false, tokensPerSec: null, sample: '' };
    }
    const total = Date.now() - t0;
    const estimated = usageTokens === null;
    const tokens = usageTokens ?? Math.ceil(text.length / 4);
    const genMs = first ? Math.max(1, Date.now() - first) : null;
    return {
      id: t.id, ok: true, pass: t.check(text), ttftMs: first ? first - t0 : null, totalMs: total, completionTokens: tokens, tokensEstimated: estimated,
      tokensPerSec: genMs ? Math.round((tokens / (genMs / 1000)) * 10) / 10 : null, sample: redactString(text).slice(0, 200),
    };
  }

  private async execute(id: string, model: string): Promise<void> {
    const det = await this.inf.detect();
    const target = this.inf.target();
    if (!det.ok || !target) throw new Error(det.ok ? 'no target' : det.error.message);
    if (!det.data.models.some((m) => m.id === model)) throw new Error(`Model "${model}" is not on the server`);
    const headers: Record<string, string> = {};
    const token = (this.inf as unknown as { cfg: { inferenceToken?: string } }).cfg.inferenceToken;
    if (token) headers.authorization = `Bearer ${token}`;

    const winBefore = (await this.tel.fetchWindows()).ok ? this.tel.win.at(-1) : undefined;
    const results: TaskResult[] = [];
    for (const t of SUITE) results.push(await this.streamOnce(target.baseUrl, headers, model, t));
    const winAfterRes = await this.tel.fetchWindows();
    const winAfter = winAfterRes.ok ? winAfterRes.data : undefined;

    const okRuns = results.filter((r) => r.ok);
    const summary = {
      suite: SUITE_VERSION,
      passRate: Math.round((results.filter((r) => r.pass).length / results.length) * 100),
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      medianTtftMs: median(okRuns.map((r) => r.ttftMs).filter((x): x is number => x !== null)),
      medianTokensPerSec: median(okRuns.map((r) => r.tokensPerSec).filter((x): x is number => x !== null)),
      tokensEstimated: okRuns.some((r) => r.tokensEstimated),
      memory: winAfter?.gpus[0]
        ? { gpuVramUsedMiBBefore: winBefore?.gpus[0]?.memUsedMiB ?? null, gpuVramUsedMiBAfter: winAfter.gpus[0].memUsedMiB, ramPercentAfter: winAfter.memPercent }
        : null,
      memoryNote: winAfter ? null : 'Memory use unavailable: Windows telemetry reporter not reachable',
    };
    const detail = { params: { temperature: 0, seed: 42, max_tokens: 700 }, tasks: SUITE.map((t) => ({ id: t.id, check: t.describe })), results };
    this.db.prepare('INSERT INTO benchmarks(id,ts,model,server,suite,summary,detail) VALUES(?,?,?,?,?,?,?)').run(id, new Date().toISOString(), model, `${det.data.kind}@${det.data.origin}`, SUITE_VERSION, JSON.stringify(summary), JSON.stringify(detail));
    this.events.add({ source: 'model', severity: 'info', type: 'benchmark.finished', message: `Benchmark of ${model}: ${summary.passed}/${summary.total} passed, ${summary.medianTokensPerSec ?? '?'} tok/s, TTFT ${summary.medianTtftMs ?? '?'} ms`, data: { id } });
  }
}
