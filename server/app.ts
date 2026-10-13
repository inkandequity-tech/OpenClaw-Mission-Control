import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from './config.ts';
import { openDb } from './db.ts';
import { Audit } from './audit.ts';
import { Events } from './events.ts';
import { Auth } from './auth.ts';
import { Capabilities } from './capabilities.ts';
import { OpenClaw } from './integrations/openclaw.ts';
import { Tailscale } from './integrations/tailscale.ts';
import { Inference } from './integrations/inference.ts';
import { Telemetry } from './integrations/telemetry.ts';
import { Backups } from './backups.ts';
import { Notifier } from './notify.ts';
import { Files } from './files.ts';
import { Monitor } from './health.ts';
import { Benchmarks } from './benchmarks.ts';
import { Actions } from './actions.ts';
import { Workflows } from './workflows.ts';
import { createHttpServer, type ServerHandle } from './http.ts';
import { buildRoutes } from './routes.ts';
import type { Deps } from './deps.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface App {
  deps: Deps;
  handle: ServerHandle;
  /** Plaintext bootstrap credentials on first run (shown once, never stored). */
  bootstrap: { user: string; password: string } | null;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export async function createApp(overrides: Partial<AppConfig> = {}, env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const cfg = loadConfig(env, overrides);
  const db = openDb(path.join(cfg.dataDir, 'mission-control.sqlite'));
  const audit = new Audit(db);
  const events = new Events(db);
  const auth = new Auth(cfg.dataDir, { sessionTtlMs: cfg.sessionTtlMs, elevationMs: cfg.elevationMs });
  const bootstrap = await auth.bootstrap();
  const caps = new Capabilities(cfg);
  const oc = new OpenClaw(cfg, caps);
  const ts = new Tailscale(cfg, caps);
  oc.hostsProvider = () => ts.selfIps();
  const inf = new Inference(cfg, caps, oc, ts);
  const tel = new Telemetry(cfg, caps);
  const backups = new Backups(cfg.dataDir, oc.configPath);
  const notifier = new Notifier(cfg, caps, oc);
  const files = new Files(cfg.fileRoots);
  const monitor = new Monitor({ db, events, notifier, oc, ts, inf, tel, caps });
  const benchmarks = new Benchmarks(db, events, inf, tel);
  const actions = new Actions();
  const workflows = new Workflows();
  const deps: Deps = { cfg, db, audit, events, auth, caps, oc, ts, inf, tel, backups, notifier, files, monitor, benchmarks, actions, workflows };
  actions.bind(deps);
  workflows.bind(deps);

  let handle: ServerHandle | null = null;
  const routes = buildRoutes(deps, () => handle);
  handle = createHttpServer(deps, routes, path.resolve(HERE, '..', 'public'));

  return {
    deps,
    handle,
    bootstrap,
    async start() {
      const addr = await handle!.listen();
      // Discovery and first snapshot happen before any change is possible.
      await caps.discover();
      await ts.status(0);
      try {
        const snap = backups.snapshot('automatic (startup)', 'system', { dedupe: true });
        events.add({ source: 'system', severity: 'info', type: 'backup.startup', message: `Config snapshot ${snap.id} is the safety baseline`, dedupeKey: `startup-${snap.id}` });
      } catch (e) {
        events.add({ source: 'system', severity: 'warn', type: 'backup.skipped', message: `No startup config snapshot: ${(e as Error).message}` });
      }
      events.add({ source: 'system', severity: 'info', type: 'app.started', message: `Mission Control listening on ${addr.host}:${addr.port}` });
      if (cfg.background) {
        tel.start(5000);
        monitor.start(cfg.monitorIntervalMs);
        void importOpenClawEvents(deps);
        const t = setInterval(() => void importOpenClawEvents(deps), 60_000);
        t.unref();
        timers.push(t);
      }
      return addr;
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      tel.stop();
      monitor.stop();
      await handle!.close();
      db.close();
    },
  };
}

const timers: NodeJS.Timeout[] = [];

/** Feed OpenClaw's own crash/restart records into the unified timeline (idempotent via dedupe keys). */
async function importOpenClawEvents(d: Deps): Promise<void> {
  for (const s of d.oc.stabilityReports(40)) {
    const severity = /startup_failed|close_failed|shutdown_timeout/.test(s.reason) ? 'error' : 'warn';
    d.events.add({ source: 'openclaw', severity, type: `gateway.${s.reason}`, message: `OpenClaw reported ${s.reason.replace(/_/g, ' ')}`, ts: s.ts, dedupeKey: `stab-${s.file}`, data: { file: s.file } });
  }
  for (const r of d.oc.lastRestarts(30)) {
    const ts = Date.parse(r.ts);
    if (!Number.isNaN(ts)) d.events.add({ source: 'openclaw', severity: 'info', type: 'gateway.restart', message: r.line.replace(/^\[[^\]]+\]\s*/, ''), ts: new Date(ts).toISOString(), dedupeKey: `rst-${r.ts}-${r.line.length}` });
  }
}
