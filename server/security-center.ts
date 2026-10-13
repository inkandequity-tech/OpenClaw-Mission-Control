import fs from 'node:fs';
import type { Deps } from './deps.ts';
import { maskId } from './redact.ts';
import { asArray } from './util.ts';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export interface Finding {
  id: string;
  severity: FindingSeverity;
  area: 'mission-control' | 'openclaw' | 'tailscale' | 'inference' | 'telegram';
  title: string;
  evidence: string;
  remediation: string;
}

const modeOf = (p: string): string | null => {
  try {
    return (fs.statSync(p).mode & 0o777).toString(8).padStart(3, '0');
  } catch {
    return null;
  }
};

/** Risk findings are derived from evidence on this machine; each states what was observed. */
export async function securityCenter(d: Deps, runtime: { sawHttps: boolean }) {
  const f: Finding[] = [];
  const add = (x: Finding) => f.push(x);
  const loop = ['127.0.0.1', '::1', 'localhost'].includes(d.cfg.host);

  add(loop
    ? { id: 'mc.bind', severity: 'info', area: 'mission-control', title: 'Mission Control listens on loopback only', evidence: `bind ${d.cfg.host}:${d.cfg.port}`, remediation: 'No action. Use Tailscale Serve for remote access.' }
    : { id: 'mc.bind', severity: 'medium', area: 'mission-control', title: 'Mission Control listens on a non-loopback address', evidence: `bind ${d.cfg.host}:${d.cfg.port} (plain HTTP)`, remediation: 'Bind to 127.0.0.1 and publish with `tailscale serve` for TLS.' });
  if (!runtime.sawHttps) add({ id: 'mc.https', severity: 'low', area: 'mission-control', title: 'No HTTPS request seen yet', evidence: 'All requests so far arrived over plain HTTP (loopback).', remediation: 'Remote devices should use the https:// Tailscale Serve URL so session cookies are Secure.' });

  const cfgMode = modeOf(d.oc.configPath);
  if (cfgMode && cfgMode !== '600') add({ id: 'oc.perms', severity: 'medium', area: 'openclaw', title: 'OpenClaw config is readable by other users', evidence: `${d.oc.configPath} mode ${cfgMode}`, remediation: `chmod 600 ${d.oc.configPath}` });

  const c = d.oc.readRawConfig();
  if (c) {
    const bind = c.gateway?.bind;
    const auth = c.gateway?.auth?.mode;
    if (auth === 'none' || auth === undefined) add({ id: 'oc.gw-auth', severity: auth === 'none' ? 'critical' : 'medium', area: 'openclaw', title: 'Gateway authentication is not enforced', evidence: `gateway.auth.mode = ${auth ?? '(unset)'}`, remediation: 'Set gateway.auth.mode to "token" with `openclaw configure`.' });
    else add({ id: 'oc.gw-auth', severity: 'info', area: 'openclaw', title: 'Gateway requires authentication', evidence: `gateway.auth.mode = ${auth}`, remediation: 'No action.' });
    if (bind && !['loopback', 'local'].includes(String(bind))) add({ id: 'oc.gw-bind', severity: bind === 'tailnet' ? 'low' : 'high', area: 'openclaw', title: `Gateway is bound to "${bind}"`, evidence: `gateway.bind = ${bind}, port ${c.gateway?.port ?? 18789}`, remediation: bind === 'tailnet' ? 'Reachable by every device on your tailnet that has the gateway token. Restrict with Tailscale ACLs if you share the tailnet.' : 'Prefer loopback or tailnet; avoid LAN/0.0.0.0 binds.' });
    const origins = asArray(c.gateway?.controlUi?.allowedOrigins).map(String);
    if (origins.some((o) => o.startsWith('http://') && !/\/\/(localhost|127\.0\.0\.1)/.test(o))) add({ id: 'oc.origins', severity: 'low', area: 'openclaw', title: 'Control UI allows plain-HTTP origins', evidence: `${origins.filter((o) => o.startsWith('http://')).length} http:// origin(s) in gateway.controlUi.allowedOrigins`, remediation: 'Prefer https:// Serve origins; tokens cross the network in clear text on http://.' });
    if (c.tools?.profile === 'full') add({ id: 'oc.tools', severity: 'medium', area: 'openclaw', title: 'Agents use the "full" tool profile', evidence: 'tools.profile = "full"', remediation: 'Review which tools each agent really needs; Mission Control never runs agent-generated shell commands.' });
    const tg = d.oc.telegramConfig();
    if (tg.enabled && tg.groupsRequireMention === false) add({ id: 'tg.mention', severity: 'medium', area: 'telegram', title: 'Telegram groups do not require @mention', evidence: 'channels.telegram.groups["*"].requireMention = false', remediation: 'Set requireMention to true so the bot only answers when addressed.' });
    if (tg.enabled && tg.ownerIds.length === 0) add({ id: 'tg.owner', severity: 'medium', area: 'telegram', title: 'No Telegram owner allow-list', evidence: 'commands.ownerAllowFrom has no telegram:* entry', remediation: 'Add your Telegram user id so privileged chat commands are limited to you.' });
    if (c.telemetry?.enabled === true) add({ id: 'oc.telemetry', severity: 'info', area: 'openclaw', title: 'OpenClaw telemetry is enabled', evidence: 'telemetry.enabled = true', remediation: 'Disable if undesired.' });
  } else {
    add({ id: 'oc.config', severity: 'medium', area: 'openclaw', title: 'OpenClaw config could not be read', evidence: d.oc.configPath, remediation: 'Check the path (OPENCLAW_HOME_DIR) and permissions.' });
  }

  const serve = await d.ts.serveStatus();
  if (serve.ok && serve.data.funnel) add({ id: 'ts.funnel', severity: 'critical', area: 'tailscale', title: 'Tailscale Funnel is ON: a service is public on the internet', evidence: 'AllowFunnel is true in `tailscale serve status --json`', remediation: 'Run `tailscale funnel reset` unless you intended this. Mission Control must never be public.' });
  else if (serve.ok) add({ id: 'ts.funnel', severity: 'info', area: 'tailscale', title: 'No Tailscale Funnel exposure', evidence: serve.data.configured ? 'Serve is configured; Funnel is off' : 'No Serve/Funnel configuration', remediation: 'No action.' });

  const inf = d.inf.lastDetect();
  if (inf?.ok && !inf.data.authRequired) add({ id: 'inf.auth', severity: 'low', area: 'inference', title: 'Inference API accepts unauthenticated requests', evidence: `${inf.data.kind} at ${inf.data.origin} answered without credentials`, remediation: 'Limit the Windows firewall rule to Tailscale addresses (100.64.0.0/10) and use Tailscale ACLs. Enable an API token in the server if offered.' });

  for (const [p, want] of [[d.cfg.dataDir, '700'], [`${d.cfg.dataDir}/auth.json`, '600']] as const) {
    const m = modeOf(p);
    if (m && m !== want) add({ id: `mc.perm.${p}`, severity: 'medium', area: 'mission-control', title: 'Mission Control data has loose permissions', evidence: `${p} mode ${m}`, remediation: `chmod ${want} ${p}` });
  }
  const chain = d.audit.verify();
  add(chain.ok
    ? { id: 'mc.audit', severity: 'info', area: 'mission-control', title: 'Audit trail intact', evidence: `${chain.checked} records, hash chain verified`, remediation: 'No action.' }
    : { id: 'mc.audit', severity: 'high', area: 'mission-control', title: 'Audit trail tampering detected', evidence: `Hash chain broken at record ${chain.brokenAt}`, remediation: 'Investigate who had write access to the data directory.' });

  const rank: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  f.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const peers = d.ts.status ? await d.ts.status(10000) : null;
  const principals = d.auth.listPrincipals();
  const tg = d.oc.telegramConfig();
  const devices = d.caps.get('openclaw.devices').supported ? await d.oc.devices() : null;
  const osec = d.caps.get('openclaw.security.audit').supported ? await d.oc.securityAudit() : null;
  return {
    findings: f,
    access: {
      missionControl: principals,
      activeSessions: d.auth.sessionCount(),
      telegramOwners: tg.ownerIds.map(maskId),
      telegramBoundAgents: tg.boundAgents,
      tailnetPeers: peers?.ok ? peers.data.peers.map((p) => ({ host: p.host, os: p.os, online: p.online, lastSeen: p.lastSeen })) : null,
      openclawDevices: devices ? (devices.ok ? devices.data : { error: devices.error.message }) : { unavailable: d.caps.get('openclaw.devices').reason },
    },
    openclawAudit: osec ? (osec.ok ? osec.data : { error: osec.error.message }) : { unavailable: d.caps.get('openclaw.security.audit').reason },
    audit: chain,
  };
}
