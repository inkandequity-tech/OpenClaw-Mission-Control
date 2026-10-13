import { h, icon, num, pct, bytes, relTime, clock } from '../dom.js';
import { api, state, unwrap, canAct } from '../api.js';
import { panel, body, flush, pageHead, region, status, badge, kv, meter, metric, table, empty, onLeave, notice, toast, STATUS_WORD, sevBadge, errorState } from '../components.js';
import { savePrefs, enableNotifications } from '../prefs.js';
import { runAction } from '../actions.js';
import { systemMap } from './_map.js';

const ck = (checks, id) => checks.find((c) => c.id === id);
const st = (c) => c?.status ?? 'unknown';
const WIDGET_TITLES = { health: 'Health checks', gateway: 'Gateway', agents: 'Agents', sessions: 'Sessions', inference: 'Inference server', resources: 'Resources', network: 'Tailscale', telegram: 'Telegram', events: 'Latest events', quick: 'Quick controls' };

function buildMap(o, net) {
  const checks = o.health.checks;
  const gw = o.gateway.http;
  const inf = o.inference;
  const peer = inf.origin ? o.tailscale.peers?.find((p) => inf.origin.includes(p.ips?.[0] ?? '~')) : null;
  const https = location.protocol === 'https:';
  const loaded = inf.loaded?.[0];
  return {
    mac: { label: o.tailscale.self ? `${o.tailscale.self.host || 'Mac'} · hosts Mission Control and OpenClaw` : 'Mac · hosts Mission Control and OpenClaw' },
    win: { label: peer ? `${peer.host} · inference server` : 'Inference server' },
    you: { st: 'ok', sub: https ? 'private https' : 'local http' },
    mc: { st: 'ok', sub: `port ${location.port || (https ? 443 : 80)} · ${state.session.user}` },
    gw: { st: st(ck(checks, 'gateway')), sub: gw.error ? 'cannot check' : `${gw.live ? 'live' : 'not responding'}${gw.ready ? ' · ready' : ''}${o.gateway.version ? ` · ${o.gateway.version}` : ''}` },
    inf: { title: inf.kind ? (inf.kind === 'lmstudio' ? 'LM Studio' : inf.kind) : 'Inference server', st: st(ck(checks, 'inference')), sub: inf.error ? 'not reachable' : loaded ? `${loaded} loaded` : `${inf.models ?? 0} models, none loaded` },
    tg: { st: st(ck(checks, 'telegram')), sub: o.telegram.config.configured ? (o.telegram.config.enabled ? 'bot enabled' : 'bot disabled') : 'not configured' },
    links: {
      youMc: https ? 'ok' : 'warn', youMcLabel: https ? 'Tailscale Serve' : 'local',
      mcGw: st(ck(checks, 'gateway')),
      gwInf: st(ck(checks, 'inference')), gwInfLabel: peer ? `Tailscale · ${peer.path ?? (peer.online ? 'online' : 'offline')}` : 'Tailscale',
      gwTg: st(ck(checks, 'telegram')), gwTgLabel: 'internet',
    },
  };
}

