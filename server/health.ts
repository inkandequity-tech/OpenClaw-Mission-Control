import type { Db } from './db.ts';
import { kvGet, kvSet } from './db.ts';
import type { Events } from './events.ts';
import type { Notifier } from './notify.ts';
import type { OpenClaw } from './integrations/openclaw.ts';
import type { Tailscale } from './integrations/tailscale.ts';
import type { Inference } from './integrations/inference.ts';
import type { Telemetry } from './integrations/telemetry.ts';
import type { Capabilities } from './capabilities.ts';
import type { CheckStatus, EventSource, HealthCheck } from './types.ts';
import { AppError } from './types.ts';
import { findDeep } from './util.ts';

export interface MonitorSettings {
  diskWarn: number; diskCrit: number;
  memWarn: number; memCrit: number;
  vramWarn: number; vramCrit: number;
  gpuTempWarn: number; gpuTempCrit: number;
  /** Consecutive bad results before an alert fires (de-flaps transient failures). */
  failuresBeforeAlert: number;
  /** Minutes before the same ongoing problem alerts again. */
  cooldownMin: number;
  telegramAlerts: boolean;
}

export const DEFAULT_SETTINGS: MonitorSettings = {
  diskWarn: 85, diskCrit: 95, memWarn: 88, memCrit: 96, vramWarn: 92, vramCrit: 98,
  gpuTempWarn: 80, gpuTempCrit: 88, failuresBeforeAlert: 2, cooldownMin: 30, telegramAlerts: false,
};

export function validateSettings(raw: unknown): MonitorSettings {
  if (!raw || typeof raw !== 'object') throw new AppError(400, 'bad_input', 'Settings must be an object');
  const r = raw as Record<string, unknown>;
  const out: MonitorSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof MonitorSettings>) {
    if (!(key in r)) continue;
    const v = r[key];
    if (key === 'telegramAlerts') {
      if (typeof v !== 'boolean') throw new AppError(400, 'bad_input', 'telegramAlerts must be true/false');
      out.telegramAlerts = v;
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 200) throw new AppError(400, 'bad_input', `${key} must be a number between 1 and 200`);
      (out as unknown as Record<string, number>)[key] = v;
    }
  }
  if (out.diskWarn >= out.diskCrit || out.memWarn >= out.memCrit || out.vramWarn >= out.vramCrit || out.gpuTempWarn >= out.gpuTempCrit) {
    throw new AppError(400, 'bad_input', 'Each warning threshold must be below its critical threshold');
  }
  return out;
}

interface CheckState {
  status: CheckStatus;
  consecutive: number;
  alertedStatus: CheckStatus | null;
  lastAlertAt: number;
}

interface MonitorDeps {
  db: Db; events: Events; notifier: Notifier; oc: OpenClaw; ts: Tailscale; inf: Inference; tel: Telemetry; caps: Capabilities;
}

const SOURCE: Record<string, EventSource> = {
  gateway: 'openclaw', inference: 'model', tailscale: 'network', telegram: 'telegram', 'mac.disk': 'system', 'mac.memory': 'system',
  'win.vram': 'model', 'win.gpu-temp': 'model', 'win.reporter': 'system',
};

/**
 * Proactive health monitor: runs checks on a timer, compares them to configurable thresholds,
 * de-duplicates alerts (consecutive-failure gate + cooldown + recovery notice) and optionally
 * forwards them to Telegram through OpenClaw.
 */
export class Monitor {
  private d: MonitorDeps;
  private state = new Map<string, CheckState>();
  private timer: NodeJS.Timeout | null = null;
  private telegramCache: { at: number; check: HealthCheck } | null = null;
  checks: HealthCheck[] = [];
  lastRun: string | null = null;
  private running = false;

  constructor(deps: MonitorDeps) {
    this.d = deps;
  }

  settings(): MonitorSettings {
    return { ...DEFAULT_SETTINGS, ...kvGet<Partial<MonitorSettings>>(this.d.db, 'monitor.settings', {}) };
  }

  saveSettings(s: MonitorSettings): void {
    kvSet(this.d.db, 'monitor.settings', s);
  }

