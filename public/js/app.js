import { h, $, icon, num } from './dom.js';
import { api, state, canAct, isElevated, ApiError } from './api.js';
import { loadPrefs, savePrefs, applyTheme, THEME_LABELS, registerWorker, notify, enableNotifications, resolvedMode } from './prefs.js';
import { runCleanups, errorState, skeleton, toast, status, modal, when, STATUS_WORD, onLeave } from './components.js';
import { elevateDialog, refreshSession } from './actions.js';
import { healthRing } from './charts.js';

const NAV = [
  { group: 'Command', items: [
    { id: 'overview', path: '', label: 'Overview', icon: 'overview', mod: 'overview' },
    { id: 'approvals', path: 'approvals', label: 'Approvals', icon: 'approvals', mod: 'approvals', badge: true },
    { id: 'events', path: 'events', label: 'Event timeline', icon: 'events', mod: 'events' },
  ] },
  { group: 'OpenClaw', items: [
    { id: 'openclaw', path: 'openclaw', label: 'Gateway', icon: 'gateway', mod: 'openclaw' },
    { id: 'agents', path: 'agents', label: 'Agents', icon: 'agents', mod: 'agents' },
    { id: 'sessions', path: 'sessions', label: 'Sessions', icon: 'sessions', mod: 'sessions' },
    { id: 'automation', path: 'automation', label: 'Automation', icon: 'automation', mod: 'automation' },
    { id: 'telegram', path: 'telegram', label: 'Telegram', icon: 'telegram', mod: 'telegram' },
  ] },
  { group: 'Infrastructure', items: [
    { id: 'models', path: 'models', label: 'Models', icon: 'models', mod: 'models' },
    { id: 'resources', path: 'resources', label: 'Resources', icon: 'resources', mod: 'resources' },
    { id: 'network', path: 'network', label: 'Network', icon: 'network', mod: 'network' },
  ] },
  { group: 'Control', items: [
    { id: 'workflows', path: 'workflows', label: 'Workflows', icon: 'workflows', mod: 'workflows' },
    { id: 'security', path: 'security', label: 'Security', icon: 'security', mod: 'security' },
    { id: 'config', path: 'config', label: 'Config & backups', icon: 'config', mod: 'config' },
    { id: 'files', path: 'files', label: 'Workspace files', icon: 'files', mod: 'files' },
    { id: 'logs', path: 'logs', label: 'Logs & diagnostics', icon: 'logs', mod: 'logs' },
    { id: 'audit', path: 'audit', label: 'Audit trail', icon: 'audit', mod: 'audit' },
  ] },
];
const PAGES = NAV.flatMap((g) => g.items);
const BOTTOM = ['overview', 'approvals', 'events', 'models'];

const ui = { health: { overall: 'unknown', checks: [], lastRun: null }, popOpen: false };
let els = {};

// ---------- boot ----------
async function boot() {
  const app = document.getElementById('app');
  app.replaceChildren(skeleton(6));
  try {
    state.session = await api('/api/session');
  } catch (e) {
    if (e.status !== 401) app.replaceChildren(errorState(e, () => location.reload()));
    return;
  }
  await loadPrefs();
  registerWorker();
  buildShell(app);
  window.addEventListener('hashchange', route);
  document.addEventListener('mc:session', updateSessionUi);
  document.addEventListener('mc:approvals', () => refreshSession().catch(() => {}));
  document.addEventListener('mc:prefs', () => { syncThemeControls(); els.shell.classList.toggle('collapsed', Boolean(state.prefs.sidebarCollapsed)); });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.prefs.mode === 'system') applyTheme(); });
  document.addEventListener('keydown', onKey);
  connectStream();
  pollHealth();
  setInterval(pollHealth, 30_000);
  setInterval(() => { if (!document.hidden) refreshSession().catch(() => {}); }, 20_000);
  setInterval(updateSessionUi, 15_000);
  route();
}

