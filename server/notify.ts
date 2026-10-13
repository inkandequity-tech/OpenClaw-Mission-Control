import type { AppConfig } from './config.ts';
import type { Capabilities } from './capabilities.ts';
import type { OpenClaw } from './integrations/openclaw.ts';
import { run } from './exec.ts';
import { redactString } from './redact.ts';

/**
 * Outbound alerts through OpenClaw's own `message send` (so the bot token never touches this app).
 * Only enabled when the installed CLI's help lists --channel/--target/--message, and rate-limited.
 */
export class Notifier {
  private cfg: AppConfig;
  private caps: Capabilities;
  private oc: OpenClaw;
  private sent: number[] = [];

  constructor(cfg: AppConfig, caps: Capabilities, oc: OpenClaw) {
    this.cfg = cfg;
    this.caps = caps;
    this.oc = oc;
  }

  available(): { ok: boolean; reason: string } {
    const c = this.caps.get('openclaw.message.send');
    if (!c.supported) return { ok: false, reason: c.reason };
    const t = this.oc.telegramConfig();
    if (!t.enabled) return { ok: false, reason: 'Telegram is not enabled in OpenClaw config' };
    if (!t.ownerIds.length) return { ok: false, reason: 'No Telegram owner id in commands.ownerAllowFrom to send to' };
    return { ok: true, reason: 'Ready' };
  }

  async send(text: string): Promise<{ ok: boolean; detail: string }> {
    const a = this.available();
    if (!a.ok) return { ok: false, detail: a.reason };
    const now = Date.now();
    this.sent = this.sent.filter((t) => now - t < 3600_000);
    if (this.sent.length >= 10) return { ok: false, detail: 'Rate limit: 10 alerts per hour' };
    this.sent.push(now);
    const owner = this.oc.telegramConfig().ownerIds[0]!;
    const r = await run(this.cfg.openclawBin, ['message', 'send', '--channel', 'telegram', '--target', owner, '--message', redactString(text).slice(0, 800)], { timeoutMs: 30000 });
    return { ok: r.ok, detail: r.ok ? 'Accepted by the OpenClaw CLI (delivery to Telegram not independently confirmed)' : redactString(r.stderr || r.spawnError || 'send failed').slice(0, 300) };
  }
}
