# OpenClaw Mission Control

A private command center for an OpenClaw install: gateway, agents, sessions, scheduled jobs, Telegram, the LLM
inference server on your Windows PC, Tailscale, security, config backups and an approval queue — in one dashboard that
works on a desktop and on an Android phone over your tailnet.

It reads real data only. Every number comes from the OpenClaw CLI, the gateway's HTTP health endpoints, the inference
server's API, `tailscale`, or the optional Windows reporter. When something cannot be read, the page says so and shows
why; nothing is simulated.

- **Runtime:** Node 22.18+ (developed against 22; your Mac's Node 26 works). **No runtime dependencies, no build step.**
- **Storage:** SQLite (`node:sqlite`) in `~/.openclaw-mission-control/`, mode 0700/0600.
- **Frontend:** plain ES modules. No framework, no CDN, no inline scripts or styles (strict CSP).

---

## Quick start (on the Mac)

```bash
cd ~/openclaw-mission-control
npm start                     # no install needed to run
```

First run creates the operator account and prints its password **once**:

```
user:     admin
password: <shown once; only a hash is stored>
```

Open <http://127.0.0.1:7788/> on the Mac and sign in. Change the password any time:

```bash
npm run users -- set-password admin
npm run users -- add alice viewer         # read-only account
npm run users -- add-agent vedika-bot     # bearer token that can only PROPOSE actions
npm run users -- list
```

Stop with Ctrl+C. Nothing is installed as a service and no login/startup setting is touched. (An optional launchd
example is at the end; it is not applied for you.)

`npm install` is only needed for `npm run typecheck` (TypeScript). `npm test` needs nothing.

## Remote access over Tailscale (private, never public)

Mission Control binds to **127.0.0.1 only** and refuses to start on a public address. To reach it from your phone,
publish it to your tailnet with **Tailscale Serve** (tailnet-only HTTPS). Never use Funnel; the Security and Network
pages raise a critical finding if Funnel is on.

1. On the Mac, with Tailscale running and HTTPS certificates enabled for your tailnet:
   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:7788
   tailscale serve status
   ```
   Or use **Network → Publish on my tailnet** (needs your password and a typed confirmation).
2. The private URL is `https://<this-mac>.<your-tailnet>.ts.net/`. **The Network page shows the exact URL** discovered
   from Tailscale (with a copy button). Mission Control adds that host name to its allowed-Host list automatically.
3. **Android:** install Tailscale and sign in to the same tailnet, turn it on, open the URL in Chrome, sign in, then
   menu → *Add to Home screen* to install it. Quick controls and the five-item bottom bar are built for thumbs.
4. Undo any time: `tailscale serve --https=443 off`.

Notes
- Session cookies are `Secure` only when a request arrives through the local proxy with `X-Forwarded-Proto: https`.
- Device notifications (Alerts) need the page installed/open in Chrome; they open the app and never approve anything.
  For alerts while the phone app is closed, turn on Telegram alerts (below).

## The Windows PC (inference server)

Mission Control discovers the server from OpenClaw's `models.providers.*.baseUrl` (override with `MC_INFERENCE_URL`)
and identifies what is running by probing it (LM Studio, Ollama, llama.cpp, or generic OpenAI-compatible). If it
cannot connect, **Models → Diagnose connection** checks each hop (tailnet peer, ping, TCP port, API, models) and tells
you which one fails and what to change. LM Studio must have *Serve on Local Network* enabled; limit the Windows firewall
rule to `100.64.0.0/10`.

### Optional: GPU/VRAM/CPU/RAM telemetry from the PC

Windows hardware numbers cannot be read remotely without something running on the PC. A small read-only reporter is
included. On the PC (Node 18.15+):

```powershell
node windows-telemetry-agent.mjs --host <PC-tailscale-ip> --port 7790 --token <long random secret>
```

On the Mac, before `npm start`:

```bash
export MC_WINDOWS_TELEMETRY_URL=http://<PC-tailscale-ip>:7790
export MC_WINDOWS_TELEMETRY_TOKEN=<same secret>
```

It runs one fixed program (`nvidia-smi`) with fixed arguments, has no input that reaches a shell, and refuses to start
without a token. Without it, Resources shows Windows metrics as off.

## What you get

| Area | What it does | Source |
|---|---|---|
| Overview | Live system map, health, gateway, agents, sessions, model, resources, Tailscale, Telegram, events, quick controls. Widgets can be reordered/hidden. | all of the below |
| Approvals | Queue for every high-impact or agent-proposed action; review, approve (password + typed phrase) or reject. | Mission Control |
| Event timeline | One searchable, live stream of gateway, agent, model, Telegram, network, security events. | OpenClaw logs + app events |
| Gateway | Liveness/readiness, restarts, stability reports, status JSON, capability table. | `/healthz`, `/readyz`, `openclaw` CLI |
| Agents, Sessions | Agents (config + CLI); sessions with activity; transcript tail needs password and is audited. | `openclaw` CLI, `openclaw.json` |
| Automation | Cron jobs, run history, run/enable/disable, create (approval). | `openclaw cron …` |
| Telegram | Bot/route status, live probe, test alert, alert opt-in. | `openclaw channels`, `openclaw message send` |
| Models | Server and model facts, test inference, switch OpenClaw's model (approval), benchmarks and comparison, diagnosis. | LM Studio / OpenAI-compatible API |
| Resources | Mac CPU/RAM/disk; Windows GPU/VRAM/temp/CPU/RAM (reporter). Threshold lines match alert settings. | OS, `df`, reporter |
| Network | Tailnet status, peers, Serve/Funnel state, private URL, Android steps. | `tailscale` CLI |
| Workflows | Restart-with-checks; config-change-with-rollback. Retries, gates, recovery, history. | code-defined templates |
| Security | Findings with evidence and fixes, access review, audit-chain status. | derived from the machine |
| Config & backups | Versioned snapshots, redacted diffs, verified restore. | `openclaw.json` |
| Workspace files | Read-only browser limited to configured roots. | filesystem |
| Logs & diagnostics | Redacted logs; sanitized troubleshooting report. | OpenClaw logs |
| Audit trail | Who, what, when, outcome, verified? Hash-chained. | Mission Control |

Themes: Noir (default), Obsidian, Cyberpunk, Aurora, Arctic, Solar Flare — each in dark and light — from the dropdown
beside the night-mode button. Choices persist per user. Ctrl/Cmd+K opens search and commands.

## Security model

- **Network:** loopback bind only (`MC_HOST` may be loopback, tailnet `100.64/10` or RFC1918, never public). Host-header
  allow-list stops DNS rebinding. Tailscale Serve only; Funnel is detected and flagged.
- **Sessions:** HttpOnly, SameSite=Strict cookie; CSRF header on every write; Origin/Fetch-Metadata checks; JSON only;
  64 KB body cap; request flood limit; scrypt passwords; lockout with back-off after failed sign-ins.
- **Browser hardening:** CSP `default-src 'none'; script-src 'self'; style-src 'self'`, frame/nosniff/referrer headers.
  The client never assigns HTML strings (a test enforces it).
- **Roles:** *operator* (can act), *viewer* (read-only), *agent token* (can only propose; always queued for a human).
- **Risk tiers** for every state-changing action:
  - low — runs for an operator (snapshot, monitor settings);
  - medium — needs a recent password re-entry (“Unlocked”, 10 min): test inference, benchmark, cron run/enable/disable, Telegram test, start workflow;
  - high — queued; an unlocked operator approves it and types a confirmation phrase: restart gateway, change config, select model, restore backup, create job, Tailscale Serve on/off.
- **No arbitrary execution.** Every command is a fixed argv run without a shell, with validated identifiers, timeouts and
  output caps. Nothing in the browser or from an agent can supply a command line. Credentials cannot be changed from the
  UI (`openclaw configure` on the Mac).
- **Verified results.** Actions report *Verified*, *Verification failed* or *Not independently verified*. Config
  changes re-read the file and validate; a mismatch restores the snapshot automatically. A gateway restart is confirmed by
  `/healthz` + `/readyz`, with rollback if it does not come back.
- **Secrets:** redacted centrally (Telegram tokens, API keys, bearer/JWT, passwords, URLs with tokens) before anything is
  logged, audited, diffed or sent to the browser. Config snapshots hold secrets, so they stay on disk (0600) and only
  redacted diffs are shown.
- **Audit:** every operation, including denials, is recorded with actor, role, origin, request (redacted), outcome and
  verification, in a hash chain; tampering shows on the Security page.

## Telegram alerts

Mission Control watches gateway, Tailscale, inference server, Telegram, Mac disk/memory and (with the reporter) GPU VRAM
and temperature. Alerts fire after consecutive failures, repeat no more than every cooldown period, announce recovery,
and are capped at 10 Telegram messages per hour. Thresholds are editable on the Resources page. Telegram
delivery is enabled only if `openclaw message send --help` lists `--channel`, `--target` and `--message`; otherwise the
page says it is unavailable and alerts stay on the timeline and device notifications.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MC_PORT` / `MC_HOST` | `7788` / `127.0.0.1` | listen address (host must be private) |
| `MC_DATA_DIR` | `~/.openclaw-mission-control` | database, users, backups |
| `OPENCLAW_HOME_DIR` | `~/.openclaw` | where `openclaw.json` and logs live |
| `OPENCLAW_BIN`, `TAILSCALE_BIN` | `openclaw`, `tailscale` | CLI paths (set if not on PATH, e.g. the macOS app bundle) |
| `MC_ALLOWED_HOSTS` | (tailnet name auto-added) | extra Host headers to accept |
| `MC_INFERENCE_URL`, `MC_INFERENCE_TOKEN` | from OpenClaw config | override the inference server |
| `MC_WINDOWS_TELEMETRY_URL`, `…_TOKEN` | off | Windows reporter |
| `MC_FILE_ROOTS` | `~/.openclaw/workspace` | folders the file browser may show (`:` separated) |
| `MC_SESSION_TTL_HOURS`, `MC_ELEVATION_MINUTES` | `168`, `10` | session and unlock lifetimes |
| `MC_MONITOR_INTERVAL_MS`, `MC_CMD_TIMEOUT_MS` | `30000`, `30000` | monitor cadence, CLI timeout |

## Layout

```
server/            backend (TypeScript, run directly by Node)
  http.ts routes.ts auth.ts audit.ts redact.ts exec.ts      request pipeline, auth, audit, redaction, no-shell exec
  actions.ts workflows.ts backups.ts health.ts notify.ts    policy engine, workflows, snapshots, monitor, alerts
  benchmarks.ts security-center.ts files.ts report.ts
  integrations/    openclaw.ts tailscale.ts inference.ts telemetry.ts
public/            frontend (themes.css, app.css, js/app.js, js/pages/*)
tools/             windows-telemetry-agent.mjs (optional, runs on the PC)
scripts/users.ts   account management
test/              automated tests (fixtures are stand-ins used only by tests and the dev preview)
```

## Tests

```bash
npm test             # ~65 tests, no network or real services needed
npm run typecheck    # after `npm install`
node test/demo.ts    # dev preview against fixtures: http://127.0.0.1:7799  (admin / correct-horse-battery)
```

Tests cover authentication and lockout, CSRF/Origin/Host defences, role and agent authorization, dangerous or malformed
input, approval single-use and expiry, rollback after failed config changes and failed restarts, workflow retries and
gates, audit-chain tampering, secret redaction, file-browser containment, integration failures (CLI missing, garbage
output, server down, auth required), the Windows reporter, and mobile access (Tailscale Serve host, Secure cookies,
manifest, service worker, theme persistence, CSP-clean HTML).

## Known limits (by design, not simulated)

- Feature availability is **discovered**: each OpenClaw capability is enabled only if `openclaw <cmd> --help` shows it.
  JSON field names vary by OpenClaw version, so unfamiliar output is shown as redacted JSON instead of guessed fields.
- Loading/unloading models in LM Studio from here is not offered (no verified API contract); use LM Studio. Benchmarks
  and test inference may load a model if it is not in memory.
- Cron job editing is not implemented (create, run, enable, disable are).
- Conversation history is limited to `openclaw sessions tail` (password required, audited).
- Windows hardware metrics need the reporter. Without it those panels say so.
- Notifications are page-driven (service worker); true background Web Push is not implemented. Use Telegram alerts for
  away-from-phone alerts.
- Workflows are the built-in templates; user-authored workflows are not supported.

## Optional: start at login (not applied for you)

If you later want Mission Control to start automatically, save this as
`~/Library/LaunchAgents/local.openclaw.mission-control.plist`, adjust the Node path, and run
`launchctl load ~/Library/LaunchAgents/local.openclaw.mission-control.plist`. Remove it with `launchctl unload`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.openclaw.mission-control</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>server/index.ts</string></array>
  <key>WorkingDirectory</key><string>/Users/YOU/openclaw-mission-control</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mission-control.log</string><key>StandardErrorPath</key><string>/tmp/mission-control.log</string>
</dict></plist>
```