// ---------- shell ----------
function buildShell(app) {
  const side = h('nav', { class: 'sidebar', 'aria-label': 'Main' },
    h('div', { class: 'brand' }, icon('pulse', 24), h('span', null, 'Mission Control')),
    NAV.map((g) => [h('div', { class: 'nav-group' }, g.group), g.items.map((it) => h('a', { class: 'navlink', href: `#/${it.path}`, 'data-id': it.id, title: it.label }, icon(it.icon), h('span', null, it.label), it.badge ? h('span', { class: 'count', hidden: true, 'data-badge': it.id }) : null))]),
    h('div', { class: 'sidebar-foot' },
      h('button', { class: 'navlink', type: 'button', onclick: () => savePrefs({ sidebarCollapsed: !state.prefs.sidebarCollapsed }), 'aria-label': 'Collapse or expand the sidebar' }, icon('sidebar'), h('span', null, 'Collapse')),
      h('button', { class: 'navlink', type: 'button', onclick: logout }, icon('signout'), h('span', null, `Sign out (${state.session.user})`))));

  const themeSel = h('select', { class: 'theme-select', 'aria-label': 'Colour theme', onchange: (e) => savePrefs({ theme: e.target.value }) },
    (state.themes ?? Object.keys(THEME_LABELS)).map((t) => h('option', { value: t }, THEME_LABELS[t] ?? t)));
  const modeBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Toggle night mode', 'aria-pressed': 'false', onclick: () => savePrefs({ mode: resolvedMode(state.prefs.mode) === 'dark' ? 'light' : 'dark' }) });
  const lockBtn = h('button', { class: 'lock-btn', type: 'button', onclick: toggleLock });
  const ring = h('button', { class: 'health-ring', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: toggleHealthPop });
  const pop = h('div', { class: 'panel health-pop', role: 'dialog', 'aria-label': 'System health', hidden: true });
  const menuBtn = h('button', { class: 'iconbtn mobile-only', type: 'button', 'aria-label': 'Open menu', onclick: () => side.classList.toggle('open') }, icon('menu'));
  menuBtn.classList.add('menu-btn');

  const top = h('header', { class: 'topbar' },
    menuBtn,
    h('button', { class: 'search-btn', type: 'button', onclick: openPalette }, icon('search', 16), h('span', { class: 'label-long' }, 'Search or run a command'), h('kbd', null, navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K')),
    h('span', { class: 'right' }),
    h('span', { class: 'theme-wrap' }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), themeSel), modeBtn, lockBtn, ring);
  const main = h('main', { id: 'main', tabindex: '-1' });
  const bottom = h('nav', { class: 'bottomnav', 'aria-label': 'Quick navigation' },
    BOTTOM.map((id) => { const it = PAGES.find((p) => p.id === id); return h('a', { href: `#/${it.path}`, 'data-id': id, style: { position: 'relative' } }, icon(it.icon, 22), h('span', null, it.label.split(' ')[0]), it.badge ? h('span', { class: 'count', hidden: true, 'data-badge': id }) : null); }),
    h('button', { type: 'button', onclick: () => side.classList.toggle('open') }, icon('menu', 22), h('span', null, 'More')));
  const shell = h('div', { class: `shell${state.prefs.sidebarCollapsed ? ' collapsed' : ''}` }, side, top, main, bottom, pop);
  app.replaceChildren(shell);
  els = { shell, side, main, themeSel, modeBtn, lockBtn, ring, pop };
  side.addEventListener('click', (e) => { if (e.target.closest('a')) side.classList.remove('open'); });
  syncThemeControls();
  updateSessionUi();
  renderHealth();
}

function syncThemeControls() {
  els.themeSel.value = state.prefs.theme;
  const dark = resolvedMode(state.prefs.mode) === 'dark';
  els.modeBtn.setAttribute('aria-pressed', String(dark));
  els.modeBtn.replaceChildren(icon(dark ? 'moon' : 'sun'));
  els.modeBtn.title = dark ? 'Night mode is on' : 'Night mode is off';
}

function updateSessionUi() {
  const s = state.session;
  const unlocked = isElevated();
  const left = unlocked ? Math.max(0, Math.round((s.elevatedUntil - Date.now()) / 60000)) : 0;
  els.lockBtn.dataset.unlocked = String(unlocked);
  els.lockBtn.replaceChildren(icon(unlocked ? 'unlock' : 'lock', 16), h('span', { class: 'lock-label' }, unlocked ? `Unlocked, ${left || '<1'} min` : s.role === 'operator' ? 'Locked' : 'Read-only'));
  els.lockBtn.disabled = s.role !== 'operator';
  els.lockBtn.title = s.role !== 'operator' ? 'This account is read-only' : unlocked ? 'Privileged actions are unlocked. Select to lock now.' : 'Select to unlock privileged actions with your password';
  for (const b of document.querySelectorAll('[data-badge]')) { b.hidden = !s.pendingApprovals; b.textContent = String(s.pendingApprovals); b.setAttribute('aria-label', `${s.pendingApprovals} pending`); }
  if (unlocked && s.elevatedUntil < Date.now()) refreshSession().catch(() => {});
}
async function toggleLock() {
  if (isElevated()) { await api('/api/elevate/drop', { method: 'POST', body: {} }); await refreshSession(); toast('Locked', ''); }
  else await elevateDialog('Unlock privileged actions for 10 minutes.');
}
async function logout() { try { await api('/api/logout', { method: 'POST', body: {} }); } finally { location.replace('/login.html'); } }

// ---------- health ----------
async function pollHealth() {
  try {
    const m = await api('/api/monitor');
    ui.health = { overall: m.overall, checks: m.checks, lastRun: m.lastRun };
    renderHealth();
  } catch { ui.health = { ...ui.health, overall: 'unknown' }; renderHealth(); }
}
function renderHealth() {
  if (!els.ring) return;
  const o = ui.health.overall;
  els.ring.replaceChildren(healthRing(o), h('span', { class: 'sr-only' }, `System health: ${STATUS_WORD[o] ?? o}`));
  els.ring.title = `System health: ${STATUS_WORD[o] ?? o}`;
  if (ui.popOpen) fillPop();
}
function fillPop() {
  const bad = ui.health.checks.filter((c) => c.status !== 'ok');
  els.pop.replaceChildren(
    h('header', null, h('h2', null, 'System health'), h('div', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => { const r = await api('/api/monitor/run', { method: 'POST', body: {} }); ui.health = { ...ui.health, overall: r.overall, checks: r.checks, lastRun: new Date().toISOString() }; renderHealth(); } }, 'Check now'))),
    h('ul', { class: 'list' }, ui.health.checks.length ? ui.health.checks.map((c) => h('li', null, status(c.status, ''), h('div', { class: 'grow' }, h('div', null, c.label), h('div', { class: 'muted' }, c.message)))) : h('li', null, h('span', { class: 'muted' }, 'No checks have run yet.'))),
    h('div', { class: 'panel-body muted' }, bad.length ? `${bad.length} need attention.` : 'Everything checked is healthy.', ui.health.lastRun ? ` Last run ${new Date(ui.health.lastRun).toLocaleTimeString()}.` : ''));
}
function toggleHealthPop() {
  ui.popOpen = !ui.popOpen;
  els.pop.hidden = !ui.popOpen;
  els.ring.setAttribute('aria-expanded', String(ui.popOpen));
  if (ui.popOpen) fillPop();
}
document.addEventListener('click', (e) => { if (ui.popOpen && !e.target.closest('.health-pop, .health-ring')) { ui.popOpen = false; els.pop.hidden = true; els.ring.setAttribute('aria-expanded', 'false'); } });