// ---------- widgets ----------
const W = {
  health: (o) => panel('Health checks', o.health.checks.length ? h('ul', { class: 'list' }, o.health.checks.map((c) => h('li', null, status(c.status, ''), h('div', { class: 'grow' }, h('div', null, c.label), h('div', { class: 'muted' }, c.message))))) : body(h('p', { class: 'muted' }, 'The first check runs a moment after start-up.')),
    { actions: [h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { await api('/api/monitor/run', { method: 'POST', body: {} }); toast('Checks refreshed', 'ok'); document.dispatchEvent(new CustomEvent('mc:refresh-overview')); } finally { e.target.disabled = false; } } }, 'Check now')] }),
  gateway: (o) => {
    const g = o.gateway, http = g.http;
    return panel('Gateway', body(http.error ? notice('warn', http.error.message) : kv([
      ['State', status(http.live ? (http.ready === false ? 'warn' : 'ok') : 'crit', http.live ? (http.ready === false ? 'Alive, not ready' : 'Live and ready') : 'Not responding')],
      ['Endpoint', http.host ? h('code', null, `${http.host}:${http.port}`) : `port ${http.port}`],
      ['Version', g.version ?? null],
      ['Last restart', g.restarts[0] ? h('span', { title: g.restarts[0].line }, g.restarts[0].ts) : 'none recorded'],
      ['Stability reports', g.stability.length ? `${g.stability.length} on disk` : 'none'],
    ])), { actions: [h('a', { class: 'btn sm', href: '#/openclaw' }, 'Open')] });
  },
  agents: (o) => panel('Agents', o.agents.error ? body(notice('warn', o.agents.error.message)) : body(h('div', { class: 'metric' }, h('div', { class: 'v' }, num(o.agents.count)), h('div', { class: 'l' }, 'configured')), h('ul', { class: 'list' }, o.agents.list.slice(0, 5).map((a) => h('li', null, h('span', { class: 'grow trunc' }, a.name !== a.id ? `${a.name} ` : a.id, a.name !== a.id ? h('span', { class: 'faint' }, `(${a.id})`) : null))))), { actions: [h('a', { class: 'btn sm', href: '#/agents' }, 'Open')] }),
  sessions: (o) => panel('Sessions', o.sessions.error ? body(notice('warn', o.sessions.error.message)) : o.sessions.unavailable ? body(h('p', { class: 'muted' }, o.sessions.unavailable)) : body(h('div', { class: 'metrics' }, metric(num(o.sessions.active), 'active in the last 30 min'), metric(num(o.sessions.total), 'total'))), { actions: [h('a', { class: 'btn sm', href: '#/sessions' }, 'Open')] }),
  inference: (o) => {
    const i = o.inference;
    return panel('Inference server', body(i.error ? notice('crit', i.error.message) : kv([
      ['Software', i.kind === 'lmstudio' ? 'LM Studio' : i.kind], ['Address', h('code', null, i.origin)], ['Models', `${i.models} available, ${i.loaded.length} loaded`],
      ['In memory', i.loaded.length ? i.loaded.join(', ') : 'nothing loaded'],
      ['OpenClaw uses', i.configuredModel ? h('span', null, h('code', null, i.configuredModel), ' ', i.configuredPresent === false ? badge('not on server', 'crit') : i.configuredPresent ? badge('present', 'ok') : '') : 'not set'],
    ])), { actions: [h('a', { class: 'btn sm', href: '#/models' }, 'Open')] });
  },
  resources: (o) => {
    const t = o.telemetry, m = t.mac, w = t.windows;
    const row = (label, v, extra) => h('div', { class: 'stack' }, h('div', { class: 'row' }, h('span', null, label), h('span', { class: 'right muted' }, v == null ? 'no data' : extra ?? pct(v))), v == null ? null : meter(v));
    return panel('Resources', body(h('div', { class: 'stack' },
      h('strong', null, 'Mac'), row('CPU', m?.cpuPercent), row('Memory', m?.memPercent), row('Disk', m?.diskPercent),
      w ? [h('strong', null, 'Windows PC'), row('GPU VRAM', w.gpus[0]?.memTotalMiB ? (w.gpus[0].memUsedMiB / w.gpus[0].memTotalMiB) * 100 : null, w.gpus[0] ? `${num(w.gpus[0].memUsedMiB)} / ${num(w.gpus[0].memTotalMiB)} MiB` : undefined), row('GPU', w.gpus[0]?.utilPercent), row('RAM', w.memPercent)]
        : notice('info', h('b', null, 'Windows metrics are off. '), t.windowsReason ?? 'No reporter configured.'))), { actions: [h('a', { class: 'btn sm', href: '#/resources' }, 'Open')] });
  },
  network: (o) => {
    const ts = o.tailscale;
    return panel('Tailscale', body(ts.error ? notice('warn', ts.error.message) : kv([
      ['State', status(ts.state === 'Running' ? 'ok' : 'crit', ts.state)], ['This Mac', ts.self ? h('code', null, ts.self.dns || ts.self.host) : null],
      ['Peers online', `${ts.peers.filter((p) => p.online).length} of ${ts.peers.length}`],
    ])), { actions: [h('a', { class: 'btn sm', href: '#/network' }, 'Open')] });
  },
  telegram: (o) => {
    const c = o.telegram.config, k = o.telegram.check;
    return panel('Telegram', body(kv([
      ['Status', k ? status(k.status, k.message) : status('unknown', 'not checked yet')],
      ['Bot', c.configured ? (c.enabled ? 'enabled' : 'disabled') : 'not configured'], ['Token', c.hasToken ? 'present in config (hidden)' : 'missing'],
      ['Owners', String(c.ownerIds.length)], ['Agents bound', c.boundAgents.join(', ') || 'none'],
    ])), { actions: [h('a', { class: 'btn sm', href: '#/telegram' }, 'Open')] });
  },
  events: (o) => panel('Latest events', o.events.length ? h('ul', { class: 'list' }, o.events.map((e) => h('li', null, sevBadge(e.severity), h('div', { class: 'grow' }, h('div', null, e.message), h('div', { class: 'faint' }, `${e.source} · ${relTime(e.ts)}`))))) : body(empty('No events yet', 'Events appear here as the system runs.')), { actions: [h('a', { class: 'btn sm', href: '#/events' }, 'Open timeline')] }),
  quick: (o) => {
    const op = canAct();
    const btn = (label, fn, ic, kind = '') => h('button', { class: `btn ${kind}`, type: 'button', disabled: op ? null : true, onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } finally { b.disabled = !op; } } }, icon(ic, 16), label);
    return panel('Quick controls', body(h('div', { class: 'stack' },
      !op ? notice('info', 'This account is read-only, so controls are disabled.') : null,
      h('div', { class: 'grid cols-2' },
        btn('Snapshot config', () => runAction('config.snapshot', { label: 'quick snapshot' }, { title: 'Snapshot' }), 'copy'),
        btn('Test inference', () => runAction('inference.test', {}, { title: 'Test inference' }), 'bolt'),
        btn('Restart with checks', () => runAction('workflow.start', { template: 'restart-with-checks', params: {} }, { title: 'Restart workflow' }).then((r) => { if (r?.status === 'executed') location.hash = '#/workflows'; }), 'refresh'),
        btn('Telegram test alert', () => runAction('telegram.test', {}, { title: 'Telegram test' }), 'telegram')),
      h('div', { class: 'row' }, h('button', { class: 'btn sm ghost', type: 'button', onclick: enableNotifications }, icon('alert', 16), state.prefs.notifications ? 'Alerts are on for this device' : 'Turn on alerts for this device'),
        h('a', { class: 'btn sm ghost', href: '#/approvals' }, o.pendingApprovals ? `${o.pendingApprovals} waiting for approval` : 'No approvals waiting'))))); },
};

