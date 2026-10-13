import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIX = path.join(HERE, 'fixtures');
export const PASSWORD = 'correct-horse-battery';

export interface Fakes {
  gatewayUp: boolean;
  gatewayReady: boolean;
  llm: { models: unknown; chatStatus: number; authRequired: boolean; calls: string[] };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

export interface Harness {
  app: App;
  base: string;
  port: number;
  dir: string;
  home: string;
  stateDir: string;
  fakes: Fakes;
  llmPort: number;
  setBehavior(patch: Record<string, unknown>): void;
  setTs(patch: Record<string, unknown>): void;
  calls(): string[][];
  readConfig(): any;
  client(opts?: { user?: string; password?: string; headers?: Record<string, string> }): Promise<Client>;
  close(): Promise<void>;
}

export interface Client {
  get(p: string, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  post(p: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  put(p: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }>;
  csrf: string;
  elevate(): Promise<void>;
}

export async function startHarness(opts: { overrides?: Partial<AppConfig>; llm?: boolean; gateway?: boolean; viewer?: boolean } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
  const home = path.join(dir, 'openclaw-home');
  const stateDir = path.join(dir, 'fake-state');
  fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs', 'stability'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const fakes: Fakes = { gatewayUp: true, gatewayReady: true, llm: { models: null, chatStatus: 200, authRequired: false, calls: [] } };

  // Fake OpenClaw gateway HTTP endpoints (/healthz, /readyz)
  const gw = http.createServer((req, res) => {
    if (!fakes.gatewayUp || fs.existsSync(path.join(stateDir, 'gateway-down'))) return req.socket.destroy();
    if (req.url === '/healthz') return res.end('{"ok":true}');
    if (req.url === '/readyz') { res.statusCode = fakes.gatewayReady ? 200 : 503; return res.end('{"ready":' + fakes.gatewayReady + '}'); }
    res.statusCode = 404; res.end();
  });
  const gwPort = await listen(gw);

  // Fake LM Studio (native v1 + OpenAI-compatible)
  fakes.llm.models = {
    models: [
      { type: 'llm', publisher: 'google', key: 'google/gemma-4-12b-qat', display_name: 'Gemma 4 12B QAT', architecture: 'gemma', quantization: { name: 'Q4_0', bits_per_weight: 4 }, size_bytes: 8_000_000_000, params_string: '12B', loaded_instances: [{ id: 'google/gemma-4-12b-qat', config: { context_length: 8192 } }], max_context_length: 262144, format: 'gguf', capabilities: { vision: false, trained_for_tool_use: true } },
      { type: 'embedding', publisher: 'nomic', key: 'nomic-embed', display_name: 'Nomic', quantization: null, size_bytes: 100, params_string: null, loaded_instances: [], max_context_length: 2048, format: 'gguf' },
    ],
  };
  const llm = http.createServer((req, res) => {
    fakes.llm.calls.push(`${req.method} ${req.url}`);
    if (fakes.llm.authRequired && req.headers.authorization !== 'Bearer secret-llm-token') { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/models') return res.end(JSON.stringify(fakes.llm.models));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'google/gemma-4-12b-qat' }] }));
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (fakes.llm.chatStatus !== 200) { res.statusCode = fakes.llm.chatStatus; return res.end('{"error":"model crashed"}'); }
        const j = JSON.parse(body);
        if (j.stream) {
          res.setHeader('content-type', 'text/event-stream');
          const answer = j.messages[0].content.includes('multiplied') ? '391' : j.messages[0].content.includes('JSON') ? '{"name":"Ada","year":1815}' : j.messages[0].content.includes('fruits') ? 'apple\nbanana\ncherry' : j.messages[0].content.includes('bloops') ? 'Yes' : Array(150).fill('ocean').join(' ');
          for (const piece of answer.match(/.{1,20}/gs) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 42 } })}\n\ndata: [DONE]\n\n`);
          return res.end();
        }
        res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 9, completion_tokens: 1 } }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  const llmPort = opts.llm === false ? 1 : await listen(llm);

  fs.writeFileSync(path.join(home, 'openclaw.json'), JSON.stringify({
    gateway: { mode: 'local', port: gwPort, bind: 'tailnet', auth: { mode: 'token', token: 'GATEWAY-SECRET-TOKEN-123456' }, controlUi: { allowedOrigins: ['http://100.87.186.59:18789'] } },
    agents: { defaults: { model: 'lmstudio/google/gemma-4-12b-qat', workspace: path.join(home, 'workspace'), systemAgent: { agentId: 'vedika' } }, entries: { vedika: { name: 'vedika', identity: { name: 'Chief of Staff' }, workspace: path.join(home, 'workspace', 'vedika') } } },
    models: { providers: { lmstudio: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, api: 'openai-completions', apiKey: 'lm-secret-key-0000', models: [{ id: 'google/gemma-4-12b-qat' }] } } },
    channels: { telegram: { enabled: true, botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' } },
    commands: { ownerAllowFrom: ['telegram:1000000001'] },
    bindings: [{ agentId: 'vedika', match: { channel: 'telegram', accountId: 'default' } }],
    tools: { profile: 'full' },
  }, null, 2), { mode: 0o600 });

  const behaviorFile = path.join(stateDir, 'behavior.json');
  const tsFile = path.join(stateDir, 'ts.json');
  fs.writeFileSync(behaviorFile, '{}');
  fs.writeFileSync(tsFile, '{}');
  // Per-harness wrapper scripts keep fixtures isolated (no process-global env between concurrent harnesses).
  const wrap = (name: string, script: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!/bin/sh\nexport OPENCLAW_FAKE_STATE='${stateDir}'\nexport OPENCLAW_HOME_DIR='${home}'\nexec node '${path.join(FIX, script)}' "$@"\n`, { mode: 0o755 });
    return f;
  };
  const ocBin = wrap('openclaw', 'fake-openclaw.mjs');
  const tsBin = wrap('tailscale', 'fake-tailscale.mjs');

  const app = await createApp({
    host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data'), openclawHome: home, fileRoots: [path.join(home, 'workspace')],
    openclawBin: ocBin, tailscaleBin: tsBin,
    background: false, restartWaitMs: 1500, retryScale: 0.01, cmdTimeoutMs: 15000, ...opts.overrides,
  }, { ...process.env });
  const addr = await app.start();
  await app.deps.auth.setUser('admin', 'operator', PASSWORD);
  if (opts.viewer) await app.deps.auth.setUser('viewer1', 'viewer', PASSWORD);
  const base = `http://127.0.0.1:${addr.port}`;

  const h: Harness = {
    app, base, port: addr.port, dir, home, stateDir, fakes, llmPort,
    setBehavior: (patch) => fs.writeFileSync(behaviorFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(behaviorFile, 'utf8')), ...patch })),
    setTs: (patch) => fs.writeFileSync(tsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(tsFile, 'utf8')), ...patch })),
    calls: () => (fs.existsSync(path.join(stateDir, 'calls.log')) ? fs.readFileSync(path.join(stateDir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    readConfig: () => JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8')),
    async client(o = {}) {
      let cookie = '';
      const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
        const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...o.headers, ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch { /* keep text */ }
        return { status: res.status, body: parsed, headers: res.headers };
      };
      let csrf = '';
      const login = await call('POST', '/api/login', { user: o.user ?? 'admin', password: o.password ?? PASSWORD });
      if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
      cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
      csrf = login.body.csrf;
      return {
        get: (p, headers) => call('GET', p, undefined, headers),
        post: (p, body = {}, headers) => call('POST', p, body, headers),
        put: (p, body = {}) => call('PUT', p, body),
        csrf,
        async elevate() { const r = await call('POST', '/api/elevate', { password: o.password ?? PASSWORD }); if (r.status !== 200) throw new Error('elevate failed'); },
      };
    },
    async close() {
      await app.stop();
      await new Promise<void>((r) => { gw.closeAllConnections(); gw.close(() => r()); });
      await new Promise<void>((r) => { llm.closeAllConnections(); llm.close(() => r()); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Raw request with a custom Host header (fetch forbids overriding Host). */
export function rawRequest(port: number, p: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
