import net from 'node:net';
import type { AppConfig } from '../config.ts';
import type { Capabilities } from '../capabilities.ts';
import type { DiagStep, Result } from '../types.ts';
import { fetchJson, pick, timed, asArray, fail } from '../util.ts';
import { redactDeep, redactString } from '../redact.ts';
import type { OpenClaw } from './openclaw.ts';
import type { Tailscale } from './tailscale.ts';

export type ServerKind = 'lmstudio' | 'ollama' | 'llamacpp' | 'openai-compatible' | 'unknown';

export interface ModelInfo {
  id: string;
  name: string;
  type: string;
  loaded: boolean | null;
  contextLoaded: number | null;
  contextMax: number | null;
  quantization: string | null;
  arch: string | null;
  publisher: string | null;
  sizeBytes: number | null;
  params: string | null;
  format: string | null;
  toolUse: boolean | null;
  vision: boolean | null;
}

export interface ServerInfo {
  baseUrl: string;
  origin: string;
  host: string;
  port: number;
  kind: ServerKind;
  apiFlavor: string | null;
  authRequired: boolean;
  models: ModelInfo[];
  probes: Array<{ path: string; status: number; ms: number; note?: string }>;
  detectedAt: string;
  /** Which source supplied the URL: env override or an OpenClaw provider entry. */
  source: string;
}

const blankModel = (id: string): ModelInfo => ({
  id, name: id, type: 'llm', loaded: null, contextLoaded: null, contextMax: null, quantization: null, arch: null,
  publisher: null, sizeBytes: null, params: null, format: null, toolUse: null, vision: null,
});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function tcpCheck(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; code?: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean, code?: string) => {
      s.destroy();
      resolve({ ok, code, ms: Date.now() - t0 });
    };
    s.setTimeout(timeoutMs, () => done(false, 'ETIMEDOUT'));
    s.once('connect', () => done(true));
    s.once('error', (e: NodeJS.ErrnoException) => done(false, e.code ?? 'ERROR'));
  });
}

/**
 * Detects the inference server by probing documented endpoints and fingerprinting the response
 * shapes. The URL itself comes from trusted local configuration only, never from the browser.
 */
export class Inference {
  private cfg: AppConfig;
  private caps: Capabilities;
  private oc: OpenClaw;
  private ts: Tailscale;
  private last: Result<ServerInfo> | null = null;

  constructor(cfg: AppConfig, caps: Capabilities, oc: OpenClaw, ts: Tailscale) {
    this.cfg = cfg;
    this.caps = caps;
    this.oc = oc;
    this.ts = ts;
  }

  target(): { baseUrl: string; source: string; provider: string | null } | null {
    if (this.cfg.inferenceUrl) return { baseUrl: this.cfg.inferenceUrl.replace(/\/+$/, ''), source: 'MC_INFERENCE_URL', provider: null };
    const cfgModel = this.oc.configuredModel();
    const providers = this.oc.providerBaseUrls();
    const p = providers.find((x) => x.provider === cfgModel.provider) ?? providers[0];
    return p ? { baseUrl: p.baseUrl.replace(/\/+$/, ''), source: `openclaw.json → models.providers.${p.provider}`, provider: p.provider } : null;
  }

  private headers(): Record<string, string> {
    return this.cfg.inferenceToken ? { authorization: `Bearer ${this.cfg.inferenceToken}` } : {};
  }

  lastDetect(): Result<ServerInfo> | null {
    return this.last;
  }

