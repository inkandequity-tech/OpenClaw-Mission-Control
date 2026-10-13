import { h, relTime, clock } from '../dom.js';
import { api, apiR, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, table, badge, status, resultView, modal, jsonView, notice, empty } from '../components.js';
import { runAction } from '../actions.js';

const pickv = (r, ks) => { for (const k of ks) if (r[k] !== undefined && r[k] !== null) return r[k]; return null; };
const jobId = (j) => String(pickv(j, ['id', 'jobId']) ?? '');
const isOn = (j) => !(j.enabled === false || j.status === 'disabled');
const lastStatus = (j) => String(pickv(j, ['status']) ?? j.state?.lastRunStatus ?? j.lastRunStatus ?? 'unknown');
const sched = (j) => { const s = pickv(j, ['schedule', 'cron', 'expr']); return s && typeof s === 'object' ? (s.expr ?? s.cron ?? JSON.stringify(s)) : s; };

export default async function automation() {
  const view = region(() => apiR('/api/openclaw/cron'), (r) => resultView(r, (d) => {
    const act = (a, j) => runAction(a, { id: jobId(j) }, { title: `${a.split('.')[1]} job` }).then(() => view.reload());
    const runs = async (j) => {
      const res = await apiR(`/api/openclaw/cron/${encodeURIComponent(jobId(j))}/runs?limit=30`).catch((e) => ({ ok: false, error: { message: e.message } }));
      modal(`Run history: ${pickv(j, ['name']) ?? jobId(j)}`, ({ close }) => ({ body: resultView(res, (x) => jsonView(x)), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] }), { wide: true });
    };
    const failing = d.jobs.filter((j) => ['error', 'failed'].includes(lastStatus(j)));
    return h('div', { class: 'stack' },
      failing.length ? notice('crit', h('b', null, `${failing.length} job${failing.length > 1 ? 's' : ''} failed on the last run. `), failing.map((j) => pickv(j, ['name']) ?? jobId(j)).join(', ')) : null,
      panel('Scheduled jobs', d.jobs.length ? flush(table([
        { label: 'Job', render: (j) => h('div', null, h('strong', null, String(pickv(j, ['name']) ?? jobId(j))), h('div', { class: 'faint' }, jobId(j))) },
        { label: 'Schedule', render: (j) => { const s = sched(j); return s ? h('code', null, String(s)) : '—'; } },
        { label: 'Enabled', render: (j) => status(isOn(j) ? 'ok' : 'skipped', isOn(j) ? 'On' : 'Off') },
        { label: 'Last run', render: (j) => { const l = lastStatus(j); return badge(l, l === 'ok' || l === 'success' ? 'ok' : ['error', 'failed'].includes(l) ? 'crit' : ''); } },
        { label: '', render: (j) => h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); runs(j); } }, 'History'),
          h('button', { class: 'btn sm', type: 'button', disabled: canAct() ? null : true, onclick: (e) => { e.stopPropagation(); act('cron.run', j); } }, 'Run now'),
          h('button', { class: 'btn sm', type: 'button', disabled: canAct() ? null : true, onclick: (e) => { e.stopPropagation(); act(isOn(j) ? 'cron.disable' : 'cron.enable', j); } }, isOn(j) ? 'Turn off' : 'Turn on')) },
      ], d.jobs)) : body(empty('No scheduled jobs', 'Jobs created in OpenClaw appear here.')),
      { lead: true, actions: [h('button', { class: 'btn sm primary', type: 'button', disabled: canAct() ? null : true, onclick: createJob }, 'New job')] }),
      d.status ? panel('Scheduler status', body(jsonView(d.status))) : null);
  }), { every: 30000 });

  async function createJob() {
    const ag = await apiR('/api/openclaw/agents').catch(() => null);
    const agents = ag?.ok ? ag.data.agents : [];
    const sc = h('input', { type: 'text', id: 'cj-s', placeholder: '0 8 * * *', required: true }), nm = h('input', { type: 'text', id: 'cj-n', placeholder: 'Morning brief' });
    const pr = h('textarea', { id: 'cj-p', rows: 4, required: true, placeholder: 'What should the agent do each time?' });
    const agSel = h('select', { id: 'cj-a' }, h('option', { value: '' }, 'Default agent'), agents.map((a) => h('option', { value: a.id }, a.name ?? a.id)));
    const res = await modal('New scheduled job', ({ close }) => ({
      body: h('form', { id: 'cj-form', class: 'stack', onsubmit: (e) => { e.preventDefault(); close({ schedule: sc.value.trim(), prompt: pr.value.trim(), name: nm.value.trim() || undefined, agent: agSel.value || undefined }); } },
        h('label', { for: 'cj-n' }, 'Name (optional)'), nm, h('label', { for: 'cj-s' }, 'Schedule (5-field cron, in the Mac’s time zone)'), sc, h('label', { for: 'cj-a' }, 'Agent'), agSel, h('label', { for: 'cj-p' }, 'Prompt'), pr,
        notice('info', 'Creating a job queues it for your approval. The job runs an agent, so review the prompt carefully.')),
      foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit', form: 'cj-form' }, 'Queue for approval')],
    }));
    if (res) { await runAction('cron.create', res, { title: 'New job' }); view.reload(); }
  }
  return h('div', null, pageHead('Automation', 'OpenClaw cron jobs. Running or toggling a job needs your password; creating one needs an approval.'), view);
}
