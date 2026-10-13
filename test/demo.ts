// DEV PREVIEW ONLY: runs the real app against the test fixtures (fake openclaw/tailscale/LM Studio and a real
// telemetry agent reading a fake nvidia-smi) so the UI can be inspected without the Mac. Never used in production.
//   node test/demo.ts   ->  http://127.0.0.1:7799  user: admin  password: correct-horse-battery
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startHarness, FIX, PASSWORD } from './helpers.ts';

const agentPort = 17777;
const AGENT = path.join(FIX, '..', '..', 'tools', 'windows-telemetry-agent.mjs');
const agent = spawn('node', [AGENT, '--host', '127.0.0.1', '--port', String(agentPort), '--token', 'demo-token-demo-token', '--nvidia-smi', path.join(FIX, 'fake-nvidia-smi.sh')], { stdio: 'inherit' });
const h = await startHarness({ overrides: { port: 7799, windowsTelemetryUrl: `http://127.0.0.1:${agentPort}`, windowsTelemetryToken: 'demo-token-demo-token', background: true } });
await h.app.deps.auth.setUser('viewer1', 'viewer', PASSWORD);
console.log(`DEMO ready: ${h.base}  admin / ${PASSWORD}  (viewer1 is read-only)`);
process.on('SIGTERM', () => { agent.kill(); void h.close().then(() => process.exit(0)); });
