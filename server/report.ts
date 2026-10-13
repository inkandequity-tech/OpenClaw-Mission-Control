import os from 'node:os';
import type { Deps } from './deps.ts';
import { redactString } from './redact.ts';

/** Mask the last octet of private/tailnet IPv4 addresses in shareable output. */
export function maskIps(text: string): string {
  return text.replace(/\b((?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3})\.\d{1,3}\b/g, '$1.x');
}

/** A sanitized, copy-pasteable troubleshooting report. Secrets are redacted; addresses masked unless `full`. */
export async function buildReport(d: Deps, opts: { full: boolean }): Promise<string> {
  const L: string[] = [];
  const h = (t: string) => L.push('', `## ${t}`);
  L.push('# OpenClaw Mission Control — troubleshooting report', `generated: ${new Date().toISOString()}`);
  L.push(`host: ${process.platform}/${process.arch}, node ${process.version}, ${os.cpus().length} cores`);
  L.push(`openclaw: ${d.caps.openclawVersion ?? 'not found'}   tailscale: ${d.caps.tailscaleVersion ?? 'not found'}`);

  h('Health checks');
  for (const c of d.monitor.checks) L.push(`- [${c.status.toUpperCase()}] ${c.label}: ${c.message}`);
  if (!d.monitor.checks.length) L.push('- (monitor has not completed a run yet)');

  h('Gateway');
  const g = await d.oc.gatewayHttp();
  L.push(g.ok ? `- live=${g.data.live} ready=${g.data.ready} via ${g.data.host ?? 'none'}:${g.data.port} (tried ${g.data.attempts.map((a) => `${a.host}${a.error ? ':' + a.error : ''}`).join(', ')})` : `- error: ${g.error.message}`);
  for (const r of d.oc.lastRestarts(5)) L.push(`- restart log: ${r.line}`);
  const stab = d.oc.stabilityReports(8);
  for (const s of stab) L.push(`- stability: ${s.ts} ${s.reason}`);

  h('Inference');
  for (const s of await d.inf.diagnose()) L.push(`- [${s.status}] ${s.label}: ${s.detail}${s.hint ? ` — ${s.hint}` : ''}`);
  const det = d.inf.lastDetect();
  if (det?.ok) L.push(`- server: ${det.data.kind}, ${det.data.models.length} models, ${det.data.models.filter((m) => m.loaded).length} loaded; OpenClaw model: ${d.oc.configuredModel().raw}`);

  h('Tailscale');
  const t = await d.ts.status(0);
  L.push(t.ok ? `- state ${t.data.backendState}; peers online ${t.data.peers.filter((p) => p.online).length}/${t.data.peers.length}; health: ${t.data.health.join('; ') || 'none'}` : `- error: ${t.error.message}`);

  h('Capabilities not available');
  for (const c of d.caps.list().filter((x) => !x.supported)) L.push(`- ${c.id}: ${c.reason}`);

  h('Recent errors and warnings');
  for (const e of d.events.list({ limit: 25 }).filter((x) => x.severity === 'error' || x.severity === 'critical' || x.severity === 'warn').slice(0, 15)) L.push(`- ${e.ts} [${e.source}] ${e.message}`);

  const text = redactString(L.join('\n'));
  return opts.full ? text : maskIps(text);
}
