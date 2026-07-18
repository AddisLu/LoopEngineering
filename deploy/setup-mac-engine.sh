#!/usr/bin/env bash
# setup-mac-engine.sh — set up (and optionally start) Loop Engineering as an ON-DEMAND
# engine on a MacBook, using your own Claude subscription. Unlike setup-mac.sh (which only
# registers the remote-control MCP client), this RUNS the engine locally.
#
# The Mac is a PORTABLE, on-demand engine: by default it does NOT auto-start on boot. Your
# home Linux box stays the always-on primary — do NOT run both against the same repo/base
# at the same time (each uses its own worktree, but they'd race on the same base branch).
#
# Usage (from a full clone of the repo):
#   bash deploy/setup-mac-engine.sh            # build + env file, then print the start command
#   bash deploy/setup-mac-engine.sh --run      # also start the engine now (foreground)
#   bash deploy/setup-mac-engine.sh --install-launchd   # install a LaunchAgent (auto-start)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${LOOP_PORT:-4711}"
LABEL="${LOOP_LAUNCHD_LABEL:-com.loop-engineering}"   # must match selfUpdate's launchctl default
MODE="${1:-}"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites ---
command -v node   >/dev/null || die "node not found — install Node.js >= 20."
command -v claude >/dev/null || die "claude CLI not found — run: npm i -g @anthropic-ai/claude-code"
[ -f "$HOME/.claude/.credentials.json" ] || \
  warn "~/.claude/.credentials.json missing — run 'claude' and log in once (subscription auth; do NOT set an API key)."

# --- build ---
say "installing deps + building"
( cd "$REPO" && npm ci && npm run build )

# --- env file (create if missing; never overwrite an existing token) ---
ENV_DIR="$HOME/.config/loop-engineering"
ENV_FILE="$ENV_DIR/env"
mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  say "writing $ENV_FILE"
  TOKEN="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  cat > "$ENV_FILE" <<EOF
LOOP_PORT=$PORT
LOOP_BIND=127.0.0.1
LOOP_API_TOKEN=$TOKEN
# LOOP_LAUNCHD_LABEL=$LABEL   # used by self-update's launchctl kickstart
EOF
else
  say "keeping existing $ENV_FILE"
fi

# The Mac uses the default (Claude) backend + anthropic-oauth usage — no config presets needed;
# the defaults already reproduce the home-box behavior.

case "$MODE" in
  --install-launchd)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    say "installing LaunchAgent $PLIST (auto-start)"
    NODE="$(command -v node)"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/dist/server.js</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.local/share/loop-engineering/logs/launchd-out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.local/share/loop-engineering/logs/launchd-err.log</string>
</dict>
</plist>
EOF
    mkdir -p "$HOME/.local/share/loop-engineering/logs"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    say "loaded. restart it any time with: launchctl kickstart -k gui/\$(id -u)/$LABEL"
    ;;
  --run)
    say "starting engine (foreground) on :$PORT — Ctrl-C to stop"
    ( cd "$REPO" && node dist/server.js )
    ;;
  *)
    say "done. start on demand with:"
    echo "    cd $REPO && node dist/server.js       # or: npm run serve"
    echo "    board: http://127.0.0.1:$PORT/?token=<LOOP_API_TOKEN from $ENV_FILE>"
    echo "  auto-start on login instead:  bash deploy/setup-mac-engine.sh --install-launchd"
    ;;
esac
