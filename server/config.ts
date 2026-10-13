import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  openclawHome: string;
  openclawBin: string;
  tailscaleBin: string;
  /** Extra Host header values accepted besides loopback and the auto-discovered Tailscale name. */
  allowedHosts: string[];
  /** Override for the inference server base URL (otherwise discovered from OpenClaw config). */
  inferenceUrl?: string;
  inferenceToken?: string;
  windowsTelemetryUrl?: string;
  windowsTelemetryToken?: string;
  /** Directories the workspace browser may read. */
  fileRoots: string[];
  cmdTimeoutMs: number;
  sessionTtlMs: number;
  elevationMs: number;
  monitorIntervalMs: number;
  /** How long to wait for the gateway after a restart (ms). */
  restartWaitMs: number;
  /** Multiplier for workflow retry back-off (tests use a small value). */
  retryScale: number;
  /** Disable background timers (tests). */
  background: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isPrivateBind(host: string): boolean {
  if (LOOPBACK.has(host)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (a === 100 && b >= 64 && b <= 127) || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const home = os.homedir();
  const openclawHome = env.OPENCLAW_HOME_DIR ?? path.join(home, '.openclaw');
  const cfg: AppConfig = {
    host: env.MC_HOST ?? '127.0.0.1',
    port: Number(env.MC_PORT ?? 7788),
    dataDir: env.MC_DATA_DIR ?? path.join(home, '.openclaw-mission-control'),
    openclawHome,
    openclawBin: env.OPENCLAW_BIN ?? 'openclaw',
    tailscaleBin: env.TAILSCALE_BIN ?? 'tailscale',
    allowedHosts: (env.MC_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    inferenceUrl: env.MC_INFERENCE_URL || undefined,
    inferenceToken: env.MC_INFERENCE_TOKEN || undefined,
    windowsTelemetryUrl: env.MC_WINDOWS_TELEMETRY_URL || undefined,
    windowsTelemetryToken: env.MC_WINDOWS_TELEMETRY_TOKEN || undefined,
    fileRoots: (env.MC_FILE_ROOTS ?? path.join(openclawHome, 'workspace')).split(path.delimiter).filter(Boolean),
    cmdTimeoutMs: Number(env.MC_CMD_TIMEOUT_MS ?? 30000),
    sessionTtlMs: Number(env.MC_SESSION_TTL_HOURS ?? 168) * 3600_000,
    elevationMs: Number(env.MC_ELEVATION_MINUTES ?? 10) * 60_000,
    monitorIntervalMs: Number(env.MC_MONITOR_INTERVAL_MS ?? 30000),
    restartWaitMs: Number(env.MC_RESTART_WAIT_MS ?? 90000),
    retryScale: 1,
    background: true,
    ...overrides,
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error(`Invalid MC_PORT: ${cfg.port}`);
  if (!isPrivateBind(cfg.host)) {
    throw new Error(
      `Refusing to bind to ${cfg.host}: Mission Control only binds to loopback or a private/Tailscale address. ` +
        'Use loopback with `tailscale serve` (recommended).',
    );
  }
  return cfg;
}