// ---------- router ----------
let navToken = 0;
async function route() {
  const token = ++navToken;
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const page = PAGES.find((p) => p.path === (segs[0] ?? '')) ?? PAGES[0];
  runCleanups();
  document.title = `${page.label} · Mission Control`;
  for (const a of document.querySelectorAll('[data-id]')) { if (a.dataset.id === page.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  els.main.replaceChildren(skeleton(5));
  try {
    const mod = await import(`./pages/${page.mod}.js`);
    if (token !== navToken) return;
    const node = await mod.default({ params: segs.slice(1), query: new URLSearchParams(queryPart ?? ''), page });
    if (token !== navToken) return;
    els.main.replaceChildren(node);
    els.main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    if (token !== navToken) return;
    els.main.replaceChildren(errorState(e, route));
  }
}

// ---------- live events ----------
let lastSeverityToast = 0;
function connectStream() {
  const es = new EventSource('/api/events/stream');
  es.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    document.dispatchEvent(new CustomEvent('mc:event', { detail: ev }));
    if (ev.type === 'approval.requested' || ev.type === 'approval.pending') { refreshSession().catch(() => {}); notify('Approval needed', ev.message, '/#/approvals'); }
    else if (ev.severity === 'critical' || ev.severity === 'error') {
      if (Date.now() - lastSeverityToast > 4000) { lastSeverityToast = Date.now(); toast(ev.message, 'crit', ev.source); }
      notify(`Mission Control: ${ev.source}`, ev.message, '/#/events');
    }
  };
}

// ---------- command palette + global search ----------
const COMMANDS = () => [
  ...PAGES.map((p) => ({ group: 'Go to', label: p.label, hint: 'page', run: () => { location.hash = `#/${p.path}`; } })),
  { group: 'Do', label: 'Run health check now', run: async () => { const r = await api('/api/monitor/run', { method: 'POST', body: {} }); ui.health = { ...ui.health, overall: r.overall, checks: r.checks }; renderHealth(); toast(`Overall: ${STATUS_WORD[r.overall]}`, r.overall === 'ok' ? 'ok' : 'warn'); } },
  { group: 'Do', label: isElevated() ? 'Lock privileged actions' : 'Unlock privileged actions', run: toggleLock },
  { group: 'Do', label: resolvedMode(state.prefs.mode) === 'dark' ? 'Switch to light mode' : 'Switch to night mode', run: () => savePrefs({ mode: resolvedMode(state.prefs.mode) === 'dark' ? 'light' : 'dark' }) },
  { group: 'Do', label: 'Turn on alerts on this device', run: enableNotifications },
  { group: 'Do', label: 'Customize overview widgets', run: () => { location.hash = '#/?customize=1'; } },
  ...(state.themes ?? []).map((t) => ({ group: 'Theme', label: `Theme: ${THEME_LABELS[t] ?? t}`, run: () => savePrefs({ theme: t }) })),
  { group: 'Do', label: 'Sign out', run: logout },
];
let searchCache = null;
async function searchData() {
  if (searchCache && Date.now() - searchCache.at < 30_000) return searchCache;
  const [ag, se] = await Promise.allSettled([api('/api/openclaw/agents'), api('/api/openclaw/sessions')]);
  const agents = ag.status === 'fulfilled' && ag.value.ok ? ag.value.data.agents : [];
  const sessions = se.status === 'fulfilled' && se.value.ok ? se.value.data.sessions : [];
  searchCache = { at: Date.now(), agents, sessions };
  return searchCache;
}
function openPalette() {
  if (document.querySelector('dialog.palette')) return;
  const dlg = h('dialog', { class: 'palette', 'aria-label': 'Command palette' });
  const input = h('input', { type: 'search', placeholder: 'Search pages, agents, sessions, events — or type a command', 'aria-label': 'Search', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list' });
  const list = h('ul', { id: 'pal-list', role: 'listbox' });
  dlg.append(input, list);
  let items = [], sel = 0, seq = 0;
  const draw = () => {
    list.replaceChildren();
    let g = null;
    items.forEach((it, i) => {
      if (it.group !== g) { g = it.group; list.append(h('li', { class: 'grp', role: 'presentation' }, g)); }
      const li = h('li', { role: 'option', 'aria-selected': String(i === sel), id: `pal-${i}` }, h('span', null, it.label), it.hint ? h('span', { class: 'hint' }, it.hint) : null);
      li.addEventListener('click', () => choose(it));
      list.append(li);
    });
    if (!items.length) list.append(h('li', { class: 'grp' }, 'No matches'));
    input.setAttribute('aria-activedescendant', `pal-${sel}`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (it) => { dlg.close(); it.run?.(); };
  const score = (label, q) => { const l = label.toLowerCase(); if (!q) return 1; if (l.startsWith(q)) return 3; if (l.includes(q)) return 2; return q.split(/\s+/).every((w) => l.includes(w)) ? 1 : 0; };
  const update = async () => {
    const q = input.value.trim().toLowerCase();
    const mine = ++seq;
    items = COMMANDS().map((c) => ({ ...c, s: score(c.label, q) })).filter((c) => c.s > 0).sort((a, b) => b.s - a.s).slice(0, q ? 8 : 40);
    sel = 0; draw();
    if (q.length < 2) return;
    const data = await searchData().catch(() => null);
    if (mine !== seq) return;
    const extra = [];
    for (const a of data?.agents ?? []) if (score(`${a.id} ${a.name ?? ''}`, q)) extra.push({ group: 'Agents', label: String(a.name ?? a.id), hint: a.id, run: () => { location.hash = '#/agents'; } });
    for (const s of data?.sessions ?? []) { const k = String(s.key ?? s.sessionKey ?? ''); if (k && score(`${k} ${s.agentId ?? ''}`, q)) extra.push({ group: 'Sessions', label: k, hint: String(s.agentId ?? ''), run: () => { location.hash = '#/sessions'; } }); }
    items = [...items, ...extra.slice(0, 8)];
    try {
      const ev = await api(`/api/events?q=${encodeURIComponent(q)}&limit=6`);
      if (mine !== seq) return;
      const rows = ev.events ?? ev.rows ?? ev;
      for (const e of Array.isArray(rows) ? rows : []) items.push({ group: 'Events', label: e.message.slice(0, 90), hint: e.source, run: () => { location.hash = `#/events?q=${encodeURIComponent(q)}`; } });
    } catch { /* search is best effort */ }
    draw();
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); choose(items[sel]); }
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  update();
}
function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName ?? '') && !document.querySelector('dialog[open]')) { e.preventDefault(); openPalette(); }
}

boot();
