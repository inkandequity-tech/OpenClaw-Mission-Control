import crypto from 'node:crypto';
import { AppError, type Actor } from './types.ts';
import type { Deps } from './deps.ts';
import { CONFIG_PATH_RE, type ExecOutcome } from './actions.ts';
import { redactString } from './redact.ts';
import { sleep } from './util.ts';

type CheckName = 'config.valid' | 'gateway.live' | 'inference.api';

export type Step =
  | { id: string; label: string; kind: 'action'; action: string; params: (ctx: Ctx) => unknown; retries?: number; backoffMs?: number; when?: (ctx: Ctx) => boolean }
  | { id: string; label: string; kind: 'check'; check: CheckName; retries?: number; backoffMs?: number; when?: (ctx: Ctx) => boolean }
  | { id: string; label: string; kind: 'gate'; message: string }
  | { id: string; label: string; kind: 'wait'; ms: number };

export interface Ctx {
  params: any;
  out: Record<string, ExecOutcome | undefined>;
}

interface Template {
  id: string;
  title: string;
  description: string;
  validate(raw: unknown): unknown;
  steps(p: any): Step[];
  onFailure(p: any): Step[];
}

export interface StepRecord {
  id: string;
  label: string;
  kind: string;
  status: 'pending' | 'running' | 'waiting' | 'ok' | 'failed' | 'skipped';
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
  approval?: string;
}

export interface RunRecord {
  id: string;
  workflow: string;
  status: 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'recovered' | 'interrupted';
  actor: string;
  started: string;
  finished: string | null;
  params: unknown;
  steps: StepRecord[];
  recovery: StepRecord[];
}

const TEMPLATES: Template[] = [
  {
    id: 'restart-with-checks',
    title: 'Restart gateway with checks',
    description: 'Validate config → snapshot → human gate → restart → confirm the gateway is live and the inference server is still reachable.',
    validate: () => ({}),
    steps: () => [
      { id: 'validate', label: 'Validate OpenClaw config', kind: 'check', check: 'config.valid' },
      { id: 'snap', label: 'Snapshot config', kind: 'action', action: 'config.snapshot', params: () => ({ label: 'pre-restart' }) },
      { id: 'gate', label: 'Approval: restart the gateway', kind: 'gate', message: 'Restart the OpenClaw gateway now? Agent runs and Telegram delivery pause briefly.' },
      { id: 'restart', label: 'Restart gateway (verified)', kind: 'action', action: 'gateway.restart', params: () => ({}) },
      { id: 'live', label: 'Gateway live & ready', kind: 'check', check: 'gateway.live', retries: 6, backoffMs: 5000 },
      { id: 'infer', label: 'Inference server reachable', kind: 'check', check: 'inference.api', retries: 2, backoffMs: 3000 },
    ],
    onFailure: () => [],
  },
  {
    id: 'config-change-with-rollback',
    title: 'Config change with automatic rollback',
    description: 'Snapshot → approval → set one value (verified, validated) → approval → restart → verify. Any failure restores the snapshot and re-checks the gateway.',
    validate(raw) {
      const o = (raw ?? {}) as Record<string, unknown>;
      if (typeof o.path !== 'string' || !CONFIG_PATH_RE.test(o.path)) throw new AppError(400, 'bad_input', 'params.path is required (dotted config path)');
      if (!('value' in o)) throw new AppError(400, 'bad_input', 'params.value is required');
      return { path: o.path, value: o.value };
    },
    steps: (p) => [
      { id: 'validate', label: 'Validate current config', kind: 'check', check: 'config.valid' },
      { id: 'snap', label: 'Snapshot config', kind: 'action', action: 'config.snapshot', params: () => ({ label: `pre-change ${p.path}` }) },
      { id: 'gate1', label: `Approval: set ${p.path}`, kind: 'gate', message: `Change ${p.path} in OpenClaw config? A snapshot was just taken.` },
      { id: 'set', label: `Set ${p.path} (verified)`, kind: 'action', action: 'config.set', params: () => ({ path: p.path, value: p.value }) },
      { id: 'valid2', label: 'Validate new config', kind: 'check', check: 'config.valid' },
      { id: 'gate2', label: 'Approval: restart to apply', kind: 'gate', message: 'Restart the gateway so the new configuration takes effect?' },
      { id: 'restart', label: 'Restart gateway (verified)', kind: 'action', action: 'gateway.restart', params: () => ({}) },
      { id: 'live', label: 'Gateway live & ready', kind: 'check', check: 'gateway.live', retries: 6, backoffMs: 5000 },
    ],
    onFailure: () => [
      { id: 'rb-restore', label: 'Restore pre-change snapshot', kind: 'action', action: 'config.restore', params: (c) => ({ backupId: (c.out.snap?.data as { id: string } | undefined)?.id }), when: (c) => Boolean(c.out.snap?.data) && c.out.set !== undefined },
      { id: 'rb-valid', label: 'Validate restored config', kind: 'check', check: 'config.valid', when: (c) => c.out.set !== undefined },
      { id: 'rb-restart', label: 'Restart gateway on restored config', kind: 'action', action: 'gateway.restart', params: () => ({}), when: (c) => c.out.restart !== undefined },
      { id: 'rb-live', label: 'Gateway live & ready', kind: 'check', check: 'gateway.live', retries: 6, backoffMs: 5000, when: (c) => c.out.restart !== undefined },
    ],
  },
];

