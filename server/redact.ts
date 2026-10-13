/**
 * Central redaction. Everything that leaves the backend (API responses, audit rows, events,
 * reports) passes through here, so a credential read from a config file or CLI output never
 * reaches the browser or the database.
 */

const SECRET_KEY =
  /(token|secret|passw|passphrase|api[-_]?key|authorization|cookie|credential|private[-_]?key|bearer|signature|hmac|csrf|^auth$|^auth[A-Z_-])/i;
const CONTENT_KEY = /^(content|message|messages|text|prompt|body|input|output|transcript|reply|completion)$/i;

const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED:telegram-bot-token]'],
  [/\btskey-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:tailscale-key]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/(["']?(?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)(["']?)[^\s"',}]{4,}\2/gi, '$1$2[REDACTED]$2'],
  [/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[REDACTED]'],
];

export const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  let s = input;
  for (const [re, rep] of STRING_PATTERNS) s = s.replace(re, rep);
  return s;
}

export interface RedactOptions {
  /** Replace conversational/message bodies with a length marker (audit trail, events). */
  content?: boolean;
  maxString?: number;
}

export function redactDeep(value: unknown, opts: RedactOptions = {}, depth = 0, key = ''): unknown {
  const maxString = opts.maxString ?? 4000;
  if (value === null || value === undefined) return value;
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return REDACTED;
    if (opts.content && CONTENT_KEY.test(key)) return `[content:${value.length} chars]`;
    const s = redactString(value);
    return s.length > maxString ? `${s.slice(0, maxString)}…[+${s.length - maxString}]` : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (opts.content && CONTENT_KEY.test(key)) return `[content:${value.length} items]`;
    return value.slice(0, 500).map((v) => redactDeep(v, opts, depth + 1, key));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && (typeof v === 'string' || Array.isArray(v))) out[k] = REDACTED;
      else out[k] = redactDeep(v, opts, depth + 1, k);
    }
    return out;
  }
  return String(value);
}

/** Redaction for audit rows and events: credentials and message bodies are removed. */
export function redactForAudit(value: unknown): unknown {
  return redactDeep(value, { content: true, maxString: 500 });
}

/** Mask an identifier but keep enough to recognise it (e.g. a Telegram owner id). */
export function maskId(id: string): string {
  return id.length <= 4 ? '****' : `${'*'.repeat(Math.max(2, id.length - 3))}${id.slice(-3)}`;
}
