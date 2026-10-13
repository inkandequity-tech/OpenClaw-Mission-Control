import { h, icon, relTime } from './dom.js';
import { ApiError } from './api.js';

// ---------- status primitives (shape + colour + text, never colour alone) ----------
export const STATUS_WORD = { ok: 'Healthy', warn: 'Warning', crit: 'Critical', unknown: 'Unknown', fail: 'Failed', skipped: 'Skipped' };
export const dot = (st) => h('span', { class: `dot s-${st}`, 'aria-hidden': 'true' });
export const status = (st, text) => h('span', { class: 'status' }, dot(st), h('span', null, text ?? STATUS_WORD[st] ?? st));
export const badge = (text, kind) => h('span', { class: `badge${kind ? ` ${kind}` : ''}` }, text);
export const sevBadge = (sev) => badge(sev, { critical: 'crit', error: 'crit', high: 'crit', medium: 'warn', warn: 'warn', low: 'accent', info: '', debug: '' }[sev] ?? '');
export const riskBadge = (risk) => badge(`${risk} risk`, { high: 'crit', medium: 'warn', low: 'ok' }[risk]);

// ---------- layout ----------
export function panel(title, body, { actions, lead, cls, sub } = {}) {
  return h('section', { class: `panel${lead ? ' lead' : ''}${cls ? ` ${cls}` : ''}` },
    title || actions ? h('header', null, h('h2', null, title), sub ? h('span', { class: 'muted' }, sub) : null, actions ? h('div', { class: 'actions' }, actions) : null) : null,
    body);
}
export const body = (...kids) => h('div', { class: 'panel-body' }, ...kids);
export const flush = (...kids) => h('div', { class: 'panel-body flush' }, ...kids);
export const pageHead = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null), actions.length ? h('div', { class: 'row right' }, ...actions) : null);
export const notice = (kind, ...kids) => h('div', { class: `notice ${kind}`, role: kind === 'crit' ? 'alert' : 'note' }, ...kids);

export function kv(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v === undefined) continue;
    dl.append(h('dt', null, k), h('dd', null, v === null || v === '' ? h('span', { class: 'faint' }, '—') : v));
  }
  return dl;
}
export function metric(value, label, extra) {
  return h('div', { class: 'metric' }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label), extra ?? null);
}
export function meter(percent, warn = 85, crit = 95) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const bar = h('i'); bar.style.setProperty('width', `${p}%`);
  return h('div', { class: `meter${percent >= crit ? ' crit' : percent >= warn ? ' warn' : ''}`, role: 'meter', 'aria-valuenow': String(Math.round(p)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
}

export function table(cols, rows, { onRow, empty = 'Nothing to show.', caption } = {}) {
  if (!rows.length) return empty instanceof Node ? empty : h('div', { class: 'empty' }, h('p', null, empty));
  const t = h('table', null,
    caption ? h('caption', { class: 'sr-only' }, caption) : null,
    h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', null, rows.map((r) => {
      const tr = h('tr', { class: onRow ? 'clickable' : '', tabindex: onRow ? '0' : null },
        cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : r[c.key] ?? '—')));
      if (onRow) {
        tr.addEventListener('click', () => onRow(r));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRow(r); });
      }
      return tr;
    })));
  return h('div', { class: 'table-wrap' }, t);
}

// ---------- states ----------
export const skeleton = (n = 4) => h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' }, Array.from({ length: n }, (_, i) => { const e = h('i'); e.style.setProperty('width', `${92 - ((i * 17) % 40)}%`); return e; }));
export const empty = (title, text, ...actions) => h('div', { class: 'empty' }, icon('events', 26), h('h3', null, title), text ? h('p', null, text) : null, actions.length ? h('div', { class: 'row' }, ...actions) : null);
export function errorState(err, retry) {
  const e = err instanceof ApiError ? err : { message: err?.message ?? String(err) };
  return h('div', { class: 'error-state', role: 'alert' }, icon('alert', 26), h('h3', null, 'This section could not load'),
    h('div', { class: 'detail' }, e.message), e.hint ? h('p', null, e.hint) : null,
    retry ? h('button', { class: 'btn sm', onclick: retry }, 'Try again') : null);
}
export function unavailable(reason) {
  return h('div', { class: 'empty' }, icon('config', 26), h('h3', null, 'Not available on this system'), h('p', null, reason ?? 'The required capability was not found.'), h('p', { class: 'faint' }, 'Mission Control only shows what it can verify, so this is left blank rather than simulated.'));
}

// ---------- async regions ----------
const cleanups = [];
export function onLeave(fn) { cleanups.push(fn); }
export function runCleanups() { while (cleanups.length) { try { cleanups.pop()(); } catch { /* ignore */ } } }

