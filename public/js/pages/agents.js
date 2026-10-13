import { h } from '../dom.js';
import { apiR } from '../api.js';
import { panel, body, flush, pageHead, region, table, badge, resultView, modal, jsonView, kv } from '../components.js';

export default async function agents() {
  const view = region(() => apiR('/api/openclaw/agents'), (r) => resultView(r, (d) => {
    const show = (a) => modal(a.name ?? a.id, ({ close }) => ({ body: h('div', { class: 'stack' }, kv([
      ['Id', h('code', null, a.id)], ['Model', a.model ? h('span', null, h('code', null, a.model), a.modelIsDefault ? badge('default') : null) : null], ['Workspace', a.workspace ? h('code', null, a.workspace) : null],
      ['Roles', [a.isDefault ? 'default' : null, a.isSystemAgent ? 'system' : null, a.isHeartbeat ? 'heartbeat' : null].filter(Boolean).join(', ') || 'regular'],
      ['Known to CLI', a.inCli === null ? 'CLI list unavailable' : a.inCli ? 'yes' : 'no (config only)'],
    ]), a.bindings ? h('div', null, h('h3', null, 'Bindings'), jsonView(a.bindings)) : null, a.subagents ? h('div', null, h('h3', null, 'Subagents'), jsonView(a.subagents)) : null), foot: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')] }));
    return panel('Agents', flush(table([
      { label: 'Agent', render: (a) => h('div', null, h('strong', null, a.name ?? a.id), a.name !== a.id ? h('div', { class: 'faint' }, a.id) : null) },
      { label: 'Model', render: (a) => a.model ? h('span', null, h('code', null, a.model), ' ', a.modelIsDefault ? h('span', { class: 'faint' }, '(default)') : null) : '—' },
      { label: 'Role', render: (a) => h('span', { class: 'row' }, a.isDefault ? badge('default', 'accent') : null, a.isSystemAgent ? badge('system') : null, a.isHeartbeat ? badge('heartbeat') : null) },
    ], d.agents, { onRow: show, empty: 'No agents found in the OpenClaw config.' })), { sub: d.defaultModel ? `default model ${d.defaultModel}` : undefined });
  }), { every: 30000 });
  return h('div', null, pageHead('Agents', 'Read from openclaw.json and the OpenClaw CLI. Changing an agent is done through approvals, never directly from here.'), view);
}
