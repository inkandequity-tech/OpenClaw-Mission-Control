import { s } from './dom.js';

const W = 600, H = 150, PAD = { l: 34, r: 8, t: 8, b: 18 };

/** Accessible SVG line chart. series: [{name, color (css var), points: [number|null], fmt}] */
export function lineChart(series, { yMax = 100, yMin = 0, unit = '%', labels, threshold, title } = {}) {
  const n = Math.max(2, ...series.map((x) => x.points.length));
  const x = (i) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title ?? series.map((q) => q.name).join(', ') });
  svg.append(s('title', {}, `${title ?? ''} ${series.map((q) => `${q.name}: ${q.points.filter((p) => p != null).slice(-1)[0] ?? 'no data'}${unit}`).join('; ')}`));
  for (const t of [0, 0.5, 1]) {
    const v = yMin + t * (yMax - yMin);
    svg.append(s('line', { class: 'grid-line', x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v) }), s('text', { class: 'axis', x: PAD.l - 5, y: y(v) + 3, 'text-anchor': 'end' }, `${Math.round(v)}${unit === '%' ? '' : ''}`));
  }
  if (threshold != null) svg.append(s('line', { class: 'thresh', x1: PAD.l, x2: W - PAD.r, y1: y(threshold), y2: y(threshold) }));
  if (labels) svg.append(s('text', { class: 'axis', x: PAD.l, y: H - 4 }, labels[0]), s('text', { class: 'axis', x: W - PAD.r, y: H - 4, 'text-anchor': 'end' }, labels[1]));
  for (const q of series) {
    let d = '';
    let pen = false;
    q.points.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i + (n - q.points.length)).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    if (d) svg.append(s('path', { class: 'line', d, style: { stroke: q.color } }));
  }
  return svg;
}

export function legend(series) {
  const el = document.createElement('div');
  el.className = 'legend';
  for (const q of series) {
    const i = document.createElement('i');
    i.style.setProperty('background', q.color);
    const last = q.points.filter((p) => p != null).slice(-1)[0];
    const sp = document.createElement('span');
    sp.append(i, last != null ? `${q.name} ${Math.round(last * 10) / 10}${q.unit ?? '%'}` : `${q.name} (no data)`);
    el.append(sp);
  }
  return el;
}

/** Global health ring: a full circle whose colour and arc length reflect the overall state. */
export function healthRing(status, size = 28) {
  const r = 11, c = 2 * Math.PI * r;
  const frac = { ok: 1, warn: 0.66, crit: 0.33, unknown: 0.15 }[status] ?? 0.15;
  const col = { ok: 'var(--ok)', warn: 'var(--warn)', crit: 'var(--crit)', unknown: 'var(--faint)' }[status] ?? 'var(--faint)';
  return s('svg', { viewBox: '0 0 28 28', width: size, height: size, 'aria-hidden': 'true' },
    s('circle', { cx: 14, cy: 14, r, fill: 'none', stroke: 'var(--line-strong)', 'stroke-width': 3 }),
    s('circle', { cx: 14, cy: 14, r, fill: 'none', stroke: col, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * frac} ${c}`, transform: 'rotate(-90 14 14)' }),
    s('circle', { cx: 14, cy: 14, r: 3.2, fill: col }));
}
