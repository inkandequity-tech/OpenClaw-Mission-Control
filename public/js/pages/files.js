import { h, bytes, relTime } from '../dom.js';
import { api, apiR, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, table, notice, empty, errorState, skeleton, modal, badge } from '../components.js';
import { ensureElevated } from '../actions.js';

export default async function files({ query }) {
  let root = Number(query.get('root') ?? 0);
  let dir = query.get('path') ?? '';
  const out = h('div');
  const crumbs = () => {
    const parts = dir.split('/').filter(Boolean);
    return h('nav', { class: 'row', 'aria-label': 'Folder path' }, h('button', { class: 'btn sm', type: 'button', onclick: () => go('') }, 'Root'), parts.map((p, i) => [h('span', { class: 'faint' }, '/'), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => go(parts.slice(0, i + 1).join('/')) }, p)]));
  };
  const open = async (e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.type === 'dir') return go(rel);
    if (e.denied) return;
    if (!(await ensureElevated('File contents can hold private data. Confirm with your password; the read is audited.'))) return;
    try {
      const f = await api(`/api/files/read?root=${root}&path=${encodeURIComponent(rel)}`);
      modal(e.name, ({ close }) => ({ body: h('div', { class: 'stack' }, f.truncated ? notice('info', 'Showing the first 256 KB.') : null, h('pre', { class: 'block' }, f.text)), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] }), { wide: true });
    } catch (x) { modal('Cannot open this file', ({ close }) => ({ body: h('p', null, x.message), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] })); }
  };
  const go = async (path) => {
    dir = path;
    out.replaceChildren(skeleton(5));
    try {
      const d = await api(`/api/files?root=${root}&path=${encodeURIComponent(dir)}`);
      const rows = [...d.entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      out.replaceChildren(h('div', { class: 'stack' }, crumbs(), panel(null, flush(table([
        { label: 'Name', render: (e) => h('span', null, e.type === 'dir' ? '📁 ' : '', e.name, e.denied ? ' ' : '', e.denied ? badge('protected') : null) },
        { label: 'Size', num: true, render: (e) => (e.size != null ? bytes(e.size) : '—') }, { label: 'Changed', render: (e) => relTime(e.mtime) },
      ], rows, { onRow: open, empty: 'This folder is empty.' })))));
    } catch (x) { out.replaceChildren(errorState(x, () => go(dir))); }
  };
  if (!canAct()) return h('div', null, pageHead('Workspace files', 'Read-only browser for agent workspaces.'), panel(null, body(notice('info', 'Browsing files needs an operator account.'))));
  const roots = await api('/api/files/roots');
  if (!roots.length) return h('div', null, pageHead('Workspace files'), panel(null, body(empty('No folders configured', 'Set MC_FILE_ROOTS to the agent workspace folders you want to browse.'))));
  go(dir);
  return h('div', null, pageHead('Workspace files', 'Read-only. Only the folders below can be browsed; paths outside them, symbolic links that leave them, and credential files are blocked.'),
    roots.length > 1 ? h('label', { class: 'row' }, 'Folder', h('select', { onchange: (e) => { root = Number(e.target.value); go(''); } }, roots.map((r) => h('option', { value: r.index }, r.path)))) : h('p', { class: 'muted' }, h('code', null, roots[0].path), roots[0].exists ? '' : ' (does not exist)'),
    out);
}
