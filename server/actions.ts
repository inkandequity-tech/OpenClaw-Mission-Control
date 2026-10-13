import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError, type Actor, type Risk } from './types.ts';
import type { Deps } from './deps.ts';
import { run, SAFE_ID } from './exec.ts';
import { redactForAudit, redactString } from './redact.ts';
import { sleep } from './util.ts';
import { validateSettings } from './health.ts';

export interface ExecOutcome {
  ok: boolean;
  /** true: a post-condition was observed. false: it was checked and failed. null: cannot be verified. */
  verified: boolean | null;
  detail: string;
  data?: unknown;
}

export interface ActionDef<P = any> {
  id: string;
  title: string;
  risk: Risk;
  /** May an agent principal propose this? (It is always queued for a human.) */
  agent: boolean;
  /** Not directly submittable from the API (used by workflows). */
  internal?: boolean;
  capability?: string;
  validate(raw: unknown): P;
  summary(p: P): string;
  preview?(d: Deps, p: P): Promise<unknown>;
  execute(d: Deps, p: P, actor: Actor): Promise<ExecOutcome>;
  confirmPhrase?(p: P): string;
}

export interface ApprovalRow {
  id: string;
  ts: string;
  proposer: string;
  proposer_role: string;
  action: string;
  params: string;
  params_hash: string;
  risk: Risk;
  preview: string;
  confirm_phrase: string | null;
  status: 'pending' | 'running' | 'executed' | 'failed' | 'rejected' | 'expired';
  decided_by: string | null;
  decided_ts: string | null;
  result: string | null;
  expires: string;
}

export type SubmitResult =
  | { status: 'executed'; outcome: ExecOutcome }
  | { status: 'pending'; approval: ApprovalPublic };

export type ApprovalPublic = Omit<ApprovalRow, 'params' | 'preview' | 'result'> & { params: unknown; preview: unknown; result: unknown };

const APPROVAL_TTL_MS = 60 * 60_000;
const hashOf = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// ---- parameter helpers ---------------------------------------------------------------------

function obj(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'bad_input', 'Parameters must be an object');
  return raw as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string, opts: { max?: number; re?: RegExp; optional?: boolean } = {}): string {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new AppError(400, 'bad_input', `"${k}" is required`);
  }
  if (typeof v !== 'string') throw new AppError(400, 'bad_input', `"${k}" must be a string`);
  if (v.length > (opts.max ?? 200)) throw new AppError(400, 'bad_input', `"${k}" is too long`);
  if (opts.re && !opts.re.test(v)) throw new AppError(400, 'bad_input', `"${k}" has an invalid format`);
  return v;
}
const noExtra = (o: Record<string, unknown>, allowed: string[]) => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new AppError(400, 'bad_input', `Unknown parameter(s): ${extra.join(', ')}`);
};

export const CONFIG_PATH_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/;
const SECRET_PATH_RE = /(token|secret|passw|api[-_]?key|credential|private)/i;
const FORBIDDEN_SEGMENT = /(^|[.[])(__proto__|constructor|prototype)([.\]]|$)/;

function pathTokens(p: string): Array<string | number> {
  return p.match(/[A-Za-z_][A-Za-z0-9_-]*|\[\d+\]/g)!.map((t) => (t.startsWith('[') ? Number(t.slice(1, -1)) : t));
}
export function getPath(o: unknown, p: string): unknown {
  let cur: any = o;
  for (const t of pathTokens(p)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[t];
  }
  return cur;
}
export function setPath(o: any, p: string, v: unknown): void {
  const toks = pathTokens(p);
  let cur = o;
  toks.forEach((t, i) => {
    if (i === toks.length - 1) cur[t] = v;
    else {
      if (cur[t] === undefined || cur[t] === null || typeof cur[t] !== 'object') cur[t] = typeof toks[i + 1] === 'number' ? [] : {};
      cur = cur[t];
    }
  });
}
const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- shared executors ----------------------------------------------------------------------

