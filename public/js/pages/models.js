import { h, bytes, num, relTime, clock } from '../dom.js';
import { api, apiR, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, table, kv, badge, status, notice, resultView, jsonView, modal, errorState, onLeave, toast, meter } from '../components.js';
import { runAction } from '../actions.js';

const flag = (v) => (v === null ? h('span', { class: 'faint' }, 'unknown') : v ? 'yes' : 'no');

export default async function models() {
  const diagBox = h('div', { class: 'panel-body muted' }, 'Select “Diagnose connection” to test each hop: Tailscale peer, ping, port, API and models.');
  const selected = new Set();
  const view = region(async () => {
    const [inf, bm] = await Promise.all([api('/api/inference'), api('/api/benchmarks')]);
    return { inf, bm };
  }, ({ inf, bm }) => {
    const det = inf.detection;
    const cfg = inf.configured;
    const op = canAct();
    const runDiag = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      diagBox.replaceChildren(h('p', { class: 'muted panel-body' }, 'Checking each hop from this Mac to the PC…'));
      try {
        const r = await api('/api/inference/diagnose', { method: 'POST', body: {} });
        diagBox.replaceChildren(h('ul', { class: 'diag' }, r.steps.map((s) => h('li', null, h('span', null, h('span', { class: `dot s-${s.status}`, 'aria-hidden': 'true' })), h('div', null, h('strong', null, s.label), h('div', { class: 'muted' }, s.detail), s.hint ? h('div', { class: 'hint' }, s.hint) : null, s.commands?.length ? s.commands.map((c) => h('div', { class: 'cmd' }, h('code', null, c))) : null)))));
      } catch (x) { diagBox.replaceChildren(errorState(x)); }
      btn.disabled = false;
    };
    const benchRow = (m) => h('div', { class: 'row' },
      h('button', { class: 'btn sm', type: 'button', disabled: op ? null : true, onclick: () => runAction('inference.test', { model: m.id }, { title: 'Test inference' }) }, 'Test'),
      h('button', { class: 'btn sm', type: 'button', disabled: op && !bm.running ? null : true, title: bm.running ? 'A benchmark is already running' : 'Runs five fixed prompts at temperature 0', onclick: () => runAction('benchmark.run', { model: m.id }, { title: 'Benchmark' }).then(() => setTimeout(() => view.reload(), 1500)) }, 'Benchmark'),
      h('button', { class: 'btn sm', type: 'button', disabled: op && m.id !== cfg.modelId ? null : true, onclick: () => runAction('model.select', { model: m.id }, { title: 'Switch model' }).then(() => view.reload()) }, m.id === cfg.modelId ? 'In use' : 'Use in OpenClaw'));
    const compareBtn = h('button', { class: 'btn sm', type: 'button', disabled: selected.size !== 2, onclick: () => compare([...selected]) }, 'Compare selected');
    const pick = (r) => h('input', { type: 'checkbox', checked: selected.has(r.id) || null, 'aria-label': `Select benchmark of ${r.model}`, onclick: (e) => e.stopPropagation(), onchange: (e) => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); compareBtn.disabled = selected.size !== 2; } });
    const showRun = async (r) => {
      const full = await api(`/api/benchmarks/${r.id}`);
      modal(`Benchmark: ${full.model}`, ({ close }) => ({ body: h('div', { class: 'stack' },
        kv([['Server', full.server], ['Suite', full.suite], ['When', clock(full.ts)], ['Parameters', h('code', null, JSON.stringify(full.detail.params))], ['Memory', full.summary.memory ? `VRAM ${full.summary.memory.gpuVramUsedMiBBefore ?? '?'} → ${full.summary.memory.gpuVramUsedMiBAfter ?? '?'} MiB` : full.summary.memoryNote]]),
        table([
          { label: 'Task', key: 'id' }, { label: 'Result', render: (t) => (t.ok ? badge(t.pass ? 'passed' : 'failed', t.pass ? 'ok' : 'crit') : badge('error', 'crit')) },
          { label: 'First token', num: true, render: (t) => (t.ttftMs != null ? `${num(t.ttftMs)} ms` : '—') }, { label: 'Tokens/s', num: true, render: (t) => (t.tokensPerSec != null ? `${t.tokensPerSec}${t.tokensEstimated ? '*' : ''}` : '—') }, { label: 'Total', num: true, render: (t) => `${num(t.totalMs)} ms` },
          { label: 'Notes', render: (t) => h('span', { class: 'muted' }, t.error ?? t.sample?.slice(0, 80) ?? '') },
        ], full.detail.results), full.summary.tokensEstimated ? h('p', { class: 'muted' }, '* The server did not report token counts, so tokens were estimated from text length.') : null), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] }), { wide: true });
    };
    const compare = async (ids) => {
      const [a, b] = await Promise.all(ids.map((id) => api(`/api/benchmarks/${id}`)));
      const row = (label, f, better) => { const x = f(a.summary), y = f(b.summary); const cmpv = x != null && y != null ? (better === 'high' ? (x > y ? 0 : y > x ? 1 : -1) : (x < y ? 0 : y < x ? 1 : -1)) : -1; return [label, x, y, cmpv]; };
      const rows = [row('Pass rate', (s) => s.passRate, 'high'), row('Median first token (ms)', (s) => s.medianTtftMs, 'low'), row('Median tokens/s', (s) => s.medianTokensPerSec, 'high'), row('VRAM after (MiB)', (s) => s.memory?.gpuVramUsedMiBAfter ?? null, 'low')];
      modal('Compare benchmarks', ({ close }) => ({ body: table([{ label: 'Measure', key: 'l' }, { label: `${a.model} · ${relTime(a.ts)}`, render: (r) => h('span', null, r.a ?? '—', r.w === 0 ? ' ' : '', r.w === 0 ? badge('better', 'ok') : null) }, { label: `${b.model} · ${relTime(b.ts)}`, render: (r) => h('span', null, r.b ?? '—', r.w === 1 ? ' ' : '', r.w === 1 ? badge('better', 'ok') : null) }], rows.map(([l, x, y, w]) => ({ l, a: x, b: y, w }))), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] }), { wide: true });
    };

    return h('div', { class: 'stack' },
      h('div', { class: 'grid cols-2' },
        panel('Inference server', det.ok ? body(kv([
          ['Software', det.data.kind === 'lmstudio' ? 'LM Studio' : det.data.kind], ['Address', h('code', null, det.data.origin)], ['API', det.data.apiFlavor], ['Sign-in required', det.data.authRequired ? 'yes' : 'no'],
          ['Found from', det.data.source], ['Detected', relTime(det.data.detectedAt)],
        ])) : body(notice('crit', h('b', null, 'Cannot reach the inference server. '), det.error.message), det.error.hint ? h('p', { class: 'muted' }, det.error.hint) : null, h('p', { class: 'muted' }, 'Run the diagnosis to see which hop is failing.')),
          { lead: true, actions: [h('button', { class: 'btn sm', type: 'button', onclick: runDiag }, 'Diagnose connection')] }),
        panel('What OpenClaw is set to use', body(kv([
          ['Configured model', cfg.raw ? h('code', null, cfg.raw) : 'not set'],
          ['On the server', cfg.modelId && det.ok ? (det.data.models.some((m) => m.id === cfg.modelId) ? status('ok', 'Present') : status('crit', 'Not found on the server')) : status('unknown', 'Cannot tell')],
          ['In memory', det.ok ? (det.data.models.filter((m) => m.loaded).map((m) => m.id).join(', ') || 'nothing loaded') : null],
        ]), inf.benchmarkRunning ? notice('info', 'A benchmark is running. Other inference may be slower until it finishes.') : null))),
      panel('Connection diagnosis', diagBox, { sub: 'Only runs when you ask' }),
      panel('Models on the server', det.ok ? flush(table([
        { label: 'Model', render: (m) => h('div', null, h('strong', null, m.name), m.name !== m.id ? h('div', { class: 'faint' }, m.id) : null) },
        { label: 'State', render: (m) => (m.loaded === null ? badge('unknown') : m.loaded ? badge('loaded', 'ok') : badge('on disk')) },
        { label: 'Size', num: true, render: (m) => (m.sizeBytes ? bytes(m.sizeBytes) : '—') },
        { label: 'Context', num: true, render: (m) => (m.contextLoaded ? `${num(m.contextLoaded)}${m.contextMax ? ` / ${num(m.contextMax)}` : ''}` : m.contextMax ? `max ${num(m.contextMax)}` : '—') },
        { label: 'Quant', render: (m) => m.quantization ?? '—' }, { label: 'Params', render: (m) => m.params ?? '—' },
        { label: 'Tools', render: (m) => flag(m.toolUse) }, { label: 'Vision', render: (m) => flag(m.vision) },
        { label: '', render: benchRow },
      ], det.data.models.filter((m) => m.type !== 'embedding'), { empty: 'The server lists no models.' })) : body(h('p', { class: 'muted' }, 'Model details need a reachable server.')),
        { sub: 'Loading and unloading models is done in LM Studio on the PC. Mission Control does not change what is in memory.' }),
      panel('Benchmarks', h('div', null, bm.running ? body(notice('info', 'A benchmark is running. Results will appear here when it finishes.')) : null,
        bm.runs.length ? flush(table([
          { label: '', render: pick },
          { label: 'Model', render: (r) => h('code', null, r.model) }, { label: 'When', render: (r) => relTime(r.ts) },
          { label: 'Passed', num: true, render: (r) => `${r.summary.passed}/${r.summary.total}` },
          { label: 'First token', num: true, render: (r) => (r.summary.medianTtftMs != null ? `${num(r.summary.medianTtftMs)} ms` : '—') },
          { label: 'Tokens/s', num: true, render: (r) => (r.summary.medianTokensPerSec != null ? String(r.summary.medianTokensPerSec) : '—') },
          { label: 'VRAM after', num: true, render: (r) => (r.summary.memory?.gpuVramUsedMiBAfter != null ? `${num(r.summary.memory.gpuVramUsedMiBAfter)} MiB` : '—') },
        ], bm.runs, { onRow: showRun })) : body(h('p', { class: 'muted' }, 'No benchmarks yet. Choose Benchmark on a model above. The suite has five fixed prompts at temperature 0 with a fixed seed, so runs are comparable.'))),
        { actions: [compareBtn], sub: `suite ${bm.suite.length} tasks` }));
  }, { every: 20000, rows: 6 });
  return h('div', null, pageHead('Models', 'The inference server on the Windows PC, the model OpenClaw uses, and how models compare.'), view);
}
