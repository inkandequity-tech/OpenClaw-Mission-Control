import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError, type Actor, type Role } from './types.ts';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface UserRec {
  role: 'operator' | 'viewer';
  hash: string;
  created: string;
}
interface AgentRec {
  tokenHash: string;
  created: string;
  scopes: string[];
}
interface AuthFile {
  users: Record<string, UserRec>;
  agents: Record<string, AgentRec>;
}

export interface Session {
  id: string;
  user: string;
  role: 'operator' | 'viewer';
  csrf: string;
  created: number;
  lastSeen: number;
  elevatedUntil: number;
  ip: string;
}

async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const want = Buffer.from(keyB64, 'base64');
  const got = await scrypt(pw, Buffer.from(saltB64, 'base64'), want.length, SCRYPT);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

export class Auth {
  private file: string;
  private data: AuthFile;
  private sessions = new Map<string, Session>();
  private fails = new Map<string, { count: number; lockedUntil: number; level: number }>();
  private sessionTtl: number;
  private elevationMs: number;
  private agentLastUsed = new Map<string, number>();

  constructor(dir: string, opts: { sessionTtlMs: number; elevationMs: number }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'auth.json');
    this.sessionTtl = opts.sessionTtlMs;
    this.elevationMs = opts.elevationMs;
    this.data = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as AuthFile) : { users: {}, agents: {} };
    this.data.agents ??= {};
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  hasUsers(): boolean {
    return Object.keys(this.data.users).length > 0;
  }

  /** First run: create an operator with a random password. The plaintext is returned once, never stored. */
  async bootstrap(): Promise<{ user: string; password: string } | null> {
    if (this.hasUsers()) return null;
    const password = crypto.randomBytes(18).toString('base64url');
    await this.setUser('admin', 'operator', password);
    return { user: 'admin', password };
  }

  async setUser(name: string, role: 'operator' | 'viewer', password: string): Promise<void> {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) throw new AppError(400, 'bad_user', 'User names are 2-32 chars: a-z, 0-9, _ or -');
    if (password.length < 12) throw new AppError(400, 'weak_password', 'Password must be at least 12 characters');
    this.data.users[name] = { role, hash: await hashPassword(password), created: new Date().toISOString() };
    this.save();
  }

  /** Create an agent principal. It can only propose actions; it can never approve them. */
  addAgent(name: string): string {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) throw new AppError(400, 'bad_agent', 'Agent names are 2-32 chars: a-z, 0-9, _ or -');
    const token = `mca_${crypto.randomBytes(24).toString('base64url')}`;
    this.data.agents[name] = { tokenHash: sha256(token), created: new Date().toISOString(), scopes: ['propose'] };
    this.save();
    return token;
  }

  revokeAgent(name: string): boolean {
    const had = name in this.data.agents;
    delete this.data.agents[name];
    if (had) this.save();
    return had;
  }

  listPrincipals(): { users: Array<{ name: string; role: string; created: string }>; agents: Array<{ name: string; created: string; scopes: string[]; lastUsed: string | null }> } {
    return {
      users: Object.entries(this.data.users).map(([name, u]) => ({ name, role: u.role, created: u.created })),
      agents: Object.entries(this.data.agents).map(([name, a]) => ({
        name,
        created: a.created,
        scopes: a.scopes,
        lastUsed: this.agentLastUsed.has(name) ? new Date(this.agentLastUsed.get(name)!).toISOString() : null,
      })),
    };
  }

  private throttleKey(user: string, ip: string): string {
    return `${user.toLowerCase()}|${ip}`;
  }

  async login(user: string, password: string, ip: string): Promise<Session> {
    const key = this.throttleKey(user, ip);
    const f = this.fails.get(key);
    if (f && f.lockedUntil > Date.now()) {
      throw new AppError(429, 'locked', `Too many failed attempts. Try again in ${Math.ceil((f.lockedUntil - Date.now()) / 1000)}s.`);
    }
    const rec = this.data.users[user];
    const ok = await checkPassword(password, rec?.hash ?? DUMMY_HASH); // constant work for unknown users
    if (!rec || !ok) {
      const cur = f ?? { count: 0, lockedUntil: 0, level: 0 };
      cur.count += 1;
      if (cur.count >= 5) {
        cur.level += 1;
        cur.lockedUntil = Date.now() + Math.min(15 * 60_000 * 2 ** (cur.level - 1), 6 * 3600_000);
        cur.count = 0;
      }
      this.fails.set(key, cur);
      throw new AppError(401, 'bad_credentials', 'Invalid user name or password');
    }
    this.fails.delete(key);
    const now = Date.now();
    const s: Session = {
      id: crypto.randomBytes(32).toString('base64url'),
      user,
      role: rec.role,
      csrf: crypto.randomBytes(24).toString('base64url'),
      created: now,
      lastSeen: now,
      elevatedUntil: 0,
      ip,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  getSession(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const now = Date.now();
    if (now - s.created > this.sessionTtl || now - s.lastSeen > 12 * 3600_000) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = now;
    return s;
  }

  logout(id: string): void {
    this.sessions.delete(id);
  }

  /** Step-up: re-enter the password to unlock privileged actions for a short window. */
  async elevate(s: Session, password: string): Promise<number> {
    if (s.role !== 'operator') throw new AppError(403, 'forbidden', 'Only operators can elevate');
    const key = this.throttleKey(`elev:${s.user}`, s.ip);
    const f = this.fails.get(key);
    if (f && f.lockedUntil > Date.now()) throw new AppError(429, 'locked', 'Too many failed attempts. Try again later.');
    const ok = await checkPassword(password, this.data.users[s.user]?.hash ?? DUMMY_HASH);
    if (!ok) {
      const cur = f ?? { count: 0, lockedUntil: 0, level: 0 };
      if (++cur.count >= 5) (cur.lockedUntil = Date.now() + 15 * 60_000), (cur.count = 0);
      this.fails.set(key, cur);
      throw new AppError(401, 'bad_credentials', 'Password incorrect');
    }
    this.fails.delete(key);
    s.elevatedUntil = Date.now() + this.elevationMs;
    return s.elevatedUntil;
  }

  dropElevation(s: Session): void {
    s.elevatedUntil = 0;
  }

  isElevated(s: Session): boolean {
    return s.elevatedUntil > Date.now();
  }

  agentFromToken(token: string): Actor | null {
    const h = sha256(token);
    for (const [name, a] of Object.entries(this.data.agents)) {
      const want = Buffer.from(a.tokenHash);
      const got = Buffer.from(h);
      if (want.length === got.length && crypto.timingSafeEqual(want, got)) {
        this.agentLastUsed.set(name, Date.now());
        return { name, role: 'agent', via: 'agent-token', ip: '' };
      }
    }
    return null;
  }

  sessionCount(): number {
    return this.sessions.size;
  }
}

export function roleOf(a: Actor): Role {
  return a.role;
}