async function applyConfigSet(d: Deps, actor: Actor, p: { path: string; value: unknown }): Promise<ExecOutcome> {
  d.caps.require('openclaw.config.set');
  const snap = d.backups.snapshot(`before config set ${p.path}`, actor.name);
  const valueArg = typeof p.value === 'string' ? p.value : JSON.stringify(p.value);
  const res = await run(d.cfg.openclawBin, ['config', 'set', p.path, valueArg], { timeoutMs: 30000 });
  const rollback = (why: string): ExecOutcome => {
    try {
      d.backups.writeBack(snap.id);
      return { ok: false, verified: false, detail: `${why} Previous config restored from backup ${snap.id}.`, data: { rolledBack: true, backup: snap.id } };
    } catch (e) {
      return { ok: false, verified: false, detail: `${why} AND automatic restore failed (${(e as Error).message}). Restore backup ${snap.id} manually.`, data: { rolledBack: false, backup: snap.id } };
    }
  };
  if (res.spawnError || !res.ok) return rollback(`openclaw config set failed: ${redactString(res.stderr || res.stdout || res.spawnError || '').slice(0, 300)}.`);
  if (d.caps.get('openclaw.config.validate').supported) {
    const v = await d.oc.validateConfig();
    if (!v.ok || !v.data.valid) return rollback('Config failed validation after the change.');
  }
  const now = d.oc.readRawConfig();
  if (!now || !deepEq(getPath(now, p.path), p.value)) return rollback(`The value at ${p.path} is not what was requested after the change.`);
  return { ok: true, verified: true, detail: `Set ${p.path} and re-read it from the config file. Backup ${snap.id} kept. Some settings only take effect after a gateway restart.`, data: { backup: snap.id } };
}

async function waitGateway(d: Deps, totalMs: number): Promise<{ live: boolean; ready: boolean; after: number }> {
  const t0 = Date.now();
  const poll = Math.min(3000, Math.max(100, totalMs / 10));
  while (Date.now() - t0 < totalMs) {
    const g = await d.oc.gatewayHttp();
    if (g.ok && g.data.live && g.data.ready !== false) return { live: true, ready: true, after: Date.now() - t0 };
    await sleep(poll);
  }
  const g = await d.oc.gatewayHttp();
  return { live: g.ok && g.data.live, ready: false, after: Date.now() - t0 };
}

// ---- registry ------------------------------------------------------------------------------

