import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, rawRequest, PASSWORD, type Harness } from './helpers.ts';
import { redactDeep, redactString } from '../server/redact.ts';
import { Audit } from '../server/audit.ts';
import { openDb } from '../server/db.ts';

describe('authentication, sessions and request hardening', () => {
  let h: Harness;
  before(async () => { h = await startHarness({ viewer: true }); });
  after(async () => { await h.close(); });

  test('API requires a session', async () => {
    for (const p of ['/api/session', '/api/overview', '/api/openclaw/config', '/api/audit', '/api/security', '/api/files']) {
      const r = await fetch(h.base + p);
      assert.equal(r.status, 401, p);
    }
  });

  test('login sets an HttpOnly, SameSite=Strict cookie; wrong password is rejected', async () => {
    const bad = await fetch(h.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'nope-nope-nope' }) });
    assert.equal(bad.status, 401);
    const ok = await fetch(h.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: PASSWORD }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/, 'plain-http loopback must not set Secure');
  });

  test('repeated failures lock the account (429) even for the right password', async () => {
    const attempt = (password: string) => fetch(h.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'viewer1', password }) });
    for (let i = 0; i < 5; i++) assert.equal((await attempt('wrong-wrong-wrong')).status, 401);
    assert.equal((await attempt(PASSWORD)).status, 429);
  });

  test('state-changing requests need the CSRF token, a same-origin Origin and JSON content type', async () => {
    const c = await h.client();
    assert.equal((await c.post('/api/actions', { action: 'config.snapshot', params: {} }, { 'x-csrf-token': 'wrong' })).status, 403);
    const noToken = await c.post('/api/actions', { action: 'config.snapshot', params: {} }, { 'x-csrf-token': '' });
    assert.equal(noToken.status, 403);
    const evil = await c.post('/api/actions', { action: 'config.snapshot', params: {} }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error.code, 'bad_origin');
    const crossSite = await c.post('/api/actions', { action: 'config.snapshot', params: {} }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    const form = await fetch(h.base + '/api/logout', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-csrf-token': c.csrf }, body: 'x' });
    assert.ok([401, 415].includes(form.status));
    const good = await c.post('/api/actions', { action: 'config.snapshot', params: {} });
    assert.equal(good.status, 200);
  });

  test('unknown Host headers are refused (DNS-rebinding defence)', async () => {
    const r = await rawRequest(h.port, '/api/ping', { host: 'attacker.example' });
    assert.equal(r.status, 421);
    const ok = await rawRequest(h.port, '/api/ping', { host: `localhost:${h.port}` });
    assert.equal(ok.status, 200);
  });

  test('security headers are present on API and static responses', async () => {
    for (const p of ['/api/ping', '/index.html']) {
      const r = await fetch(h.base + p);
      assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    }
  });

  test('static file server cannot be tricked into leaking server code', async () => {
    for (const p of ['/../server/app.ts', '/%2e%2e/server/app.ts', '/..%2fserver%2fapp.ts', '/.env', '/server/app.ts', '/package.json']) {
      const r = await rawRequest(h.port, p, { host: `127.0.0.1:${h.port}` });
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(r.body, /createApp|import /, p);
    }
  });

  test('oversized request bodies are rejected', async () => {
    const c = await h.client();
    const r = await c.post('/api/actions', { action: 'config.snapshot', params: { label: 'x'.repeat(70_000) } });
    assert.equal(r.status, 413);
  });

  test('viewer role is strictly read-only and the denial is audited', async () => {
    const v = await h.client({ user: 'viewer1', password: PASSWORD }).catch(() => null);
    // viewer1 may be locked by the lockout test above from the same IP; use a fresh account instead
    if (!v) {
      await h.app.deps.auth.setUser('viewer2', 'viewer', PASSWORD);
    }
    const c = await h.client({ user: v ? 'viewer1' : 'viewer2' });
    assert.equal((await c.get('/api/overview')).status, 200);
    assert.equal((await c.get('/api/audit')).status, 403);
    assert.equal((await c.get('/api/files')).status, 403);
    assert.equal((await c.post('/api/elevate', { password: PASSWORD })).status, 403);
    const act = await c.post('/api/actions', { action: 'config.snapshot', params: {} });
    assert.equal(act.status, 403);
    const rows = h.app.deps.audit.list({ outcome: 'denied' });
    assert.ok(rows.some((r) => r.action === 'config.snapshot' && /read-only/.test(r.detail)));
  });

  test('config endpoint never returns credentials', async () => {
    const c = await h.client();
    const r = await c.get('/api/openclaw/config');
    const text = JSON.stringify(r.body);
    for (const secret of ['GATEWAY-SECRET-TOKEN-123456', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', 'lm-secret-key-0000']) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.ok(text.includes('[REDACTED]'));
    for (const p of ['/api/overview', '/api/security', '/api/openclaw/agents', '/api/report']) {
      const body = JSON.stringify((await c.get(p)).body);
      for (const secret of ['GATEWAY-SECRET-TOKEN-123456', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', 'lm-secret-key-0000']) assert.ok(!body.includes(secret), `${p} leaked a secret`);
    }
  });

  test('tailscale auth URLs and node keys are never exposed', async () => {
    const c = await h.client();
    const body = JSON.stringify((await c.get('/api/network')).body);
    assert.ok(!body.includes('SECRETAUTH'));
    assert.ok(!body.includes('SECRETKEY'));
  });
});

describe('redaction and the audit trail', () => {
  test('redactString removes tokens in free text', () => {
    const s = redactString('bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw and Bearer abcdefghijkl and password=hunter2hunter2 sk-abcdefghijklmnop1234 tskey-auth-abc123def456');
    for (const bad of ['AAHdqTcv', 'abcdefghijkl', 'hunter2', 'sk-abcdef', 'tskey-auth']) assert.ok(!s.includes(bad), bad);
  });

  test('redactDeep keeps numbers (token counts) but hides secret strings and message bodies for audit', () => {
    const o = redactDeep({ totalTokens: 1200, botToken: 'x'.repeat(20), nested: { apiKey: 'k', mode: 'token' }, content: 'private chat text' }, { content: true }) as any;
    assert.equal(o.totalTokens, 1200);
    assert.equal(o.botToken, '[REDACTED]');
    assert.equal(o.nested.apiKey, '[REDACTED]');
    assert.equal(o.nested.mode, 'token');
    assert.match(o.content, /^\[content:17 chars\]$/);
  });

  test('audit rows record actor, action, outcome, are redacted and hash-chained', () => {
    const db = openDb(':memory:');
    const a = new Audit(db);
    const actor = { name: 'admin', role: 'operator' as const, via: 'session', ip: '100.64.0.2' };
    a.record({ actor, action: 'config.set', params: { path: 'x', botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', prompt: 'summarise my private email' }, outcome: 'success', verified: true, detail: 'Bearer abcdefghijklmnop leaked?' });
    a.record({ actor, action: 'gateway.restart', outcome: 'failure', verified: false });
    const rows = a.list();
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes('AAHdqTcv'));
    assert.ok(!JSON.stringify(rows).includes('private email'));
    assert.ok(!JSON.stringify(rows).includes('abcdefghijklmnop'));
    assert.equal(rows[1]!.actor, 'admin');
    assert.equal(rows[1]!.ip, '100.64.0.2');
    assert.deepEqual(a.verify(), { ok: true, checked: 2, brokenAt: null });
    db.prepare("UPDATE audit SET outcome = 'success' WHERE action = 'gateway.restart'").run();
    const v = a.verify();
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 2);
  });
});
