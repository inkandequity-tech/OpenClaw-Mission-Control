import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startHarness, PASSWORD, FIX, type Harness } from './helpers.ts';

const PUBLIC = path.join(FIX, '..', '..', 'public');
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const TS_HOST = 'mac.tail1234.ts.net';

function raw(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('mobile (Android over Tailscale Serve)', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ viewer: true });
    await h.app.deps.ts.status(0); // learn this Mac's tailnet DNS name so the Host allow-list includes it
  });
  after(async () => { await h.close(); });

  const serveHeaders = (extra: Record<string, string> = {}) => ({ host: TS_HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.1.2', 'user-agent': ANDROID, ...extra });

  test('the tailnet HTTPS host is accepted, other hosts are refused', async () => {
    assert.equal((await raw(h.port, 'GET', '/api/ping', serveHeaders())).status, 200);
    assert.equal((await raw(h.port, 'GET', '/api/ping', serveHeaders({ host: 'evil.ts.net' }))).status, 421);
    assert.equal((await raw(h.port, 'GET', '/api/ping', serveHeaders({ host: '100.64.9.9' }))).status, 421);
  });

  test('sign-in through the proxy yields a Secure, HttpOnly, SameSite=Strict cookie and HSTS', async () => {
    const r = await raw(h.port, 'POST', '/api/login', serveHeaders(), { user: 'admin', password: PASSWORD });
    assert.equal(r.status, 200);
    const cookie = String(r.headers['set-cookie']);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(String(r.headers['strict-transport-security']), /max-age=/);
  });

  test('a plain-http request without the proxy header never gets a Secure cookie', async () => {
    // A direct plain-http login must never be told it is https (no Secure cookie => it still works on loopback).
    const r = await raw(h.port, 'POST', '/api/login', { host: `127.0.0.1:${h.port}`, 'user-agent': ANDROID }, { user: 'admin', password: PASSWORD });
    assert.doesNotMatch(String(r.headers['set-cookie']), /Secure/);
  });

  test('the app shell is mobile-ready: viewport, manifest, service worker, strict CSP', async () => {
    const page = await raw(h.port, 'GET', '/', serveHeaders());
    assert.equal(page.status, 200);
    assert.match(page.body, /<meta name="viewport" content="width=device-width, initial-scale=1/);
    assert.match(page.body, /rel="manifest"/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    const man = await raw(h.port, 'GET', '/manifest.webmanifest', serveHeaders());
    const m = JSON.parse(man.body);
    assert.equal(m.display, 'standalone');
    assert.equal(m.start_url, '/');
    assert.ok(m.icons.length >= 1);
    const sw = await raw(h.port, 'GET', '/sw.js', serveHeaders());
    assert.equal(sw.status, 200);
    assert.match(String(sw.headers['content-type']), /javascript/);
  });

  test('notification actions can only open the app: the service worker never calls the API', () => {
    const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
    assert.match(sw, /notificationclick/);
    assert.doesNotMatch(sw, /fetch\s*\(/, 'approving from a notification would bypass the password + typed confirmation');
    assert.doesNotMatch(sw, /\/api\//);
  });

  test('a read-only account on a phone cannot change anything', async () => {
    const login = await raw(h.port, 'POST', '/api/login', serveHeaders(), { user: 'viewer1', password: PASSWORD });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const csrf = JSON.parse(login.body).csrf;
    const r = await raw(h.port, 'POST', '/api/actions', serveHeaders({ cookie, 'x-csrf-token': csrf, origin: `https://${TS_HOST}` }), { action: 'config.snapshot', params: {} });
    assert.equal(r.status, 403);
  });

  test('theme and layout preferences persist per user and reject unknown values', async () => {
    const c = await h.client();
    const bad = await c.put('/api/prefs', { theme: 'rainbow' });
    assert.equal(bad.status, 400);
    const ok = await c.put('/api/prefs', { theme: 'aurora', mode: 'light', widgetHidden: ['telegram'], widgetOrder: ['quick', 'health'] });
    assert.equal(ok.status, 200);
    const back = await (await h.client()).get('/api/prefs');
    assert.equal(back.body.theme, 'aurora');
    assert.deepEqual(back.body.widgetHidden, ['telegram']);
    assert.ok(back.body.themes.includes('solarflare'));
    const unknownWidget = await c.put('/api/prefs', { widgetHidden: ['not-a-widget'] });
    assert.equal(unknownWidget.status, 400);
  });
});

describe('frontend static guarantees', () => {
  const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  const jsFiles = (dir: string): string[] => fs.readdirSync(path.join(PUBLIC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));

  test('all six themes exist in both modes, plus a dark/light switch and reduced-motion support', () => {
    const css = read('themes.css');
    for (const t of ['noir', 'obsidian', 'cyberpunk', 'aurora', 'arctic', 'solarflare']) {
      for (const m of ['dark', 'light']) assert.match(css, new RegExp(`data-theme="${t}"\\]\\[data-mode="${m}"\\]`), `${t}/${m}`);
    }
    const app = read('app.css');
    assert.match(app, /prefers-reduced-motion: reduce/);
    assert.match(app, /max-width: 760px/);
  });

  test('HTML has no inline scripts, handlers or style attributes (the CSP forbids them)', () => {
    for (const f of ['index.html', 'login.html']) {
      const html = read(f);
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f} inline script`);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f} inline handler`);
      assert.doesNotMatch(html, /\sstyle\s*=/i, `${f} inline style`);
    }
  });

  test('client code never writes HTML strings, so API data cannot inject markup', () => {
    for (const f of jsFiles('js')) {
      const code = read(f).replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(code, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/, f);
    }
  });
});
