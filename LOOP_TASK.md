# Loop task: Loop 新功能 — 刪除與清理任務

## Goal
為 Loop Engineering 新增「永久刪除單一任務」與「批次清理舊終態任務」的能力，並連帶清除其磁碟產物（worktree / plan 檔 / logs）。涵蓋 core / API / CLI / 看板 / MCP 五層，並補測試。務必只清理資料目錄下的產物，絕不碰使用者的目標 repo。完成前 typecheck + test 全綠。詳見 plan。

## Plan
# 新功能 — 刪除與清理任務

目前只有 `close`（設狀態為 closed，卡片仍留在看板），沒有真正的刪除，看板會無限累積。新增「刪除單一任務」與「批次清理」，並清除磁碟產物。以小 conventional commit 實作。完成前 `npm run typecheck` 與 `npm test` 全綠。

## 1. Core：刪除任務 — src/tasks.ts
- 新增 `deleteTask(db, id)`：在 transaction 內刪除 task 列並級聯刪除關聯列（task_events、task_runs）。回傳是否存在。
- 新增批次查詢 helper（供 prune 使用）：依 status 與 age 過濾出可刪任務。

## 2. 磁碟產物清理 — src/git/worktree.ts, src/config.ts
- 刪除有 run 的任務時，移除其 worktree（實作/重用 removeWorktree：`git worktree remove --force` + 分支清理）、plan 檔（task.plan_ref 若位於 paths.dataDir/plans 底下）、run log（paths.logsDir）。
- 新增 `pruneTaskArtifacts(db, task)` helper。
- **安全**：只刪資料目錄（worktrees/plans/logs）底下的產物；**絕不**觸碰使用者的目標 repo。路徑務必用 path.resolve 後確認在 dataDir 內才刪。

## 3. API — src/server/app.ts
- `DELETE /api/tasks/:id`：刪單一任務 + 產物。守則：對 ACTIVE 狀態（running/verifying/queued）預設拒絕（409）除非 `?force=1`；force 時先 abort 再刪。回傳 {ok, deleted:id}。
- `POST /api/tasks/prune`，body {status?: string[]（預設 ['closed','failed']）, olderThanDays?: number, dryRun?: boolean}：批次刪除符合條件的終態任務 + 清產物。**永不**刪 active/blocked/review。回傳 {count, ids}。dryRun 只回傳「將會刪除」的清單不實際刪。

## 4. CLI — src/cli.ts
- `delete <id> [--force]`：刪單一任務。
- `prune [--status closed,failed] [--older-than <days>] [--dry-run] [--yes]`：批次清理；需 `--yes` 才真的刪（預設 dry-run）。

## 5. 看板 — web/app.js, web/index.html, web/styles.css
- 在終態欄（closed/failed/review）的卡片加一個小的刪除動作（🗑），含確認對話框，呼叫 DELETE /api/tasks/:id。
- 在 Closed 欄標題或頂欄加「清理」控制：小對話框（status 過濾 + older-than）→ POST /api/tasks/prune；顯示刪除數量；刪前確認。維持既有 Refined Studio 視覺語言。

## 6. MCP — mcp/loop-mcp.mjs
- `loop_delete_task(id, force?)` → DELETE /api/tasks/:id。
- `loop_cleanup({status?, olderThanDays?, dryRun?})` → POST /api/tasks/prune。描述中鼓勵模型對大量刪除先 dryRun 確認。

## 7. 測試
- deleteTask 級聯刪除 events/runs。
- prune 尊重 status/age 過濾，且**絕不**刪 active/review/blocked。
- 產物清理路徑受限於 dataDir（給一個路徑在 dataDir 外的案例，斷言不會刪）。

## 限制
- 刪除為永久（無 soft-delete，這是刻意的）；看板只在終態卡片提供刪除。
- active 任務未 force 不得刪（先 abort）。
- typecheck + test 全綠。


## Verification steps (must all pass before you finish)
- `npm run typecheck`
- `npm test`

## Rules
- Only modify files needed for this task; do not touch anything outside its scope.
- Commit your work in small, conventional commits.
- Before finishing, run the verification steps yourself and fix until they pass.
- If you cannot complete the task, clearly explain the blocker and stop — do not force a workaround.
