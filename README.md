# Loop Engineering

Token-aware scheduler + orchestrator for autonomous coding tasks. It queues coding
tasks, gates them on a required-fields checklist, and — while your Claude usage stays
under day/night thresholds — dispatches them one at a time to a headless coding tool
(Claude Code) in an isolated git worktree, runs your verification steps, and parks the
result in a **review** column for you to close. Designed to run 24/7 on a Linux host
and be watched / paused remotely over Tailscale.

> Subscription note: built for a fixed **MAX** plan — it schedules on **usage percent**
> (session 5h / weekly), never on dollar cost.

## Status: M1–M4 complete

Full lifecycle runs from the CLI **and** the server, with a **mock adapter** so scheduling,
timeouts, the circuit breaker, and crash recovery are all testable at **zero token cost**.

```
draft ──(gate)──> queued ──> running ──> verifying ──> review ──> closed
                                │
                                ├─ breaker/pause ─> blocked ─(auto-resume)─> running
                                │                       └─ 轉待確認 (hold) ─> attention
                                └─ adapter/setup_cmd failure, timeout, verify exhausted
                                                        ─> attention ─(續跑/重來/放棄)─> …
```

`attention` is a human-triage hold: worktree/session/HANDOFF are preserved and the
board offers 續跑 (resume the session) / 重來 (fresh from base) / 放棄 (abandon). A
`setup_cmd` failure fails fast to `attention` with a captured output tail — the adapter
is never dispatched into a broken workspace, so the run costs zero tokens. A `blocked`
task auto-resumes on every eligible tick; `轉待確認` on its board card stops that by
moving it to `attention` instead.

- **M1** engine — scheduler, orchestrator, three-layer budget protection, recovery.
- **M2** remote — Fastify REST + SSE, optional bearer, ntfy (with pause action),
  systemd unit + `deploy/setup-linux.sh` (mask sleep, `tailscale serve`).
- **M3** board — CDS-styled kanban served at `/`, live SSE, pause toggle, per-card actions.
- **M4** — read-only gap-review, `gh pr create`, usage history, estimate auto-calibration
  (all host-only bits guarded to no-op safely off-host).

17 tests pass (engine, API, M4). The full production entry `node dist/server.js` runs the
tick loop and serves the board together. See the plan in `~/.claude/plans/loop-engineering-*.md`.

## Quickstart (dev, on this machine)

```bash
npm install          # native better-sqlite3 build is approved in package.json
npm run build        # tsc + copy schema.sql into dist
npm test             # 9 M1 checks, zero tokens

# CLI (isolate data with LOOP_DATA_DIR while experimenting)
npm run loop -- add --title "Job" --goal "..." --plan ./plan.md \
  --repo /path/to/repo --base main --verify "npm test" --complexity M
npm run loop -- gate <id>      # show the intake checklist
npm run loop -- queue <id>     # validate + enqueue
npm run loop -- status         # scheduler + usage
npm run engine                 # run the scheduling loop (systemd runs this on the host)
```

Config lives in SQLite `settings` (seeded from `src/config.ts`); paths and TokenBar
integration come from env (see `.env.example`).

## Architecture

Single Node process + SQLite (WAL). No Redis/queue — an in-process 60s tick with a
mutex and `max_concurrency`.

- `src/token/` — usage via TokenBar's oauth/usage contract (session/weekly %), shared
  cache, 180s cadence, ledger fallback; session %-points estimator.
- `src/gate/` — required-fields checklist (goal, plan, tool, verification, repo/branch).
- `src/scheduler/` — `tick` (snapshot → breaker → watchdog → safe-to-run → resume →
  dispatch), day/night `policy`, `breaker`, `watchdog`, `power` (Linux systemd-inhibit).
- `src/orchestrator/` — worktree → `LOOP_TASK.md` → `settings.local.json` (scoped tools +
  budget-guard hook) → spawn adapter (stream-json, detached process group) → auto-commit →
  verify. Adapters: `claude-code`, `mock`.
- `hooks/budget-guard.mjs` — PreToolUse inner safeguard: blocks tool use at the hard limit.

Three-layer budget protection: pre-dispatch gate → in-flight circuit breaker (SIGINT →
SIGKILL) → per-run watchdog timeout.

