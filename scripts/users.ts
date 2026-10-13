/**
 * Local account management. Runs on the Mac, never exposed over HTTP.
 *   npm run users -- list
 *   npm run users -- add <name> <operator|viewer>        (password is generated and shown once)
 *   npm run users -- set-password <name>                  (generated and shown once)
 *   npm run users -- add-agent <name>                     (bearer token shown once; can only PROPOSE actions)
 *   npm run users -- revoke-agent <name>
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Auth } from '../server/auth.ts';

const dir = process.env.MC_DATA_DIR ?? path.join(os.homedir(), '.openclaw-mission-control');
const auth = new Auth(dir, { sessionTtlMs: 0, elevationMs: 0 });
const [cmd, name, role] = process.argv.slice(2);
const gen = () => crypto.randomBytes(18).toString('base64url');

switch (cmd) {
  case 'list': {
    const p = auth.listPrincipals();
    console.log('Users:');
    for (const u of p.users) console.log(`  ${u.name}  (${u.role})  created ${u.created}`);
    console.log('Agents:');
    for (const a of p.agents) console.log(`  ${a.name}  scopes=${a.scopes.join(',')}  created ${a.created}`);
    break;
  }
  case 'add':
  case 'set-password': {
    if (!name) throw new Error('name required');
    const pw = gen();
    const existing = auth.listPrincipals().users.find((u) => u.name === name);
    const r = cmd === 'add' ? role : existing?.role;
    if (r !== 'operator' && r !== 'viewer') throw new Error(cmd === 'add' ? 'role must be operator or viewer' : `no such user: ${name}`);
    await auth.setUser(name, r, pw);
    console.log(`${cmd === 'add' ? 'Created' : 'Updated'} ${name} (${r}). Password (shown once): ${pw}`);
    break;
  }
  case 'add-agent': {
    if (!name) throw new Error('name required');
    console.log(`Agent token for "${name}" (shown once; it can only propose actions for human approval):\n${auth.addAgent(name)}`);
    break;
  }
  case 'revoke-agent': {
    if (!name) throw new Error('name required');
    console.log(auth.revokeAgent(name) ? `Revoked ${name}` : `No agent ${name}`);
    break;
  }
  default:
    console.log('usage: users.ts list | add <name> <operator|viewer> | set-password <name> | add-agent <name> | revoke-agent <name>');
    process.exitCode = 1;
}
