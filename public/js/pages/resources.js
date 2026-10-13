import { h, bytes, num, pct } from '../dom.js';
import { api, canAct } from '../api.js';
import { runAction } from '../actions.js';
import { panel, body, flush, pageHead, region, notice, table, meter, kv, toast } from '../components.js';
import { lineChart, legend } from '../charts.js';

const col = { a: 'var(--accent)', b: 'var(--accent-2)', c: 'var(--warn)' };
const span = (series) => { const ts = series.map((s) => s.t); if (ts.length < 2) return undefined; const f = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return [f(ts[0]), f(ts.at(-1))]; };

const FIELDS = [
  ['diskWarn', 'Mac disk warning (%)'], ['diskCrit', 'Mac disk critical (%)'], ['memWarn', 'Mac memory warning (%)'], ['memCrit', 'Mac memory critical (%)'],
  ['vramWarn', 'GPU VRAM warning (%)'], ['vramCrit', 'GPU VRAM critical (%)'], ['gpuTempWarn', 'GPU temperature warning (°C)'], ['gpuTempCrit', 'GPU temperature critical (°C)'],
  ['failuresBeforeAlert', 'Failures in a row before alerting'], ['cooldownMin', 'Minutes before repeating an alert'],
];
function thresholds(s, reload) {
  const inputs = Object.fromEntries(FIELDS.map(([k]) => [k, h('input', { type: 'number', id: `th-${k}`, min: 1, max: 200, value: String(s[k]), disabled: canAct() ? null : true })]));
  const save = async () => {
    const next = { ...s, ...Object.fromEntries(FIELDS.map(([k]) => [k, Number(inputs[k].value)])) };
    const r = await runAction('monitor.settings', next, { title: 'Alert thresholds' });
    if (r) reload();
  };
  return panel('Alert thresholds', body(h('div', { class: 'grid cols-2' }, FIELDS.map(([k, label]) => h('div', null, h('label', { for: `th-${k}` }, label), inputs[k]))),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', disabled: canAct() ? null : true, onclick: save }, 'Save thresholds'), h('span', { class: 'muted' }, 'Warning must be below critical. Dashed lines on the charts show the warning level.'))));
}

export default async function resources() {
  const view = region(async () => { const [t, m] = await Promise.all([api('/api/telemetry'), api('/api/monitor')]); return { t, s: m.settings }; }, ({ t, s }) => {
    const mac = t.macSeries, win = t.windowsSeries, g0 = (x) => x.gpus[0];
    const chart = (title, series, opts, sub) => panel(title, body(series.some((x) => x.points.some((p) => p != null)) ? [lineChart(series, { title, labels: span(opts.src), ...opts }), legend(series)] : h('p', { class: 'muted' }, 'Collecting samples…')), { sub });
    const macSeries = [{ name: 'CPU', color: col.a, points: mac.map((x) => x.cpuPercent) }, { name: 'Memory', color: col.b, points: mac.map((x) => x.memPercent) }];
    const w = t.windows;
    return h('div', { class: 'stack' },
      h('div', { class: 'grid cols-2' },
        chart('Mac: CPU and memory', macSeries, { src: mac, threshold: s.memWarn }, 'sampled every 5 s'),
        panel('Mac: disk and load', body(kv([['Disk used', t.mac?.diskPercent != null ? h('div', null, pct(t.mac.diskPercent), meter(t.mac.diskPercent, s.diskWarn, s.diskCrit)) : null], ['Disk size', t.mac?.diskTotalBytes ? `${bytes(t.mac.diskUsedBytes)} of ${bytes(t.mac.diskTotalBytes)}` : null], ['Memory', t.mac?.memTotalBytes ? `${bytes(t.mac.memUsedBytes)} of ${bytes(t.mac.memTotalBytes)}` : null], ['Load (1 min)', t.mac ? t.mac.load1.toFixed(2) : null]])))),
      w ? h('div', { class: 'stack' },
        h('div', { class: 'grid cols-2' },
          chart('Windows GPU: utilisation and VRAM', [{ name: 'GPU', color: col.a, points: win.map((x) => g0(x)?.utilPercent ?? null) }, { name: 'VRAM', color: col.b, points: win.map((x) => (g0(x)?.memTotalMiB ? (g0(x).memUsedMiB / g0(x).memTotalMiB) * 100 : null)) }], { src: win, threshold: s.vramWarn }),
          chart('Windows: GPU temperature', [{ name: 'Temperature', color: col.c, unit: ' °C', points: win.map((x) => g0(x)?.tempC ?? null) }], { src: win, yMax: 110, unit: '°C', threshold: s.gpuTempWarn })),
        h('div', { class: 'grid cols-2' },
          chart('Windows: CPU and RAM', [{ name: 'CPU', color: col.a, points: win.map((x) => x.cpuPercent) }, { name: 'RAM', color: col.b, points: win.map((x) => x.memPercent) }], { src: win }),
          panel('GPU details', body(w.gpus.length ? w.gpus.map((g) => kv([['Model', g.name], ['VRAM', g.memTotalMiB ? `${num(g.memUsedMiB)} of ${num(g.memTotalMiB)} MiB` : null], ['Utilisation', g.utilPercent != null ? `${g.utilPercent}%` : null], ['Temperature', g.tempC != null ? `${g.tempC} °C` : null], ['Power', g.powerW != null ? `${g.powerW} W` : null]])) : notice('info', 'The reporter is running but nvidia-smi found no GPU.')))))
        : panel('Windows PC', body(notice('info', h('b', null, 'Windows metrics are off. '), t.windowsReason ?? 'No reporter configured.'), h('p', { class: 'muted' }, 'Mission Control never guesses GPU numbers. Run tools/windows-telemetry-agent.mjs on the PC (see the README), then set MC_WINDOWS_TELEMETRY_URL and MC_WINDOWS_TELEMETRY_TOKEN on the Mac.'))));
  }, { every: 5000, rows: 6 });
  const th = region(() => api('/api/monitor'), (m) => thresholds(m.settings, () => th.reload()), { rows: 3 });
  return h('div', { class: 'stack' }, pageHead('Resources', 'Mac metrics are read locally. Windows GPU, VRAM, CPU and RAM come from the optional read-only reporter on the PC.'), view, th);
}