## Verified CLI contract (claude 2.1.201, macOS)

Confirmed against `claude --help` on this machine — do **not** re-derive from memory;
re-verify on the Linux host before first real run.

| Flag | Status | Notes |
|------|--------|-------|
| `-p, --print` | ✅ | headless |
| `--output-format stream-json` | ✅ | choices: text \| json \| stream-json |
| `--include-partial-messages` | ✅ | needs `--print` + stream-json |
| `--permission-mode acceptEdits` | ✅ | choices incl. acceptEdits, plan, bypassPermissions… |
| `--allowed-tools <tools...>` | ✅ | scoped allow-list (we do **not** grant bare `Bash`) |
| `--append-system-prompt`, `--model`, `-r/--resume`, `--settings`, `--add-dir` | ✅ | present |
| `--max-turns` | ❌ **absent** | no turn cap → runaway guard = **watchdog timeout + budget-guard hook** |
| `--max-budget-usd` | ⚠️ present but API-billing | N/A on MAX subscription — unused |
| `--bare` | ⛔ **avoid** | help: "skip hooks, LSP, plugin" → would bypass budget-guard |
| `--dangerously-skip-permissions` | ⛔ **avoid** | never used |

Still to confirm on the host: exact `result`-event fields of stream-json, native
sandbox keys in `settings.local.json`, and the PreToolUse hook exit/JSON contract
(we use exit 2 + stderr = block).

## Cross-platform deployment (macOS + Windows/Copilot)

The engine runs on Linux, macOS, and Windows 11. The AI backend is selected by the
`agent_backend` setting; budget by `usage_provider`.

| Host | Backend | Budget | Service | Setup |
|------|---------|--------|---------|-------|
| Linux (home) | `claude-code` | `anthropic-oauth` (session/weekly %) | systemd user | `deploy/setup-linux.sh` |
| **macOS (portable)** | `claude-code` | `anthropic-oauth` | launchd (optional) | `deploy/setup-mac-engine.sh` |
| **Windows 11 (company)** | `copilot-cli` | `none` + request caps | NSSM | `deploy/setup-windows.ps1` |

**Copilot backend (Windows).** `agent_backend=copilot-cli` spawns the GitHub Copilot CLI
(`npm i -g @github/copilot`, Node ≥ 22) instead of `claude`. Copilot Business has no
real-time usage-percent API, so set `usage_provider=none`: `readUsage()` returns a benign
0% reading (the percent breaker/fit-gate go inert) and the **request-cap gate** becomes the
real limiter — `request_daily_max` / `request_window_max` (+ `request_window_hours`) cap
dispatches (each = one premium request). Auth is device-code (`copilot login` → enter the
code at github.com/login/device); when the token expires the adapter reports `auth-required`,
which routes the task to `attention` and (if `pause_on_auth_fail`, default on) auto-pauses the
scheduler so an unattended host never burns premium requests re-trying an unauthenticated CLI.
Your org admin must have **enabled the Copilot CLI policy** for the Business seat.

**Portability primitives.** `signalGroup` tree-kills via `taskkill /T /F` on win32 (POSIX
`kill(-pid)` unchanged); `commandExists` probes with `where`/`which`; `shell=auto` runs
verify/setup steps under git-bash→PowerShell→cmd on Windows; `selfUpdate()` restarts via
systemctl/launchctl/nssm by platform (override with `LOOP_RESTART_CMD`); and a small
`KEY=VALUE` env-file loader (`~/.config/loop-engineering/env`, override `LOOP_ENV_FILE`) gives
all three platforms one env-injection mechanism. `*_python` settings default to `python` on
the Windows PPTX/SSoT tooling; data lives under `%LOCALAPPDATA%` on Windows.

## TokenBar integration

Reuses [AddisLu/TokenBar](https://github.com/AddisLu/TokenBar)'s `mcp/usage-core.mjs`
contract. On the host, point `TOKENBAR_MCP_DIR` at the installed `mcp/` dir; TokenClient
shares TokenBar's token cache and reads `history.jsonl`. TokenBar's `claude-usage` MCP
(`get_claude_usage`, `get_usage_history`) is registered separately by you so spawned
Claude sessions can self-check budget — the engine itself reads usage directly, not via MCP.
