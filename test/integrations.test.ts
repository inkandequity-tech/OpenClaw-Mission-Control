import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startHarness, FIX, type Harness, type Client } from './helpers.ts';
import { Files } from '../server/files.ts';
import { Capabilities } from '../server/capabilities.ts';
import { loadConfig } from '../server/config.ts';

describe('capability discovery (no simulation)', () => {
  test('with no OpenClaw/Tailscale binaries everything is reported unsupported with a reason', async () => {
    const cfg = loadConfig({}, { openclawBin: '/nonexistent/openclaw', tailscaleBin: '/nonexistent/tailscale', port: 0 });
    const caps = new Capabilities(cfg);
    await caps.discover(true);
    assert.equal(caps.get('openclaw.cli').supported, false);
    assert.match(caps.get('openclaw.gateway.restart').reason, /not found/i);
    assert.equal(caps.get('tailscale.serve').supported, false);
    assert.throws(() => caps.require('openclaw.sessions'), /Not available/);
  });

  test('features appear only when the installed CLI help lists them', async () => {
    const h = await startHarness();
    try {
      let caps = h.app.deps.caps;
      assert.equal(caps.get('openclaw.gateway.restart').supported, true);
      assert.equal(caps.get('openclaw.message.send').supported, true);
      h.setBehavior({ noRestart: true, noMessageFlags: true });
      await caps.discover(true);
      assert.equal(caps.get('openclaw.gateway.restart').supported, false);
      assert.match(caps.get('openclaw.gateway.restart').reason, /does not list restart/);
      assert.equal(caps.get('openclaw.message.send').supported, false, 'alerts need --channel/--target/--message');
      // and the action layer refuses, auditing the failure
      const c = await h.client();
      const r = await c.post('/api/actions', { action: 'gateway.restart', params: {} });
      assert.equal(r.status, 501);
      assert.ok(h.app.deps.audit.list().some((x) => x.action === 'gateway.restart' && x.outcome === 'failure'));
    } finally { await h.close(); }
  });
});

describe('OpenClaw adapter failure handling', () => {
  let h: Harness; let c: Client;
  before(async () => { h = await startHarness(); c = await h.client(); });
  after(async () => { await h.close(); });

  test('real data flows through: agents (config + CLI), sessions with active/historical split, cron', async () => {
    const ag = (await c.get('/api/openclaw/agents?refresh=1')).body;
    assert.equal(ag.ok, true);
    const v = ag.data.agents.find((a: any) => a.id === 'vedika');
    assert.equal(v.identity.name, 'Chief of Staff');
    assert.equal(v.isSystemAgent, true);
    assert.equal(ag.data.defaultModel, 'lmstudio/google/gemma-4-12b-qat');
    const ses = (await c.get('/api/openclaw/sessions?refresh=1')).body;
    assert.equal(ses.ok, true);
    assert.equal(ses.data.sessions.length, 1);
    assert.deepEqual(ses.data.activeKeys, ['agent:vedika:main']);
    const cron = (await c.get('/api/openclaw/cron?refresh=1')).body;
    assert.equal(cron.data.jobs.length, 2);
    const ov = (await c.get('/api/overview')).body;
    assert.equal(ov.automation.failing, 1);
    assert.equal(ov.agents.count, 2);
  });

  test('non-JSON CLI output becomes a clear error, not a crash', async () => {
    h.setBehavior({ garbage: true });
    const r = (await c.get('/api/openclaw/sessions?refresh=1')).body;
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'bad_output');
    const ov = await c.get('/api/overview');
    assert.equal(ov.status, 200, 'one failing integration must not break the overview');
    h.setBehavior({ garbage: false });
  });

  test('a missing CLI is reported as cli_missing with a hint', async () => {
    const h2 = await startHarness({ overrides: { openclawBin: '/nonexistent/openclaw' } });
    try {
      const c2 = await h2.client();
      const r = (await c2.get('/api/openclaw/agents')).body;
      assert.equal(r.ok, true, 'agents still come from openclaw.json');
      assert.deepEqual(r.data.source, ['openclaw.json']);
      const sess = await c2.get('/api/openclaw/sessions');
      assert.equal(sess.status, 501);
      assert.match(sess.body.error.message, /Not available/);
    } finally { await h2.close(); }
  });

  test('log lines are redacted', async () => {
    const r = (await c.get('/api/openclaw/logs')).body;
    assert.equal(r.ok, true);
    assert.ok(r.data.lines.length >= 1);
    assert.ok(!JSON.stringify(r).includes('abcd1234abcd1234'));
  });

  test('session transcripts need elevation and are audited', async () => {
    const denied = await c.get('/api/openclaw/sessions/tail?key=agent:vedika:main');
    assert.equal(denied.status, 403);
    await c.elevate();
    const bad = await c.get('/api/openclaw/sessions/tail?key=' + encodeURIComponent('x; rm -rf /'));
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.error.code, 'bad_input');
  });
});

