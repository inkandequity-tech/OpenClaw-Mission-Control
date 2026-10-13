#!/usr/bin/env node
// TEST FIXTURE ONLY. A stand-in `openclaw` executable driven by $OPENCLAW_FAKE_STATE/behavior.json,
// so the real adapters (argv building, JSON parsing, error handling) can be exercised in tests.
import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.OPENCLAW_FAKE_STATE;
const home = process.env.OPENCLAW_HOME_DIR;
const b = JSON.parse(fs.readFileSync(path.join(stateDir, 'behavior.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(stateDir, 'calls.log'), JSON.stringify(argv) + '\n');
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o) + '\n');
const cfgFile = path.join(home, 'openclaw.json');

if (b.garbage && argv.includes('--json')) { out('this is not json at all'); process.exit(0); }
if (argv[0] === '--version') { out('OpenClaw 2026.10.2\n'); process.exit(0); }

if (argv.includes('--help')) {
  const c = argv[0];
  const lines = {
    gateway: ['health', 'status', 'probe', ...(b.noRestart ? [] : ['restart'])],
    status: ['--json', '--deep', '--timeout'],
    sessions: ['--json', '--all-agents', '--active', 'tail'],
    agents: ['list', 'bindings'],
    cron: ['list', 'status', 'enable', 'disable', 'run', 'create'],
    channels: ['status', 'list'],
    models: ['status', 'list'],
    logs: ['--json', '--limit'],
    config: ['validate', 'set', 'get'],
    security: ['audit'],
    devices: ['list'],
    message: ['send'],
  }[c] ?? [];
  if (c === 'message' && argv[1] === 'send') out(`Usage: openclaw message send\nOptions:\n  ${b.noMessageFlags ? '--to <x>' : '--channel <c>\n  --target <t>\n  --message <m>'}\n`);
  else out(`Usage: openclaw ${c}\n\nCommands and options:\n${lines.map((l) => `  ${l}  description`).join('\n')}\n`);
  process.exit(0);
}

const cmd = argv.join(' ');
if (cmd.startsWith('gateway restart')) {
  if (b.restart === 'fail') { process.stderr.write('Error: close failed\n'); process.exit(1); }
  if (b.restartKillsGateway) fs.writeFileSync(path.join(stateDir, 'gateway-down'), '1');
  else fs.rmSync(path.join(stateDir, 'gateway-down'), { force: true });
  out('restarted\n');
} else if (cmd.startsWith('config validate')) {
  if (b.validate === 'invalid') { out({ valid: false, errors: ['bad value at agents.defaults.model'] }); process.exit(1); }
  out({ valid: true });
} else if (cmd.startsWith('config set')) {
  const [, , p, v] = argv;
  if (b.setMode === 'fail') { process.stderr.write('refused\n'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const toks = p.match(/[A-Za-z_][A-Za-z0-9_-]*|\[\d+\]/g);
  let cur = cfg;
  toks.forEach((t, i) => {
    const k = t.startsWith('[') ? Number(t.slice(1, -1)) : t;
    if (i === toks.length - 1) {
      let val; try { val = JSON.parse(v); } catch { val = v; }
      cur[k] = b.setMode === 'wrong' ? 'SOMETHING-ELSE' : val;
    } else { cur[k] ??= {}; cur = cur[k]; }
  });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  out({ ok: true });
} else if (cmd.startsWith('sessions') && argv.includes('--json')) {
  const active = argv.includes('--active');
  const rows = (b.sessions ?? [{ agentId: 'vedika', key: 'agent:vedika:main', model: 'lmstudio/google/gemma-4-12b-qat', updatedAt: Date.now() - 60_000 }]);
  out({ path: 'x', stores: 1, allAgents: true, count: rows.length, totalCount: rows.length, hasMore: false, sessions: active ? rows.slice(0, 1) : rows });
} else if (cmd.startsWith('agents list')) {
  out([{ id: 'vedika', isDefault: true, model: 'lmstudio/google/gemma-4-12b-qat' }, { id: 'writer' }]);
} else if (cmd.startsWith('cron list')) {
  out({ jobs: b.jobs ?? [{ id: 'job1', name: 'Morning brief', enabled: true, status: 'ok' }, { id: 'job2', name: 'Broken', enabled: true, status: 'error' }] });
} else if (cmd.startsWith('cron status')) {
  out({ enabled: true });
} else if (cmd.startsWith('cron run')) {
  out({ ok: true, enqueued: true, runId: 'run-123' });
} else if (cmd.startsWith('cron enable') || cmd.startsWith('cron disable')) {
  const on = cmd.startsWith('cron enable');
  b.jobs = (b.jobs ?? [{ id: 'job1', name: 'Morning brief', enabled: true, status: 'ok' }, { id: 'job2', name: 'Broken', enabled: true, status: 'error' }]).map((j) => (j.id === argv[2] ? { ...j, enabled: on, status: on ? 'ok' : 'disabled' } : j));
  fs.writeFileSync(path.join(stateDir, 'behavior.json'), JSON.stringify(b));
  out({ ok: true });
} else if (cmd.startsWith('channels status')) {
  out(b.channels ?? { channels: { telegram: { running: true, probe: { ok: true } } } });
} else if (cmd.startsWith('models status')) {
  out({ default: 'lmstudio/google/gemma-4-12b-qat' });
} else if (cmd.startsWith('logs')) {
  out(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: 'delivery failed token=abcd1234abcd1234 for chat' }) + '\n');
} else if (cmd.startsWith('message send')) {
  out({ ok: true });
} else if (cmd.startsWith('security audit')) {
  out({ findings: [] });
} else if (cmd.startsWith('devices list')) {
  out({ devices: [{ id: 'dev1', name: 'phone' }] });
} else {
  process.stderr.write(`unknown fake command: ${cmd}\n`);
  process.exit(3);
}