  async detect(): Promise<Result<ServerInfo>> {
    this.last = await timed<ServerInfo>(async () => {
      const t = this.target();
      if (!t) return fail('no_target', 'No inference server URL found', 'Set MC_INFERENCE_URL or add a provider baseUrl to OpenClaw config.');
      const url = new URL(t.baseUrl);
      const origin = url.origin;
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      const probes: ServerInfo['probes'] = [];
      let authRequired = false;
      const get = async (p: string) => {
        const r = await fetchJson(origin + p, { headers: this.headers(), timeoutMs: 5000 });
        probes.push({ path: p, status: r.status, ms: r.ms, note: r.error });
        if (r.status === 401 || r.status === 403) authRequired = true;
        return r;
      };

      let kind: ServerKind = 'unknown';
      let apiFlavor: string | null = null;
      let models: ModelInfo[] = [];

      const v1 = await get('/api/v1/models');
      const v1list = asArray(pick(v1.json, ['models']));
      if (v1.ok && v1list.some((m) => m && typeof m === 'object' && ('key' in (m as object) || 'loaded_instances' in (m as object)))) {
        kind = 'lmstudio';
        apiFlavor = 'LM Studio native v1 (/api/v1)';
        models = v1list.map((m: any) => {
          const x = blankModel(String(m.key ?? m.id));
          const inst = asArray(m.loaded_instances);
          return {
            ...x,
            name: str(m.display_name) ?? x.id,
            type: str(m.type) ?? 'llm',
            loaded: inst.length > 0,
            contextLoaded: num((inst[0] as any)?.config?.context_length),
            contextMax: num(m.max_context_length),
            quantization: str(m.quantization?.name),
            arch: str(m.architecture),
            publisher: str(m.publisher),
            sizeBytes: num(m.size_bytes),
            params: str(m.params_string),
            format: str(m.format),
            toolUse: typeof m.capabilities?.trained_for_tool_use === 'boolean' ? m.capabilities.trained_for_tool_use : null,
            vision: typeof m.capabilities?.vision === 'boolean' ? m.capabilities.vision : null,
          };
        });
      } else {
        const v0 = await get('/api/v0/models');
        const v0list = asArray(pick(v0.json, ['data']));
        if (v0.ok && v0list.some((m) => m && typeof m === 'object' && ('state' in (m as object) || 'compatibility_type' in (m as object)))) {
          kind = 'lmstudio';
          apiFlavor = 'LM Studio REST v0 (/api/v0)';
          models = v0list.map((m: any) => ({
            ...blankModel(String(m.id)),
            type: str(m.type) ?? 'llm',
            loaded: m.state === 'loaded' ? true : m.state === 'not-loaded' ? false : null,
            contextLoaded: num(m.loaded_context_length),
            contextMax: num(m.max_context_length),
            quantization: str(m.quantization),
            arch: str(m.arch),
            publisher: str(m.publisher),
            format: str(m.compatibility_type),
          }));
        } else {
          const tags = await get('/api/tags');
          const tagList = asArray(pick(tags.json, ['models']));
          if (tags.ok && tagList.some((m: any) => m && 'digest' in m)) {
            kind = 'ollama';
            apiFlavor = 'Ollama (/api/tags)';
            const ps = await get('/api/ps');
            const running = new Set(asArray(pick(ps.json, ['models'])).map((m: any) => String(m.name)));
            models = tagList.map((m: any) => ({
              ...blankModel(String(m.name)),
              loaded: ps.ok ? running.has(String(m.name)) : null,
              quantization: str(m.details?.quantization_level),
              params: str(m.details?.parameter_size),
              arch: str(m.details?.family),
              sizeBytes: num(m.size),
              format: str(m.details?.format),
            }));
          } else {
            const props = await get('/props');
            const oai = await get('/v1/models');
            const list = asArray(pick(oai.json, ['data']));
            if (props.ok && props.json && typeof props.json === 'object' && 'default_generation_settings' in (props.json as object)) kind = 'llamacpp';
            else if (oai.ok && list.length) kind = 'openai-compatible';
            if (kind !== 'unknown') apiFlavor = kind === 'llamacpp' ? 'llama.cpp server (/props)' : 'OpenAI-compatible (/v1/models)';
            models = list.map((m: any) => ({ ...blankModel(String(m.id)), publisher: str(m.owned_by) }));
          }
        }
      }

      // Cross-check what the OpenAI-compatible route (the one OpenClaw uses) advertises.
      const oaiRoute = await get(url.pathname.replace(/\/+$/, '') + '/models');
      const routeIds = new Set(asArray(pick(oaiRoute.json, ['data'])).map((m: any) => String(m.id)));
      if (!models.length && routeIds.size) models = [...routeIds].map((id) => blankModel(id));

      if (kind === 'unknown' && !probes.some((p) => p.status > 0)) {
        return fail('unreachable', `No response from ${origin}`, 'See the network diagnosis for the failing layer.');
      }
      if (kind === 'unknown' && authRequired) {
        return fail('auth_required', `${origin} requires authentication (HTTP 401/403)`, 'Set MC_INFERENCE_TOKEN to the server API token.');
      }
      const info: ServerInfo = {
        baseUrl: t.baseUrl, origin, host: url.hostname, port, kind, apiFlavor, authRequired,
        models: models.filter((m) => m.id), probes, detectedAt: new Date().toISOString(), source: t.source,
      };
      this.caps.set('inference.api', true, `${kind} at ${origin} (${apiFlavor ?? 'unrecognised API'}; ${info.models.length} models)`);
      return info;
    });
    if (!this.last.ok) this.caps.set('inference.api', false, this.last.error.message);
    return this.last;
  }

