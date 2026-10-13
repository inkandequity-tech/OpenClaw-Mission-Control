import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, type Harness, type Client } from './helpers.ts';

async function approve(c: Client, action: string, params: unknown, phrase: string) {
  const q = await c.post('/api/actions', { action, params });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.status, 'pending');
  const r = await c.post(`/api/approvals/${q.body.approval.id}/approve`, { confirm: phrase });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

describe('config change, backup, restore and verified rollback', () => {
  let h: Harness;
  let c: Client;
  let baseline: string;
  before(async () => { h = await startHarness(); c = await h.client(); await c.elevate(); });
  after(async () => { await h.close(); });
  beforeEach(() => {
    h.setBehavior({ setMode: 'ok', validate: 'ok', restart: 'ok' });
    h.fakes.gatewayUp = true;
    fs.rmSync(path.join(h.stateDir, 'gateway-down'), { force: true });
    baseline = fs.readFileSync(path.join(h.home, 'openclaw.json'), 'utf8');
  });

  test('a baseline snapshot is taken at startup, before anything can change', () => {
    const list = h.app.deps.backups.list();
    assert.ok(list.length >= 1);
    assert.ok(list.some((b) => b.label.includes('startup')));
  });

  test('config.set applies, re-reads the file to verify, and keeps a backup', async () => {
    const r = await approve(c, 'config.set', { path: 'tools.profile', value: 'coding' }, 'set tools.profile');
    assert.equal(r.status, 'executed');
    assert.equal(r.result.verified, true);
    assert.equal(h.readConfig().tools.profile, 'coding');
    assert.ok(h.app.deps.backups.list().some((b) => b.label.includes('before config set tools.profile')));
    const diff = await c.get(`/api/backups/diff?from=${h.app.deps.backups.list().find((b) => b.label.includes('before config set tools.profile'))!.id}&to=current`);
    assert.equal(diff.body.changed, true);
    assert.ok(diff.body.lines.some((l: any) => l.op === '+' && l.text.includes('coding')));
    assert.ok(!JSON.stringify(diff.body).includes('GATEWAY-SECRET-TOKEN'), 'diffs are redacted');
  });

  test('if the CLI silently stores something else, the previous config is restored automatically', async () => {
    h.setBehavior({ setMode: 'wrong' });
    const r = await approve(c, 'config.set', { path: 'tools.profile', value: 'minimal' }, 'set tools.profile');
    assert.equal(r.status, 'failed');
    assert.equal(r.result.verified, false);
    assert.equal(r.result.data.rolledBack, true);
    assert.equal(fs.readFileSync(path.join(h.home, 'openclaw.json'), 'utf8'), baseline);
  });

  test('if validation fails after the change, the previous config is restored', async () => {
    const orig = h.setBehavior.bind(h);
    // validation passes before (restart gate not involved) but fails after config set: flip it via the CLI's set hook
    h.setBehavior({ validate: 'invalid' });
    const r = await approve(c, 'config.set', { path: 'tools.profile', value: 'minimal' }, 'set tools.profile');
    void orig;
    assert.equal(r.status, 'failed');
    assert.match(r.result.detail, /validation/i);
    assert.equal(fs.readFileSync(path.join(h.home, 'openclaw.json'), 'utf8'), baseline);
  });

  test('if the CLI refuses, the file is left exactly as it was', async () => {
    h.setBehavior({ setMode: 'fail' });
    const r = await approve(c, 'config.set', { path: 'tools.profile', value: 'minimal' }, 'set tools.profile');
    assert.equal(r.status, 'failed');
    assert.equal(fs.readFileSync(path.join(h.home, 'openclaw.json'), 'utf8'), baseline);
  });

  test('restore from a backup verifies the checksum; a bad restore is rolled back', async () => {
    const snap = (await c.post('/api/actions', { action: 'config.snapshot', params: { label: 'good state' } })).body.outcome.data;
    fs.writeFileSync(path.join(h.home, 'openclaw.json'), JSON.stringify({ ...h.readConfig(), tools: { profile: 'changed-outside' } }, null, 2));
    const ok = await approve(c, 'config.restore', { backupId: snap.id }, `restore ${snap.id}`);
    assert.equal(ok.status, 'executed');
    assert.equal(ok.result.verified, true);
    assert.equal(h.app.deps.backups.currentSha(), snap.sha256);

    // Now make validation fail after restoring an older snapshot → automatic rollback to pre-restore state
    fs.writeFileSync(path.join(h.home, 'openclaw.json'), JSON.stringify({ ...h.readConfig(), tools: { profile: 'x' } }, null, 2));
    const before = fs.readFileSync(path.join(h.home, 'openclaw.json'), 'utf8');
    h.setBehavior({ validate: 'invalid' });
    const bad = await approve(c, 'config.restore', { backupId: snap.id }, `restore ${snap.id}`);
    assert.equal(bad.status, 'failed');
    assert.equal(bad.result.data.rolledBack, true);
    assert.equal(fs.readFileSync(path.join(h.home, 'openclaw.json'), 'utf8'), before);
  });

  test('a tampered backup file is refused', async () => {
    const snap = (await c.post('/api/actions', { action: 'config.snapshot', params: { label: 'will be tampered' } })).body.outcome.data;
    fs.appendFileSync(path.join(h.app.deps.cfg.dataDir, 'backups', `${snap.id}.json`), ' ');
    const r = await approve(c, 'config.restore', { backupId: snap.id }, `restore ${snap.id}`);
    assert.equal(r.status, 'failed');
    assert.match(r.result.detail, /checksum/);
  });

  test('gateway restart refuses to restart into an invalid config', async () => {
    h.setBehavior({ validate: 'invalid' });
    const before = h.calls().filter((a) => a[1] === 'restart').length;
    const r = await approve(c, 'gateway.restart', {}, 'restart gateway');
    assert.equal(r.status, 'failed');
    assert.match(r.result.detail, /validate/i);
    assert.equal(h.calls().filter((a) => a[1] === 'restart').length, before);
  });

  test('restart is NOT reported as success when the gateway never comes back', async () => {
    h.setBehavior({ restartKillsGateway: true });
    const r = await approve(c, 'gateway.restart', {}, 'restart gateway');
    assert.equal(r.status, 'failed');
    assert.equal(r.result.verified, false);
    assert.match(r.result.detail, /did not become/);
    h.setBehavior({ restartKillsGateway: false });
  });

  test('restart CLI failure is surfaced (and still verified against the gateway)', async () => {
    h.setBehavior({ restart: 'fail', restartKillsGateway: false });
    const r = await approve(c, 'gateway.restart', {}, 'restart gateway');
    // the fake gateway is still up, so the end state is healthy; the CLI error must still be reported in the detail
    assert.match(r.result.detail, /exited 1|Error: close failed/);
  });
});