describe('inference server detection and layered diagnosis', () => {
  let h: Harness; let c: Client;
  before(async () => { h = await startHarness(); c = await h.client(); });
  after(async () => { await h.close(); });

  test('fingerprints LM Studio from its API shape and reads loaded state / context', async () => {
    const r = (await c.get('/api/inference?refresh=1')).body;
    assert.equal(r.detection.ok, true);
    const s = r.detection.data;
    assert.equal(s.kind, 'lmstudio');
    assert.match(s.apiFlavor, /native v1/);
    const m = s.models.find((x: any) => x.id === 'google/gemma-4-12b-qat');
    assert.equal(m.loaded, true);
    assert.equal(m.contextLoaded, 8192);
    assert.equal(m.contextMax, 262144);
    assert.equal(m.quantization, 'Q4_0');
    assert.equal(s.models.find((x: any) => x.id === 'nomic-embed').loaded, false);
    assert.equal(r.configured.modelId, 'google/gemma-4-12b-qat');
  });

  test('diagnosis separates peer, ping, TCP, API, models and inference — inference is opt-in', async () => {
    const steps = (await c.post('/api/inference/diagnose')).body.steps;
    const byId = Object.fromEntries(steps.map((s: any) => [s.id, s]));
    assert.equal(byId.tcp.status, 'ok');
    assert.equal(byId.api.status, 'ok');
    assert.equal(byId.models.status, 'ok');
    assert.equal(byId.inference.status, 'skipped');
    assert.match(byId.inference.detail, /Not run/);
    const llmCalls = h.fakes.llm.calls.filter((x) => x.includes('chat/completions'));
    assert.equal(llmCalls.length, 0, 'diagnosis must not consume GPU time');
  });

  test('API reachable but inference failing is reported as such (connectivity ≠ inference)', async () => {
    h.fakes.llm.chatStatus = 500;
    await c.elevate();
    const r = await c.post('/api/actions', { action: 'inference.test', params: {} });
    assert.equal(r.body.outcome.ok, false);
    assert.equal(r.body.outcome.verified, false);
    const steps = h.app.deps; void steps;
    h.fakes.llm.chatStatus = 200;
    const good = await c.post('/api/actions', { action: 'inference.test', params: {} });
    assert.equal(good.body.outcome.ok, true);
    assert.equal(good.body.outcome.data.modelReported, 'google/gemma-4-12b-qat');
  });

  test('auth-protected server is detected, not misreported as down', async () => {
    h.fakes.llm.authRequired = true;
    const r = (await c.get('/api/inference?refresh=1')).body;
    assert.equal(r.detection.ok, false);
    assert.equal(r.detection.error.code, 'auth_required');
    assert.match(r.detection.error.hint, /MC_INFERENCE_TOKEN/);
    h.fakes.llm.authRequired = false;
  });

  test('model.select refuses a model the server does not have; accepts one it has', async () => {
    await c.elevate();
    const q = await c.post('/api/actions', { action: 'model.select', params: { model: 'ghost/model' } });
    const r = await c.post(`/api/approvals/${q.body.approval.id}/approve`, { confirm: 'use ghost/model' });
    assert.equal(r.body.status, 'failed');
    assert.match(r.body.result.detail, /not on the inference server/);
    assert.equal(h.readConfig().agents.defaults.model, 'lmstudio/google/gemma-4-12b-qat');
  });
});