  /** Layered diagnosis. Each layer is checked and reported separately; inference is opt-in. */
  async diagnose(opts: { inference?: boolean } = {}): Promise<DiagStep[]> {
    const steps: DiagStep[] = [];
    const t = this.target();
    if (!t) {
      return [{ id: 'target', label: 'Inference server address', status: 'fail', detail: 'No baseUrl found in OpenClaw config and MC_INFERENCE_URL is unset.', hint: 'Add models.providers.<name>.baseUrl in OpenClaw config.' }];
    }
    const url = new URL(t.baseUrl);
    const host = url.hostname;
    const port = Number(url.port || 80);
    steps.push({ id: 'target', label: 'Configured address', status: 'ok', detail: `${url.origin} (from ${t.source})` });

    // 1. Tailnet peer visibility
    const isTailnetIp = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
    const st = await this.ts.status(0);
    let peerOnline: boolean | null = null;
    if (!st.ok) {
      steps.push({ id: 'peer', label: 'Tailscale peer visible', status: 'unknown', detail: st.error.message, hint: st.error.hint, commands: ['tailscale status'] });
    } else if (st.data.needsLogin || st.data.backendState !== 'Running') {
      steps.push({ id: 'peer', label: 'Tailscale peer visible', status: 'fail', detail: `Tailscale is ${st.data.backendState} on this Mac`, hint: 'Open Tailscale and sign in / connect.', commands: ['tailscale status'] });
    } else if (isTailnetIp) {
      const peer = this.ts.findPeerByIp(st.data, host);
      if (!peer) {
        const windows = st.data.peers.filter((p) => /windows/i.test(p.os));
        steps.push({
          id: 'peer', label: 'Tailscale peer visible', status: 'fail',
          detail: `No peer with address ${host} in this tailnet.`,
          hint: windows.length
            ? `The address may have changed. Windows peers seen: ${windows.map((p) => `${p.host} ${p.ips.join(',')}`).join('; ')}. Update the provider baseUrl in OpenClaw config (with approval).`
            : 'The Windows PC is not in this tailnet: sign in to Tailscale there.',
          commands: ['tailscale status'],
        });
      } else {
        peerOnline = peer.online;
        steps.push({ id: 'peer', label: 'Tailscale peer visible', status: peer.online ? 'ok' : 'fail', detail: `${peer.host} (${peer.os || 'os?'}) is ${peer.online ? 'online' : 'offline'}${peer.path ? `, path ${peer.path}` : ''}`, hint: peer.online ? undefined : 'Wake the PC or start Tailscale on it.', commands: ['tailscale status'] });
      }
    } else {
      steps.push({ id: 'peer', label: 'Tailscale peer visible', status: 'skipped', detail: `${host} is not a Tailscale address; peer check skipped.` });
    }

    // 2. Tailscale ping (only meaningful for tailnet addresses)
    if (isTailnetIp && st.ok && st.data.backendState === 'Running') {
      const p = await this.ts.ping(host);
      steps.push({ id: 'ping', label: 'Tailscale ping', status: p.ok ? 'ok' : 'fail', detail: p.detail || 'no output', commands: [`tailscale ping ${host}`] });
    } else {
      steps.push({ id: 'ping', label: 'Tailscale ping', status: 'skipped', detail: 'Not applicable.' });
    }

    // 3. TCP reachability
    const tcp = await tcpCheck(host, port);
    const tcpHint: Record<string, string> = {
      ECONNREFUSED: `The PC answered but nothing is listening on ${port}. Start the server, and enable "Serve on Local Network" (LM Studio) / bind 0.0.0.0 so it listens on the Tailscale interface, not just localhost.`,
      ETIMEDOUT: `No answer. A Windows firewall rule probably blocks inbound TCP ${port} on the Tailscale network, or the PC is asleep/offline.`,
      EHOSTUNREACH: 'No route to host: the Windows PC is off, asleep, or Tailscale is disconnected there.',
      ENETUNREACH: 'No route: Tailscale is not connected on this Mac.',
    };
    steps.push({
      id: 'tcp', label: `TCP ${host}:${port}`, status: tcp.ok ? 'ok' : 'fail',
      detail: tcp.ok ? `Connected in ${tcp.ms} ms` : `${tcp.code} after ${tcp.ms} ms`,
      hint: tcp.ok ? undefined : tcpHint[tcp.code ?? ''] ?? 'Check the server and firewall.',
      commands: tcp.ok ? [`nc -vz ${host} ${port}`] : [`nc -vz ${host} ${port}`, '# On the Windows PC (PowerShell, admin):', `Get-NetTCPConnection -LocalPort ${port} -State Listen`, `New-NetFirewallRule -DisplayName "LLM server ${port} (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort ${port} -RemoteAddress 100.64.0.0/10 -Action Allow`],
    });
    void peerOnline;

    // 4. API health + model list
    if (!tcp.ok) {
      steps.push({ id: 'api', label: 'Inference API responds', status: 'skipped', detail: 'TCP failed.' });
      steps.push({ id: 'models', label: 'Models listed', status: 'skipped', detail: 'TCP failed.' });
      steps.push({ id: 'inference', label: 'Test inference', status: 'skipped', detail: 'TCP failed.' });
      return steps;
    }
    const det = await this.detect();
    if (!det.ok) {
      steps.push({ id: 'api', label: 'Inference API responds', status: 'fail', detail: det.error.message, hint: det.error.hint, commands: [`curl -s ${url.origin}/v1/models | head -c 400`] });
      steps.push({ id: 'models', label: 'Models listed', status: 'skipped', detail: 'API check failed.' });
    } else {
      steps.push({ id: 'api', label: 'Inference API responds', status: 'ok', detail: `${det.data.kind}: ${det.data.apiFlavor ?? 'unrecognised'}` });
      const cm = this.oc.configuredModel();
      const wanted = cm.modelId;
      const found = wanted ? det.data.models.find((m) => m.id === wanted) : undefined;
      steps.push({
        id: 'models', label: 'Models listed', status: det.data.models.length ? (wanted && !found ? 'fail' : 'ok') : 'fail',
        detail: `${det.data.models.length} models; ${det.data.models.filter((m) => m.loaded).length} loaded.` + (wanted ? ` OpenClaw uses "${wanted}": ${found ? (found.loaded ? 'loaded' : found.loaded === false ? 'present, not loaded' : 'present') : 'NOT FOUND on this server'}` : ''),
        hint: wanted && !found ? 'The model id in OpenClaw config does not exist on the server. Download it or change the config (with approval).' : undefined,
      });
    }

    // 5. Real inference (opt-in: consumes GPU time and may make the server load a model)
    if (opts.inference) {
      const r = await this.testInference();
      steps.push(r.ok
        ? { id: 'inference', label: 'Test inference', status: 'ok', detail: `Answered by "${r.data.modelReported}" in ${r.data.latencyMs} ms${r.data.completionTokens != null ? `, ${r.data.completionTokens} tokens` : ''}` }
        : { id: 'inference', label: 'Test inference', status: 'fail', detail: r.error.message, hint: r.error.hint });
    } else {
      steps.push({ id: 'inference', label: 'Test inference', status: 'skipped', detail: 'Not run: a real completion uses GPU time and may load a model. Run it explicitly.' });
    }
    return steps;
  }