const nowIso = () => new Date().toISOString();

/**
 * Small workflow engine: ordered steps with retries, human approval gates, an execution history
 * and failure recovery. Templates are defined in code (no user-supplied step lists), and any
 * high-risk action step is refused unless a gate earlier in the same run was approved.
 */
export class Workflows {
  private d!: Deps;
  private active = new Map<string, boolean>();

  bind(d: Deps): void {
    this.d = d;
    this.d.db.prepare("UPDATE workflow_runs SET status='interrupted', finished=? WHERE status IN ('running','waiting_approval')").run(nowIso());
  }

  templates(): Array<{ id: string; title: string; description: string; steps: Array<{ id: string; label: string; kind: string }> }> {
    return TEMPLATES.map((t) => ({ id: t.id, title: t.title, description: t.description, steps: t.steps({ path: '<path>', value: '<value>' }).map((s) => ({ id: s.id, label: s.label, kind: s.kind })) }));
  }

  list(limit = 30): RunRecord[] {
    return (this.d.db.prepare('SELECT * FROM workflow_runs ORDER BY started DESC LIMIT ?').all(limit) as any[]).map(this.parse);
  }

  get(id: string): RunRecord {
    const r = this.d.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as any;
    if (!r) throw new AppError(404, 'not_found', 'No such workflow run');
    return this.parse(r);
  }

  private parse(r: any): RunRecord {
    const s = JSON.parse(r.steps);
    return { id: r.id, workflow: r.workflow, status: r.status, actor: r.actor, started: r.started, finished: r.finished, params: JSON.parse(r.params), steps: s.steps, recovery: s.recovery };
  }

  private save(run: RunRecord): void {
    this.d.db.prepare('UPDATE workflow_runs SET status=?, finished=?, steps=? WHERE id=?').run(run.status, run.finished, JSON.stringify({ steps: run.steps, recovery: run.recovery }), run.id);
  }

  start(templateId: string, rawParams: unknown, starter: Actor): string {
    const t = TEMPLATES.find((x) => x.id === templateId);
    if (!t) throw new AppError(404, 'no_template', `Unknown workflow "${templateId}"`);
    const params = t.validate(rawParams);
    const steps = t.steps(params);
    const run: RunRecord = {
      id: crypto.randomBytes(6).toString('hex'), workflow: t.id, status: 'running', actor: starter.name, started: nowIso(), finished: null, params,
      steps: steps.map((s) => ({ id: s.id, label: s.label, kind: s.kind, status: 'pending' as const, attempts: 0 })), recovery: [],
    };
    this.d.db.prepare('INSERT INTO workflow_runs(id,workflow,status,actor,started,finished,params,steps) VALUES(?,?,?,?,?,?,?,?)').run(run.id, run.workflow, run.status, run.actor, run.started, null, JSON.stringify(params), JSON.stringify({ steps: run.steps, recovery: [] }));
    this.d.events.add({ source: 'system', severity: 'info', type: 'workflow.started', message: `Workflow "${t.title}" started by ${starter.name}`, data: { run: run.id } });
    const actor: Actor = { name: starter.name, role: 'operator', via: 'workflow', ip: starter.ip, elevated: true };
    void this.execute(t, run, steps, actor).catch((e) => {
      run.status = 'failed';
      run.finished = nowIso();
      this.save(run);
      this.d.events.add({ source: 'system', severity: 'error', type: 'workflow.crashed', message: `Workflow ${run.id} crashed: ${(e as Error).message}` });
    });
    return run.id;
  }

  private async execute(t: Template, run: RunRecord, steps: Step[], actor: Actor): Promise<void> {
    const ctx: Ctx = { params: run.params, out: {} };
    const gate = { passed: false };
    let failed: string | null = null;
    for (let i = 0; i < steps.length && !failed; i++) {
      const rec = run.steps[i]!;
      const err = await this.runStep(steps[i]!, rec, run, ctx, actor, gate);
      this.save(run);
      if (err) failed = `${rec.label}: ${err}`;
    }
    if (!failed) {
      run.status = 'succeeded';
      run.finished = nowIso();
      this.save(run);
      this.d.events.add({ source: 'system', severity: 'info', type: 'workflow.succeeded', message: `Workflow "${t.title}" succeeded`, data: { run: run.id } });
      return;
    }
    // Failure recovery
    run.steps.filter((s) => s.status === 'pending').forEach((s) => (s.status = 'skipped'));
    const rec = t.onFailure(run.params);
    run.recovery = rec.map((s) => ({ id: s.id, label: s.label, kind: s.kind, status: 'pending' as const, attempts: 0 }));
    this.save(run);
    let recoveredOk = rec.length > 0;
    for (let i = 0; i < rec.length; i++) {
      const s = rec[i]!;
      const r = run.recovery[i]!;
      if ('when' in s && s.when && !s.when(ctx)) { r.status = 'skipped'; continue; }
      const err = await this.runStep(s, r, run, ctx, actor, { passed: true });
      this.save(run);
      if (err) { recoveredOk = false; break; }
    }
    run.status = recoveredOk && rec.some((s, i) => run.recovery[i]!.status === 'ok') ? 'recovered' : 'failed';
    run.finished = nowIso();
    this.save(run);
    const msg = `Workflow "${t.title}" ${run.status === 'recovered' ? 'failed but was rolled back' : 'FAILED'}: ${failed}`;
    this.d.events.add({ source: 'system', severity: 'error', type: `workflow.${run.status}`, message: msg, data: { run: run.id } });
    if (this.d.monitor.settings().telegramAlerts) await this.d.notifier.send(`[Mission Control] ${msg}`);
  }

