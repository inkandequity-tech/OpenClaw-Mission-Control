export class ApiError extends Error {
  constructor(status, code, message, hint) { super(message); this.status = status; this.code = code; this.hint = hint; }
}
export const state = { session: null, prefs: null };

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && state.session) headers['x-csrf-token'] = state.session.csrf;
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach Mission Control. Check that the Mac is awake and Tailscale is connected.');
  }
  if (res.status === 401 && path !== '/api/login') { location.replace('/login.html'); throw new ApiError(401, 'unauthorized', 'Sign in required'); }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code, json?.error?.message ?? `HTTP ${res.status}`, json?.error?.hint);
  return json;
}

/** Integration endpoints answer { ok, data | error }. Return data or throw a readable error. */
export function unwrap(r) {
  if (r && typeof r === 'object' && 'ok' in r && ('data' in r || 'error' in r)) {
    if (r.ok) return r.data;
    throw new ApiError(200, r.error?.code, r.error?.message ?? 'Request failed', r.error?.hint);
  }
  return r;
}

export const canAct = () => state.session?.role === 'operator';
export const isElevated = () => Boolean(state.session && state.session.elevatedUntil > Date.now());

/** Like api(), but a 501 (capability missing on this system) comes back as a value, not an exception. */
export async function apiR(path, opts) {
  try { return await api(path, opts); }
  catch (e) { if (e instanceof ApiError && e.status === 501) return { ok: false, unsupported: true, error: { code: e.code, message: e.message, hint: e.hint } }; throw e; }
}
