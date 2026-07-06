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
GITHUB_TOKEN=<pat>                      # optional: ADO/GitHub bridge (integration_provider=github)
GITHUB_API_URL=https://api.github.com   # optional: override for GHES
ADO_PAT=<pat>                           # optional: ADO bridge (integration_provider=ado)
ADO_ORG=<org>
ADO_PROJECT=<project>
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

---

# Remote-control from another machine (Mac / laptop) — one-shot

The engine is **single-host**: tasks always execute on the Linux box above, against repos
that live there. Other machines act as **remote controls** — the web board (a browser + the
tailnet URL) plus the Loop MCP tools inside their Claude Code. No engine runs on the client.

On the new machine (Mac or Linux):

```bash
git clone git@github.com:AddisLu/LoopEngineering.git ~/LoopEngineering
cd ~/LoopEngineering
bash deploy/setup-mac.sh            # prompts for LOOP_API_TOKEN
```

`deploy/setup-mac.sh` installs the MCP shim deps, checks the engine is reachable, and
registers the `loop-engineering` MCP (scope `user`) in this machine's `claude`, pointed at
the home engine over Tailscale. Then:

```bash
claude mcp list                     # loop-engineering ✓ Connected
# VS Code: ⌘⇧P → Reload Window so the Claude Code MCP panel picks it up
```

Prerequisites on the client: **Node**, the **claude CLI** (`npm i -g @anthropic-ai/claude-code`),
and **Tailscale** logged into the same tailnet. Get the token from the home box:

```bash
grep '^LOOP_API_TOKEN=' ~/.config/loop-engineering/env | cut -d= -f2
```

Override the engine URL / default repo if needed:

```bash
LOOP_API_URL=https://<host>.<tailnet>.ts.net \
LOOP_DEFAULT_REPO=/home/you/Coding/LoopEngineering \
  bash deploy/setup-mac.sh
```

Usage note: when adding tasks from the client, `repo_path` must be a path **on the home box**
(the script sets `LOOP_DEFAULT_REPO` as the default). Repos that exist only on the client
cannot run remotely.
