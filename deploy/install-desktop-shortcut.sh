#!/usr/bin/env bash
# install-desktop-shortcut.sh — puts a one-click "啟動 LoopEngineering" launcher on the
# desktop. Linux: a .desktop entry (also registered in ~/.local/share/applications so it
# shows up in the app menu). macOS: a .command file. Windows: not handled here — pin
# deploy/start-loop.bat instead (右鍵 → 傳送到 → 桌面建立捷徑). Idempotent; safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

os="$(uname -s)"
if [ "$os" = "Darwin" ]; then
  target="$HOME/Desktop/啟動LoopEngineering.command"
  cat > "$target" <<EOF
#!/usr/bin/env bash
exec "$REPO/deploy/start-loop.sh"
EOF
  chmod +x "$target"
  say "已建立 $target（雙擊即啟動並開啟看板）"
  exit 0
fi

# Linux
desktop_dir="$(command -v xdg-user-dir >/dev/null 2>&1 && xdg-user-dir DESKTOP || echo "$HOME/Desktop")"
mkdir -p "$desktop_dir" "$HOME/.local/share/applications"
entry="[Desktop Entry]
Type=Application
Name=啟動 LoopEngineering
Comment=Start the Loop Engineering engine and open the board
Exec=$REPO/deploy/start-loop.sh
Icon=utilities-terminal
Terminal=true
Categories=Development;"
for f in "$desktop_dir/LoopEngineering.desktop" "$HOME/.local/share/applications/LoopEngineering.desktop"; do
  printf '%s\n' "$entry" > "$f"
  chmod +x "$f"
done
# GNOME marks unknown desktop files untrusted ("允許啟動" needed once); best-effort clear it.
command -v gio >/dev/null 2>&1 && gio set "$desktop_dir/LoopEngineering.desktop" metadata::trusted true 2>/dev/null || true
say "已建立 $desktop_dir/LoopEngineering.desktop（含應用程式選單項目）"