export function buildRegistry(): Map<string, ActionDef> {
  const defs: ActionDef[] = [
    {
      id: 'config.snapshot', title: 'Snapshot OpenClaw config', risk: 'low', agent: false,
      validate: (raw) => { const o = obj(raw); noExtra(o, ['label']); return { label: str(o, 'label', { max: 60, optional: true, re: /^[\w .:-]*$/ }) || 'manual snapshot' }; },
      summary: (p) => `Snapshot config (${p.label})`,
      async execute(d, p, a) {
        const m = d.backups.snapshot(p.label, a.name);
        return { ok: true, verified: d.backups.currentSha() === m.sha256 || d.backups.get(m.id).sha256 === m.sha256, detail: `Saved backup ${m.id}`, data: m };
      },
    },
    {
      id: 'config.restore', title: 'Restore OpenClaw config from backup', risk: 'high', agent: false,
      validate: (raw) => { const o = obj(raw); noExtra(o, ['backupId']); return { backupId: str(o, 'backupId', { re: /^\d{14}-[0-9a-f]{8}$/ }) }; },
      summary: (p) => `Restore config from backup ${p.backupId}`,
      confirmPhrase: (p) => `restore ${p.backupId}`,
      preview: async (d, p) => d.backups.diff('current', p.backupId),
      async execute(d, p, a) {
        const target = d.backups.get(p.backupId);
        const pre = d.backups.snapshot(`pre-restore of ${p.backupId}`, a.name);
        const written = d.backups.writeBack(p.backupId);
        const back = (why: string): ExecOutcome => {
          try { d.backups.writeBack(pre.id); return { ok: false, verified: false, detail: `${why} Rolled back to ${pre.id}.`, data: { rolledBack: true } }; }
          catch (e) { return { ok: false, verified: false, detail: `${why} Rollback failed: ${(e as Error).message}. Restore ${pre.id} manually.`, data: { rolledBack: false } }; }
        };
        if (d.caps.get('openclaw.config.validate').supported) {
          const v = await d.oc.validateConfig();
          if (!v.ok || !v.data.valid) return back('Restored config failed validation.');
        }
        const ok = d.backups.currentSha() === written && written === target.sha256;
        return ok ? { ok: true, verified: true, detail: `Config restored from ${p.backupId} (checksum verified). Pre-restore state kept as ${pre.id}.`, data: { preRestore: pre.id } } : back('Checksum mismatch after restore.');
      },
    },
    {
      id: 'config.set', title: 'Change an OpenClaw config value', risk: 'high', agent: true, capability: 'openclaw.config.set',
      validate: (raw) => {
        const o = obj(raw); noExtra(o, ['path', 'value']);
        const path = str(o, 'path', { max: 120, re: CONFIG_PATH_RE });
        if (FORBIDDEN_SEGMENT.test(path)) throw new AppError(400, 'bad_input', 'Forbidden path segment');
        if (SECRET_PATH_RE.test(path)) throw new AppError(400, 'forbidden_path', 'Credentials cannot be changed from the browser. Use `openclaw configure` on the Mac.');
        if (!('value' in o)) throw new AppError(400, 'bad_input', '"value" is required');
        if (JSON.stringify(o.value)?.length > 2000) throw new AppError(400, 'bad_input', 'Value too large');
        return { path, value: o.value };
      },
      summary: (p) => `Set ${p.path}`,
      confirmPhrase: (p) => `set ${p.path}`,
      async preview(d, p) {
        const raw = d.oc.readRawConfig();
        const clone = raw ? JSON.parse(JSON.stringify(raw)) : {};
        setPath(clone, p.path, p.value);
        const before = getPath(raw, p.path);
        return { path: p.path, before: before === undefined ? '(unset)' : redactForAudit(before), after: redactForAudit(p.value), note: 'The change is verified by re-reading the file and validating; on any mismatch the previous config is restored automatically.' };
      },
      execute: (d, p, a) => applyConfigSet(d, a, p),
    },
    {
      id: 'model.select', title: 'Select the model OpenClaw uses by default', risk: 'high', agent: true, capability: 'openclaw.config.set',
      validate: (raw) => { const o = obj(raw); noExtra(o, ['model']); return { model: str(o, 'model', { max: 160, re: /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/ }) }; },
      summary: (p) => `Use model ${p.model} (agents.defaults.model)`,
      confirmPhrase: (p) => `use ${p.model}`,
      async preview(d, p) {
        const det = await d.inf.detect();
        const cur = d.oc.configuredModel();
        const provider = cur.provider ?? d.inf.target()?.provider ?? 'lmstudio';
        const onServer = det.ok ? det.data.models.find((m) => m.id === p.model) : undefined;
        return { current: cur.raw, next: `${provider}/${p.model}`, onServer: det.ok ? Boolean(onServer) : null, loaded: onServer?.loaded ?? null, warning: det.ok && !onServer ? 'This model is not on the inference server.' : undefined };
      },
      async execute(d, p, a) {
        const det = await d.inf.detect();
        if (!det.ok) return { ok: false, verified: false, detail: `Inference server unreachable: ${det.error.message}. Not changing the model.` };
        if (!det.data.models.some((m) => m.id === p.model)) return { ok: false, verified: false, detail: `"${p.model}" is not on the inference server; refusing to point OpenClaw at it.` };
        const provider = d.oc.configuredModel().provider ?? d.inf.target()?.provider ?? 'lmstudio';
        return applyConfigSet(d, a, { path: 'agents.defaults.model', value: `${provider}/${p.model}` });
      },
    },
    {
      id: 'gateway.restart', title: 'Restart the OpenClaw gateway', risk: 'high', agent: true, capability: 'openclaw.gateway.restart',
      validate: (raw) => { noExtra(obj(raw), []); return {}; },
      summary: () => 'Restart the OpenClaw gateway',
      confirmPhrase: () => 'restart gateway',
      async preview(d) {
        const g = await d.oc.gatewayHttp();
        const v = d.caps.get('openclaw.config.validate').supported ? await d.oc.validateConfig() : null;
        const recent = d.oc.stabilityReports(40).filter((r) => Date.now() - Date.parse(r.ts) < 24 * 3600_000);
        return {
          gateway: g.ok ? { live: g.data.live, ready: g.data.ready } : g.error,
          configValid: v ? (v.ok ? v.data.valid : null) : 'not checked (validate unsupported)',
          impact: 'Agent runs and Telegram delivery are interrupted until the gateway is back.',
          history: `${recent.length} stability report(s) in the last 24h` + (recent.some((r) => /restart_(close_failed|shutdown_timeout)/.test(r.reason)) ? ' — including failed/slow restarts; this restart may need manual recovery.' : ''),
        };
      },
      async execute(d) {
        if (d.caps.get('openclaw.config.validate').supported) {
          const v = await d.oc.validateConfig();
          if (!v.ok || !v.data.valid) return { ok: false, verified: false, detail: 'Config does not validate; refusing to restart into a broken config.' };
        }
        const r = await run(d.cfg.openclawBin, ['gateway', 'restart'], { timeoutMs: 90_000 });
        const cliNote = r.spawnError ? r.spawnError : r.ok ? 'CLI returned success' : `CLI exited ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${redactString(r.stderr).slice(0, 200)}`;
        await sleep(Math.min(2000, d.cfg.restartWaitMs / 10));
        const w = await waitGateway(d, d.cfg.restartWaitMs);
        if (w.live && w.ready) return { ok: true, verified: true, detail: `Gateway answered /healthz and /readyz ${Math.round(w.after / 1000)}s after restart. ${cliNote}.` };
        return { ok: false, verified: false, detail: `Gateway did not become ${w.live ? 'ready' : 'live'} within ${Math.round(d.cfg.restartWaitMs / 1000)}s. ${cliNote}. Check Logs & Diagnostics.` };
      },
    },
    ...(['run', 'enable', 'disable'] as const).map((verb): ActionDef => ({
      id: `cron.${verb}`, title: `${verb[0]!.toUpperCase()}${verb.slice(1)} a scheduled job`, risk: 'medium', agent: true, capability: 'openclaw.cron.manage',
      validate: (raw) => { const o = obj(raw); noExtra(o, ['id']); return { id: str(o, 'id', { re: SAFE_ID }) }; },
      summary: (p) => `${verb} scheduled job ${p.id}`,
      async execute(d, p) {
        const r = await d.oc.cli(['cron', verb, p.id, '--json']);
        if ('error' in r) return { ok: false, verified: false, detail: r.error.message };
        if (verb === 'run') {
          const j = r.json as any;
          return j?.enqueued === true && j?.runId ? { ok: true, verified: true, detail: `Run enqueued (${j.runId}).`, data: j } : { ok: true, verified: null, detail: 'Command succeeded but did not confirm an enqueued run.', data: j };
        }
        const list = await d.oc.cron();
        const job = list.ok ? (list.data.jobs.find((x) => String(x.id ?? x.jobId) === p.id) as any) : undefined;
        if (!job) return { ok: true, verified: null, detail: 'Command succeeded; could not re-read the job to confirm.' };
        const isOff = job.enabled === false || job.status === 'disabled';
        return (verb === 'disable') === isOff ? { ok: true, verified: true, detail: `Job ${p.id} is now ${isOff ? 'disabled' : 'enabled'}.` } : { ok: false, verified: false, detail: `Job ${p.id} did not change state.` };
      },
    })),
    {
      id: 'cron.create', title: 'Create a scheduled job', risk: 'high', agent: true, capability: 'openclaw.cron.create',
      validate: (raw) => {
        const o = obj(raw); noExtra(o, ['schedule', 'prompt', 'name', 'agent']);
        const schedule = str(o, 'schedule', { max: 80, re: /^[0-9*/,-]+( [0-9*/,A-Za-z-]+){4}$/ });
        const prompt = str(o, 'prompt', { max: 2000 });
        if (prompt.startsWith('-')) throw new AppError(400, 'bad_input', 'Prompt must not start with "-"');
        const name = str(o, 'name', { max: 80, optional: true, re: /^[\w][\w .:-]*$/ });
        const agent = str(o, 'agent', { optional: true, re: SAFE_ID });
        return { schedule, prompt, name, agent };
      },
      summary: (p) => `Create job "${p.name || p.prompt.slice(0, 30)}" on schedule ${p.schedule}`,
      confirmPhrase: () => 'create job',
      preview: async (_d, p) => ({ schedule: p.schedule, agent: p.agent || '(default)', name: p.name || '(none)', prompt: p.prompt, warning: 'This prompt will run unattended on the schedule, with the agent\'s full tool access.' }),
      async execute(d, p) {
        const before = await d.oc.cron();
        const args = ['cron', 'create', p.schedule, p.prompt, ...(p.name ? ['--name', p.name] : []), ...(p.agent ? ['--agent', p.agent] : []), '--json'];
        const r = await d.oc.cli(args);
        if ('error' in r) return { ok: false, verified: false, detail: r.error.message };
        const after = await d.oc.cron();
        if (!before.ok || !after.ok) return { ok: true, verified: null, detail: 'Created; could not re-list jobs to confirm.' };
        const found = p.name ? after.data.jobs.some((j) => j.name === p.name) : after.data.jobs.length > before.data.jobs.length;
        return found ? { ok: true, verified: true, detail: 'Job created and found in the job list.' } : { ok: false, verified: false, detail: 'Command succeeded but the job was not found in the list.' };
      },
    },
    {
      id: 'tailscale.serve.enable', title: 'Publish Mission Control on the tailnet (Tailscale Serve)', risk: 'high', agent: false, capability: 'tailscale.serve',
      validate: (raw) => { const o = obj(raw); noExtra(o, ['httpsPort']); const n = Number(o.httpsPort ?? 443); if (![443, 8443, 10000].includes(n)) throw new AppError(400, 'bad_input', 'httpsPort must be 443, 8443 or 10000'); return { httpsPort: n }; },
      summary: (p) => `tailscale serve --bg --https=${p.httpsPort} → 127.0.0.1`,
      confirmPhrase: (p) => `serve ${p.httpsPort}`,
      async preview(d, p) {
        const s = await d.ts.serveStatus();
        const dns = d.ts.selfDns();
        return { url: dns ? `https://${dns}${p.httpsPort === 443 ? '' : ':' + p.httpsPort}/` : '(Tailscale DNS name unknown)', currentServe: s.ok ? s.data.raw : s.error, scope: 'Tailnet only (Serve). Funnel (public internet) is never enabled by this app.', command: `tailscale serve --bg --https=${p.httpsPort} http://127.0.0.1:${d.cfg.port}` };
      },
      async execute(d, p) {
        const cur = await d.ts.serveStatus();
        if (cur.ok && JSON.stringify(cur.data.raw).includes(`:${p.httpsPort}"`)) return { ok: false, verified: false, detail: `Port ${p.httpsPort} already has a Serve configuration; refusing to overwrite it. Pick another port.` };
        const r = await d.ts.serveEnable(d.cfg.port, p.httpsPort);
        const after = await d.ts.serveStatus();
        if (!r.ok) return { ok: false, verified: false, detail: `tailscale serve failed: ${r.detail}` };
        const good = after.ok && after.data.configured && !after.data.funnel && JSON.stringify(after.data.raw).includes(`:${p.httpsPort}`);
        return good ? { ok: true, verified: true, detail: `Serve is active on https port ${p.httpsPort}; Funnel is off.` } : { ok: false, verified: false, detail: `Command ran but Serve status does not show the expected configuration${after.ok && after.data.funnel ? ' (FUNNEL DETECTED — disable it now)' : ''}.` };
      },
    },
    {
      id: 'tailscale.serve.disable', title: 'Stop publishing Mission Control on the tailnet', risk: 'high', agent: false, capability: 'tailscale.serve',
      validate: (raw) => { const o = obj(raw); noExtra(o, ['httpsPort']); const n = Number(o.httpsPort ?? 443); if (![443, 8443, 10000].includes(n)) throw new AppError(400, 'bad_input', 'httpsPort must be 443, 8443 or 10000'); return { httpsPort: n }; },
      summary: (p) => `tailscale serve --https=${p.httpsPort} off`,
      confirmPhrase: (p) => `unserve ${p.httpsPort}`,
      async execute(d, p) {
        const r = await d.ts.serveDisable(p.httpsPort);
        const after = await d.ts.serveStatus();
        const gone = after.ok && !JSON.stringify(after.data.raw).includes(`:${p.httpsPort}"`);
        return r.ok && gone ? { ok: true, verified: true, detail: `Serve on port ${p.httpsPort} removed.` } : { ok: false, verified: false, detail: r.ok ? 'Serve status still lists the port.' : r.detail };
      },
    },
    {
      id: 'inference.test', title: 'Run a test inference', risk: 'medium', agent: true,
      validate: (raw) => { const o = obj(raw); noExtra(o, ['model']); return { model: str(o, 'model', { optional: true, max: 160, re: /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/ }) || undefined }; },
      summary: (p) => `Test inference${p.model ? ` on ${p.model}` : ''}`,
      async execute(d, p) {
        await d.inf.detect();
        const r = await d.inf.testInference(p.model);
        return r.ok ? { ok: true, verified: true, detail: `"${r.data.modelReported ?? r.data.modelRequested}" answered in ${r.data.latencyMs} ms`, data: r.data } : { ok: false, verified: false, detail: r.error.message };
      },
    },
    {
      id: 'benchmark.run', title: 'Benchmark a model', risk: 'medium', agent: true,
      validate: (raw) => { const o = obj(raw); noExtra(o, ['model']); return { model: str(o, 'model', { max: 160, re: /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/ }) }; },
      summary: (p) => `Benchmark ${p.model}`,
      async execute(d, p) {
        const id = d.benchmarks.start(p.model);
        return { ok: true, verified: null, detail: `Benchmark ${id} started; progress and results appear on the Models page and event timeline.`, data: { id } };
      },
    },
    {
      id: 'monitor.settings', title: 'Update health-monitor thresholds', risk: 'low', agent: false,
      validate: (raw) => validateSettings({ ...obj(raw) }),
      summary: () => 'Update monitor settings',
      async execute(d, p) {
        d.monitor.saveSettings(p);
        return { ok: true, verified: JSON.stringify(d.monitor.settings()) === JSON.stringify(p), detail: 'Monitor settings saved.' };
      },
    },
    {
      id: 'telegram.test', title: 'Send a test Telegram alert', risk: 'medium', agent: false, capability: 'openclaw.message.send',
      validate: (raw) => { noExtra(obj(raw), []); return {}; },
      summary: () => 'Send a test alert to the Telegram owner',
      async execute(d) {
        const r = await d.notifier.send('Test alert from OpenClaw Mission Control.');
        return { ok: r.ok, verified: null, detail: r.detail };
      },
    },
    {
      id: 'workflow.start', title: 'Start a workflow', risk: 'medium', agent: false,
      validate: (raw) => { const o = obj(raw); noExtra(o, ['template', 'params']); return { template: str(o, 'template', { re: /^[a-z0-9-]+$/ }), params: o.params ?? {} }; },
      summary: (p) => `Start workflow ${p.template}`,
      async execute(d, p, a) {
        const id = d.workflows.start(p.template, p.params, a);
        return { ok: true, verified: null, detail: `Workflow run ${id} started. High-impact steps wait for your approval.`, data: { runId: id } };
      },
    },
    {
      id: 'workflow.gate', title: 'Workflow approval gate', risk: 'high', agent: false, internal: true,
      validate: (raw) => { const o = obj(raw); return { runId: str(o, 'runId'), stepId: str(o, 'stepId'), message: str(o, 'message', { max: 500 }) }; },
      summary: (p) => `Gate: ${p.message}`,
      async preview(_d, p) { return { question: p.message }; },
      confirmPhrase: () => 'proceed',
      async execute() { return { ok: true, verified: true, detail: 'Gate approved.' }; },
    },
  ];
  return new Map(defs.map((d) => [d.id, d]));
}

