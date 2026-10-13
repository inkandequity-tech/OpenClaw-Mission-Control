import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, PASSWORD, type Harness } from './helpers.ts';

describe('authorization and the approval queue', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  test('medium-risk actions need an elevated (password-confirmed) session', async () => {
    const c = await h.client();
    const denied = await c.post('/api/actions', { action: 'cron.run', params: { id: 'job1' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'elevation_required');
    assert.equal(h.calls().filter((a) => a[0] === 'cron' && a[1] === 'run').length, 0, 'CLI must not run when denied');
    await c.elevate();
    const ok = await c.post('/api/actions', { action: 'cron.run', params: { id: 'job1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'executed');
    assert.equal(ok.body.outcome.verified, true);
    assert.equal(h.calls().filter((a) => a[0] === 'cron' && a[1] === 'run').length, 1);
  });

  test('a wrong password cannot elevate', async () => {
    const c = await h.client();
    const bad = await c.post('/api/elevate', { password: 'definitely-wrong-pw' });
    assert.equal(bad.status, 401);
  });

  test('high-risk actions are queued, not executed; approval needs elevation and the typed phrase', async () => {
    const c = await h.client();
    await c.elevate();
    const before = h.calls().filter((a) => a[0] === 'gateway' && a[1] === 'restart').length;
    const q = await c.post('/api/actions', { action: 'gateway.restart', params: {} });
    assert.equal(q.status, 200);
    assert.equal(q.body.status, 'pending');
    assert.equal(h.calls().filter((a) => a[0] === 'gateway' && a[1] === 'restart').length, before, 'nothing may run before approval');
    const id = q.body.approval.id;
    assert.equal(q.body.approval.confirm_phrase, 'restart gateway');
    assert.ok(q.body.approval.preview.impact);

    const wrong = await c.post(`/api/approvals/${id}/approve`, { confirm: 'yes please' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'confirm_mismatch');

    const unelevated = await h.client();
    const noElev = await unelevated.post(`/api/approvals/${id}/approve`, { confirm: 'restart gateway' });
    assert.equal(noElev.status, 403);
    assert.equal(noElev.body.error.code, 'elevation_required');

    const done = await c.post(`/api/approvals/${id}/approve`, { confirm: 'restart gateway' });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'executed');
    assert.equal(done.body.result.verified, true, 'success is only claimed after /healthz+/readyz were observed');
    assert.equal(h.calls().filter((a) => a[0] === 'gateway' && a[1] === 'restart').length, before + 1);

    const again = await c.post(`/api/approvals/${id}/approve`, { confirm: 'restart gateway' });
    assert.equal(again.status, 409, 'an approval can never run twice');
  });

  test('rejecting leaves everything untouched and is audited', async () => {
    const c = await h.client();
    await c.elevate();
    const q = await c.post('/api/actions', { action: 'cron.create', params: { schedule: '0 7 * * *', prompt: 'Summarise the news', name: 'News' } });
    assert.equal(q.body.status, 'pending');
    const r = await c.post(`/api/approvals/${q.body.approval.id}/reject`);
    assert.equal(r.body.status, 'rejected');
    assert.equal(h.calls().filter((a) => a[0] === 'cron' && a[1] === 'create').length, 0);
    assert.ok(h.app.deps.audit.list({ outcome: 'denied' }).some((x) => x.action === 'cron.create' && /rejected/.test(x.detail)));
  });

  test('agent principals can only propose; humans decide', async () => {
    const token = h.app.deps.auth.addAgent('researcher-bot');
    const bearer = { authorization: `Bearer ${token}` };
    const propose = await fetch(h.base + '/api/actions', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer }, body: JSON.stringify({ action: 'gateway.restart', params: {} }) });
    const pj: any = await propose.json();
    assert.equal(propose.status, 200);
    assert.equal(pj.status, 'pending', 'agent proposals are always queued, even low-risk ones');

    const low = await fetch(h.base + '/api/actions', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer }, body: JSON.stringify({ action: 'inference.test', params: {} }) });
    assert.equal(((await low.json()) as any).status, 'pending');

    const approve = await fetch(h.base + `/api/approvals/${pj.approval.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer }, body: JSON.stringify({ confirm: 'restart gateway' }) });
    assert.equal(approve.status, 403, 'agent token must not reach approval endpoints');

    const humanOnly = await fetch(h.base + '/api/actions', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer }, body: JSON.stringify({ action: 'tailscale.serve.enable', params: {} }) });
    assert.equal(humanOnly.status, 403);

    for (const p of ['/api/overview', '/api/audit', '/api/openclaw/config']) {
      const r = await fetch(h.base + p, { headers: bearer });
      assert.equal(r.status, 403, `${p} must not accept agent tokens`);
    }
    const bogus = await fetch(h.base + '/api/actions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mca_notarealtoken' }, body: '{}' });
    assert.equal(bogus.status, 401);

    h.app.deps.auth.revokeAgent('researcher-bot');
    const revoked = await fetch(h.base + '/api/actions', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer }, body: JSON.stringify({ action: 'inference.test', params: {} }) });
    assert.equal(revoked.status, 401);
    const rows = h.app.deps.audit.list({ limit: 200 });
    assert.ok(rows.some((r) => r.actor === 'researcher-bot' && r.outcome === 'pending'));
    assert.ok(rows.some((r) => r.actor === 'researcher-bot' && r.outcome === 'denied'));
  });

  test('dangerous inputs are rejected before any command runs', async () => {
    const c = await h.client();
    await c.elevate();
    const calls0 = h.calls().length;
    const bad: Array<[string, unknown]> = [
      ['cron.run', { id: 'x; rm -rf /' }],
      ['cron.run', { id: '--all' }],
      ['cron.run', { id: '$(touch /tmp/pwned)' }],
      ['cron.run', { id: 'a b' }],
      ['cron.create', { schedule: '0 7 * * *', prompt: '--dangerous-flag' }],
      ['cron.create', { schedule: '; reboot', prompt: 'hi' }],
      ['cron.create', { schedule: '0 7 * * *', prompt: 'hi', name: 'x`id`' }],
      ['config.set', { path: 'channels.telegram.botToken', value: 'x' }],
      ['config.set', { path: 'gateway.auth.token', value: 'x' }],
      ['config.set', { path: '__proto__.polluted', value: 1 }],
      ['config.set', { path: 'a.b; rm', value: 1 }],
      ['config.set', { path: 'a.b', value: 'y'.repeat(3000) }],
      ['model.select', { model: '--evil' }],
      ['gateway.restart', { force: true }],
      ['config.restore', { backupId: '../../etc/passwd' }],
      ['tailscale.serve.enable', { httpsPort: 22 }],
      ['no.such.action', {}],
    ];
    for (const [action, params] of bad) {
      const r = await c.post('/api/actions', { action, params });
      assert.ok(r.status === 400 || r.status === 404 || r.status === 403, `${action} ${JSON.stringify(params).slice(0, 40)} → ${r.status}`);
    }
    assert.equal(h.calls().length, calls0, 'no CLI invocation may result from rejected input');
    assert.equal(({} as any).polluted, undefined);
  });

  test('pending identical proposals are de-duplicated', async () => {
    const c = await h.client();
    const a = await c.post('/api/actions', { action: 'config.set', params: { path: 'tools.profile', value: 'safe' } });
    const b = await c.post('/api/actions', { action: 'config.set', params: { path: 'tools.profile', value: 'safe' } });
    assert.equal(a.body.approval.id, b.body.approval.id);
  });

  test('every decision above left an audit trail with who/what/outcome/when and an intact chain', async () => {
    const rows = h.app.deps.audit.list({ limit: 500 });
    assert.ok(rows.length > 10);
    for (const r of rows) {
      assert.ok(r.actor && r.role && r.action && r.outcome && /^\d{4}-/.test(r.ts), JSON.stringify(r));
    }
    assert.ok(rows.some((r) => r.action === 'gateway.restart' && r.outcome === 'success' && r.verified === 1));
    assert.equal(h.app.deps.audit.verify().ok, true);
  });
});
