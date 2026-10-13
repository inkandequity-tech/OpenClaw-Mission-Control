import { h, clock, relTime } from '../dom.js';
import { api, apiR, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, kv, status, badge, notice, jsonView, resultView, table, empty, cmd } from '../components.js';
import { runAction } from '../actions.js';

export default async function openclaw() {
  const view = region(async () => {
    const [gw, caps, st] = await Promise.all([api('/api/openclaw/gateway'), api('/api/capabilities'), apiR('/api/openclaw/status')]);
    return { gw, caps, st };
  }, ({ gw, caps, st }) => {
    const http = gw.http;
    return h('div', { class: 'stack' },
      h('div', { class: 'grid cols-2' },
        panel('Gateway health', body(http.ok ? kv([
          ['Liveness', status(http.data.live ? 'ok' : 'crit', http.data.live ? 'Live' : 'No response')],
          ['Readiness', http.data.ready === null ? status('unknown', 'Not reported') : status(http.data.ready ? 'ok' : 'warn', http.data.ready ? 'Ready' : `Not ready (HTTP ${http.data.readyzStatus})`)],
          ['Reached via', http.data.host ? h('code', null, `${http.data.host}:${http.data.port}`) : `nothing answered on port ${http.data.port}`],
          ['Version', gw.version], ['Checked in', `${http.ms} ms`],
        ]) : notice('warn', http.error.message)), { lead: true, actions: [
          h('button', { class: 'btn sm', type: 'button', disabled: canAct() ? null : true, onclick: () => runAction('workflow.start', { template: 'restart-with-checks', params: {} }, { title: 'Restart with checks' }).then((r) => { if (r?.status === 'executed') location.hash = '#/workflows'; }) }, 'Restart with checks')] }),
        panel('Restarts and crashes', body(
          h('h3', null, 'Recent restarts'), gw.restarts.length ? h('ul', { class: 'list' }, gw.restarts.map((r) => h('li', null, h('code', { class: 'grow' }, r.line)))) : h('p', { class: 'muted' }, 'No restart log entries found.'),
          h('h3', null, 'Stability reports'), gw.stability.length ? h('ul', { class: 'list' }, gw.stability.slice(0, 6).map((r) => h('li', null, h('div', { class: 'grow' }, h('div', null, r.reason), h('div', { class: 'faint' }, `${r.ts} · ${r.file}`))))) : h('p', { class: 'muted' }, 'No stability reports. That is good.')))),
      panel('OpenClaw status', resultView(st, (d) => body(jsonView(d))), { actions: [h('button', { class: 'btn sm', type: 'button', onclick: async (e) => { e.target.disabled = true; const r = await apiR('/api/openclaw/status?deep=1'); e.target.disabled = false; view.querySelector('.deep')?.remove(); e.target.closest('.panel').append(h('div', { class: 'deep' }, resultView(r, (d) => body(jsonView(d))))); } }, 'Run deep check')] }),
      panel('What this install supports', flush(table([
        { label: 'Capability', render: (c) => h('code', null, c.id) }, { label: 'Available', render: (c) => status(c.supported ? 'ok' : 'unknown', c.supported ? 'Yes' : 'No') }, { label: 'Evidence', render: (c) => h('span', { class: 'muted' }, c.reason) },
      ], caps.capabilities)), { sub: `OpenClaw ${caps.openclawVersion ?? 'version unknown'}` }));
  }, { every: 20000, rows: 6 });
  return h('div', null, pageHead('OpenClaw gateway', 'Live status of the gateway on this Mac and what its CLI lets Mission Control do.'), view);
}