describe('workflows: approval gates, retries and failure recovery', () => {
  let h: Harness;
  let c: Client;
  before(async () => { h = await startHarness(); c = await h.client(); await c.elevate(); });
  after(async () => { await h.close(); });

  async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  test('restart-with-checks pauses at the gate, then verifies the gateway', async () => {
    const start = await c.post('/api/actions', { action: 'workflow.start', params: { template: 'restart-with-checks' } });
    assert.equal(start.body.status, 'executed');
    const runId = start.body.outcome.data.runId;
    const gate = await waitFor(async () => (await c.get('/api/approvals?status=pending')).body.approvals.find((a: any) => a.action === 'workflow.gate'));
    assert.equal((await c.get(`/api/workflows/${runId}`)).body.status, 'waiting_approval');
    assert.equal(h.calls().filter((a) => a[1] === 'restart').length, 0, 'no restart before the gate is approved');
    const ok = await c.post(`/api/approvals/${gate.id}/approve`, { confirm: 'proceed' });
    assert.equal(ok.status, 200);
    const run = await waitFor(async () => { const r = (await c.get(`/api/workflows/${runId}`)).body; return ['succeeded', 'failed', 'recovered'].includes(r.status) ? r : undefined; });
    assert.equal(run.status, 'succeeded', JSON.stringify(run.steps));
    assert.deepEqual(run.steps.map((s: any) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    assert.equal(h.calls().filter((a) => a[1] === 'restart').length, 1);
  });

  test('rejecting a gate fails the run without touching anything', async () => {
    const before = h.calls().filter((a) => a[1] === 'restart').length;
    const start = await c.post('/api/actions', { action: 'workflow.start', params: { template: 'restart-with-checks' } });
    const runId = start.body.outcome.data.runId;
    const gate = await waitFor(async () => (await c.get('/api/approvals?status=pending')).body.approvals.find((a: any) => a.action === 'workflow.gate' && a.params.runId === runId));
    await c.post(`/api/approvals/${gate.id}/reject`);
    const run = await waitFor(async () => { const r = (await c.get(`/api/workflows/${runId}`)).body; return ['succeeded', 'failed', 'recovered'].includes(r.status) ? r : undefined; });
    assert.equal(run.status, 'failed');
    assert.equal(h.calls().filter((a) => a[1] === 'restart').length, before);
  });

  test('config-change-with-rollback: a restart that never recovers triggers restore + re-check', async () => {
    const original = fs.readFileSync(path.join(h.home, 'openclaw.json'), 'utf8');
    h.setBehavior({ restartKillsGateway: true });
    const start = await c.post('/api/actions', { action: 'workflow.start', params: { template: 'config-change-with-rollback', params: { path: 'tools.profile', value: 'coding' } } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const runId = start.body.outcome.data.runId;
    for (const phrase of ['gate1', 'gate2']) {
      const gate = await waitFor(async () => (await c.get('/api/approvals?status=pending')).body.approvals.find((a: any) => a.action === 'workflow.gate' && a.params.runId === runId && a.params.stepId === phrase));
      await c.post(`/api/approvals/${gate.id}/approve`, { confirm: 'proceed' });
    }
    await waitFor(async () => ((await c.get(`/api/workflows/${runId}`)).body.steps.find((s: any) => s.id === 'restart')?.status === 'failed' ? true : undefined), 30000);
    h.setBehavior({ restartKillsGateway: false }); // the recovery restart can now succeed
    const run = await waitFor(async () => { const r = (await c.get(`/api/workflows/${runId}`)).body; return ['succeeded', 'failed', 'recovered'].includes(r.status) ? r : undefined; }, 30000);
    assert.equal(run.status, 'recovered', JSON.stringify([run.steps, run.recovery]));
    assert.equal(run.steps.find((s: any) => s.id === 'restart').status, 'failed');
    assert.ok(run.recovery.find((s: any) => s.id === 'rb-restore').status === 'ok');
    assert.equal(h.readConfig().tools.profile, JSON.parse(original).tools.profile, 'config rolled back to the pre-change value');
  });

  test('workflows left running by a crash are marked interrupted on restart', () => {
    h.app.deps.db.prepare("INSERT INTO workflow_runs(id,workflow,status,actor,started,finished,params,steps) VALUES('zombie','x','running','a','2026-01-01',NULL,'{}','{\"steps\":[],\"recovery\":[]}')").run();
    h.app.deps.workflows.bind(h.app.deps);
    assert.equal(h.app.deps.workflows.get('zombie').status, 'interrupted');
  });
});
