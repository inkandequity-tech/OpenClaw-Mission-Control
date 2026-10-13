import { api, state } from './api.js';
import { toast } from './components.js';

const KEY = 'mc.prefs';
export const THEME_LABELS = { noir: 'Noir', obsidian: 'Obsidian', cyberpunk: 'Cyberpunk', aurora: 'Aurora', arctic: 'Arctic', solarflare: 'Solar Flare' };
export const DEFAULTS = { theme: 'noir', mode: 'dark', sidebarCollapsed: false, widgetOrder: [], widgetHidden: [], notifications: false };

export function localPrefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function mirror(p) { try { localStorage.setItem(KEY, JSON.stringify({ theme: p.theme, mode: p.mode, sidebarCollapsed: p.sidebarCollapsed })); } catch { /* storage may be blocked */ } }

export function resolvedMode(mode) {
  return mode === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
}
export function applyTheme(p = state.prefs) {
  const r = document.documentElement;
  r.setAttribute('data-theme', p.theme);
  r.setAttribute('data-mode', resolvedMode(p.mode));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) requestAnimationFrame(() => meta.setAttribute('content', getComputedStyle(document.body).backgroundColor));
}

export async function loadPrefs() {
  state.prefs = { ...localPrefs() };
  try {
    const server = await api('/api/prefs');
    state.themes = server.themes; state.widgets = server.widgets;
    const { themes: _t, widgets: _w, ...rest } = server;
    state.prefs = { ...state.prefs, ...rest };
    if (!state.prefs.widgetOrder?.length) state.prefs.widgetOrder = [...server.widgets];
    // Include widgets added after the order was saved.
    for (const w of server.widgets) if (!state.prefs.widgetOrder.includes(w)) state.prefs.widgetOrder.push(w);
    mirror(state.prefs);
  } catch { /* offline: local copy is still usable */ }
  applyTheme();
  return state.prefs;
}

/** Apply immediately, persist to the server and the local mirror (so the next load never flashes). */
export async function savePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  mirror(state.prefs);
  applyTheme();
  document.dispatchEvent(new CustomEvent('mc:prefs'));
  try { await api('/api/prefs', { method: 'PUT', body: patch }); } catch (e) { toast(`Saved on this device only: ${e.message}`, 'warn'); }
}

// ---------- notifications ----------
export const notificationsSupported = () => 'Notification' in window && 'serviceWorker' in navigator;
let reg = null;
export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { reg = await navigator.serviceWorker.register('/sw.js'); navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'navigate') location.hash = String(e.data.url).replace(/^.*#/, '#'); }); } catch { reg = null; }
  return reg;
}
export async function enableNotifications() {
  if (!notificationsSupported()) { toast('This browser cannot show notifications. Telegram alerts still work.', 'warn'); return false; }
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications were not allowed in the browser settings.', 'warn'); await savePrefs({ notifications: false }); return false; }
  await registerWorker();
  await savePrefs({ notifications: true });
  toast('Alerts are on for this device while Mission Control is open or installed.', 'ok');
  return true;
}
export async function notify(title, body, url = '/#/approvals') {
  if (!state.prefs?.notifications || Notification.permission !== 'granted') return;
  try {
    const r = reg ?? (await navigator.serviceWorker.ready);
    await r.showNotification(title, { body, icon: '/icon.svg', badge: '/icon.svg', tag: title, data: { url }, actions: [{ action: 'review', title: 'Review' }, { action: 'dismiss', title: 'Dismiss' }] });
  } catch { try { new Notification(title, { body }); } catch { /* ignore */ } }
}
