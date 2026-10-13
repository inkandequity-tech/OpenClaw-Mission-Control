import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.ts';
import type { Capabilities } from '../capabilities.ts';
import type { Result } from '../types.ts';
import { parseJsonLoose, run, SAFE_ID } from '../exec.ts';
import { redactDeep, redactString } from '../redact.ts';
import { asArray, fail, fetchJson, findArray, findDeep, pick, timed, toIso } from '../util.ts';

export interface OpenClawConfigView {
  path: string;
  exists: boolean;
  mode: string | null;
  parseError?: string;
  /** Redacted. Secrets never leave this module. */
  redacted: unknown;
}

export class OpenClaw {
  private cfg: AppConfig;
  private caps: Capabilities;
  /** Extra hosts (e.g. this machine's Tailscale IP) to probe for the gateway HTTP endpoints. */
  hostsProvider: () => string[] = () => [];

  constructor(cfg: AppConfig, caps: Capabilities) {
    this.cfg = cfg;
    this.caps = caps;
  }

  get configPath(): string {
    return path.join(this.cfg.openclawHome, 'openclaw.json');
  }

  /** Raw (unredacted) config for server-side logic only. Never return this to a client. */
  readRawConfig(): Record<string, any> | null {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  }

  configView(): OpenClawConfigView {
    const p = this.configPath;
    if (!fs.existsSync(p)) return { path: p, exists: false, mode: null, redacted: null };
    let mode: string | null = null;
    try {
      mode = (fs.statSync(p).mode & 0o777).toString(8).padStart(3, '0');
    } catch {
      /* ignore */
    }
    const text = fs.readFileSync(p, 'utf8');
    try {
      return { path: p, exists: true, mode, redacted: redactDeep(JSON.parse(text)) };
    } catch (e) {
      return { path: p, exists: true, mode, parseError: (e as Error).message, redacted: redactString(text).slice(0, 20000) };
    }
  }

