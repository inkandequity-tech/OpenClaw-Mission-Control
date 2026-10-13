import { h, relTime, clock, icon } from '../dom.js';
import { api } from '../api.js';
import { panel, body, flush, pageHead, sevBadge, empty, errorState, skeleton, jsonView, onLeave } from '../components.js';

const SOURCES = ['', 'openclaw', 'agent', 'model', 'telegram', 'network', 'system', 'security', 'audit'];
const SEVS = ['', 'debug', 'info', 'warn', 'error', 'critical'];

export default async function events({ query }) {
  const f = { q: query.get('q') ?? '', source: '', severity: '' };
  const list = h('div', { class: 'panel-body flush' }, skeleton(6));
  const count = h('span', { class: 'muted' });
  let rows = [], live = true;

  const draw = () => {
    count.textContent = `${rows.length} shown`;
    list.replaceChildren(rows.length ? h('ul', { class: 'list' }, rows.map((e) => {
      const d = h('details', null, h('summary', { class: 'row' }, sevBadge(e.severity), h('span', { class: 'grow' }, e.message)), h('div', { class: 'faint' }, `${e.type} · ${clock(e.ts)}`), (() => { try { const j = JSON.parse(e.data || 'null'); return j ? jsonView(j) : null; } catch { return null; } })());
      return h('li', null, h('div', { class: 'grow' }, d, h('div', { class: 'faint' }, `${e.source} · ${relTime(e.ts)}`)));
    })) : empty('No matching events', f.q || f.source || f.severity ? 'Try removing a filter.' : 'Events appear as the system runs.'));
  };
  const load = async () => {
    const p = new URLSearchParams({ limit: '300' });
    for (const k of ['q', 'source', 'severity']) if (f[k]) p.set(k, f[k]);
    try { rows = await api(`/api/events?${p}`); draw(); } catch (e) { list.replaceChildren(errorState(e, load)); }
  };
  const sel = (label, key, opts) => h('label', { class: 'row' }, label, h('select', { onchange: (e) => { f[key] = e.target.value; load(); } }, opts.map((o) => h('option', { value: o }, o || 'Any'))));
  const q = h('input', { type: 'search', placeholder: 'Search messages and details', value: f.q, 'aria-label': 'Search events', oninput: (() => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 250); }; })() });
  const onEvent = (e) => {
    const ev = e.detail;
    if (!live) return;
    if ((f.source && ev.source !== f.source) || (f.severity && ev.severity !== f.severity)) return;
    if (f.q && !`${ev.message} ${ev.type}`.toLowerCase().includes(f.q.toLowerCase())) return;
    rows = [ev, ...rows].slice(0, 500); draw();
  };
  document.addEventListener('mc:event', onEvent);
  onLeave(() => document.removeEventListener('mc:event', onEvent));
  load();
  return h('div', null,
    pageHead('Event timeline', 'One searchable stream for gateway, agent, model, Telegram, network and security events, newest first. New events arrive live.'),
    panel(null, h('div', { class: 'stack' }, h('div', { class: 'panel-body row' }, q, sel('Source', 'source', SOURCES), sel('Severity', 'severity', SEVS), count,
      h('label', { class: 'switch right' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { live = e.target.checked; } }), 'Live')), list)));
}
