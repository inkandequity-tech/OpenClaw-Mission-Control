import type { AppConfig } from './config.ts';
import type { Db } from './db.ts';
import type { Audit } from './audit.ts';
import type { Events } from './events.ts';
import type { Auth } from './auth.ts';
import type { Capabilities } from './capabilities.ts';
import type { OpenClaw } from './integrations/openclaw.ts';
import type { Tailscale } from './integrations/tailscale.ts';
import type { Inference } from './integrations/inference.ts';
import type { Telemetry } from './integrations/telemetry.ts';
import type { Backups } from './backups.ts';
import type { Notifier } from './notify.ts';
import type { Files } from './files.ts';
import type { Monitor } from './health.ts';
import type { Benchmarks } from './benchmarks.ts';
import type { Actions } from './actions.ts';
import type { Workflows } from './workflows.ts';

/** Everything the request handlers and action executors need, wired once in app.ts. */
export interface Deps {
  cfg: AppConfig;
  db: Db;
  audit: Audit;
  events: Events;
  auth: Auth;
  caps: Capabilities;
  oc: OpenClaw;
  ts: Tailscale;
  inf: Inference;
  tel: Telemetry;
  backups: Backups;
  notifier: Notifier;
  files: Files;
  monitor: Monitor;
  benchmarks: Benchmarks;
  actions: Actions;
  workflows: Workflows;
}
