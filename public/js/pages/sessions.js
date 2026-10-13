import { h, relTime, clock } from '../dom.js';
import { api, apiR, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, table, badge, resultView, modal, notice, toast } from '../components.js';
import { ensureElevated } from '../actions.js';

const pickv = (r, ks) => { for (const k of ks) if (r[k] !== undefined && r[k] !== null) return r[k]; return null; };

export default async function sessions() {
  let filter = '';
  let data = null;
  const out = h('div');
  const draw = () => {
    if (!data) return;
    const rows = data.sessions.filter((r) => !filter || JSON.stringify(r).toLowerCase().includes(filter));
    out.replaceChildren(panel('Sessions', flush(table([
      { label: 'Session', render: (r) => h('code', null, String(pickv(r, ['key', 'sessionKey', 'id']) ?? '—')) },
      { label: 'Agent', render: (r) => String(pickv(r, ['agentId', 'agent']) ?? '—') },
      { label: 'Model', render: (r) => { const m = pickv(r, ['model']); return m ? h('code', null, String(m)) : '—'; } },
      { label: 'State', render: (r) => data.activeKeys.includes(String(pickv(r, ['key', 'sessionKey']))) ? badge('active', 'ok') : badge('idle') },
      { label: 'Last activity', render: (r) => r._updatedAt ? h('span', { title: clock(r._updatedAt) }, relTime(r._updatedAt)) : '—' },
    ], rows, { onRow: tail, empty: 'No sessions match.' })), { sub: `${rows.length} of ${data.total ?? data.sessions.length}${data.hasMore ? ' (more exist than are listed)' : ''}` }));
  };
  const tail = async (r) => {
    if (!canAct()) { toast('Reading conversation history needs an operator account.', 'warn'); return; }
    const key = String(pickv(r, ['key', 'sessionKey', 'id']) ?? '');
    if (!(await ensureElevated('Conversation history is private. Confirm with your password to read it. The read is recorded in the audit trail.'))) return;
    const res = await apiR(`/api/openclaw/sessions/tail?key=${encodeURIComponent(key)}&agent=${encodeURIComponent(String(pickv(r, ['agentId', 'agent']) ?? ''))}&lines=60`).catch((e) => ({ ok: false, error: { message: e.message } }));
    modal('Recent conversation', ({ close }) => ({ body: h('div', { class: 'stack' }, h('code', null, key), resultView(res, (d) => h('pre', { class: 'block' }, d.text || '(empty)'))), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] }), { wide: true });
  };
  const view = region(() => apiR('/api/openclaw/sessions'), (r) => resultView(r, (d) => { data = d; draw(); return out; }), { every: 20000 });
  const search = h('input', { type: 'search', placeholder: 'Filter sessions', 'aria-label': 'Filter sessions', oninput: (e) => { filter = e.target.value.trim().toLowerCase(); draw(); } });
  return h('div', null, pageHead('Sessions', 'Select a session to read its recent conversation. That needs your password and is written to the audit trail.', search), view);
}
