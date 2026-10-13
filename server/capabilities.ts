import type { AppConfig } from './config.ts';
import type { Capability } from './types.ts';
import { AppError } from './types.ts';
import { run } from './exec.ts';

/**
 * Capability discovery. A feature is switched on only when evidence from the *installed* tools
 * says it exists (their --help output, a live API probe, or configuration). Nothing is assumed
 * from documentation alone, and nothing is simulated when evidence is missing.
 */

interface HelpCap {
  id: string;
  help: string[];
  /** Words (subcommands) or --flags that must appear in the help text. */
  needs: string[];
  title: string;
}

const OPENCLAW: HelpCap[] = [
  { id: 'openclaw.gateway.health', help: ['gateway', '--help'], needs: ['health'], title: 'Gateway health query' },
  { id: 'openclaw.gateway.status', help: ['gateway', '--help'], needs: ['status'], title: 'Gateway status query' },
  { id: 'openclaw.gateway.restart', help: ['gateway', '--help'], needs: ['restart'], title: 'Gateway restart' },
  { id: 'openclaw.status', help: ['status', '--help'], needs: ['--json'], title: 'Status report' },
  { id: 'openclaw.sessions', help: ['sessions', '--help'], needs: ['--json', '--all-agents'], title: 'Session listing' },
  { id: 'openclaw.sessions.tail', help: ['sessions', '--help'], needs: ['tail'], title: 'Session transcript tail' },
  { id: 'openclaw.agents', help: ['agents', '--help'], needs: ['list'], title: 'Agent listing' },
  { id: 'openclaw.cron', help: ['cron', '--help'], needs: ['list'], title: 'Scheduled jobs listing' },
  { id: 'openclaw.cron.manage', help: ['cron', '--help'], needs: ['enable', 'disable', 'run'], title: 'Scheduled job enable/disable/run' },
  { id: 'openclaw.cron.create', help: ['cron', '--help'], needs: ['create'], title: 'Scheduled job creation' },
  { id: 'openclaw.channels', help: ['channels', '--help'], needs: ['status'], title: 'Channel status' },
  { id: 'openclaw.models', help: ['models', '--help'], needs: ['status'], title: 'Model status' },
  { id: 'openclaw.logs', help: ['logs', '--help'], needs: ['--json'], title: 'Gateway logs' },
  { id: 'openclaw.config.validate', help: ['config', '--help'], needs: ['validate'], title: 'Config validation' },
  { id: 'openclaw.config.set', help: ['config', '--help'], needs: ['set'], title: 'Config set' },
  { id: 'openclaw.security.audit', help: ['security', '--help'], needs: ['audit'], title: 'Security audit' },
  { id: 'openclaw.devices', help: ['devices', '--help'], needs: ['list'], title: 'Paired devices' },
  { id: 'openclaw.message.send', help: ['message', 'send', '--help'], needs: ['--channel', '--target', '--message'], title: 'Outbound message (Telegram alerts)' },
];

const TAILSCALE: HelpCap[] = [
  { id: 'tailscale.serve', help: ['serve', '--help'], needs: ['--bg'], title: 'Tailscale Serve' },
  { id: 'tailscale.ping', help: ['ping', '--help'], needs: ['--timeout'], title: 'Tailscale ping' },
];

function helpHas(text: string, needle: string): boolean {
  if (needle.startsWith('-')) return text.includes(needle);
  return new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|\\[|<|,|\\||$)`, 'm').test(text);
}

export class Capabilities {
  private cfg: AppConfig;
  private map = new Map<string, Capability>();
  private lastRun = 0;
  private inflight: Promise<void> | null = null;
  openclawVersion: string | null = null;
  tailscaleVersion: string | null = null;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
  }

  set(id: string, supported: boolean, reason: string): void {
    this.map.set(id, { id, supported, reason, checkedAt: new Date().toISOString() });
  }

  get(id: string): Capability {
    return this.map.get(id) ?? { id, supported: false, reason: 'Not yet discovered', checkedAt: '' };
  }

  list(): Capability[] {
    return [...this.map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Throws a 501 with the discovery reason when a feature is unavailable. */
  require(id: string): void {
    const c = this.get(id);
    if (!c.supported) throw new AppError(501, 'unsupported', `Not available: ${c.reason}`, `Capability ${id}`);
  }

  async discover(force = false): Promise<Capability[]> {
    if (!force && Date.now() - this.lastRun < 10 * 60_000 && this.map.size) return this.list();
    if (this.inflight) {
      await this.inflight;
      return this.list();
    }
    this.inflight = this.doDiscover().finally(() => {
      this.inflight = null;
      this.lastRun = Date.now();
    });
    await this.inflight;
    return this.list();
  }

  private async helpText(bin: string, argv: string[]): Promise<{ text: string; err?: string }> {
    const r = await run(bin, argv, { timeoutMs: 15000, maxBytes: 512 * 1024 });
    if (r.spawnError) return { text: '', err: r.spawnError };
    const text = `${r.stdout}\n${r.stderr}`;
    if (!r.ok && text.trim().length < 20) return { text: '', err: `exit ${r.code ?? 'n/a'}${r.timedOut ? ' (timed out)' : ''}` };
    return { text };
  }

  private async doDiscover(): Promise<void> {
    const ver = await run(this.cfg.openclawBin, ['--version'], { timeoutMs: 15000 });
    if (ver.spawnError || !ver.ok) {
      this.openclawVersion = null;
      this.set('openclaw.cli', false, ver.spawnError ?? `openclaw --version failed (exit ${ver.code})`);
      for (const c of OPENCLAW) this.set(c.id, false, 'OpenClaw CLI not found or not runnable');
    } else {
      this.openclawVersion = ver.stdout.trim().split('\n').pop()?.trim() ?? null;
      this.set('openclaw.cli', true, `OpenClaw ${this.openclawVersion}`);
      await this.evalHelp(this.cfg.openclawBin, OPENCLAW);
    }

    const tv = await run(this.cfg.tailscaleBin, ['version'], { timeoutMs: 10000 });
    if (tv.spawnError || !tv.ok) {
      this.tailscaleVersion = null;
      this.set('tailscale.cli', false, tv.spawnError ?? `tailscale version failed (exit ${tv.code})`);
      for (const c of TAILSCALE) this.set(c.id, false, 'Tailscale CLI not found or not runnable');
    } else {
      this.tailscaleVersion = tv.stdout.trim().split('\n')[0] ?? null;
      this.set('tailscale.cli', true, `Tailscale ${this.tailscaleVersion}`);
      await this.evalHelp(this.cfg.tailscaleBin, TAILSCALE);
    }
  }

  private async evalHelp(bin: string, caps: HelpCap[]): Promise<void> {
    const cache = new Map<string, Promise<{ text: string; err?: string }>>();
    await Promise.all(
      caps.map(async (c) => {
        const key = c.help.join(' ');
        if (!cache.has(key)) cache.set(key, this.helpText(bin, c.help));
        const { text, err } = await cache.get(key)!;
        if (err) return this.set(c.id, false, `${c.title}: help for "${key}" failed (${err})`);
        const missing = c.needs.filter((n) => !helpHas(text, n));
        if (missing.length) this.set(c.id, false, `${c.title}: installed CLI help does not list ${missing.join(', ')}`);
        else this.set(c.id, true, `${c.title}: found in "${bin.split('/').pop()} ${key}"`);
      }),
    );
  }
}
