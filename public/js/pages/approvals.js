import { h, relTime, clock } from '../dom.js';
import { api, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, table, badge, riskBadge, empty, when } from '../components.js';
import { approvalDialog } from '../actions.js';

const KIND = { pending: 'warn', running: 'accent', executed: 'ok', failed: 'crit', rejected: '', expired: '' };

export default async function approvals() {
  const refresh = () => view.reload?.();
  document.addEventListener('mc:approvals', refresh);
  const view = region(() => api('/api/approvals'), ({ approvals: rows }) => {
    const pending = rows.filter((r) => r.status === 'pending');
    const past = rows.filter((r) => r.status !== 'pending');
    const open = async (r) => { await approvalDialog(r); document.dispatchEvent(new CustomEvent('mc:approvals')); view.reload(); };
    return h('div', { class: 'stack' },
      panel('Waiting for a decision', pending.length ? flush(table([
        { label: 'Risk', render: (r) => riskBadge(r.risk) },
        { label: 'Request', render: (r) => h('div', null, h('div', null, r.action), h('div', { class: 'muted' }, typeof r.params === 'object' ? JSON.stringify(r.params).slice(0, 120) : '')) },
        { label: 'From', render: (r) => h('span', null, r.proposer, r.proposer_role === 'agent' ? ' ' : '', r.proposer_role === 'agent' ? badge('agent') : null) },
        { label: 'Expires', render: (r) => when(r.expires) },
        { label: '', render: (r) => h('button', { class: 'btn sm primary', type: 'button', disabled: canAct() ? null : true, onclick: (e) => { e.stopPropagation(); open(r); } }, 'Review') },
      ], pending, { onRow: open })) : body(empty('Nothing is waiting', 'High-impact actions, config changes and anything an agent proposes will queue here for your decision.')), { lead: true }),
      panel('Decided', past.length ? flush(table([
        { label: 'When', render: (r) => h('span', { title: clock(r.decided_ts ?? r.ts) }, relTime(r.decided_ts ?? r.ts)) },
        { label: 'Action', key: 'action' },
        { label: 'Outcome', render: (r) => badge(r.status, KIND[r.status]) },
        { label: 'Decided by', render: (r) => r.decided_by ?? '—' },
        { label: 'Result', render: (r) => h('span', { class: 'muted' }, r.result && typeof r.result === 'object' ? String(r.result.detail ?? '').slice(0, 140) : '') },
      ], past.slice(0, 60))) : body(h('p', { class: 'muted' }, 'No decisions yet.'))));
  }, { every: 10000 });
  return h('div', null, pageHead('Approvals', 'Every high-impact change waits here. Approving needs your password and, for the riskiest actions, a typed confirmation.'), view);
}