// ---- engine --------------------------------------------------------------------------------

/**
 * Policy engine for every state-changing operation.
 *  - viewer: denied.  agent principal: may only propose; always queued for a human.
 *  - low: operator, runs immediately.  medium: operator with an elevated (password-confirmed) session.
 *  - high: queued; a human approves with an elevated session AND by typing the confirmation phrase.
 * Every outcome (including denials) is written to the audit trail.
 */
export class Actions extends EventEmitter {
  private defs = buildRegistry();
  private d!: Deps;

  bind(d: Deps): void {
    this.d = d;
  }

  describe(): Array<{ id: string; title: string; risk: Risk; agent: boolean; capability: string | null; available: boolean; reason: string | null }> {
    return [...this.defs.values()]
      .filter((x) => !x.internal)
      .map((x) => {
        const cap = x.capability ? this.d.caps.get(x.capability) : null;
        return { id: x.id, title: x.title, risk: x.risk, agent: x.agent, capability: x.capability ?? null, available: cap ? cap.supported : true, reason: cap && !cap.supported ? cap.reason : null };
      });
  }

  def(id: string): ActionDef {
    const x = this.defs.get(id);
    if (!x) throw new AppError(404, 'no_action', `Unknown action "${id}"`);
    return x;
  }

  private deny(actor: Actor, id: string, params: unknown, status: number, code: string, msg: string): never {
    this.d.audit.record({ actor, action: id, params, outcome: 'denied', detail: `${code}: ${msg}` });
    throw new AppError(status, code, msg);
  }