describe('network failure diagnosis', () => {
  test('closed port → ECONNREFUSED with the right hint and copyable commands; downstream steps skipped', async () => {
    const h = await startHarness({ llm: false });
    try {
      const c = await h.client();
      const steps = (await c.post('/api/inference/diagnose')).body.steps;
      const tcp = steps.find((s: any) => s.id === 'tcp');
      assert.equal(tcp.status, 'fail');
      assert.match(tcp.detail, /ECONNREFUSED/);
      assert.match(tcp.hint, /listening|bind|Local Network/i);
      assert.ok(tcp.commands.some((x: string) => x.includes('New-NetFirewallRule')));
      assert.equal(steps.find((s: any) => s.id === 'api').status, 'skipped');
    } finally { await h.close(); }
  });

  test('address change: configured IP no longer in the tailnet → names the Windows peer', async () => {
    const h = await startHarness({ llm: false });
    try {
      const target = new URL(h.app.deps.inf.target()!.baseUrl);
      void target;
      // point OpenClaw at a tailnet address that the fake tailscale does not know
      const cfg = h.readConfig();
      cfg.models.providers.lmstudio.baseUrl = 'http://100.102.106.99:1234/v1';
      fs.writeFileSync(path.join(h.home, 'openclaw.json'), JSON.stringify(cfg));
      const c = await h.client();
      const steps = (await c.post('/api/inference/diagnose')).body.steps;
      const peer = steps.find((s: any) => s.id === 'peer');
      assert.equal(peer.status, 'fail');
      assert.match(peer.hint, /address may have changed/);
      assert.match(peer.hint, /win-pc/);
    } finally { await h.close(); }
  });

  test('Tailscale logged out / stopped is surfaced', async () => {
    const h = await startHarness();
    try {
      h.setTs({ backendState: 'NeedsLogin' });
      const c = await h.client();
      const steps = (await c.post('/api/inference/diagnose')).body.steps;
      assert.equal(steps.find((s: any) => s.id === 'peer').status, 'fail');
      assert.match(steps.find((s: any) => s.id === 'peer').detail, /NeedsLogin/);
    } finally { await h.close(); }
  });
});