  /** Returns an error string on failure, or null on success/skip. */
  private async runStep(step: Step, rec: StepRecord, run: RunRecord, ctx: Ctx, actor: Actor, gate: { passed: boolean }): Promise<string | null> {
    if ('when' in step && step.when && !step.when(ctx)) { rec.status = 'skipped'; return null; }
    rec.status = 'running';
    rec.startedAt = nowIso();
    this.save(run);
    const finish = (status: StepRecord['status'], detail: string): string | null => {
      rec.status = status;
      rec.detail = redactString(detail).slice(0, 400);
      rec.finishedAt = nowIso();
      return status === 'ok' || status === 'skipped' ? null : rec.detail;
    };
    try {
      if (step.kind === 'wait') { await sleep(step.ms); return finish('ok', `waited ${step.ms} ms`); }
      if (step.kind === 'gate') return await this.gate(step, rec, run, gate, finish);
      const tries = 1 + (step.retries ?? 0);
      let last = '';
      for (let n = 1; n <= tries; n++) {
        rec.attempts = n;
        this.save(run);
        if (step.kind === 'check') {
          const r = await this.check(step.check);
          last = r.detail;
          if (r.ok) return finish('ok', r.detail);
        } else {
          const def = this.d.actions.def(step.action);
          if (def.risk === 'high' && !gate.passed) return finish('failed', 'Policy: a high-risk step ran before an approved gate. Aborted.');
          const out = await this.d.actions.runPreapproved(actor, step.action, step.params(ctx));
          ctx.out[step.id] = out;
          last = out.detail;
          if (out.ok) return finish('ok', out.detail + (out.verified === true ? ' (verified)' : ''));
        }
        if (n < tries) await sleep((step.backoffMs ?? 2000) * this.d.cfg.retryScale);
      }
      return finish('failed', last || 'failed');
    } catch (e) {
      return finish('failed', (e as Error).message);
    }
  }

  private async check(name: CheckName): Promise<{ ok: boolean; detail: string }> {
    const { oc, inf } = this.d;
    if (name === 'config.valid') {
      if (!this.d.caps.get('openclaw.config.validate').supported) return { ok: true, detail: 'skipped: this OpenClaw has no config validate command' };
      const v = await oc.validateConfig();
      return v.ok ? { ok: v.data.valid, detail: v.data.valid ? 'Config is valid' : 'Config is INVALID' } : { ok: false, detail: v.error.message };
    }
    if (name === 'gateway.live') {
      const g = await oc.gatewayHttp();
      return g.ok ? { ok: g.data.live && g.data.ready !== false, detail: g.data.live ? (g.data.ready === false ? 'Live but not ready yet' : 'Live and ready') : 'No response from gateway' } : { ok: false, detail: g.error.message };
    }
    const d = await inf.detect();
    return d.ok ? { ok: true, detail: `${d.data.kind} up with ${d.data.models.length} models` } : { ok: false, detail: d.error.message };
  }

  private async gate(step: Extract<Step, { kind: 'gate' }>, rec: StepRecord, run: RunRecord, gate: { passed: boolean }, finish: (s: StepRecord['status'], d: string) => string | null): Promise<string | null> {
    const actor: Actor = { name: `workflow:${run.id}`, role: 'operator', via: 'workflow', ip: '' };
    const res = await this.d.actions.submitInternal(actor, 'workflow.gate', { runId: run.id, stepId: step.id, message: step.message });
    rec.status = 'waiting';
    rec.approval = res;
    run.status = 'waiting_approval';
    this.save(run);
    const deadline = Date.now() + 60 * 60_000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const row = this.d.actions.getRow(res);
      if (!row) return finish('failed', 'Approval record vanished');
      if (row.status === 'executed') {
        gate.passed = true;
        run.status = 'running';
        return finish('ok', `Approved by ${row.decided_by}`);
      }
      if (row.status === 'rejected' || row.status === 'expired' || row.status === 'failed') return finish('failed', `Gate ${row.status}${row.decided_by ? ` by ${row.decided_by}` : ''}`);
    }
    return finish('failed', 'Gate timed out');
  }
}
