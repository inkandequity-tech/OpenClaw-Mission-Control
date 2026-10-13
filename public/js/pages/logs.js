import { h, clock } from '../dom.js';
import { api, apiR, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, notice, resultView, errorState, skeleton, copyText, toast, onLeave } from '../components.js';

const lvl = (l) => String(l ?? 'info').toLowerCase();

export default async function logs() {
  let filter = '', onlyBad = false, lines = [];
  const box = h('div', { class: 'log', role: 'log', 'aria-label': 'OpenClaw log lines', tabindex: '0' });
  const draw = () => {
    const shown = lines.filter((l) => (!onlyBad || ['error', 'fatal', 'warn', 'warning'].includes(lvl(l.level))) && (!filter || `${l.message}`.toLowerCase().includes(filter)));
    box.replaceChildren(...(shown.length ? shown.map((l) => h('div', { class: `lv-${lvl(l.level)}` }, h('span', { class: 'faint' }, l.time ? new Date(l.time).toLocaleTimeString() : ''), h('span', null, lvl(l.level)), h('span', { class: 'm' }, l.message))) : [h('div', null, h('span'), h('span'), h('span', { class: 'm muted' }, 'No lines match.'))]));
  };
  const logView = region(() => apiR('/api/openclaw/logs'), (r) => resultView(r, (d) => {
    const arr = Array.isArray(d) ? d : d.lines ?? d.entries ?? d.logs ?? [];
    lines = arr.map((x) => (typeof x === 'string' ? { message: x } : { time: x.time ?? x.ts ?? x.timestamp, level: x.level ?? x.severity, message: String(x.message ?? x.msg ?? JSON.stringify(x)) }));
    draw(); return box;
  }), { every: 15000 });
  const report = async (full) => {
    try {
      if (full) { const { ensureElevated } = await import('../actions.js'); if (!(await ensureElevated('Full reports include network addresses. Confirm with your password.'))) return; }
      const r = await api(`/api/report${full ? '?full=1' : ''}`);
      await copyText(r.text);
    } catch (e) { toast(e.message, 'crit'); }
  };
  return h('div', null,
    pageHead('Logs and diagnostics', 'Recent OpenClaw log lines with credentials removed, and a report you can paste when asking for help.'),
    h('div', { class: 'stack' },
      panel('OpenClaw log', h('div', { class: 'stack panel-body' }, h('div', { class: 'row' },
        h('input', { type: 'search', placeholder: 'Filter lines', 'aria-label': 'Filter log lines', oninput: (e) => { filter = e.target.value.trim().toLowerCase(); draw(); } }),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', onchange: (e) => { onlyBad = e.target.checked; draw(); } }), 'Warnings and errors only')), logView), { lead: true }),
      panel('Troubleshooting report', body(h('p', { class: 'muted' }, 'Versions, capabilities, health checks, recent errors and config shape, with credentials removed and IP addresses masked.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => report(false) }, 'Copy sanitized report'), canAct() ? h('button', { class: 'btn', type: 'button', onclick: () => report(true) }, 'Copy with full addresses') : null)))));
}