  /** Run an OpenClaw CLI command. Callers pass fixed argv built from validated parameters. */
  async cli(args: string[], opts: { timeoutMs?: number; json?: boolean; partial?: boolean } = {}) {
    const r = await run(this.cfg.openclawBin, args, {
      timeoutMs: opts.timeoutMs ?? this.cfg.cmdTimeoutMs,
      keepPartialOnTimeout: opts.partial,
      maxBytes: 8 * 1024 * 1024,
    });
    if (r.spawnError) return fail('cli_missing', r.spawnError, 'Install OpenClaw or set OPENCLAW_BIN to its path.');
    if (!r.ok) {
      const msg = redactString((r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ')).slice(0, 400);
      return fail(r.timedOut ? 'cli_timeout' : 'cli_failed', `openclaw ${args[0]} ${r.timedOut ? 'timed out' : `exited ${r.code}`}${msg ? `: ${msg}` : ''}`);
    }
    if (opts.json === false) return { text: redactString(r.stdout) };
    const parsed = parseJsonLoose(r.stdout);
    if (parsed === undefined) return fail('bad_output', `openclaw ${args[0]} did not return JSON`, 'The installed version may not support --json for this command.');
    return { json: redactDeep(parsed), ms: r.ms };
  }

  // ---- gateway --------------------------------------------------------------------------

  gatewayPort(): number {
    return Number(this.readRawConfig()?.gateway?.port ?? 18789);
  }

  /** Liveness/readiness over HTTP (/healthz and /readyz), tried on each candidate host. */
  async gatewayHttp(): Promise<Result<{ live: boolean; ready: boolean | null; host: string | null; port: number; readyzStatus: number | null; detail: unknown; attempts: Array<{ host: string; error?: string; status?: number }> }>> {
    return timed(async () => {
      const port = this.gatewayPort();
      const hosts = [...new Set([...this.hostsProvider(), '127.0.0.1'])];
      // Probe every candidate host in parallel and stop waiting as soon as one answers, so an unreachable
      // address (e.g. a tailnet IP that is down) does not hold up a healthy loopback answer.
      const probeOne = async (host: string) => {
        const h = host.includes(':') ? `[${host}]` : host;
        return { host, h, live: await fetchJson(`http://${h}:${port}/healthz`, { timeoutMs: 2500 }) };
      };
      const pending = hosts.map((host) => probeOne(host));
      const settled: Array<Awaited<ReturnType<typeof probeOne>>> = [];
      await new Promise<void>((resolve) => {
        let left = pending.length;
        for (const pr of pending) {
          void pr.then((r) => {
            settled.push(r);
            left--;
            if (r.live.status !== 0 || left === 0) resolve();
          });
        }
      });
      const probes = settled;
      const attempts: Array<{ host: string; error?: string; status?: number }> = probes.map((p) => ({ host: p.host, status: p.live.status || undefined, error: p.live.error }));
      const hit = probes.find((p) => p.live.status !== 0);
      if (hit) {
        const ready = await fetchJson(`http://${hit.h}:${port}/readyz`, { timeoutMs: 3000 });
        return { live: hit.live.ok, ready: ready.status === 0 ? null : ready.ok, host: hit.host, port, readyzStatus: ready.status || null, detail: redactDeep(ready.json ?? ready.text.slice(0, 500)), attempts };
      }
      return { live: false, ready: null, host: null, port, readyzStatus: null, detail: null, attempts };
    });
  }

  async gatewayStatus(): Promise<Result<unknown>> {
    this.caps.require('openclaw.gateway.status');
    return timed(async () => {
      const r = await this.cli(['gateway', 'status', '--json', '--timeout', '15000'], { timeoutMs: 25000 });
      return 'error' in r ? r : r.json;
    });
  }

  /** Newest "restart" line from OpenClaw's own supervisor log: a verified last-restart signal. */
  lastRestarts(limit = 8): Array<{ ts: string; line: string }> {
    try {
      const lines = fs.readFileSync(path.join(this.cfg.openclawHome, 'logs', 'gateway-restart.log'), 'utf8').trim().split('\n');
      return lines
        .slice(-60)
        .map((l) => ({ ts: /^\[([^\]]+)\]/.exec(l)?.[1] ?? '', line: redactString(l).slice(0, 300) }))
        .filter((x) => x.ts)
        .slice(-limit)
        .reverse();
    } catch {
      return [];
    }
  }

  /** Crash/stability reports OpenClaw writes itself (startup_failed, restart_close_failed, …). */
  stabilityReports(limit = 30): Array<{ file: string; ts: string; reason: string; bytes: number }> {
    const dir = path.join(this.cfg.openclawHome, 'logs', 'stability');
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('openclaw-stability-') && f.endsWith('.json'))
        .map((f) => {
          const m = /^openclaw-stability-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-\d+-(.+)\.json$/.exec(f);
          const st = fs.statSync(path.join(dir, f));
          const ts = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : st.mtime.toISOString();
          return { file: f, ts, reason: m?.[6] ?? 'unknown', bytes: st.size };
        })
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  // ---- inventory ------------------------------------------------------------------------

  async status(deep = false): Promise<Result<unknown>> {
    this.caps.require('openclaw.status');
    return timed(async () => {
      const r = await this.cli(['status', '--json', ...(deep ? ['--deep'] : []), '--timeout', '20000'], { timeoutMs: 35000 });
      return 'error' in r ? r : r.json;
    });
  }

  async sessions(): Promise<Result<{ sessions: Array<Record<string, unknown>>; total: number | null; activeKeys: string[]; hasMore: boolean }>> {
    this.caps.require('openclaw.sessions');
    return timed(async () => {
      const [all, active] = await Promise.all([
        this.cli(['sessions', '--all-agents', '--json', '--limit', '200']),
        this.cli(['sessions', '--all-agents', '--json', '--active', '30', '--limit', 'all']),
      ]);
      if ('error' in all) return all;
      const rows = findArray(all.json, ['sessions']).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
      const activeKeys = 'error' in active ? [] : findArray(active.json, ['sessions']).map((x) => String(pick(x, ['key']) ?? '')).filter(Boolean);
      const total = pick(all.json, ['totalCount', 'count']);
      return {
        sessions: rows.map((r) => ({ ...r, _updatedAt: toIso(pick(r, ['updatedAt', 'lastActivityAt', 'updated', 'lastMessageAt'])) })),
        total: typeof total === 'number' ? total : null,
        activeKeys,
        hasMore: pick(all.json, ['hasMore']) === true,
      };
    });
  }

  /** Transcript tail: private data. The route requires an elevated operator session and audits the read. */
  async sessionTail(key: string, agent: string | undefined, lines: number): Promise<Result<{ text: string }>> {
    this.caps.require('openclaw.sessions.tail');
    if (!SAFE_ID.test(key) || (agent && !SAFE_ID.test(agent))) return { ok: false, error: { code: 'bad_input', message: 'Invalid session key or agent id' }, ms: 0 };
    const n = Math.max(1, Math.min(Math.trunc(lines) || 40, 200));
    return timed(async () => {
      const r = await this.cli(['sessions', 'tail', '--session-key', key, '--tail', String(n), ...(agent ? ['--agent', agent] : [])], { json: false });
      return 'error' in r ? r : { text: String('text' in r ? r.text : '').slice(0, 200_000) };
    });
  }

  /** Agents: CLI list merged with the verified fields from openclaw.json. */
  async agents(): Promise<Result<{ defaultModel: string | null; agents: Array<Record<string, unknown>>; source: string[] }>> {
    return timed(async () => {
      const conf = this.readRawConfig();
      const entries = (conf?.agents?.entries ?? {}) as Record<string, any>;
      const defaults = (conf?.agents?.defaults ?? {}) as Record<string, any>;
      const source: string[] = conf ? ['openclaw.json'] : [];
      let cliRows: Array<Record<string, unknown>> = [];
      if (this.caps.get('openclaw.agents').supported) {
        const r = await this.cli(['agents', 'list', '--json', '--bindings']);
        if (!('error' in r)) {
          cliRows = findArray(r.json, ['agents', 'entries']).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
          source.push('openclaw agents list');
        }
      }
      const ids = new Set<string>([...Object.keys(entries), ...cliRows.map((r) => String(pick(r, ['id', 'agentId', 'name']) ?? '')).filter(Boolean)]);
      const agents = [...ids].map((id) => {
        const c = entries[id] ?? {};
        const row = cliRows.find((r) => String(pick(r, ['id', 'agentId', 'name'])) === id) ?? {};
        return {
          id,
          name: c.name ?? pick(row, ['name']) ?? id,
          identity: c.identity ?? pick(row, ['identity']) ?? null,
          workspace: c.workspace ?? pick(row, ['workspace']) ?? defaults.workspace ?? null,
          model: c.model ?? pick(row, ['model']) ?? defaults.model ?? null,
          modelIsDefault: !c.model && !pick(row, ['model']),
          isDefault: pick(row, ['isDefault']) === true || defaults.systemAgent?.agentId === id,
          isSystemAgent: defaults.systemAgent?.agentId === id,
          isHeartbeat: defaults.heartbeat?.agentId === id,
          subagents: c.subagents ?? null,
          bindings: redactDeep(pick(row, ['bindings', 'routes']) ?? null),
          inCli: cliRows.length ? cliRows.some((r) => String(pick(r, ['id', 'agentId', 'name'])) === id) : null,
        };
      });
      return { defaultModel: typeof defaults.model === 'string' ? defaults.model : null, agents, source };
    });
  }

  async cron(): Promise<Result<{ jobs: Array<Record<string, unknown>>; status: unknown }>> {
    this.caps.require('openclaw.cron');
    return timed(async () => {
      const [list, st] = await Promise.all([this.cli(['cron', 'list', '--all', '--json']), this.cli(['cron', 'status', '--json'])]);
      if ('error' in list) return list;
      const jobs = findArray(list.json, ['jobs', 'items', 'automations']).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
      return { jobs, status: 'error' in st ? null : st.json };
    });
  }

  async cronRuns(jobId: string, limit = 30): Promise<Result<unknown>> {
    this.caps.require('openclaw.cron');
    if (!SAFE_ID.test(jobId)) return { ok: false, error: { code: 'bad_input', message: 'Invalid job id' }, ms: 0 };
    return timed(async () => {
      const r = await this.cli(['cron', 'runs', jobId, '--limit', String(Math.min(limit, 100)), '--json']);
      return 'error' in r ? r : r.json;
    });
  }

  async channels(probe: boolean): Promise<Result<unknown>> {
    this.caps.require('openclaw.channels');
    return timed(async () => {
      const r = await this.cli(['channels', 'status', '--json', ...(probe ? ['--probe', '--timeout', '15000'] : [])], { timeoutMs: probe ? 30000 : 20000 });
      return 'error' in r ? r : r.json;
    });
  }

  async models(): Promise<Result<unknown>> {
    this.caps.require('openclaw.models');
    return timed(async () => {
      const r = await this.cli(['models', 'status', '--json']);
      return 'error' in r ? r : r.json;
    });
  }

  async logs(): Promise<Result<{ lines: Array<{ ts: string | null; level: string; message: string; raw?: unknown }>; partial: boolean }>> {
    this.caps.require('openclaw.logs');
    return timed(async () => {
      // `logs` tails; take what arrives within the window, then stop it.
      const r = await run(this.cfg.openclawBin, ['logs', '--json'], { timeoutMs: 6000, keepPartialOnTimeout: true, maxBytes: 2 * 1024 * 1024 });
      if (r.spawnError) return fail('cli_missing', r.spawnError);
      if (!r.ok && !r.stdout) return fail('cli_failed', redactString(r.stderr).slice(0, 300) || 'openclaw logs failed');
      const lines = r.stdout
        .split('\n')
        .filter(Boolean)
        .slice(-500)
        .map((l) => {
          const j = parseJsonLoose(l) as Record<string, unknown> | undefined;
          if (j && typeof j === 'object') {
            const level = String(pick(j, ['level', 'severity', 'lvl']) ?? 'info').toLowerCase();
            const msg = String(pick(j, ['message', 'msg', 'text']) ?? JSON.stringify(j));
            return { ts: toIso(pick(j, ['time', 'ts', 'timestamp', 'at'])), level, message: redactString(msg).slice(0, 1000) };
          }
          return { ts: null, level: /error|fail/i.test(l) ? 'error' : /warn/i.test(l) ? 'warn' : 'info', message: redactString(l).slice(0, 1000) };
        });
      return { lines, partial: r.timedOut };
    });
  }

  async validateConfig(): Promise<Result<{ valid: boolean; detail: unknown }>> {
    this.caps.require('openclaw.config.validate');
    return timed(async () => {
      const r = await run(this.cfg.openclawBin, ['config', 'validate', '--json'], { timeoutMs: 20000 });
      if (r.spawnError) return fail('cli_missing', r.spawnError);
      const parsed = parseJsonLoose(r.stdout);
      const flagged = findDeep(parsed, (o) => 'valid' in o || 'ok' in o);
      const valid = r.ok && (flagged ? (flagged.valid ?? flagged.ok) !== false : true);
      return { valid, detail: redactDeep(parsed ?? { stdout: r.stdout.slice(0, 500), stderr: r.stderr.slice(0, 500) }) };
    });
  }

  async securityAudit(): Promise<Result<unknown>> {
    this.caps.require('openclaw.security.audit');
    return timed(async () => {
      const r = await this.cli(['security', 'audit', '--json'], { timeoutMs: 60000 });
      return 'error' in r ? r : r.json;
    });
  }

  async devices(): Promise<Result<unknown>> {
    this.caps.require('openclaw.devices');
    return timed(async () => {
      const r = await this.cli(['devices', 'list', '--json']);
      return 'error' in r ? r : r.json;
    });
  }

  /** Active model per the config, split into provider / model id. */
  configuredModel(): { raw: string | null; provider: string | null; modelId: string | null } {
    const raw = this.readRawConfig()?.agents?.defaults?.model;
    if (typeof raw !== 'string') return { raw: null, provider: null, modelId: null };
    const i = raw.indexOf('/');
    return i < 0 ? { raw, provider: null, modelId: raw } : { raw, provider: raw.slice(0, i), modelId: raw.slice(i + 1) };
  }

  /** Provider base URLs declared in config (used to locate the inference server). */
  providerBaseUrls(): Array<{ provider: string; baseUrl: string; api: string | null; models: string[] }> {
    const providers = (this.readRawConfig()?.models?.providers ?? {}) as Record<string, any>;
    return Object.entries(providers)
      .filter(([, v]) => typeof v?.baseUrl === 'string')
      .map(([provider, v]) => ({ provider, baseUrl: String(v.baseUrl), api: typeof v.api === 'string' ? v.api : null, models: asArray(v.models).map((m) => String(pick(m, ['id']) ?? '')).filter(Boolean) }));
  }

  telegramConfig(): { configured: boolean; enabled: boolean; hasToken: boolean; ownerIds: string[]; boundAgents: string[]; groupsRequireMention: boolean | null } {
    const c = this.readRawConfig() ?? {};
    const t = c.channels?.telegram ?? {};
    const owners = asArray(c.commands?.ownerAllowFrom).map(String).filter((s) => s.startsWith('telegram:')).map((s) => s.slice(9));
    const bound = asArray(c.bindings)
      .filter((b: any) => b?.match?.channel === 'telegram')
      .map((b: any) => String(b.agentId));
    return {
      configured: Boolean(c.channels?.telegram),
      enabled: t.enabled === true && c.plugins?.entries?.telegram?.enabled !== false,
      hasToken: typeof t.botToken === 'string' && t.botToken.length > 0,
      ownerIds: owners,
      boundAgents: [...new Set(bound)],
      groupsRequireMention: typeof t.groups?.['*']?.requireMention === 'boolean' ? t.groups['*'].requireMention : null,
    };
  }
}
