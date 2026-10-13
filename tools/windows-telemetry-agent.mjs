#!/usr/bin/env node
// OpenClaw Mission Control - optional Windows telemetry reporter.
//
// Runs on the PC that hosts the LLM server and answers GET /metrics with CPU, RAM, disk and NVIDIA GPU/VRAM numbers
// so Mission Control can chart them. It is READ-ONLY: it executes one fixed program (nvidia-smi) with fixed
// arguments, accepts no input that reaches a shell, and refuses to start without a bearer token.
//
//   node windows-telemetry-agent.mjs --host 100.x.y.z --port 7790 --token <long random string>
//   (or set MC_TELEMETRY_TOKEN). Bind to the PC's Tailscale address so only your tailnet can reach it.
//
// Then on the Mac:  MC_WINDOWS_TELEMETRY_URL=http://100.x.y.z:7790  MC_WINDOWS_TELEMETRY_TOKEN=<same token>
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []));
const host = args.host ?? process.env.MC_TELEMETRY_HOST ?? '127.0.0.1';
const port = Number(args.port ?? process.env.MC_TELEMETRY_PORT ?? 7790);
const token = args.token ?? process.env.MC_TELEMETRY_TOKEN ?? '';
const smi = args['nvidia-smi'] ?? process.env.NVIDIA_SMI ?? 'nvidia-smi';

if (args.help) {
  console.log('Usage: node windows-telemetry-agent.mjs --host <tailscale-ip> --port 7790 --token <secret>');
  process.exit(0);
}
if (token.length < 16) {
  console.error('Refusing to start: set a token of at least 16 characters (--token or MC_TELEMETRY_TOKEN).');
  process.exit(2);
}
if (['0.0.0.0', '::'].includes(host)) console.error('Warning: binding to all interfaces. Prefer your Tailscale address (100.x.y.z) so the LAN cannot reach this.');

// ---- CPU: percent busy between two samples ----
let prev = os.cpus();
let cpuPercent = null;
const sampleCpu = () => {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = prev[i];
    if (!p) return;
    for (const k of Object.keys(c.times)) total += c.times[k] - p.times[k];
    idle += c.times.idle - p.times.idle;
  });
  prev = now;
  cpuPercent = total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
};
setInterval(sampleCpu, 2000).unref();
setTimeout(sampleCpu, 500).unref();

// ---- GPU via nvidia-smi (fixed argv, no shell) ----
const num = (s) => { const v = Number(String(s).trim()); return String(s).includes('N/A') || !Number.isFinite(v) ? null : v; };
function readGpus() {
  return new Promise((resolve) => {
    execFile(smi, ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, gpus: [] });
      const gpus = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const [name, util, used, total, temp, power] = line.split(',').map((x) => x.trim());
        return { name, utilPercent: num(util), memUsedMiB: num(used), memTotalMiB: num(total), tempC: num(temp), powerW: num(power) };
      });
      resolve({ ok: true, gpus });
    });
  });
}

// ---- disks: statfs on existing drive roots (Windows) or "/" elsewhere ----
function readDisks() {
  const roots = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`) : ['/'];
  const out = [];
  for (const r of roots) {
    try {
      if (process.platform === 'win32' && !fs.existsSync(r)) continue;
      const s = fs.statfsSync(r);
      out.push({ mount: r, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize });
    } catch { /* drive not present */ }
  }
  return out;
}

const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || !same(auth.slice(7), token)) return send(401, { error: 'unauthorized' });
  if (req.url !== '/metrics') return send(404, { error: 'not found' });
  const g = await readGpus();
  send(200, {
    schema: 1, host: os.hostname(), time: new Date().toISOString(),
    cpu: { percent: cpuPercent },
    memory: { totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem() },
    gpus: g.gpus, nvidiaSmi: g.ok, disks: readDisks(),
  });
});
server.listen(port, host, () => console.log(`Telemetry reporter listening on http://${host}:${port}/metrics (read-only)`));