  /** A real, tiny chat completion through the OpenAI-compatible route OpenClaw itself uses. */
  async testInference(modelId?: string): Promise<Result<{ modelRequested: string; modelReported: string | null; latencyMs: number; completionTokens: number | null; promptTokens: number | null; snippet: string }>> {
    return timed(async () => {
      const t = this.target();
      if (!t) return fail('no_target', 'No inference server configured');
      const firstLlm = this.last?.ok ? this.last.data.models.find((m) => m.type === 'llm')?.id : undefined;
      const model = modelId ?? this.oc.configuredModel().modelId ?? firstLlm;
      if (!model) return fail('no_model', 'No model id to test with');
      const r = await fetchJson(`${t.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers(), timeoutMs: 120000,
        body: { model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 64, temperature: 0, stream: false },
      });
      if (r.status === 0) return fail('unreachable', `Request failed: ${r.error}`);
      if (!r.ok) return fail('http_error', `HTTP ${r.status}: ${redactString(r.text).slice(0, 300)}`, r.status === 404 ? 'Model id not found on the server.' : undefined);
      const j = r.json as any;
      const choice = j?.choices?.[0];
      if (!choice) return fail('bad_response', 'Response had no choices[]');
      const snippet = String(choice.message?.content ?? choice.text ?? '').slice(0, 200);
      return {
        modelRequested: model, modelReported: typeof j.model === 'string' ? j.model : null, latencyMs: r.ms,
        completionTokens: num(j.usage?.completion_tokens), promptTokens: num(j.usage?.prompt_tokens),
        snippet: String(redactDeep(snippet)),
      };
    });
  }
}