function widgetShell(id, node, customizing) {
  if (!customizing) return node;
  const order = state.prefs.widgetOrder;
  const i = order.indexOf(id);
  const move = (d) => { const next = [...order]; const j = i + d; if (j < 0 || j >= next.length) return; [next[i], next[j]] = [next[j], next[i]]; savePrefs({ widgetOrder: next }); };
  const ctl = h('div', { class: 'widget-edit' },
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Move ${WIDGET_TITLES[id]} earlier`, onclick: () => move(-1) }, icon('up', 16)),
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Move ${WIDGET_TITLES[id]} later`, onclick: () => move(1) }, icon('down', 16)),
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Hide ${WIDGET_TITLES[id]}`, onclick: () => savePrefs({ widgetHidden: [...state.prefs.widgetHidden, id] }) }, icon('eyeoff', 16)));
  node.querySelector('header')?.append(ctl);
  return node;
}

export default async function overview({ query }) {
  let customizing = query.get('customize') === '1';
  let cache = null, tick = 0, net = null;
  const host = h('div', { class: 'stack' });

  const load = async () => {
    const [o, n] = await Promise.all([api('/api/overview'), tick++ % 4 === 0 ? api('/api/network').catch(() => net) : Promise.resolve(net)]);
    net = n;
    return o;
  };
  const toggleBtn = h('button', { class: 'btn', type: 'button', 'aria-pressed': String(customizing), onclick: () => { customizing = !customizing; toggleBtn.setAttribute('aria-pressed', String(customizing)); toggleBtn.lastChild.textContent = customizing ? 'Done' : 'Customize'; if (cache) draw(cache); } }, icon('tune', 16), h('span', null, customizing ? 'Done' : 'Customize'));

  const draw = (o) => {
    cache = o;
    const hidden = new Set(state.prefs.widgetHidden);
    const order = state.prefs.widgetOrder.filter((id) => W[id]);
    const visible = order.filter((id) => !hidden.has(id));
    const nodes = visible.map((id) => { try { return widgetShell(id, W[id](o), customizing); } catch (e) { return panel(WIDGET_TITLES[id], body(errorState(e))); } });
    const hiddenBar = customizing && hidden.size ? panel('Hidden widgets', body(h('div', { class: 'row' }, [...hidden].filter((id) => W[id]).map((id) => h('button', { class: 'btn sm', type: 'button', onclick: () => savePrefs({ widgetHidden: state.prefs.widgetHidden.filter((x) => x !== id) }) }, icon('eye', 14), `Show ${WIDGET_TITLES[id]}`)))) ) : null;
    const stateBanner = o.health.overall === 'crit' || o.health.overall === 'warn'
      ? notice(o.health.overall, h('b', null, o.health.overall === 'crit' ? 'Something needs attention. ' : 'Something looks off. '), o.health.checks.filter((c) => c.status === 'crit' || c.status === 'warn').map((c) => `${c.label}: ${c.message}`).join(' • ')) : null;
    host.replaceChildren(...[
      stateBanner,
      panel('System map', body(systemMap(buildMap(o, net), matchMedia('(max-width: 760px)').matches)), { lead: true, sub: 'Colour and shape come from live checks. Select a node to open it.' }),
      hiddenBar,
      h('div', { class: `grid auto${customizing ? ' customizing' : ''}` }, nodes)].filter(Boolean));
  };

  const live = region(load, (o) => { draw(o); return host; }, { every: 15000, rows: 7 });
  const refresh = () => live.reload?.();
  const mq = matchMedia('(max-width: 760px)');
  const onMq = () => { if (cache && document.contains(host)) draw(cache); };
  mq.addEventListener('change', onMq);
  onLeave(() => mq.removeEventListener('change', onMq));
  document.addEventListener('mc:refresh-overview', refresh);
  document.addEventListener('mc:prefs', () => { if (cache && document.contains(host)) draw(cache); });
  onLeave(() => document.removeEventListener('mc:refresh-overview', refresh));

  return h('div', null,
    pageHead('Overview', `Signed in as ${state.session.user}. ${state.session.role === 'operator' ? 'Privileged actions need your password.' : 'This account is read-only.'}`, toggleBtn),
    live);
}
