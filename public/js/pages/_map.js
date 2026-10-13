import { s } from '../dom.js';
import { STATUS_WORD } from '../components.js';

// The system map: every node and link takes its colour and shape from a real check result.
// Failing links animate; healthy links are still, so movement always means "look here".
const W = 960, H = 330;

function mark(st, cx, cy) {
  const c = { ok: 'var(--ok)', warn: 'var(--warn)', crit: 'var(--crit)', fail: 'var(--crit)', unknown: 'var(--faint)' }[st] ?? 'var(--faint)';
  if (st === 'ok') return s('circle', { cx, cy, r: 5, fill: c });
  if (st === 'warn') return s('path', { d: `M${cx} ${cy - 6}L${cx + 6} ${cy + 5}L${cx - 6} ${cy + 5}Z`, fill: c });
  if (st === 'crit' || st === 'fail') return s('path', { d: `M${cx} ${cy - 6.5}L${cx + 6.5} ${cy}L${cx} ${cy + 6.5}L${cx - 6.5} ${cy}Z`, fill: c });
  return s('circle', { cx, cy, r: 4.5, fill: 'none', stroke: c, 'stroke-width': 2 });
}

function node({ x, y, w = 200, h = 58, title, sub, st, href }) {
  const g = s('a', { class: 'node', href, 'aria-label': `${title}: ${STATUS_WORD[st] ?? st}. ${sub ?? ''}` },
    s('rect', { class: 'body', x, y, width: w, height: h, rx: 10 }),
    mark(st, x + 18, y + 20),
    s('text', { class: 'title', x: x + 34, y: y + 25 }, title),
    s('text', { class: 'sub', x: x + 18, y: y + 45 }, clip(sub ?? '', Math.floor((w - 24) / 6.6))));
  return g;
}
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function link(d, st, label, lx, ly) {
  return [s('path', { class: `link ${st}`, d }), label ? s('text', { class: 'link-label', x: lx, y: ly }, label) : null];
}

function compactMap(m) {
  const svg = s('svg', { class: 'map', viewBox: '0 0 360 410', role: 'group', 'aria-label': 'System map showing how you, Mission Control, the OpenClaw gateway, the inference server and Telegram connect' },
    s('title', {}, 'System map'),
    s('rect', { class: 'enclosure', x: 6, y: 92, width: 348, height: 176, rx: 14 }), s('text', { class: 'enc-label', x: 20, y: 112 }, clip(m.mac.label, 52)),
    s('rect', { class: 'enclosure', x: 6, y: 296, width: 218, height: 106, rx: 14 }), s('text', { class: 'enc-label', x: 20, y: 316 }, clip(m.win.label, 30)));
  svg.append(
    ...link('M310 64 L310 130', m.links.youMc, m.links.youMcLabel, 252, 88),
    ...link('M180 184 L180 198', m.links.mcGw, '', 0, 0),
    ...link('M190 252 L190 336', m.links.gwInf, m.links.gwInfLabel.replace('Tailscale · ', ''), 140, 284),
    ...link('M290 252 L290 336', m.links.gwTg, m.links.gwTgLabel, 322, 296),
    node({ x: 20, y: 10, w: 320, h: 54, title: 'You', sub: m.you.sub, st: m.you.st, href: '#/security' }),
    node({ x: 20, y: 126, w: 320, h: 54, title: 'Mission Control', sub: m.mc.sub, st: m.mc.st, href: '#/config' }),
    node({ x: 20, y: 198, w: 320, h: 54, title: 'OpenClaw gateway', sub: m.gw.sub, st: m.gw.st, href: '#/openclaw' }),
    node({ x: 18, y: 336, w: 194, h: 54, title: m.inf.title, sub: m.inf.sub, st: m.inf.st, href: '#/models' }),
    node({ x: 236, y: 336, w: 112, h: 54, title: 'Telegram', sub: m.tg.sub, st: m.tg.st, href: '#/telegram' }));
  return svg;
}

export function systemMap(m, compact = false) {
  if (compact) return compactMap(m);
  const svg = s('svg', { class: 'map', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'System map showing how you, Mission Control, the OpenClaw gateway, the inference server and Telegram connect' },
    s('title', {}, 'System map'),
    // Enclosures: which machine each service runs on.
    s('rect', { class: 'enclosure', x: 200, y: 22, width: 300, height: 286, rx: 16 }),
    s('text', { class: 'enc-label', x: 216, y: 44 }, m.mac.label),
    s('rect', { class: 'enclosure', x: 680, y: 22, width: 260, height: 286, rx: 16 }),
    s('text', { class: 'enc-label', x: 696, y: 44 }, m.win.label));

  svg.append(
    ...link('M150 100 C 180 100, 190 98, 220 98', m.links.youMc, m.links.youMcLabel, 185, 84),
    ...link('M350 126 L350 178', m.links.mcGw, '', 0, 0),
    ...link('M430 224 C 560 224, 580 150, 700 150', m.links.gwInf, m.links.gwInfLabel, 565, 176),
    ...link('M220 236 C 190 236, 175 256, 150 258', m.links.gwTg, m.links.gwTgLabel, 178, 280),
    node({ x: 20, y: 72, w: 130, h: 58, title: 'You', sub: m.you.sub, st: m.you.st, href: '#/security' }),
    node({ x: 20, y: 232, w: 130, h: 58, title: 'Telegram', sub: m.tg.sub, st: m.tg.st, href: '#/telegram' }),
    node({ x: 220, y: 68, w: 260, h: 58, title: 'Mission Control', sub: m.mc.sub, st: m.mc.st, href: '#/config' }),
    node({ x: 220, y: 180, w: 260, h: 58, title: 'OpenClaw gateway', sub: m.gw.sub, st: m.gw.st, href: '#/openclaw' }),
    node({ x: 700, y: 120, w: 220, h: 58, title: m.inf.title, sub: m.inf.sub, st: m.inf.st, href: '#/models' }));
  return svg;
}
