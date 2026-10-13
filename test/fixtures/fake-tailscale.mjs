#!/usr/bin/env node
// TEST FIXTURE ONLY. A stand-in `tailscale` executable driven by $OPENCLAW_FAKE_STATE/ts.json.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.OPENCLAW_FAKE_STATE;
const b = JSON.parse(fs.readFileSync(path.join(dir, 'ts.json'), 'utf8'));
const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o) + '\n');

if (argv[0] === 'version') out('1.80.0\n');
else if (argv.includes('--help')) out(`Usage: tailscale ${argv[0]}\n  --bg\n  --timeout\n`);
else if (argv[0] === 'status') {
  out({
    Version: '1.80.0', BackendState: b.backendState ?? 'Running', AuthURL: 'https://login.tailscale.com/a/SECRETAUTH', MagicDNSSuffix: 'tail1234.ts.net', Health: [],
    Self: { HostName: 'mac', DNSName: b.selfDns ?? 'mac.tail1234.ts.net.', TailscaleIPs: ['100.87.186.59'], Online: true, OS: 'macOS' },
    Peer: {
      'nodekey:aaa': { HostName: 'win-pc', DNSName: 'win-pc.tail1234.ts.net.', TailscaleIPs: b.winIps ?? ['100.102.106.9'], Online: b.winOnline ?? true, OS: 'windows', CurAddr: '1.2.3.4:41641', PublicKey: 'nodekey:SECRETKEY' },
    },
  });
} else if (argv[0] === 'ping') {
  if (b.pingFail) { out('no reply\n'); process.exit(1); }
  out('pong from win-pc (100.102.106.9) via 1.2.3.4:41641 in 5ms\n');
} else if (argv[0] === 'serve' && argv[1] === 'status') {
  out(b.serve ?? {});
} else if (argv[0] === 'serve') {
  const file = path.join(dir, 'ts.json');
  if (argv.includes('off')) { b.serve = {}; } else { b.serve = { TCP: { 443: { HTTPS: true } }, Web: { 'mac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7788' } } } } }; }
  fs.writeFileSync(file, JSON.stringify(b));
  out('ok\n');
} else { process.stderr.write('unknown\n'); process.exit(3); }
