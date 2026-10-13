import { h, bytes, clock, relTime } from '../dom.js';
import { api, apiR, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, table, kv, status, badge, notice, jsonView, resultView, modal, errorState, toast } from '../components.js';
import { runAction } from '../actions.js';

function diffView(d) {
  if (!d.changed) return h('p', { class: 'muted' }, 'No differences.');
  return h('div', { class: 'stack' },
    d.secretsChanged ? notice('warn', 'A credential value differs. Values are never shown, so the text diff cannot display it.') : null,
    h('div', { class: 'diff', role: 'region', 'aria-label': 'Configuration differences' }, d.lines.map((l) => h('div', { class: l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === '~' ? 'skip-line' : '' }, l.op === '~' ? l.text : `${l.op === ' ' ? ' ' : l.op} ${l.text}`))));
}

export default async function config() {
  const view = region(async () => {
    const [b, cfg, val] = await Promise.all([api('/api/backups'), apiR('/api/openclaw/config'), Promise.resolve(null)]);
    return { b, cfg };
  }, ({ b, cfg }) => {
    const op = canAct();
    const showDiff = async (from, to, title) => {
      const d = await api(`/api/backups/diff?from=${from}&to=${to}`).catch((e) => ({ err: e }));
      modal(title, ({ close }) => ({ body: d.err ? errorState(d.err) : diffView(d), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] }), { wide: true });
    };
    const restore = (m) => runAction('config.restore', { backupId: m.id }, { title: 'Restore config' }).then(() => view.reload());
    return h('div', { class: 'stack' },
      b.currentSha ? null : notice('crit', 'Mission Control cannot read the live OpenClaw config file.'),
      panel('Versioned backups', b.backups.length ? flush(table([
        { label: 'Saved', render: (m) => h('span', { title: clock(m.ts) }, relTime(m.ts)) }, { label: 'Label', key: 'label' }, { label: 'By', key: 'by' },
        { label: 'Size', num: true, render: (m) => bytes(m.bytes) },
        { label: 'Matches live', render: (m) => (m.sha256 === b.currentSha ? badge('current', 'ok') : '') },
        { label: '', render: (m) => h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => showDiff(m.id, 'current', `Backup ${m.id} → live config`) }, 'Compare with live'),
          h('button', { class: 'btn sm', type: 'button', disabled: op && m.sha256 !== b.currentSha ? null : true, onclick: () => restore(m) }, 'Restore')) },
      ], b.backups)) : body(h('p', { class: 'muted' }, 'No backups yet. One is taken at start-up and before every change Mission Control makes.')),
      { lead: true, actions: [h('button', { class: 'btn sm primary', type: 'button', disabled: op ? null : true, onclick: () => runAction('config.snapshot', { label: 'manual snapshot' }, { title: 'Snapshot' }).then(() => view.reload()) }, 'Take snapshot')], sub: 'Snapshots hold credentials, so they stay on the Mac and are never shown.' }),
      b.backups.length >= 2 ? panel('Compare two versions', body(compareForm(b.backups, showDiff))) : null,
      panel('Current OpenClaw config (credentials hidden)', resultView(cfg, (d) => body(h('p', { class: 'muted' }, 'Read-only. Changes go through approvals so each one is validated, verified and reversible.'), jsonView(d)))));
  }, { rows: 6 });
  return h('div', null, pageHead('Config and backups', 'Every change is snapshotted first, validated after, and rolled back automatically if it does not verify.'), view);
}

function compareForm(backups, showDiff) {
  const opts = (sel) => [h('option', { value: 'current' }, 'Live config'), ...backups.map((m) => h('option', { value: m.id, selected: m.id === sel || null }, `${relTime(m.ts)} · ${m.label}`))];
  const a = h('select', { id: 'cmp-a', 'aria-label': 'From' }, opts(backups[1]?.id)), c = h('select', { id: 'cmp-b', 'aria-label': 'To' }, opts('current'));
  c.value = 'current';
  return h('div', { class: 'row' }, 'From', a, 'to', c, h('button', { class: 'btn', type: 'button', onclick: () => showDiff(a.value, c.value, 'Configuration differences') }, 'Show differences'));
}