  async submit(actor: Actor, id: string, raw: unknown): Promise<SubmitResult> {
    const def = this.defs.get(id);
    if (!def || def.internal) this.deny(actor, id, raw, 404, 'no_action', `Unknown action "${id}"`);
    if (actor.role === 'viewer') this.deny(actor, id, raw, 403, 'forbidden', 'Viewers are read-only');
    if (actor.role === 'agent' && !def!.agent) this.deny(actor, id, raw, 403, 'forbidden', 'This action cannot be proposed by agents');
    let params: unknown;
    try {
      params = def!.validate(raw);
    } catch (e) {
      this.d.audit.record({ actor, action: id, params: raw, outcome: 'failure', detail: `invalid input: ${(e as Error).message}` });
      throw e;
    }
    if (def!.capability) {
      try { this.d.caps.require(def!.capability); } catch (e) { this.d.audit.record({ actor, action: id, params, outcome: 'failure', detail: (e as Error).message }); throw e; }
    }
    const queue = actor.role === 'agent' || def!.risk === 'high';
    if (!queue) {
      if (def!.risk === 'medium' && !actor.elevated) this.deny(actor, id, params, 403, 'elevation_required', 'Re-enter your password to unlock changes (Elevate).');
      return { status: 'executed', outcome: await this.runDef(def!, params, actor) };
    }
    return { status: 'pending', approval: await this.enqueue(actor, def!, params) };
  }