  start(intervalMs: number): void {
    setTimeout(() => void this.runOnce(), 1500).unref();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  overall(): CheckStatus {
    if (this.checks.some((c) => c.status === 'crit')) return 'crit';
    if (this.checks.some((c) => c.status === 'warn')) return 'warn';
    if (this.checks.length && this.checks.every((c) => c.status === 'unknown')) return 'unknown';
    return this.checks.length ? 'ok' : 'unknown';
  }

  private chk(id: string, label: string, status: CheckStatus, message: string, value: HealthCheck['value'] = null): HealthCheck {
    return { id, label, status, message, value, at: new Date().toISOString() };
  }

  private level(value: number, warn: number, crit: number): CheckStatus {
    return value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok';
  }

  async runOnce(): Promise<HealthCheck[]> {
    if (this.running) return this.checks;
    this.running = true;
    try {
      const s = this.settings();
      const out: HealthCheck[] = [];
      const { oc, ts, inf, tel, caps } = this.d;

      const gw = await oc.gatewayHttp();
      if (!gw.ok) out.push(this.chk('gateway', 'OpenClaw gateway', 'unknown', gw.error.message));
      else if (!gw.data.live) out.push(this.chk('gateway', 'OpenClaw gateway', 'crit', `No /healthz response on port ${gw.data.port} (tried ${gw.data.attempts.map((a) => a.host).join(', ')})`));
      else if (gw.data.ready === false) out.push(this.chk('gateway', 'OpenClaw gateway', 'warn', `Alive but /readyz returned ${gw.data.readyzStatus} (still starting or degraded)`));
      else out.push(this.chk('gateway', 'OpenClaw gateway', 'ok', `Live and ready via ${gw.data.host}:${gw.data.port}`));

      const tsStat = await ts.status(0);
      if (!caps.get('tailscale.cli').supported) out.push(this.chk('tailscale', 'Tailscale', 'unknown', caps.get('tailscale.cli').reason));
      else if (!tsStat.ok) out.push(this.chk('tailscale', 'Tailscale', 'crit', tsStat.error.message));
      else if (tsStat.data.backendState !== 'Running') out.push(this.chk('tailscale', 'Tailscale', 'crit', `Backend state: ${tsStat.data.backendState}`));
      else out.push(this.chk('tailscale', 'Tailscale', 'ok', `Running, ${tsStat.data.peers.filter((p) => p.online).length}/${tsStat.data.peers.length} peers online`));

      const det = await inf.detect();
      if (!det.ok) out.push(this.chk('inference', 'Inference server', det.error.code === 'no_target' ? 'unknown' : 'crit', det.error.message));
      else {
        const want = this.d.oc.configuredModel().modelId;
        const m = want ? det.data.models.find((x) => x.id === want) : undefined;
        if (want && !m) out.push(this.chk('inference', 'Inference server', 'warn', `Up (${det.data.kind}) but OpenClaw's model "${want}" is not on it`));
        else out.push(this.chk('inference', 'Inference server', 'ok', `${det.data.kind} up, ${det.data.models.filter((x) => x.loaded).length} loaded / ${det.data.models.length} models`));
      }

      out.push(await this.telegram());

      const mac = tel.mac.at(-1);
      if (mac?.diskPercent != null) out.push(this.chk('mac.disk', 'Mac disk', this.level(mac.diskPercent, s.diskWarn, s.diskCrit), `${mac.diskPercent}% used`, mac.diskPercent));
      if (mac?.memPercent != null) out.push(this.chk('mac.memory', 'Mac memory', this.level(mac.memPercent, s.memWarn, s.memCrit), `${mac.memPercent}% used`, mac.memPercent));

      if (caps.get('windows.telemetry').supported) {
        const w = tel.win.at(-1);
        const g = w?.gpus[0];
        if (g?.memUsedMiB != null && g.memTotalMiB) {
          const pct = Math.round((g.memUsedMiB / g.memTotalMiB) * 1000) / 10;
          out.push(this.chk('win.vram', 'GPU VRAM', this.level(pct, s.vramWarn, s.vramCrit), `${g.memUsedMiB}/${g.memTotalMiB} MiB (${pct}%)`, pct));
        }
        if (g?.tempC != null) out.push(this.chk('win.gpu-temp', 'GPU temperature', this.level(g.tempC, s.gpuTempWarn, s.gpuTempCrit), `${g.tempC} °C`, g.tempC));
      } else if (this.d.tel.win.length === 0 && caps.get('windows.telemetry').reason.includes('unreachable')) {
        out.push(this.chk('win.reporter', 'Windows telemetry', 'warn', caps.get('windows.telemetry').reason));
      }

      this.checks = out;
      this.lastRun = new Date().toISOString();
      for (const c of out) await this.transition(c, s);
      return out;
    } finally {
      this.running = false;
    }
  }

  /** Telegram is probed live at most every 5 minutes (the probe talks to Telegram's API). */
  private async telegram(): Promise<HealthCheck> {
    if (this.telegramCache && Date.now() - this.telegramCache.at < 5 * 60_000) return { ...this.telegramCache.check, at: new Date().toISOString() };
    const cfg = this.d.oc.telegramConfig();
    let check: HealthCheck;
    if (!cfg.configured || !cfg.enabled) check = this.chk('telegram', 'Telegram', 'unknown', cfg.configured ? 'Telegram is disabled in OpenClaw config' : 'Telegram is not configured');
    else if (!cfg.hasToken) check = this.chk('telegram', 'Telegram', 'crit', 'Telegram is enabled but has no bot token in config');
    else if (!this.d.caps.get('openclaw.channels').supported) check = this.chk('telegram', 'Telegram', 'unknown', 'Configured; live status needs `openclaw channels status` (not available)');
    else {
      const r = await this.d.oc.channels(true);
      if (!r.ok) check = this.chk('telegram', 'Telegram', 'warn', `Configured, but the live probe failed: ${r.error.message}`);
      else {
        const t = findDeep(r.data, (o, k) => k === 'telegram' || o.channel === 'telegram' || o.id === 'telegram');
        const bad = t && (t.running === false || t.lifecycle === 'blocked' || (t.probe as any)?.ok === false || t.connected === false || typeof t.lastError === 'string' && t.lastError.length > 0);
        if (!t) check = this.chk('telegram', 'Telegram', 'unknown', 'channels status returned no Telegram entry');
        else if (bad) check = this.chk('telegram', 'Telegram', 'crit', `Probe reports a problem${typeof t.lastError === 'string' ? `: ${t.lastError}` : ''}`);
        else check = this.chk('telegram', 'Telegram', 'ok', 'Configured; live probe reports no problem');
      }
    }
    this.telegramCache = { at: Date.now(), check };
    return check;
  }

  private async transition(c: HealthCheck, s: MonitorSettings): Promise<void> {
    const st = this.state.get(c.id) ?? { status: 'unknown' as CheckStatus, consecutive: 0, alertedStatus: null, lastAlertAt: 0 };
    st.consecutive = st.status === c.status ? st.consecutive + 1 : 1;
    st.status = c.status;
    const bad = c.status === 'warn' || c.status === 'crit';
    const source = SOURCE[c.id] ?? 'system';
    if (bad && st.consecutive >= s.failuresBeforeAlert) {
      const due = st.alertedStatus !== c.status || Date.now() - st.lastAlertAt > s.cooldownMin * 60_000;
      if (due) {
        st.alertedStatus = c.status;
        st.lastAlertAt = Date.now();
        this.d.events.add({ source, severity: c.status === 'crit' ? 'error' : 'warn', type: `health.${c.id}.${c.status}`, message: `${c.label}: ${c.message}`, data: { check: c.id, value: c.value } });
        if (s.telegramAlerts) {
          const r = await this.d.notifier.send(`[Mission Control] ${c.status.toUpperCase()} ${c.label}: ${c.message}`);
          if (!r.ok) this.d.events.add({ source: 'telegram', severity: 'warn', type: 'alert.delivery_failed', message: `Could not send Telegram alert: ${r.detail}` });
        }
      }
    } else if (!bad && st.alertedStatus && c.status === 'ok') {
      st.alertedStatus = null;
      this.d.events.add({ source, severity: 'info', type: `health.${c.id}.recovered`, message: `${c.label} recovered: ${c.message}`, data: { check: c.id } });
      if (s.telegramAlerts) await this.d.notifier.send(`[Mission Control] RECOVERED ${c.label}: ${c.message}`);
    }
    this.state.set(c.id, st);
  }
}
