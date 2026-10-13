// Tiny DOM helpers. Data is only ever inserted as text nodes (never innerHTML), so API content cannot inject markup.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, kids);
  return el;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  append(el, kids);
  return el;
}
function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val); // CSSOM is allowed under the CSP
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ICONS = {
  overview: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  gateway: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  agents: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 8a2.5 2.5 0 110 5M18 14.5c1.9.6 3 2.4 3 5.5',
  sessions: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
  models: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  network: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18',
  telegram: 'M21 4L3 11l6 2 2 6 3-4 5 3zM9 13l8-6',
  automation: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  logs: 'M4 5h16v14H4zM8 10l3 2-3 2M13 14h3',
  events: 'M3 12h4l3-7 4 14 3-7h4',
  config: 'M5 7h9M18 7h1M5 17h1M10 17h9M14 4v6M8 14v6',
  security: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM9 12l2 2 4-4',
  approvals: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8 12l3 3 5-6',
  workflows: 'M6 4a2 2 0 100 4 2 2 0 000-4zM6 16a2 2 0 100 4 2 2 0 000-4zM18 10a2 2 0 100 4 2 2 0 000-4zM6 8v8M8 6h4a4 4 0 014 4M8 18h4a4 4 0 004-4',
  benchmarks: 'M4 17a8 8 0 1116 0M12 17l4-6',
  files: 'M3 6h6l2 2h10v11H3z',
  audit: 'M7 3h10v18H7zM10 8h4M10 12h4M10 16h2',
  resources: 'M5 20V10M12 20V4M19 20v-7',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 016 0v3',
  unlock: 'M6 11h12v9H6zM9 11V8a3 3 0 015.7-1.3',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  refresh: 'M20 11a8 8 0 00-14-4M4 5v4h4M4 13a8 8 0 0014 4M20 19v-4h-4',
  x: 'M6 6l12 12M18 6L6 18',
  up: 'M6 14l6-6 6 6', down: 'M6 10l6 6 6-6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeoff: 'M3 3l18 18M10 6.2A9.6 9.6 0 0112 5c6 0 10 7 10 7a17 17 0 01-3 3.7M6.3 7.3C3.7 9.2 2 12 2 12s4 7 10 7a9.6 9.6 0 004-1M9.9 9.9a3 3 0 004.2 4.2',
  play: 'M7 5l12 7-12 7z',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  pulse: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8v4l2 2',
  tune: 'M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M8 16v4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.6-7 8-7s8 3 8 7',
  signout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
  sidebar: 'M4 5h16v14H4zM9 5v14',
};
export function icon(name, size = 18) {
  return s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: ICONS[name] ?? ICONS.more }));
}

export function relTime(iso) {
  if (!iso) return 'never';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const d = (Date.now() - t) / 1000;
  const abs = Math.abs(d);
  const u = abs < 60 ? [Math.round(abs), 's'] : abs < 3600 ? [Math.round(abs / 60), 'm'] : abs < 86400 ? [Math.round(abs / 3600), 'h'] : [Math.round(abs / 86400), 'd'];
  return d >= 0 ? `${u[0]}${u[1]} ago` : `in ${u[0]}${u[1]}`;
}
export const clock = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export function bytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
export const pct = (n) => (n == null ? '—' : `${Math.round(n * 10) / 10}%`);
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
