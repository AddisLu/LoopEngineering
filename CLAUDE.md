# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Token-aware scheduler + orchestrator for autonomous coding tasks. It dispatches queued tasks to a headless `claude` CLI in an isolated git worktree, verifies, auto-merges the result back into the base branch, and parks it in review. Budgeting is by **subscription usage percent** (5h session / weekly windows), never dollars. Node ESM + TypeScript, better-sqlite3 (WAL), Fastify + SSE, vanilla-JS board under `web/`.

## Commands

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest run — all suites, hermetic, zero tokens/network
npx vitest run src/__tests__/m1.test.ts        # single suite
npx vitest run -t "watchdog"                   # single test by name
npm run build            # tsc + copy schema.sql into dist/ (required before restart)
npm run loop -- <cmd>    # CLI via tsx (add/queue/status/config/knowledge/...)
npm run serve            # dev server (tick loop + board on :4711)
systemctl --user restart loop-engineering      # production engine (runs dist/)
```

The production engine runs compiled `dist/` — source changes do nothing until `npm run build` + service restart. When a task's work merges into **this** repo, the engine self-updates (rebuild + restart) automatically once idle; check `~/.local/share/loop-engineering/logs/self-update.log`.

## Architecture (the flow that matters)

One 60s **tick** (`src/scheduler/tick.ts`) drives everything: usage snapshot → safety (breaker `src/scheduler/breaker.ts`, watchdog, window checkpoint) → self-update gate → dependency-chain release → budget packing → dispatch. Dispatch calls `runTask` (`src/orchestrator/run.ts`), the single lifecycle owner:

1. Worktree `loop/<taskid>` cut from **freshly fetched** `origin/<base>` (`src/git/worktree.ts`).
2. `LOOP_TASK.md` written by `src/orchestrator/prompt.ts` — goal + injected knowledge (`src/knowledge/context.ts`) + inlined plan + verify steps + rules. This file *is* the agent's task context.
3. `setup_cmd` runs fail-fast (failure → `attention` before any token spend), then the adapter (`src/orchestrator/adapters/`: `claude-code` spawns the real CLI with `--model` from task.model ?? `default_model` setting; `mock` is the zero-token test double driven by `MOCK_*` env vars).
4. Failure routing: interrupts within `max_resumes` → `blocked` (auto-resume via `--resume` + HANDOFF.md); timeout / adapter error / verify-exhausted / setup failure → `attention` (human triage, worktree preserved); user abort → terminal `failed`. `interrupted_by='user'` is terminal; `'pause'` is resumable — do not conflate them.
5. Verify (`src/orchestrator/verify.ts`, local bash per step) → git close-out (`run.ts` post-verify block): push branch → merge latest base in + **re-verify** → PR attempt → FF-only integrate into base + push (`src/git/integrate.ts`) → conflict spawns an auto merge-task (`src/orchestrator/mergeTask.ts`, `parent_task_id` guards recursion) → `review`.

Cross-cutting: `depends_on` chains (a draft auto-queues when its dependency **closes**); knowledge base (`src/knowledge/`, FTS5 **trigram** — required for Chinese; drafts from the close-time haiku distiller never inject until approved); REST surface in `src/server/app.ts` + `knowledgeRoutes.ts` (auth hook covers `/api/*`; routes must register before the static handler); board state built per-second in `src/server/board.ts` and pushed over SSE.

DB schema: `src/db/schema.sql` (`CREATE TABLE IF NOT EXISTS`, exec'd every startup) — new *tables* go there; new *columns* on existing tables go in `migrate()`'s PRAGMA-guarded `add()` in `src/db/index.ts`. Settings are a seeded k/v table read fresh each tick (changes apply within ~60s, no restart); register new keys in `src/config.ts` DEFAULT_SETTINGS **and** the validator sets in `src/settings.ts`.

## Invariants (violating these is a bug, not a style choice)

- **Three-layer budget protection**: pre-dispatch fit gate (tick packing), in-flight breaker at `hard_limit_pct`, per-run watchdog. No new dispatch path may bypass the tick.
- **Never mutate the user's checkout**: all integration is FF-only and degrades to `merge_status='pending'` on a dirty base (`integrateIntoBase`). No `--force`, no `reset`, no moving checked-out refs.
- **Network git calls always get an execFileSync timeout + try/catch** — a hung push must never block the tick loop.
- **Tests are hermetic**: `openTestDb()` (in-memory), mock adapter, `file://` bare-origin fixtures, injected exec/fetch. Zero network, zero tokens. `vitest.config.ts` isolates `LOOP_DATA_DIR` and blanks `LOOP_API_TOKEN`.
- **Board rendering is textContent-only** — never `innerHTML` with dynamic data (guarded by a static test).
- **Zero-impact defaults**: empty knowledge base emits no prompt section; feature flags off must reproduce prior behavior exactly.

## Working conventions in this repo

- Substantive features are executed as **serial Loop task chains** on this very repo (create tasks via `loop add --depends-on <prev>`; the engine implements, auto-merges, and self-updates; a human closes each review to release the next link). Never queue two tasks that touch the same files concurrently.
- Keep the working tree clean: uncommitted changes downgrade every running task's auto-merge to `pending`.
- Commit messages are conventional (`feat(scope):`, `fix(...)`) and small.
- User docs live in `docs/操作說明.html` (Traditional Chinese, served read-only at `/docs/` and linked from the chat shell's rail); update it when user-facing behavior changes.
