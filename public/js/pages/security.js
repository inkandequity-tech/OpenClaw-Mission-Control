import { h, relTime } from '../dom.js';
import { api } from '../api.js';
import { panel, body, flush, pageHead, region, table, badge, status, sevBadge, kv, jsonView, notice, resultView, empty } from '../components.js';
import { enableNotifications } from '../prefs.js';

export default async function security() {
  const view = region(() => api('/api/security'), (d) => {
    const bad = d.findings.filter((f) => ['critical', 'high', 'medium'].includes(f.severity));
    return h('div', { class: 'stack' },
      bad.length ? notice(bad.some((f) => ['critical', 'high'].includes(f.severity)) ? 'crit' : 'warn', h('b', null, `${bad.length} finding${bad.length > 1 ? 's' : ''} to review. `), 'Each one says what was observed and how to fix it.') : notice('info', h('b', null, 'No medium or higher findings. '), 'Everything below was derived from evidence on this machine.'),
      panel('Findings', flush(h('div', null, d.findings.map((f) => h('div', { class: 'finding' }, h('div', null, sevBadge(f.severity), h('div', { class: 'faint' }, f.area)),
        h('div', null, h('strong', null, f.title), h('div', { class: 'muted' }, `Observed: ${f.evidence}`), h('div', null, `Fix: ${f.remediation}`)))))), { lead: true }),
      h('div', { class: 'grid cols-2' },
        panel('Who has access', flush(table([{ label: 'Name', key: 'name' }, { label: 'Role', render: (p) => badge(p.role, p.role === 'operator' ? 'accent' : '') }, { label: 'Kind', key: 'kind' }, { label: 'Last used', render: (p) => (p.lastUsed ? relTime(p.lastUsed) : '—') }],
          [...d.access.missionControl.users.map((u) => ({ name: u.name, role: u.role, kind: 'person', lastUsed: null })), ...d.access.missionControl.agents.map((a) => ({ name: a.name, role: 'proposes only', kind: 'agent token', lastUsed: a.lastUsed }))], { empty: 'No principals.' })), { sub: `${d.access.activeSessions} active session${d.access.activeSessions === 1 ? '' : 's'}` }),
        panel('Tailnet devices', d.access.tailnetPeers ? flush(table([{ label: 'Device', key: 'host' }, { label: 'System', key: 'os' }, { label: 'Status', render: (p) => status(p.online ? 'ok' : 'unknown', p.online ? 'online' : `offline${p.lastSeen ? `, seen ${relTime(p.lastSeen)}` : ''}`) }], d.access.tailnetPeers)) : body(h('p', { class: 'muted' }, 'Tailscale peers are unavailable.')))),
      h('div', { class: 'grid cols-2' },
        panel('Telegram access', body(kv([['Owner accounts', d.access.telegramOwners.length ? d.access.telegramOwners.join(', ') : 'none'], ['Agents reachable from Telegram', d.access.telegramBoundAgents.join(', ') || 'none']]))),
        panel('OpenClaw paired devices', body(d.access.openclawDevices?.unavailable ? h('p', { class: 'muted' }, d.access.openclawDevices.unavailable) : d.access.openclawDevices?.error ? notice('warn', d.access.openclawDevices.error) : jsonView(d.access.openclawDevices)))),
      panel('OpenClaw’s own security audit', body(d.openclawAudit?.unavailable ? h('p', { class: 'muted' }, d.openclawAudit.unavailable) : d.openclawAudit?.error ? notice('warn', d.openclawAudit.error) : jsonView(d.openclawAudit))),
      panel('Audit trail integrity', body(kv([['Records', String(d.audit.checked)], ['Hash chain', status(d.audit.ok ? 'ok' : 'crit', d.audit.ok ? 'Intact' : `Broken at record ${d.audit.brokenAt}`)]]), h('p', { class: 'muted' }, 'Every operation is recorded with who, what, when and the outcome; each record is chained to the one before it so edits are detectable.'))),
      panel('This device', body(h('button', { class: 'btn', type: 'button', onclick: enableNotifications }, 'Turn on device alerts'))));
  }, { every: 60000, rows: 6 });
  return h('div', null, pageHead('Security and access', 'Findings come from checks on this system. Nothing is invented, and unavailable checks say so.'), view);
}
