import { AppError } from './types.ts';
import type { Deps } from './deps.ts';
import { route, setSessionCookie, clearSessionCookie, type Route, type ServerHandle } from './http.ts';
import { buildReport } from './report.ts';
import { securityCenter } from './security-center.ts';
import { Memo, toIso } from './util.ts';
import { kvGet, kvSet } from './db.ts';
import { SUITE } from './benchmarks.ts';
import type { EventSource, Severity } from './types.ts';

export const THEMES = ['noir', 'obsidian', 'cyberpunk', 'aurora', 'arctic', 'solarflare'] as const;
export const WIDGETS = ['health', 'gateway', 'agents', 'sessions', 'inference', 'resources', 'network', 'telegram', 'events', 'quick'] as const;
const MODES = ['dark', 'light', 'system'];

interface Prefs {
  theme: (typeof THEMES)[number];
  mode: 'dark' | 'light' | 'system';
  sidebarCollapsed: boolean;
  widgetOrder: string[];
  widgetHidden: string[];
  notifications: boolean;
}
const DEFAULT_PREFS: Prefs = { theme: 'noir', mode: 'dark', sidebarCollapsed: false, widgetOrder: [...WIDGETS], widgetHidden: [], notifications: false };

function validatePrefs(raw: any): Partial<Prefs> {
  if (!raw || typeof raw !== 'object' || JSON.stringify(raw).length > 4096) throw new AppError(400, 'bad_input', 'Invalid preferences');
  const out: Partial<Prefs> = {};
  if ('theme' in raw) { if (!THEMES.includes(raw.theme)) throw new AppError(400, 'bad_input', 'Unknown theme'); out.theme = raw.theme; }
  if ('mode' in raw) { if (!MODES.includes(raw.mode)) throw new AppError(400, 'bad_input', 'Unknown mode'); out.mode = raw.mode; }
  for (const k of ['sidebarCollapsed', 'notifications'] as const) if (k in raw) { if (typeof raw[k] !== 'boolean') throw new AppError(400, 'bad_input', `${k} must be boolean`); out[k] = raw[k]; }
  for (const k of ['widgetOrder', 'widgetHidden'] as const) if (k in raw) {
    if (!Array.isArray(raw[k]) || raw[k].some((x: unknown) => !(WIDGETS as readonly string[]).includes(x as string))) throw new AppError(400, 'bad_input', `${k} has unknown widgets`);
    out[k] = [...new Set<string>(raw[k])];
  }
  return out;
}

