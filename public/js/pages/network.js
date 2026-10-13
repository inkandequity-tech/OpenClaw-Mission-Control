import { h, relTime } from '../dom.js';
import { api, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, kv, status, badge, notice, table, resultView, cmd, copyText } from '../components.js';
import { runAction } from '../actions.js';

export default async function network() {
  const view = region(() => api('/api/network'), (n) => {
    const st = n.status, serve = n.serve;
    const funnel = serve.ok && serve.data.funnel;
    const served = serve.ok && serve.data.configured;
    return h('div', { class: 'stack' },
      funnel ? notice('crit', h('b', null, 'Tailscale Funnel is on. '), 'Something on this Mac is reachable from the public internet. Run `tailscale funnel reset` unless you set this up on purpose.') : null,
      h('div', { class: 'grid cols-2' },
        panel('Private address', body(h('div', { class: 'stack' },
          n.privateUrl ? h('div', null, h('p', { class: 'muted' }, 'Open this on your phone or any device signed in to your tailnet:'), h('div', { class: 'cmd' }, h('code', null, n.privateUrl), h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(n.privateUrl) }, 'Copy'))) : notice('warn', 'The Tailscale DNS name is unknown. Check that Tailscale is running and MagicDNS is on.'),
          kv([['Tailscale Serve', serve.ok ? status(served ? 'ok' : 'unknown', served ? 'Publishing (tailnet only)' : 'Not set up yet') : status('unknown', serve.error.message)], ['Public exposure', serve.ok ? status(funnel ? 'crit' : 'ok', funnel ? 'Funnel ON' : 'None') : null]]),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', disabled: canAct() && !served ? null : true, onclick: () => runAction('tailscale.serve.enable', { httpsPort: 443 }, { title: 'Publish on tailnet' }).then(() => view.reload()) }, 'Publish on my tailnet'),
            h('button', { class: 'btn', type: 'button', disabled: canAct() && served ? null : true, onclick: () => runAction('tailscale.serve.disable', { httpsPort: 443 }, { title: 'Stop publishing' }).then(() => view.reload()) }, 'Stop publishing')),
          h('p', { class: 'muted' }, 'Or run it yourself on the Mac:'), cmd(n.commands.enable))), { lead: true }),
        panel('Set up the Android phone', body(h('ol', { class: 'stack' }, n.commands.androidSteps.map((s) => h('li', null, s))), h('p', { class: 'muted' }, 'Notifications from Mission Control need the page to be installed or open in Chrome. For alerts when it is closed, use the Telegram alerts.')))),
      panel('Tailnet', resultView(st, (d) => h('div', null,
        body(kv([['State', status(d.backendState === 'Running' ? 'ok' : 'crit', d.backendState)], ['Version', d.version], ['This Mac', d.self ? h('code', null, `${d.self.dns || d.self.host} · ${d.self.ips.join(', ')}`) : null], ['Health notes', d.health.length ? d.health.join('; ') : 'none']])),
        table([
          { label: 'Device', render: (p) => h('div', null, h('strong', null, p.host), h('div', { class: 'faint' }, p.dns)) }, { label: 'System', key: 'os' },
          { label: 'Address', render: (p) => h('code', null, p.ips[0] ?? '—') },
          { label: 'Status', render: (p) => status(p.online ? 'ok' : 'unknown', p.online ? (p.path ?? 'online') : `offline${p.lastSeen ? `, seen ${relTime(p.lastSeen)}` : ''}`) },
        ], d.peers, { empty: 'No other devices on this tailnet.' }))), { sub: st.ok ? `${st.ms} ms` : undefined }),
      panel('What Mission Control can do with Tailscale here', flush(table([{ label: 'Capability', render: (c) => h('code', null, c.id) }, { label: 'Available', render: (c) => status(c.supported ? 'ok' : 'unknown', c.supported ? 'Yes' : 'No') }, { label: 'Evidence', render: (c) => h('span', { class: 'muted' }, c.reason) }], n.capabilities))));
  }, { every: 30000, rows: 6 });
  return h('div', null, pageHead('Network', 'Tailscale status, the private address for this dashboard, and safe remote access.'), view);
}
