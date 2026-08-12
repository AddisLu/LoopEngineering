#!/usr/bin/env bash
# start-loop.sh — one-click engine start for Linux/macOS. Double-click target for the
# desktop shortcut (see install-desktop-shortcut.sh). Idempotent:
#   board already up          -> just open it in the browser
#   systemd unit installed    -> systemctl --user start (the production path on the host)
#   otherwise                 -> build if needed, nohup node dist/server.js
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${LOOP_PORT:-4711}"
URL="http://127.0.0.1:${PORT}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; read -r -p "按 Enter 關閉…" _ || true; exit 1; }

open_board() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then open "$URL" || true
  else say "看板網址：$URL"
  fi
}

board_up() { curl -sf -o /dev/null --max-time 2 "$URL/"; }

if board_up; then
  say "引擎已在執行 — 開啟看板 $URL"
  open_board
  exit 0
fi

command -v node >/dev/null 2>&1 || die "找不到 node — 請先安裝 Node.js >= 20"

# Production host path: the systemd user service owns the process (survives logout).
if command -v systemctl >/dev/null 2>&1 \
  && systemctl --user list-unit-files loop-engineering.service --no-legend 2>/dev/null | grep -q loop-engineering; then
  say "以 systemd 使用者服務啟動 loop-engineering"
  systemctl --user start loop-engineering
else
  cd "$REPO"
  [ -d node_modules ] || { say "首次啟動：npm ci"; npm ci; }
  [ -f dist/server.js ] || { say "首次啟動：npm run build"; npm run build; }
  LOG_DIR="${LOOP_DATA_DIR:-$HOME/.local/share/loop-engineering}/logs"
  mkdir -p "$LOG_DIR"
  say "啟動 node dist/server.js（log: $LOG_DIR/launcher.log）"
  nohup node dist/server.js >>"$LOG_DIR/launcher.log" 2>&1 &
fi

for _ in $(seq 1 60); do
  board_up && { say "看板已就緒 — $URL"; open_board; exit 0; }
  sleep 1
done
die "等了 60 秒看板仍未就緒 — 檢查 log（journalctl --user -u loop-engineering -e 或 launcher.log）"