/**
 * A container that shows a skeleton, loads, renders, and can auto-refresh without flashing.
 * load(): Promise<data>; render(data, region): Node. Optional `every` ms polling while the page is open.
 */
export function region(load, render, { every, rows = 4, className } = {}) {
  const el = h('div', { class: className ?? '' }, skeleton(rows));
  let alive = true, busy = false, first = true;
  const go = async () => {
    if (busy || !alive) return;
    busy = true;
    try {
      const data = await load();
      if (!alive) return;
      const node = render(data, { reload: go });
      el.replaceChildren(node);
    } catch (e) {
      if (!alive) return;
      if (first) el.replaceChildren(errorState(e, () => { el.replaceChildren(skeleton(rows)); first = true; go(); }));
    } finally { busy = false; first = false; }
  };
  go();
  if (every) {
    const t = setInterval(() => { if (!document.hidden) go(); }, every);
    onLeave(() => { alive = false; clearInterval(t); });
  } else onLeave(() => { alive = false; });
  el.reload = go;
  return el;
}

// ---------- JSON viewer (collapsible, text-only) ----------
export function jsonView(value, depth = 0) {
  const root = h('div', { class: 'json' });
  root.append(node(value, depth, null));
  return root;
}
function node(v, depth, key) {
  const k = key !== null ? [h('span', { class: 'k' }, `${key}`), ': '] : [];
  if (v === null) return h('div', null, ...k, h('span', { class: 'z' }, 'null'));
  if (typeof v === 'string') return h('div', null, ...k, h('span', { class: 's' }, JSON.stringify(v.length > 600 ? `${v.slice(0, 600)}…` : v)));
  if (typeof v !== 'object') return h('div', null, ...k, h('span', { class: 'n' }, String(v)));
  const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
  const open = depth < 1;
  if (!entries.length) return h('div', null, ...k, h('span', { class: 'z' }, Array.isArray(v) ? '[]' : '{}'));
  const d = h('details', { open: open || null }, h('summary', null, ...k, h('span', { class: 'z' }, Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`)));
  let filled = open;
  const fill = () => { if (filled) return; filled = true; for (const [ck, cv] of entries.slice(0, 200)) d.append(node(cv, depth + 1, ck)); };
  if (open) for (const [ck, cv] of entries.slice(0, 200)) d.append(node(cv, depth + 1, ck));
  else d.addEventListener('toggle', fill);
  return d;
}

// ---------- clipboard, toast, dialog ----------
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); }
  catch {
    const ta = h('textarea', { 'aria-hidden': 'true' }); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied', 'ok'); } catch { toast('Copy failed — select the text and copy manually', 'warn'); }
    ta.remove();
  }
}
export const cmd = (text) => h('div', { class: 'cmd' }, h('code', null, text), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Copy command', onclick: () => copyText(text) }, icon('copy', 16)));

export function toast(message, kind = '', title) {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}` }, title ? h('b', null, title) : null, message);
  host.append(t);
  setTimeout(() => t.remove(), kind === 'crit' ? 9000 : 4500);
}

/**
 * Modal built on <dialog>. Resolves with the value passed to close(value), or undefined if dismissed.
 * build({close}) returns { body: Node, foot: Node[] }.
 */
export function modal(title, build, { wide = false, cls = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: `${wide ? 'wide' : ''} ${cls}`, 'aria-labelledby': 'dlg-title' });
    let result;
    const close = (v) => { result = v; dlg.close(); };
    const { body: b, foot } = build({ close });
    dlg.append(h('div', { class: 'dlg' },
      h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title' }, title), h('button', { class: 'iconbtn right', type: 'button', 'aria-label': 'Close', onclick: () => close(undefined) }, icon('x'))),
      h('div', { class: 'dlg-body' }, b), foot?.length ? h('div', { class: 'dlg-foot' }, ...foot) : null));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export const when = (iso) => h('time', { datetime: iso ?? '', title: iso ?? '' }, relTime(iso));

/** Render an integration Result ({ok,data}|{ok:false,error}) honestly: data, "not available here", or the real error. */
export function resultView(r, render) {
  if (r?.ok === false) {
    if (r.unsupported) return unavailable(r.error?.message);
    return h('div', { class: 'error-state', role: 'alert' }, icon('alert', 24), h('h3', null, 'The source answered with an error'), h('div', { class: 'detail' }, r.error?.message ?? 'Unknown error'), r.error?.hint ? h('p', null, r.error.hint) : null);
  }
  return render(r && 'ok' in r && 'data' in r ? r.data : r);
}
