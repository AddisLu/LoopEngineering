#!/usr/bin/env bash
# setup-mac.sh — one-shot CLIENT setup for a Mac (or any laptop) to REMOTE-CONTROL
# the home Loop Engineering engine. It does NOT run an engine here; it registers the
# Loop MCP shim (mcp/loop-mcp.mjs) in this machine's `claude` so your Claude Code gets
# the loop_* tools, pointed at the home engine over Tailscale. Idempotent; safe to re-run.
#
# Usage (after cloning the repo on the new machine):
#   bash deploy/setup-mac.sh
# It will prompt for the API token (or set LOOP_API_TOKEN in the environment first).
#
# Overridable via env:
#   LOOP_API_URL      (default: the home tailnet URL below)
#   LOOP_DEFAULT_REPO (default: the engine-side repo path used when a task omits repo_path)
#   LOOP_API_TOKEN    (if unset, you'll be prompted; never commit this)
#   LOOP_MCP_SCOPE    (default: user — available in every project)
set -euo pipefail

LOOP_API_URL="${LOOP_API_URL:-https://addis-b850m-ds3h.tailffdb68.ts.net}"
LOOP_DEFAULT_REPO="${LOOP_DEFAULT_REPO:-/home/addis/Coding/LoopEngineering}"
SCOPE="${LOOP_MCP_SCOPE:-user}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MCP_JS="$REPO/mcp/loop-mcp.mjs"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites ---
command -v node   >/dev/null || die "node not found — install Node.js (>= 18) first."
command -v claude >/dev/null || die "claude CLI not found — run: npm i -g @anthropic-ai/claude-code"
[ -f "$MCP_JS" ]             || die "missing $MCP_JS — run this from a full clone of the repo."
command -v tailscale >/dev/null || warn "tailscale not found — the engine is only reachable inside your tailnet."

# --- token: env > home env-file (if present) > prompt ---
TOKEN="${LOOP_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.config/loop-engineering/env" ]; then
  TOKEN="$(grep '^LOOP_API_TOKEN=' "$HOME/.config/loop-engineering/env" | cut -d= -f2 || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "Enter LOOP_API_TOKEN."
  echo "  (get it on the home box:  grep '^LOOP_API_TOKEN=' ~/.config/loop-engineering/env | cut -d= -f2 )"
  printf '> '
  read -rs TOKEN; echo
fi
[ -n "$TOKEN" ] || die "no token provided."

# --- install shim deps ---
say "installing MCP shim deps (mcp/)"
( cd "$REPO/mcp" && npm install --silent )

# --- connectivity check (non-fatal) ---
say "checking engine reachability: $LOOP_API_URL"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Authorization: Bearer $TOKEN" "$LOOP_API_URL/api/status" || true)"
if [ "$code" = "200" ]; then
  say "engine OK (200)"
else
  warn "$LOOP_API_URL/api/status returned '$code' (expected 200)."
  warn "check: Tailscale up & logged into the same tailnet, and the token is correct. Registering anyway."
fi

# --- (re)register the MCP, idempotent ---
say "registering MCP 'loop-engineering' (scope=$SCOPE)"
claude mcp remove loop-engineering --scope "$SCOPE" >/dev/null 2>&1 || true
claude mcp add loop-engineering --scope "$SCOPE" \
  --env "LOOP_API_URL=$LOOP_API_URL" \
  --env "LOOP_API_TOKEN=$TOKEN" \
  --env "LOOP_DEFAULT_REPO=$LOOP_DEFAULT_REPO" \
  -- node "$MCP_JS"

say "done."
echo
echo "  verify:   claude mcp list        # expect: loop-engineering ✓ Connected"
echo "  VS Code:  ⌘⇧P → Reload Window    # so the Claude Code MCP panel shows it"
echo "  board:    $LOOP_API_URL/?token=<your token>"
echo
echo "Note: tasks EXECUTE on the home engine. When adding tasks, repo_path must be a path on"
echo "      the home box (default: $LOOP_DEFAULT_REPO). Repos that only exist on this Mac"
echo "      cannot be run remotely (single-host engine)."
