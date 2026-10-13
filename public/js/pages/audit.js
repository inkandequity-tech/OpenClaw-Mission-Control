import { h, clock, relTime } from '../dom.js';
import { api, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, table, badge, status, notice, jsonView, modal, kv } from '../components.js';

const OUT = { success: 'ok', failure: 'crit', denied: 'warn', pending: 'accent' };

export default async function audit() {
  if (!canAct()) return h('div', null, pageHead('Audit trail'), panel(null, body(notice('info', 'The audit trail is visible to operator accounts.'))));
  const f = { action: '', outcome: '' };
  const view = region(() => api(`/api/audit?limit=200${f.action ? `&action=${encodeURIComponent(f.action)}` : ''}${f.outcome ? `&outcome=${f.outcome}` : ''}`), ({ rows, chain }) => {
    const show = (r) => modal(`#${r.id} ${r.action}`, ({ close }) => ({ body: h('div', { class: 'stack' }, kv([['When', clock(r.ts)], ['Who', `${r.actor} (${r.role}) via ${r.via}`], ['From', r.ip], ['Outcome', badge(r.outcome, OUT[r.outcome])], ['Verified', r.verified === null || r.verified === undefined ? 'not applicable' : r.verified ? 'yes' : 'no'], ['Detail', r.detail], ['Record hash', h('code', null, String(r.hash).slice(0, 24) + '…')]]), h('h3', null, 'Request (credentials removed)'), (() => { try { return jsonView(JSON.parse(r.params)); } catch { return h('pre', { class: 'block' }, String(r.params)); } })()), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] }), { wide: true });
    return h('div', { class: 'stack' },
      notice(chain.ok ? 'info' : 'crit', h('b', null, chain.ok ? 'Chain intact. ' : 'Tampering detected. '), chain.ok ? `${chain.checked} records verified.` : `The hash chain breaks at record ${chain.brokenAt}.`),
      panel('Recorded operations', flush(table([
        { label: 'When', render: (r) => h('span', { title: clock(r.ts) }, relTime(r.ts)) }, { label: 'Who', render: (r) => h('span', null, r.actor, r.role === 'agent' ? ' ' : '', r.role === 'agent' ? badge('agent') : null) },
        { label: 'What', render: (r) => h('code', null, r.action) }, { label: 'Outcome', render: (r) => badge(r.outcome, OUT[r.outcome]) },
        { label: 'Detail', render: (r) => h('span', { class: 'muted' }, String(r.detail ?? '').slice(0, 110)) },
      ], rows, { onRow: show, empty: 'Nothing recorded for this filter.' })), { lead: true }));
  }, { every: 15000, rows: 6 });
  const controls = h('div', { class: 'row' },
    h('input', { type: 'search', placeholder: 'Filter by action, e.g. gateway', 'aria-label': 'Filter by action', oninput: (() => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => { f.action = e.target.value.trim(); view.reload(); }, 300); }; })() }),
    h('label', { class: 'row' }, 'Outcome', h('select', { onchange: (e) => { f.outcome = e.target.value; view.reload(); } }, ['', 'success', 'failure', 'denied', 'pending'].map((o) => h('option', { value: o }, o || 'Any')))));
  return h('div', null, pageHead('Audit trail', 'Who started each operation, what was requested, whether it worked, and when. Credentials and private content are removed.'), controls, view);
}
