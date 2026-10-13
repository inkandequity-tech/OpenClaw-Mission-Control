import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { AppError, type Actor } from './types.ts';
import type { Deps } from './deps.ts';
import type { Session } from './auth.ts';
import { redactString } from './redact.ts';

export const SENT = Symbol('response-already-sent');

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  query: URLSearchParams;
  params: Record<string, string>;
  body: any;
  /** Authenticated principal (session user or agent token). */
  actor: Actor;
  session: Session | null;
  proto: 'http' | 'https';
  d: Deps;
}

export type Access = 'public' | 'viewer' | 'operator' | 'agent-or-operator';
export type Handler = (c: Ctx) => Promise<unknown>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  pattern: RegExp;
  keys: string[];
  access: Access;
  handler: Handler;
}

export function route(method: Route['method'], p: string, access: Access, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp('^' + p.replace(/:([a-zA-Z]+)/g, (_m, k: string) => (keys.push(k), '([^/]+)')) + '/?$');
  return { method, pattern, keys, access, handler };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
  "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function baseHeaders(proto: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  if (proto === 'https') h['strict-transport-security'] = 'max-age=31536000';
  return h;
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const eq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new AppError(413, 'too_large', 'Request body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'bad_json', 'Body is not valid JSON');
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface ServerHandle {
  server: http.Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  runtime: { sawHttps: boolean };
}

export function createHttpServer(d: Deps, routes: Route[], publicDir: string): ServerHandle {
  const runtime = { sawHttps: false };
  const hits = new Map<string, { n: number; reset: number }>();
  let sseClients = 0;

  const allowedHost = (host: string): boolean => {
    const h = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (['localhost', '127.0.0.1', '::1', d.cfg.host.toLowerCase()].includes(h)) return true;
    if (d.cfg.allowedHosts.includes(h)) return true;
    const dns = d.ts.selfDns();
    if (dns && dns.toLowerCase() === h) return true;
    return d.ts.selfIps().includes(h);
  };

  function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}, proto = 'http') {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...baseHeaders(proto), ...extra });
    res.end(payload);
  }

  async function serveStatic(pathname: string, res: http.ServerResponse, proto: string): Promise<boolean> {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const abs = path.resolve(publicDir, '.' + rel);
    if (!abs.startsWith(publicDir + path.sep) || path.basename(abs).startsWith('.')) return false;
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return false;
      const ext = path.extname(abs).toLowerCase();
      const type = MIME[ext];
      if (!type) return false;
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...baseHeaders(proto) });
      fs.createReadStream(abs).pipe(res);
      return true;
    } catch {
      return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    const viaProxy = LOOPBACK.has(remote);
    const proto: 'http' | 'https' = viaProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    if (proto === 'https') runtime.sawHttps = true;
    const fwd = viaProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() : '';
    const ip = (fwd || remote).replace('::ffff:', '');
    try {
      if (!allowedHost(String(req.headers.host ?? ''))) {
        return send(res, 421, { error: { code: 'bad_host', message: 'Unrecognised Host header' } }, {}, proto);
      }
      // coarse flood control per client
      const now = Date.now();
      const bucket = hits.get(ip) ?? { n: 0, reset: now + 60_000 };
      if (now > bucket.reset) (bucket.n = 0), (bucket.reset = now + 60_000);
      if (++bucket.n > 1200) return send(res, 429, { error: { code: 'rate_limited', message: 'Too many requests' } }, { 'retry-after': '30' }, proto);
      hits.set(ip, bucket);
      if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);

      const url = new URL(req.url ?? '/', `${proto}://${req.headers.host}`);
      const method = (req.method ?? 'GET').toUpperCase();

      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: { code: 'method', message: 'Method not allowed' } }, {}, proto);
        if (await serveStatic(url.pathname, res, proto)) return;
        return send(res, 404, { error: { code: 'not_found', message: 'Not found' } }, {}, proto);
      }

      const match = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!match) return send(res, 404, { error: { code: 'not_found', message: 'No such endpoint' } }, {}, proto);
      const m = match.pattern.exec(url.pathname)!;
      const params: Record<string, string> = {};
      match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));

      // ---- authentication ----
      let session: Session | null = null;
      let actor: Actor = { name: 'anonymous', role: 'viewer', via: 'none', ip };
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      if (match.access !== 'public') {
        if (bearer?.startsWith('mca_')) {
          const a = d.auth.agentFromToken(bearer);
          if (!a || match.access !== 'agent-or-operator') {
            d.audit.record({ actor: { ...actor, via: 'agent-token' }, action: `${method} ${url.pathname}`, outcome: 'denied', detail: a ? 'agent token not allowed on this endpoint' : 'invalid agent token' });
            return send(res, a ? 403 : 401, { error: { code: a ? 'forbidden' : 'unauthorized', message: a ? 'Agent tokens may only use the actions API' : 'Invalid token' } }, {}, proto);
          }
          actor = { ...a, ip };
        } else {
          session = d.auth.getSession(cookies(req).mc_sid);
          if (!session) return send(res, 401, { error: { code: 'unauthorized', message: 'Sign in required' } }, {}, proto);
          actor = { name: session.user, role: session.role, via: 'session', ip, elevated: d.auth.isElevated(session) };
          if (match.access === 'operator' && session.role !== 'operator') {
            d.audit.record({ actor, action: `${method} ${url.pathname}`, outcome: 'denied', detail: 'viewer attempted an operator endpoint' });
            return send(res, 403, { error: { code: 'forbidden', message: 'Operator role required' } }, {}, proto);
          }
        }
      }

      // ---- CSRF / origin protection for state-changing requests ----
      if (method !== 'GET' && !bearer) {
        const origin = req.headers.origin;
        const expected = `${proto}://${req.headers.host}`;
        const site = req.headers['sec-fetch-site'];
        if (origin ? origin !== expected : site !== undefined && site !== 'same-origin' && site !== 'none') {
          return send(res, 403, { error: { code: 'bad_origin', message: 'Cross-site request blocked' } }, {}, proto);
        }
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return send(res, 415, { error: { code: 'bad_type', message: 'Content-Type must be application/json' } }, {}, proto);
        }
        if (session && !eq(String(req.headers['x-csrf-token'] ?? ''), session.csrf)) {
          d.audit.record({ actor, action: `${method} ${url.pathname}`, outcome: 'denied', detail: 'missing or wrong CSRF token' });
          return send(res, 403, { error: { code: 'csrf', message: 'CSRF token missing or invalid. Reload the page.' } }, {}, proto);
        }
      }

      const body = method === 'GET' ? {} : await readBody(req);
      const ctx: Ctx = { req, res, url, query: url.searchParams, params, body, actor, session, proto, d };

      if (url.pathname === '/api/events/stream') {
        if (sseClients >= 20) return send(res, 429, { error: { code: 'busy', message: 'Too many live streams' } }, {}, proto);
        sseClients++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...baseHeaders(proto) });
        res.write('retry: 5000\n\n');
        const onEvent = (row: unknown) => res.write(`data: ${JSON.stringify(row)}\n\n`);
        d.events.on('event', onEvent);
        const hb = setInterval(() => res.write(': hb\n\n'), 20000);
        req.on('close', () => { clearInterval(hb); d.events.off('event', onEvent); sseClients--; });
        return;
      }

      const out = await match.handler(ctx);
      if (out === SENT) return;
      send(res, 200, out ?? { ok: true }, {}, proto);
    } catch (e) {
      if (e instanceof AppError) {
        return send(res, e.status, { error: { code: e.code, message: redactString(e.message), hint: e.hint } }, {}, proto);
      }
      const msg = redactString((e as Error).message ?? 'error');
      d.events.add({ source: 'system', severity: 'error', type: 'server.error', message: `Unhandled error: ${msg}` });
      send(res, 500, { error: { code: 'internal', message: 'Internal error (details are in the event timeline)' } }, {}, proto);
    }
  });
  server.requestTimeout = 130_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    runtime,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(d.cfg.port, d.cfg.host, () => {
          const a = server.address();
          resolve({ host: d.cfg.host, port: typeof a === 'object' && a ? a.port : d.cfg.port });
        });
      }),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export function setSessionCookie(res: http.ServerResponse, id: string, maxAgeSec: number, secure: boolean): void {
  res.setHeader('set-cookie', `mc_sid=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res: http.ServerResponse, secure: boolean): void {
  res.setHeader('set-cookie', `mc_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
}
