export type Role = 'operator' | 'viewer' | 'agent';
export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'critical';
export type Risk = 'low' | 'medium' | 'high';
export type EventSource = 'openclaw' | 'agent' | 'model' | 'telegram' | 'network' | 'system' | 'security' | 'audit';

/** Who is performing an operation. Every state-changing path receives one. */
export interface Actor {
  name: string;
  role: Role;
  /** How the actor authenticated: 'session' | 'agent-token' | 'system' | 'workflow'. */
  via: string;
  ip: string;
  elevated?: boolean;
}

export type Outcome = 'success' | 'failure' | 'denied' | 'pending';

export interface AuditEntry {
  actor: Actor;
  action: string;
  params?: unknown;
  outcome: Outcome;
  /** true = post-condition checked; false = checked and failed; null = not verifiable. */
  verified?: boolean | null;
  detail?: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  role: string;
  via: string;
  ip: string;
  action: string;
  params: string;
  outcome: Outcome;
  verified: number | null;
  detail: string;
  hash: string;
}

export interface EventInput {
  source: EventSource;
  severity: Severity;
  type: string;
  message: string;
  data?: unknown;
  /** Stable key so repeated imports of the same underlying event are stored once. */
  dedupeKey?: string;
  ts?: string;
}

export interface EventRow {
  id: number;
  ts: string;
  source: EventSource;
  severity: Severity;
  type: string;
  message: string;
  data: string;
}

export interface Capability {
  id: string;
  supported: boolean;
  reason: string;
  checkedAt: string;
}

export type Result<T> =
  | { ok: true; data: T; ms: number }
  | { ok: false; error: { code: string; message: string; hint?: string }; ms: number };

export class AppError extends Error {
  status: number;
  code: string;
  hint?: string;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export type CheckStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  value?: number | string | null;
  at: string;
}

export interface DiagStep {
  id: string;
  label: string;
  status: 'ok' | 'fail' | 'skipped' | 'unknown';
  detail: string;
  hint?: string;
  commands?: string[];
}
