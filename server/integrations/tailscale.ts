import type { AppConfig } from '../config.ts';
import type { Capabilities } from '../capabilities.ts';
import type { Result } from '../types.ts';
import { parseJsonLoose, run } from '../exec.ts';
import { redactString } from '../redact.ts';
import { asArray, fail, findDeep, timed } from '../util.ts';

export interface TailnetPeer {
  host: string;
  dns: string;
  ips: string[];
  os: string;
  online: boolean;
  active: boolean;
  lastSeen: string | null;
  path: string | null; // 'direct' | 'relay:<name>' | null
  isSelf: boolean;
}

export interface TailnetStatus {
  backendState: string;
  version: string | null;
  health: string[];
  magicDnsSuffix: string | null;
  self: TailnetPeer | null;
  peers: TailnetPeer[];
  needsLogin: boolean;
}

function peerOf(p: any, isSelf: boolean): TailnetPeer {
  const dns = String(p?.DNSName ?? '').replace(/\.$/, '');
  return {
    host: String(p?.HostName ?? ''),
    dns,
    ips: asArray(p?.TailscaleIPs).map(String),
    os: String(p?.OS ?? ''),
    online: p?.Online === true,
    active: p?.Active === true,
    lastSeen: p?.LastSeen && !String(p.LastSeen).startsWith('0001') ? String(p.LastSeen) : null,
    path: p?.CurAddr ? 'direct' : p?.Relay ? `relay:${p.Relay}` : null,
    isSelf,
  };
}

/** Reads `tailscale status --json` through an allowlist of fields: auth URLs and keys are never copied. */
export class Tailscale {
  private cfg: AppConfig;
  private caps: Capabilities;
  private cache: { at: number; value: Result<TailnetStatus> } | null = null;

  constructor(cfg: AppConfig, caps: Capabilities) {
    this.cfg = cfg;
    this.caps = caps;
  }

  async status(maxAgeMs = 5000): Promise<Result<TailnetStatus>> {
    if (this.cache && Date.now() - this.cache.at < maxAgeMs) return this.cache.value;
    const value = await timed<TailnetStatus>(async () => {
      const r = await run(this.cfg.tailscaleBin, ['status', '--json'], { timeoutMs: 10000 });
      if (r.spawnError) return fail('cli_missing', r.spawnError, 'Install Tailscale (and its CLI) or set TAILSCALE_BIN.');
      const j = parseJsonLoose(r.stdout) as any;
      if (!j) return fail('tailscale_down', redactString(r.stderr || r.stdout).slice(0, 300) || 'tailscale status returned nothing', 'Is the Tailscale app running and signed in?');
      const backend = String(j.BackendState ?? 'Unknown');
      return {
        backendState: backend,
        version: typeof j.Version === 'string' ? j.Version : null,
        health: asArray(j.Health).map((h) => redactString(String(h))),
        magicDnsSuffix: typeof j.MagicDNSSuffix === 'string' ? j.MagicDNSSuffix : null,
        self: j.Self ? peerOf(j.Self, true) : null,
        peers: Object.values((j.Peer ?? {}) as Record<string, unknown>).map((p) => peerOf(p, false)),
        needsLogin: backend === 'NeedsLogin' || backend === 'NeedsMachineAuth',
      };
    });
    this.cache = { at: Date.now(), value };
    return value;
  }

  selfIps(): string[] {
    return this.cache?.value.ok ? this.cache.value.data.self?.ips ?? [] : [];
  }

  selfDns(): string | null {
    return this.cache?.value.ok ? this.cache.value.data.self?.dns || null : null;
  }

  findPeerByIp(st: TailnetStatus, ip: string): TailnetPeer | undefined {
    return [...(st.self ? [st.self] : []), ...st.peers].find((p) => p.ips.includes(ip));
  }

  async ping(target: string): Promise<{ ok: boolean; detail: string; ms: number }> {
    if (!/^[A-Za-z0-9.:-]{1,100}$/.test(target)) return { ok: false, detail: 'invalid target', ms: 0 };
    if (!this.caps.get('tailscale.ping').supported) return { ok: false, detail: this.caps.get('tailscale.ping').reason, ms: 0 };
    const r = await run(this.cfg.tailscaleBin, ['ping', '--c=1', '--timeout=4s', target], { timeoutMs: 10000 });
    const out = redactString(`${r.stdout} ${r.stderr}`.trim()).slice(0, 300);
    return { ok: r.ok && /pong from/i.test(out), detail: out, ms: r.ms };
  }

  /** `tailscale serve status --json`, plus a Funnel (public exposure) flag. */
  async serveStatus(): Promise<Result<{ raw: unknown; funnel: boolean; configured: boolean }>> {
    return timed(async () => {
      this.caps.require('tailscale.serve');
      const r = await run(this.cfg.tailscaleBin, ['serve', 'status', '--json'], { timeoutMs: 10000 });
      if (r.spawnError) return fail('cli_missing', r.spawnError);
      const j = parseJsonLoose(r.stdout) ?? {};
      const funnelHit = findDeep(j, (o, k) => k === 'AllowFunnel' && Object.values(o).some((v) => v === true));
      return { raw: j, funnel: Boolean(funnelHit), configured: Object.keys(j as object).length > 0 };
    });
  }

  async serveEnable(port: number, httpsPort: number): Promise<{ ok: boolean; detail: string }> {
    this.caps.require('tailscale.serve');
    const r = await run(this.cfg.tailscaleBin, ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${port}`], { timeoutMs: 20000 });
    return { ok: r.ok, detail: redactString(`${r.stdout} ${r.stderr}`).trim().slice(0, 500) };
  }

  async serveDisable(httpsPort: number): Promise<{ ok: boolean; detail: string }> {
    this.caps.require('tailscale.serve');
    const r = await run(this.cfg.tailscaleBin, ['serve', `--https=${httpsPort}`, 'off'], { timeoutMs: 20000 });
    return { ok: r.ok, detail: redactString(`${r.stdout} ${r.stderr}`).trim().slice(0, 500) };
  }
}