  /** Queue an internal action (workflow gate) and return its approval id. Never executes anything. */
  async submitInternal(actor: Actor, id: string, raw: unknown): Promise<string> {
    const def = this.def(id);
    return (await this.enqueue(actor, def, def.validate(raw))).id;
  }

  private async enqueue(actor: Actor, def: ActionDef, params: unknown): Promise<ApprovalPublic> {
    const id = def.id;
    // Queue for human approval. Identical pending proposals are de-duplicated.
    const hash = hashOf([id, params]);
    const dup = this.d.db.prepare("SELECT * FROM approvals WHERE params_hash = ? AND status = 'pending' AND expires > ?").get(hash, new Date().toISOString()) as ApprovalRow | undefined;
    if (dup) return this.pub(dup);
    let preview: unknown = null;
    try { preview = def.preview ? await def.preview(this.d, params) : null; } catch (e) { preview = { error: redactString((e as Error).message) }; }
    // Every approval carries a plain-language summary so the reviewer sees what is being asked before the details.
    const summary = def.summary(params);
    preview = preview && typeof preview === 'object' && !Array.isArray(preview) ? { summary, ...(preview as object) } : preview === null ? { summary } : { summary, detail: preview };
    const row: ApprovalRow = {
      id: crypto.randomBytes(6).toString('hex'), ts: new Date().toISOString(), proposer: actor.name, proposer_role: actor.role, action: id,
      params: JSON.stringify(redactForAudit(params)), params_hash: hash, risk: def.risk, preview: JSON.stringify(redactForAudit(preview)),
      confirm_phrase: def.confirmPhrase?.(params) ?? null, status: 'pending', decided_by: null, decided_ts: null, result: null,
      expires: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    };
    // Real params are kept server-side for execution (redacted copy is what the UI sees).
    this.d.db.prepare(`INSERT INTO approvals(id,ts,proposer,proposer_role,action,params,params_hash,risk,preview,confirm_phrase,status,decided_by,decided_ts,result,expires)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.ts, row.proposer, row.proposer_role, row.action, JSON.stringify(params), row.params_hash, row.risk, row.preview, row.confirm_phrase, row.status, null, null, null, row.expires);
    this.d.audit.record({ actor, action: id, params, outcome: 'pending', detail: `queued for approval ${row.id}: ${def.summary(params)}` });
    this.d.events.add({ source: actor.role === 'agent' ? 'agent' : 'security', severity: 'warn', type: 'approval.requested', message: `${actor.name} requests: ${def.summary(params)}`, data: { approval: row.id, risk: def.risk } });
    this.emit('approval', row.id);
    return this.pub(row);
  }

  private pub(r: ApprovalRow): ApprovalPublic {
    // `params` column holds the real params; show only a redacted copy to clients.
    let params: unknown = null;
    try { params = redactForAudit(JSON.parse(r.params)); } catch { /* keep null */ }
    return { ...r, params, preview: safeJson(r.preview), result: safeJson(r.result) };
  }

  list(status?: string): ApprovalPublic[] {
    this.expireStale();
    const rows = (status
      ? this.d.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY ts DESC LIMIT 100').all(status)
      : this.d.db.prepare('SELECT * FROM approvals ORDER BY ts DESC LIMIT 100').all()) as unknown as ApprovalRow[];
    return rows.map((r) => this.pub(r));
  }

  pendingCount(): number {
    this.expireStale();
    return (this.d.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }).n;
  }

  getRow(id: string): ApprovalRow | undefined {
    return this.d.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  }

  private expireStale(): void {
    this.d.db.prepare("UPDATE approvals SET status='expired' WHERE status='pending' AND expires <= ?").run(new Date().toISOString());
  }

  async decide(actor: Actor, id: string, decision: 'approve' | 'reject', confirm?: string): Promise<ApprovalPublic> {
    const action = `approval.${decision}`;
    if (actor.role !== 'operator') this.deny(actor, action, { id }, 403, 'forbidden', 'Only a signed-in operator can decide approvals');
    if (!actor.elevated) this.deny(actor, action, { id }, 403, 'elevation_required', 'Re-enter your password to decide approvals (Elevate).');
    this.expireStale();
    const row = this.getRow(id);
    if (!row) throw new AppError(404, 'not_found', 'No such approval');
    if (row.status !== 'pending') throw new AppError(409, 'not_pending', `Approval is already ${row.status}`);
    if (decision === 'reject') {
      this.d.db.prepare("UPDATE approvals SET status='rejected', decided_by=?, decided_ts=? WHERE id=? AND status='pending'").run(actor.name, new Date().toISOString(), id);
      this.d.audit.record({ actor, action: row.action, params: { approval: id }, outcome: 'denied', detail: `rejected (proposed by ${row.proposer})` });
      this.emit('approval', id);
      return this.pub(this.getRow(id)!);
    }
    if (row.confirm_phrase && (confirm ?? '').trim() !== row.confirm_phrase) this.deny(actor, action, { id }, 400, 'confirm_mismatch', `Type "${row.confirm_phrase}" exactly to approve.`);
    const def = this.def(row.action);
    const params = JSON.parse(row.params);
    let valid: unknown;
    try { valid = def.validate(params); } catch (e) { this.deny(actor, action, { id }, 400, 'bad_input', `Stored parameters no longer validate: ${(e as Error).message}`); }
    if (hashOf([row.action, valid]) !== row.params_hash && hashOf([row.action, params]) !== row.params_hash) this.deny(actor, action, { id }, 409, 'tampered', 'Stored parameters do not match their fingerprint');
    // Atomically claim the approval so it cannot run twice.
    const claim = this.d.db.prepare("UPDATE approvals SET status='running', decided_by=?, decided_ts=? WHERE id=? AND status='pending'").run(actor.name, new Date().toISOString(), id);
    if (Number(claim.changes) !== 1) throw new AppError(409, 'not_pending', 'Approval was already decided');
    const approver: Actor = { ...actor };
    let outcome: ExecOutcome;
    try {
      outcome = await this.runDef(def, valid, approver, `approved by ${actor.name}; proposed by ${row.proposer} (${row.proposer_role})`);
    } catch (e) {
      outcome = { ok: false, verified: false, detail: (e as Error).message };
    }
    this.d.db.prepare('UPDATE approvals SET status=?, result=? WHERE id=?').run(outcome.ok ? 'executed' : 'failed', JSON.stringify(redactForAudit(outcome)), id);
    this.emit('approval', id);
    return this.pub(this.getRow(id)!);
  }

  /** Used only by workflows whose gates a human already approved. Still validated, audited and verified. */
  async runPreapproved(actor: Actor, id: string, raw: unknown): Promise<ExecOutcome> {
    const def = this.def(id);
    if (def.capability) this.d.caps.require(def.capability);
    return this.runDef(def, def.validate(raw), actor, 'workflow step');
  }

  private async runDef(def: ActionDef, params: unknown, actor: Actor, note = ''): Promise<ExecOutcome> {
    let outcome: ExecOutcome;
    try {
      outcome = await def.execute(this.d, params, actor);
    } catch (e) {
      outcome = { ok: false, verified: false, detail: redactString(e instanceof AppError || e instanceof Error ? e.message : String(e)) };
    }
    outcome.detail = redactString(outcome.detail);
    this.d.audit.record({ actor, action: def.id, params, outcome: outcome.ok ? 'success' : 'failure', verified: outcome.verified, detail: `${note ? note + '; ' : ''}${outcome.detail}` });
    if (def.risk !== 'low') {
      this.d.events.add({
        source: 'audit', severity: outcome.ok ? 'info' : 'error', type: `action.${def.id}`,
        message: `${def.summary(params)} → ${outcome.ok ? 'OK' : 'FAILED'}${outcome.verified === true ? ' (verified)' : outcome.verified === false ? ' (verification failed)' : ' (unverified)'} by ${actor.name}`,
      });
    }
    return outcome;
  }
}

function safeJson(s: string | null): unknown {
  if (s === null) return null;
  try { return JSON.parse(s); } catch { return null; }
}
