import { h, clock, relTime } from '../dom.js';
import { api, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, table, badge, status, notice, empty, when } from '../components.js';
import { runAction, approvalDialog } from '../actions.js';

const RUN_KIND = { succeeded: 'ok', recovered: 'warn', failed: 'crit', interrupted: 'crit', running: 'accent', waiting_approval: 'warn' };
const STEP_ST = { ok: 'ok', failed: 'fail', skipped: 'skipped', running: 'warn', waiting: 'warn', pending: 'unknown' };

function flow(steps) {
  return h('div', { class: 'flow', role: 'list' }, steps.map((s) => h('div', { class: `step ${s.status}`, role: 'listitem' },
    h('div', { class: 'bar' }), h('div', { class: 't' }, h('span', { class: `dot s-${STEP_ST[s.status] ?? 'unknown'}`, 'aria-hidden': 'true' }), ' ', s.label),
    h('div', { class: 'd' }, s.status === 'waiting' ? 'Waiting for your approval' : s.status === 'pending' ? 'Not started' : s.status === 'skipped' ? 'Skipped' : s.detail ?? s.status, s.attempts > 1 ? ` (attempt ${s.attempts})` : ''))));
}

export default async function workflows({ params }) {
  const open = new Set(params[0] ? [params[0]] : []);
  const view = region(() => api('/api/workflows'), ({ templates, runs }) => {
    const start = (t) => runAction('workflow.start', { template: t.id, params: {} }, { title: t.title }).then(() => setTimeout(() => view.reload(), 800));
    const review = async (run) => {
      const gate = run.steps.find((s) => s.status === 'waiting' && s.approval);
      if (!gate) return;
      const list = await api('/api/approvals?status=pending');
      const a = list.approvals.find((x) => x.id === gate.approval);
      if (a) { await approvalDialog(a); document.dispatchEvent(new CustomEvent('mc:approvals')); view.reload(); }
    };
    return h('div', { class: 'stack' },
      panel('Templates', h('div', { class: 'grid auto panel-body' }, templates.map((t) => h('div', { class: 'stack' }, h('div', null, h('strong', null, t.title), h('p', { class: 'muted' }, t.description)),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', disabled: canAct() ? null : true, onclick: () => start(t) }, 'Start')))))),
      runs.length ? h('div', { class: 'stack' }, runs.map((r) => {
        const t = templates.find((x) => x.id === r.workflow);
        const d = h('details', { open: open.has(r.id) || r.status === 'running' || r.status === 'waiting_approval' || null },
          h('summary', { class: 'row' }, badge(r.status.replace('_', ' '), RUN_KIND[r.status]), h('strong', null, t?.title ?? r.workflow), h('span', { class: 'muted' }, `started ${relTime(r.started)} by ${r.actor}`)),
          h('div', { class: 'stack' }, flow(r.steps),
            r.recovery?.length ? h('div', null, h('h3', null, 'Recovery'), flow(r.recovery)) : null,
            r.status === 'waiting_approval' ? h('div', null, notice('warn', 'This run is paused at a decision.'), h('button', { class: 'btn primary', type: 'button', disabled: canAct() ? null : true, onclick: () => review(r) }, 'Review and decide')) : null,
            r.status === 'interrupted' ? notice('crit', 'Mission Control restarted while this run was in progress. Check the system state before running it again.') : null,
            h('p', { class: 'faint' }, `${clock(r.started)}${r.finished ? ` → ${clock(r.finished)}` : ' → in progress'}`)));
        return panel(null, h('div', { class: 'panel-body' }, d));
      })) : panel('Runs', body(empty('No runs yet', 'Start a template above. Each step, retry and decision is recorded here.')))
    );
  }, { every: 4000, rows: 5 });
  return h('div', null, pageHead('Workflows', 'Multi-step operations with checks, retries, human gates and automatic recovery. Nothing is run that is not defined in code.'), view);
}