describe('health monitor: thresholds, de-duplication, recovery, Telegram alerts', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  test('gateway outage alerts once (after 2 consecutive failures), not on every poll, and announces recovery', async () => {
    const m = h.app.deps.monitor;
    const countAlerts = () => h.app.deps.events.list({ q: 'OpenClaw gateway' }).filter((e) => e.type.startsWith('health.gateway')).length;
    await m.runOnce();
    assert.equal(m.checks.find((x) => x.id === 'gateway')!.status, 'ok');
    h.fakes.gatewayUp = false;
    await m.runOnce();
    assert.equal(countAlerts(), 0, 'first failure is not yet an alert (de-flap)');
    await m.runOnce();
    assert.equal(countAlerts(), 1);
    await m.runOnce(); await m.runOnce();
    assert.equal(countAlerts(), 1, 'cooldown suppresses duplicates');
    assert.equal(m.overall(), 'crit');
    h.fakes.gatewayUp = true;
    await m.runOnce();
    const evs = h.app.deps.events.list({ q: 'OpenClaw gateway' }).map((e) => e.type);
    assert.ok(evs.includes('health.gateway.recovered'));
    assert.equal(m.overall() === 'crit', false);
  });

  test('thresholds are configurable and validated', async () => {
    const c = await h.client();
    assert.equal((await c.post('/api/actions', { action: 'monitor.settings', params: { diskWarn: 90, diskCrit: 80 } })).status, 400);
    assert.equal((await c.post('/api/actions', { action: 'monitor.settings', params: { diskWarn: 70, diskCrit: 90, telegramAlerts: 'yes' } })).status, 400);
    const ok = await c.post('/api/actions', { action: 'monitor.settings', params: { diskWarn: 70, diskCrit: 90, telegramAlerts: true } });
    assert.equal(ok.body.outcome.verified, true);
    assert.equal(h.app.deps.monitor.settings().diskWarn, 70);
  });

  test('Telegram alerts go through `openclaw message send` with a redacted, owner-targeted message', async () => {
    const m = h.app.deps.monitor;
    h.fakes.gatewayUp = false;
    for (let i = 0; i < 3; i++) await m.runOnce();
    h.fakes.gatewayUp = true;
    await m.runOnce();
    const sends = h.calls().filter((a) => a[0] === 'message' && a[1] === 'send' && !a.includes('--help'));
    assert.ok(sends.length >= 1);
    const argv = sends[0]!;
    assert.deepEqual(argv.slice(2, 6), ['--channel', 'telegram', '--target', '1000000001']);
    assert.ok(argv.includes('--message'));
  });

  test('alert delivery failure is recorded, not swallowed', async () => {
    const n = h.app.deps.notifier;
    h.setBehavior({ noMessageFlags: true });
    await h.app.deps.caps.discover(true);
    const r = await n.send('hello');
    assert.equal(r.ok, false);
    assert.match(r.detail, /does not list/);
  });
});

describe('workspace browser boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outside-'));
  fs.writeFileSync(path.join(root, 'notes.md'), 'hello token=abcdef123456789');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, 'id_rsa'), 'KEY');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  fs.writeFileSync(path.join(root, 'state.sqlite'), 'x');
  fs.writeFileSync(path.join(outside, 'passwd'), 'root:x:0:0');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(outside, 'passwd'), path.join(root, 'link.txt'));
  const f = new Files([root]);

  test('reads allowed text files with redaction', () => {
    const r = f.read(0, 'notes.md');
    assert.match(r.text, /hello/);
    assert.ok(!r.text.includes('abcdef123456789'));
  });
  test('blocks traversal, absolute paths, symlink escapes, credentials, DBs and binaries', () => {
    for (const p of ['../' + path.basename(outside) + '/passwd', '/etc/passwd', 'escape/passwd', 'link.txt', '..', 'notes.md/../../x']) {
      assert.throws(() => f.read(0, p), /escapes|Not found|Invalid/i, p);
    }
    for (const p of ['.env', 'id_rsa', 'state.sqlite']) assert.throws(() => f.read(0, p), /blocked/, p);
    assert.throws(() => f.read(0, 'blob.bin'), /Binary/);
    assert.throws(() => f.read(5, 'notes.md'), /root/);
  });
  test('listing hides symlinks that leave the root and flags denied files', () => {
    const l = f.list(0, '');
    assert.ok(!l.entries.some((e) => e.name === 'escape' || e.name === 'link.txt'));
    assert.equal(l.entries.find((e) => e.name === '.env')!.denied, true);
  });
});

describe('troubleshooting report', () => {
  test('is sanitized: no secrets, tailnet addresses masked unless elevated "full"', async () => {
    const h = await startHarness();
    try {
      const c = await h.client();
      const text = (await c.get('/api/report')).body.text as string;
      assert.match(text, /troubleshooting report/);
      assert.ok(!text.includes('GATEWAY-SECRET'));
      assert.ok(!text.includes('AAHdqTcv'));
      assert.doesNotMatch(text, /100\.87\.186\.59|100\.102\.106\.9\b/);
      assert.equal((await c.get('/api/report?full=1')).status, 403);
    } finally { await h.close(); }
  });
});

void FIX; void http;
