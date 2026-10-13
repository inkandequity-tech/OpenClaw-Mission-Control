import { createApp } from './app.ts';

const app = await createApp();
const addr = await app.start();
const c = app.deps.cfg;

console.log(`\nOpenClaw Mission Control is running at http://${addr.host}:${addr.port}/`);
console.log(`Data directory: ${c.dataDir}`);
if (app.bootstrap) {
  console.log('\n  First run: an operator account was created.');
  console.log(`    user:     ${app.bootstrap.user}`);
  console.log(`    password: ${app.bootstrap.password}`);
  console.log('  This password is shown once and only its hash is stored.');
  console.log('  Change it with: npm run users -- set-password admin\n');
}
console.log('Remote access: see README → "Remote access over Tailscale" (Serve, never Funnel).');

const shutdown = async (sig: string) => {
  console.log(`\n${sig} received, shutting down…`);
  await app.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
