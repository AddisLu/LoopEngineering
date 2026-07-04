# Deploying Loop Engineering on the Linux host

Runs 24/7 on your home Linux box as a **systemd user service**, exposed to your
MacBook Air / phone over **Tailscale** (no public exposure).

## One-shot

```bash
git clone <your-repo> ~/loop-engineering && cd ~/loop-engineering
bash deploy/setup-linux.sh
```

The script: `npm ci && npm run build`, writes `~/.config/loop-engineering/env` (with a
random `LOOP_API_TOKEN`), masks the sleep targets, installs + enables the systemd user
service, and runs `tailscale serve --bg 4711`.

## Prerequisites

- Node ≥ 20
- Logged into Claude Code once on this host: `claude` → creates `~/.claude/.credentials.json`
  (subscription auth — do **not** set an API key; that would bill per-token)
- Tailscale up (`tailscale up`) on the host, the MacBook, and the phone
- TokenBar's MCP registered (you did this already): `claude mcp add --scope user claude-usage -- node ~/TokenBar/mcp/server.mjs`

## Configure

Edit `~/.config/loop-engineering/env`:

```
LOOP_PORT=4711
LOOP_BIND=127.0.0.1
LOOP_API_TOKEN=<random>                 # board reads it from ?token= once, then localStorage
TOKENBAR_MCP_DIR=/home/you/TokenBar/mcp # reuse usage-core.mjs + shared cache
NTFY_SERVER=https://ntfy.sh             # optional push + one-tap pause
NTFY_TOPIC=loop-eng-xxxx
LOOP_PUBLIC_URL=https://<host>.<tailnet>.ts.net   # used in ntfy pause action
```

`systemctl --user restart loop-engineering` after editing.

## Use

- Board: `https://<host>.<tailnet>.ts.net/?token=<LOOP_API_TOKEN>` (token persists after first load).
- Logs: `journalctl --user -u loop-engineering -f`
- Sleep inhibitor while working: `systemd-inhibit --list`
- CLI on the host: `node dist/cli.js status` (or `npm run loop -- status`)

## Verify after deploy

```bash
systemctl --user status loop-engineering          # active (running)
curl -s localhost:4711/api/status                 # {"paused":false,...}
# from the MacBook (on the tailnet):
curl -s https://<host>.<tailnet>.ts.net/api/status -H "Authorization: Bearer <token>"
```
