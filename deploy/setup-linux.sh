#!/usr/bin/env bash
# One-shot setup for the Linux host: build, disable sleep, install the systemd user
# service, and expose the board over Tailscale. Idempotent; safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${LOOP_PORT:-4711}"
NODE="$(command -v node || true)"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites ---
[ -n "$NODE" ] || die "node not found — install Node >= 20"
[ -f "$HOME/.claude/.credentials.json" ] || \
  echo "WARN: ~/.claude/.credentials.json missing — run 'claude' and log in once (subscription auth)."
command -v tailscale >/dev/null || echo "WARN: tailscale not found — remote access will be unavailable."

# --- build ---
say "installing deps + building"
cd "$REPO"
npm ci
npm run build

# --- env file (create if missing; do not overwrite secrets) ---
ENV_DIR="$HOME/.config/loop-engineering"
mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_DIR/env" ]; then
  say "writing $ENV_DIR/env (edit to set TOKENBAR_MCP_DIR, ntfy, LOOP_API_TOKEN)"
  TOKEN="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  cat > "$ENV_DIR/env" <<EOF
LOOP_PORT=$PORT
LOOP_BIND=127.0.0.1
LOOP_API_TOKEN=$TOKEN
# TOKENBAR_MCP_DIR=$HOME/TokenBar/mcp
# NTFY_SERVER=https://ntfy.sh
# NTFY_TOPIC=loop-eng-$(head -c 6 /dev/urandom | base64 | tr -dc 'a-z0-9')
# LOOP_PUBLIC_URL=https://<host>.<tailnet>.ts.net
EOF
fi

# --- disable sleep (primary keep-awake guard; needs sudo) ---
say "masking sleep targets (sudo)"
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target || \
  echo "WARN: could not mask sleep targets (need sudo?) — configure manually."

# --- systemd user service ---
say "installing systemd user service"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s#__REPO__#$REPO#g" -e "s#__NODE__#$NODE#g" \
  "$REPO/deploy/loop-engineering.service.template" > "$UNIT_DIR/loop-engineering.service"
# allow the user service to run without an active login session
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now loop-engineering.service
say "service status:"
systemctl --user --no-pager status loop-engineering.service | head -n 6 || true

# --- Tailscale serve (private HTTPS inside the tailnet) ---
if command -v tailscale >/dev/null; then
  say "exposing board via tailscale serve on :$PORT"
  sudo tailscale serve --bg "$PORT" || tailscale serve --bg "$PORT" || \
    echo "WARN: 'tailscale serve' failed — run it manually."
  URL="$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  [ -n "${URL:-}" ] && say "board: https://${URL%.}"
fi

say "done. logs: journalctl --user -u loop-engineering -f"