export function buildRoutes(d: Deps, getHandle: () => ServerHandle | null): Route[] {
  const memo = new Memo();
  const num = (v: string | null, def: number, max: number) => Math.min(Math.max(Number(v ?? def) || def, 1), max);
  const need = (c: { actor: { elevated?: boolean } }, what: string) => {
    if (!c.actor.elevated) throw new AppError(403, 'elevation_required', `Re-enter your password (Elevate) to ${what}.`);
  };

  // Cached CLI-backed reads shared by several pages/widgets.
  const sessions = (force = false) => memo.get('sessions', 20_000, () => d.oc.sessions(), force);
  const agents = (force = false) => memo.get('agents', 30_000, () => d.oc.agents(), force);
  const cron = (force = false) => memo.get('cron', 30_000, () => d.oc.cron(), force);

  const sessionInfo = (c: { actor: any; session: any }) => ({
    user: c.actor.name, role: c.actor.role, csrf: c.session.csrf, elevatedUntil: c.session.elevatedUntil,
    elevated: d.auth.isElevated(c.session), pendingApprovals: d.actions.pendingCount(),
  });

  return [
    // ---------- public ----------
    route('GET', '/api/ping', 'public', async () => ({ ok: true })),
    route('POST', '/api/login', 'public', async (c) => {
      const user = String(c.body?.user ?? '').slice(0, 32);
      const password = String(c.body?.password ?? '');
      try {
        const s = await d.auth.login(user, password, c.actor.ip);
        d.audit.record({ actor: { name: user, role: s.role, via: 'session', ip: c.actor.ip }, action: 'auth.login', outcome: 'success', detail: `via ${c.proto}` });
        setSessionCookie(c.res, s.id, Math.floor(d.cfg.sessionTtlMs / 1000), c.proto === 'https');
        return { user: s.user, role: s.role, csrf: s.csrf };
      } catch (e) {
        d.audit.record({ actor: { name: user || '?', role: 'viewer', via: 'none', ip: c.actor.ip }, action: 'auth.login', outcome: 'failure', detail: (e as Error).message });
        throw e;
      }
    }),

    // ---------- session ----------
    route('GET', '/api/session', 'viewer', async (c) => sessionInfo(c)),
    route('POST', '/api/logout', 'viewer', async (c) => {
      d.auth.logout(c.session!.id);
      clearSessionCookie(c.res, c.proto === 'https');
      d.audit.record({ actor: c.actor, action: 'auth.logout', outcome: 'success' });
      return { ok: true };
    }),
    route('POST', '/api/elevate', 'operator', async (c) => {
      try {
        const until = await d.auth.elevate(c.session!, String(c.body?.password ?? ''));
        d.audit.record({ actor: c.actor, action: 'auth.elevate', outcome: 'success', detail: `until ${new Date(until).toISOString()}` });
        return { elevatedUntil: until };
      } catch (e) {
        d.audit.record({ actor: c.actor, action: 'auth.elevate', outcome: 'failure', detail: (e as Error).message });
        throw e;
      }
    }),
    route('POST', '/api/elevate/drop', 'operator', async (c) => {
      d.auth.dropElevation(c.session!);
      d.audit.record({ actor: c.actor, action: 'auth.drop_elevation', outcome: 'success' });
      return { ok: true };
    }),
    route('GET', '/api/prefs', 'viewer', async (c) => ({ ...DEFAULT_PREFS, ...kvGet<Partial<Prefs>>(d.db, `prefs:${c.actor.name}`, {}), themes: THEMES, widgets: WIDGETS })),
    route('PUT', '/api/prefs', 'viewer', async (c) => {
      const next = { ...kvGet<Partial<Prefs>>(d.db, `prefs:${c.actor.name}`, {}), ...validatePrefs(c.body) };
      kvSet(d.db, `prefs:${c.actor.name}`, next);
      return { ...DEFAULT_PREFS, ...next };
    }),

    // ---------- discovery ----------
    route('GET', '/api/capabilities', 'viewer', async (c) => {
      const refresh = c.query.get('refresh') === '1';
      const list = await d.caps.discover(refresh);
      return { openclawVersion: d.caps.openclawVersion, tailscaleVersion: d.caps.tailscaleVersion, capabilities: list };
    }),

    // ---------- overview ----------
    route('GET', '/api/overview', 'viewer', async () => {
      await d.caps.discover();
      const [gw, ses, ag, cr, ts, det] = await Promise.all([
        d.oc.gatewayHttp(),
        d.caps.get('openclaw.sessions').supported ? sessions() : null,
        agents(),
        d.caps.get('openclaw.cron').supported ? cron() : null,
        d.ts.status(10_000),
        memo.get('inference', 10_000, () => d.inf.detect()),
      ]);
      const cfgModel = d.oc.configuredModel();
      const failingJobs = cr?.ok ? cr.data.jobs.filter((j) => j.status === 'error' || (j.state as any)?.lastRunStatus === 'error') : [];
      return {
        health: { overall: d.monitor.overall(), checks: d.monitor.checks, lastRun: d.monitor.lastRun },
        gateway: { http: gw.ok ? gw.data : { error: gw.error }, restarts: d.oc.lastRestarts(3), stability: d.oc.stabilityReports(5), port: d.oc.gatewayPort(), version: d.caps.openclawVersion },
        agents: ag.ok ? { count: ag.data.agents.length, list: ag.data.agents.map((a) => ({ id: a.id, name: a.name, identity: a.identity })) } : { error: ag.error },
        sessions: ses ? (ses.ok ? { total: ses.data.total ?? ses.data.sessions.length, active: ses.data.activeKeys.length } : { error: ses.error }) : { unavailable: d.caps.get('openclaw.sessions').reason },
        automation: cr ? (cr.ok ? { jobs: cr.data.jobs.length, failing: failingJobs.length } : { error: cr.error }) : { unavailable: d.caps.get('openclaw.cron').reason },
        inference: det.ok
          ? { kind: det.data.kind, origin: det.data.origin, models: det.data.models.length, loaded: det.data.models.filter((m) => m.loaded).map((m) => m.id), configuredModel: cfgModel.raw, configuredPresent: cfgModel.modelId ? det.data.models.some((m) => m.id === cfgModel.modelId) : null }
          : { error: det.error, configuredModel: cfgModel.raw },
        telemetry: d.tel.snapshot(),
        tailscale: ts.ok ? { state: ts.data.backendState, self: ts.data.self, peers: ts.data.peers } : { error: ts.error },
        telegram: { config: d.oc.telegramConfig(), check: d.monitor.checks.find((x) => x.id === 'telegram') ?? null },
        events: d.events.list({ limit: 12 }),
        pendingApprovals: d.actions.pendingCount(),
        capabilities: { total: d.caps.list().length, unsupported: d.caps.list().filter((x) => !x.supported).length },
      };
    }),

    // ---------- OpenClaw ----------
    route('GET', '/api/openclaw/gateway', 'viewer', async () => {
      const [http, status] = await Promise.all([d.oc.gatewayHttp(), d.caps.get('openclaw.gateway.status').supported ? d.oc.gatewayStatus() : null]);
      return { http, cli: status, restarts: d.oc.lastRestarts(10), stability: d.oc.stabilityReports(30), version: d.caps.openclawVersion, port: d.oc.gatewayPort() };
    }),
    route('GET', '/api/openclaw/status', 'viewer', async (c) => d.oc.status(c.query.get('deep') === '1')),
    route('GET', '/api/openclaw/agents', 'viewer', async (c) => agents(c.query.get('refresh') === '1')),
    route('GET', '/api/openclaw/sessions', 'viewer', async (c) => sessions(c.query.get('refresh') === '1')),
    route('GET', '/api/openclaw/sessions/tail', 'operator', async (c) => {
      need(c, 'read conversation history');
      const key = c.query.get('key') ?? '';
      const r = await d.oc.sessionTail(key, c.query.get('agent') ?? undefined, Number(c.query.get('lines') ?? 40));
      d.audit.record({ actor: c.actor, action: 'sessions.tail', params: { key, lines: c.query.get('lines') }, outcome: r.ok ? 'success' : 'failure', detail: r.ok ? `read ${r.data.text.length} chars` : r.error.message });
      return r;
    }),
    route('GET', '/api/openclaw/channels', 'viewer', async (c) => d.oc.channels(c.query.get('probe') === '1')),
    route('GET', '/api/openclaw/models', 'viewer', async () => ({ configured: d.oc.configuredModel(), providers: d.oc.providerBaseUrls().map((p) => ({ ...p, baseUrl: p.baseUrl })), status: await d.oc.models() })),
    route('GET', '/api/openclaw/cron', 'viewer', async (c) => cron(c.query.get('refresh') === '1')),
    route('GET', '/api/openclaw/cron/:id/runs', 'viewer', async (c) => d.oc.cronRuns(c.params.id!, num(c.query.get('limit'), 30, 100))),
    route('GET', '/api/openclaw/config', 'viewer', async () => d.oc.configView()),
    route('GET', '/api/openclaw/logs', 'viewer', async () => d.oc.logs()),

    route('GET', '/api/telegram', 'viewer', async () => ({ config: d.oc.telegramConfig(), check: d.monitor.checks.find((x) => x.id === 'telegram') ?? null })),

    // ---------- inference ----------
    route('GET', '/api/inference', 'viewer', async (c) => {
      const det = await memo.get('inference', 10_000, () => d.inf.detect(), c.query.get('refresh') === '1');
      return { target: d.inf.target(), detection: det, configured: d.oc.configuredModel(), benchmarkRunning: d.benchmarks.current() };
    }),
    route('POST', '/api/inference/diagnose', 'viewer', async () => ({ steps: await d.inf.diagnose() })),

    // ---------- network ----------
    route('GET', '/api/network', 'viewer', async () => {
      const [st, serve] = await Promise.all([d.ts.status(0), d.ts.serveStatus()]);
      const dns = d.ts.selfDns();
      return {
        status: st, serve,
        privateUrl: dns ? `https://${dns}/` : null,
        capabilities: d.caps.list().filter((x) => x.id.startsWith('tailscale.')),
        commands: {
          enable: `tailscale serve --bg --https=443 http://127.0.0.1:${d.cfg.port}`,
          status: 'tailscale serve status',
          disable: 'tailscale serve --https=443 off',
          androidSteps: ['Install Tailscale on the phone and sign in to the same tailnet.', 'Turn Tailscale on.', dns ? `Open https://${dns}/ in Chrome.` : 'Open the https URL shown after enabling Serve in Chrome.', 'Sign in; tap the menu → "Add to Home screen" to install it.'],
        },
      };
    }),

    // ---------- telemetry ----------
    route('GET', '/api/telemetry', 'viewer', async () => d.tel.snapshot()),

    // ---------- events & audit ----------
    route('GET', '/api/events', 'viewer', async (c) => d.events.list({
      q: c.query.get('q') ?? undefined, source: (c.query.get('source') as EventSource) || undefined, severity: (c.query.get('severity') as Severity) || undefined,
      since: toIso(c.query.get('since')) ?? undefined, before: Number(c.query.get('before')) || undefined, limit: num(c.query.get('limit'), 200, 1000),
    })),
    route('GET', '/api/events/stream', 'viewer', async () => ({})), // handled inside http.ts
    route('GET', '/api/audit', 'operator', async (c) => ({
      rows: d.audit.list({ limit: num(c.query.get('limit'), 100, 500), before: Number(c.query.get('before')) || undefined, action: c.query.get('action') ?? undefined, outcome: c.query.get('outcome') ?? undefined }),
      chain: d.audit.verify(),
    })),

    // ---------- config backups ----------
    route('GET', '/api/backups', 'viewer', async () => ({ backups: d.backups.list(), currentSha: d.backups.currentSha() })),
    route('GET', '/api/backups/diff', 'viewer', async (c) => {
      const ref = (v: string | null) => (v === 'current' || /^\d{14}-[0-9a-f]{8}$/.test(v ?? '') ? v! : (() => { throw new AppError(400, 'bad_input', 'Invalid backup reference'); })());
      return d.backups.diff(ref(c.query.get('from') ?? 'current'), ref(c.query.get('to') ?? 'current'));
    }),

    // ---------- security ----------
    route('GET', '/api/security', 'viewer', async () => securityCenter(d, getHandle()?.runtime ?? { sawHttps: false })),

    // ---------- files ----------
    route('GET', '/api/files/roots', 'operator', async () => d.files.rootList()),
    route('GET', '/api/files', 'operator', async (c) => d.files.list(Number(c.query.get('root') ?? 0), c.query.get('path') ?? '')),
    route('GET', '/api/files/read', 'operator', async (c) => {
      need(c, 'read file contents');
      const p = c.query.get('path') ?? '';
      try {
        const r = d.files.read(Number(c.query.get('root') ?? 0), p);
        d.audit.record({ actor: c.actor, action: 'files.read', params: { root: c.query.get('root'), path: p }, outcome: 'success', detail: `${r.size} bytes` });
        return r;
      } catch (e) {
        d.audit.record({ actor: c.actor, action: 'files.read', params: { root: c.query.get('root'), path: p }, outcome: e instanceof AppError && e.status === 403 ? 'denied' : 'failure', detail: (e as Error).message });
        throw e;
      }
    }),

    // ---------- actions & approvals ----------
    route('GET', '/api/actions', 'agent-or-operator', async () => ({ actions: d.actions.describe() })),
    route('POST', '/api/actions', 'agent-or-operator', async (c) => d.actions.submit(c.actor, String(c.body?.action ?? ''), c.body?.params)),
    route('GET', '/api/approvals', 'viewer', async (c) => ({ approvals: d.actions.list(c.query.get('status') ?? undefined) })),
    route('POST', '/api/approvals/:id/approve', 'operator', async (c) => d.actions.decide(c.actor, c.params.id!, 'approve', typeof c.body?.confirm === 'string' ? c.body.confirm : undefined)),
    route('POST', '/api/approvals/:id/reject', 'operator', async (c) => d.actions.decide(c.actor, c.params.id!, 'reject')),

    // ---------- workflows ----------
    route('GET', '/api/workflows', 'viewer', async () => ({ templates: d.workflows.templates(), runs: d.workflows.list() })),
    route('GET', '/api/workflows/:id', 'viewer', async (c) => d.workflows.get(c.params.id!)),

    // ---------- benchmarks ----------
    route('GET', '/api/benchmarks', 'viewer', async () => ({ runs: d.benchmarks.list(), running: d.benchmarks.current(), suite: SUITE.map((t) => ({ id: t.id, prompt: t.prompt, check: t.describe })) })),
    route('GET', '/api/benchmarks/:id', 'viewer', async (c) => d.benchmarks.get(c.params.id!)),

    // ---------- monitor ----------
    route('GET', '/api/monitor', 'viewer', async () => ({ settings: d.monitor.settings(), checks: d.monitor.checks, overall: d.monitor.overall(), lastRun: d.monitor.lastRun, telegramAlerts: d.notifier.available() })),
    route('POST', '/api/monitor/run', 'viewer', async () => ({ checks: await d.monitor.runOnce(), overall: d.monitor.overall() })),

    // ---------- diagnostics report ----------
    route('GET', '/api/report', 'viewer', async (c) => {
      const full = c.query.get('full') === '1';
      if (full) need(c, 'include full network addresses');
      const text = await buildReport(d, { full });
      d.audit.record({ actor: c.actor, action: 'report.generate', params: { full }, outcome: 'success' });
      return { text };
    }),
  ];
}
