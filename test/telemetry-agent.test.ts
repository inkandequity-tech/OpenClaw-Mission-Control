import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { FIX } from './helpers.ts';

const AGENT = path.join(FIX, '..', '..', 'tools', 'windows-telemetry-agent.mjs');
const TOKEN = 'a-long-random-token-for-tests';

function start(port: number, extra: string[] = []): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [AGENT, '--host', '127.0.0.1', '--port', String(port), '--token', TOKEN, '--nvidia-smi', path.join(FIX, 'fake-nvidia-smi.sh'), ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout!.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
    p.on('error', reject);
    setTimeout(() => reject(new Error('agent did not start')), 5000);
  });
}

test('telemetry agent refuses to start without a strong token', () => {
  const r = spawnSync('node', [AGENT, '--port', '0'], { encoding: 'utf8', env: { ...process.env, MC_TELEMETRY_TOKEN: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Refusing to start/);
});

test('telemetry agent requires the bearer token and reports schema 1 GPU data', async () => {
  const port = 17900 + Math.floor(Math.random() * 500);
  const p = await start(port);
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/metrics`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    const j: any = await ok.json();
    assert.equal(j.schema, 1);
    assert.equal(j.nvidiaSmi, true);
    assert.deepEqual(j.gpus[0], { name: 'NVIDIA GeForce RTX 4070', utilPercent: 37, memUsedMiB: 9450, memTotalMiB: 12282, tempC: 61, powerW: 142.5 });
    assert.ok(j.memory.totalBytes > 0);
    assert.equal((await fetch(`${base}/other`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
  } finally { p.kill(); }
});

test('missing nvidia-smi is reported honestly, not faked', async () => {
  const port = 18500 + Math.floor(Math.random() * 400);
  const p = await new Promise<ChildProcess>((resolve, reject) => {
    const c = spawn('node', [AGENT, '--host', '127.0.0.1', '--port', String(port), '--token', TOKEN, '--nvidia-smi', '/nonexistent/nvidia-smi'], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout!.on('data', (d) => String(d).includes('listening') && resolve(c));
    c.on('error', reject);
  });
  try {
    const j: any = await (await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(j.nvidiaSmi, false);
    assert.deepEqual(j.gpus, []);
  } finally { p.kill(); }
});
