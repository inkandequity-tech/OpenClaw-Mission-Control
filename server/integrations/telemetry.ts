import fs from 'node:fs';
import os from 'node:os';
import type { AppConfig } from '../config.ts';
import type { Capabilities } from '../capabilities.ts';
import type { Result } from '../types.ts';
import { run } from '../exec.ts';
import { fail, fetchJson, timed } from '../util.ts';

export interface MacSample {
  t: number;
  cpuPercent: number | null;
  memPercent: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number;
  diskPercent: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  load1: number;
}

export interface WinSample {
  t: number;
  host: string;
  cpuPercent: number | null;
  memPercent: number | null;
  gpus: Array<{ name: string; utilPercent: number | null; memUsedMiB: number | null; memTotalMiB: number | null; tempC: number | null; powerW: number | null }>;
  disks: Array<{ mount: string; totalBytes: number; freeBytes: number }>;
  nvidiaSmi: boolean;
}

const MAX_POINTS = 360;

export class Telemetry {
  private cfg: AppConfig;
  private caps: Capabilities;
  private prevCpu: os.CpuInfo[] | null = null;
  readonly mac: MacSample[] = [];
  readonly win: WinSample[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(cfg: AppConfig, caps: Capabilities) {
    this.cfg = cfg;
    this.caps = caps;
  }

  start(intervalMs = 5000): void {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private cpuPercent(): number | null {
    const cur = os.cpus();
    const prev = this.prevCpu;
    this.prevCpu = cur;
    if (!prev || prev.length !== cur.length) return null;
    let idle = 0;
    let total = 0;
    cur.forEach((c, i) => {
      const p = prev[i]!;
      const d = (k: keyof os.CpuInfo['times']) => c.times[k] - p.times[k];
      idle += d('idle');
      total += d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    });
    return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
  }

  private async memory(): Promise<{ used: number | null; total: number }> {
    const total = os.totalmem();
    if (process.platform === 'darwin') {
      const r = await run('vm_stat', [], { timeoutMs: 3000 });
      if (r.ok) {
        const ps = Number(/page size of (\d+) bytes/.exec(r.stdout)?.[1] ?? 4096);
        const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(r.stdout)?.[1] ?? 0);
        const available = (pages('free') + pages('inactive') + pages('speculative')) * ps;
        return { used: Math.max(0, total - available), total };
      }
    }
    return { used: total - os.freemem(), total };
  }

  private async disk(): Promise<{ used: number; total: number } | null> {
    const target = process.platform === 'darwin' && fs.existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';
    const r = await run('df', ['-k', target], { timeoutMs: 3000 });
    if (!r.ok) return null;
    const cols = r.stdout.trim().split('\n').pop()?.trim().split(/\s+/) ?? [];
    const total = Number(cols[1]) * 1024;
    const used = Number(cols[2]) * 1024;
    return Number.isFinite(total) && total > 0 ? { used, total } : null;
  }

  async sampleMac(): Promise<MacSample> {
    const [m, d] = await Promise.all([this.memory(), this.disk()]);
    const s: MacSample = {
      t: Date.now(),
      cpuPercent: this.cpuPercent(),
      memPercent: m.used != null ? Math.round((m.used / m.total) * 1000) / 10 : null,
      memUsedBytes: m.used,
      memTotalBytes: m.total,
      diskPercent: d ? Math.round((d.used / d.total) * 1000) / 10 : null,
      diskUsedBytes: d?.used ?? null,
      diskTotalBytes: d?.total ?? null,
      load1: os.loadavg()[0] ?? 0,
    };
    return s;
  }

  /**
   * Windows telemetry comes from the optional read-only reporter in tools/windows-telemetry-agent.mjs.
   * The inference server itself exposes no GPU/VRAM metrics, so without the reporter these stay
   * "unavailable" rather than being guessed.
   */
  async fetchWindows(): Promise<Result<WinSample>> {
    return timed(async () => {
      if (!this.cfg.windowsTelemetryUrl) return fail('not_configured', 'Windows telemetry reporter not configured', 'Run tools/windows-telemetry-agent.mjs on the Windows PC, then set MC_WINDOWS_TELEMETRY_URL and MC_WINDOWS_TELEMETRY_TOKEN.');
      const r = await fetchJson(`${this.cfg.windowsTelemetryUrl.replace(/\/+$/, '')}/metrics`, {
        headers: this.cfg.windowsTelemetryToken ? { authorization: `Bearer ${this.cfg.windowsTelemetryToken}` } : {},
        timeoutMs: 4000,
      });
      if (r.status === 0) return fail('unreachable', `Reporter unreachable (${r.error})`);
      if (r.status === 401 || r.status === 403) return fail('auth', 'Reporter rejected the token');
      const j = r.json as any;
      if (!r.ok || !j || j.schema !== 1) return fail('bad_response', `Unexpected reporter response (HTTP ${r.status})`);
      const memT = Number(j.memory?.totalBytes);
      const memU = Number(j.memory?.usedBytes);
      return {
        t: Date.now(),
        host: String(j.host ?? ''),
        cpuPercent: typeof j.cpu?.percent === 'number' ? j.cpu.percent : null,
        memPercent: memT > 0 ? Math.round((memU / memT) * 1000) / 10 : null,
        gpus: (Array.isArray(j.gpus) ? j.gpus : []).map((g: any) => ({
          name: String(g.name ?? 'GPU'),
          utilPercent: typeof g.utilPercent === 'number' ? g.utilPercent : null,
          memUsedMiB: typeof g.memUsedMiB === 'number' ? g.memUsedMiB : null,
          memTotalMiB: typeof g.memTotalMiB === 'number' ? g.memTotalMiB : null,
          tempC: typeof g.tempC === 'number' ? g.tempC : null,
          powerW: typeof g.powerW === 'number' ? g.powerW : null,
        })),
        disks: Array.isArray(j.disks) ? j.disks.map((d: any) => ({ mount: String(d.mount), totalBytes: Number(d.totalBytes), freeBytes: Number(d.freeBytes) })) : [],
        nvidiaSmi: j.nvidiaSmi === true,
      } satisfies WinSample;
    });
  }

  async sample(): Promise<void> {
    const m = await this.sampleMac();
    this.mac.push(m);
    if (this.mac.length > MAX_POINTS) this.mac.shift();
    if (this.cfg.windowsTelemetryUrl) {
      const w = await this.fetchWindows();
      if (w.ok) {
        this.win.push(w.data);
        if (this.win.length > MAX_POINTS) this.win.shift();
        this.caps.set('windows.telemetry', true, `Reporter at ${new URL(this.cfg.windowsTelemetryUrl).host}${w.data.nvidiaSmi ? ' (nvidia-smi OK)' : ' (no nvidia-smi: GPU metrics unavailable)'}`);
      } else {
        this.caps.set('windows.telemetry', false, w.error.message);
      }
    } else {
      this.caps.set('windows.telemetry', false, 'Reporter not configured: GPU/VRAM/CPU/RAM of the Windows PC cannot be read remotely without it');
    }
  }

  snapshot(): { mac: MacSample | null; macSeries: MacSample[]; windows: WinSample | null; windowsSeries: WinSample[]; windowsReason: string | null } {
    const cap = this.caps.get('windows.telemetry');
    return {
      mac: this.mac.at(-1) ?? null,
      macSeries: this.mac,
      windows: this.win.at(-1) ?? null,
      windowsSeries: this.win,
      windowsReason: cap.supported ? null : cap.reason,
    };
  }
}
