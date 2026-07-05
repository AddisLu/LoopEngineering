# Loop task: Loop 自我優化 Phase 1 — Quick Wins

## Goal
實作 Loop Engineering 優化路線圖第一階段（Quick Wins）：7 項低風險高價值修正。務必保留所有預算安全保證，17 個既有測試需全綠，並依註記新增/調整測試。詳見 plan。

## Plan
# Phase 1 — Quick Wins（低風險高價值）

實作以下 7 項獨立修正，每項用小的 conventional commit。保留所有既有行為與預算安全保證（pre-dispatch gate / breaker / watchdog）。完成前跑 `npm run typecheck` 與 `npm test` 直到全綠。

## 1. 中斷前先 auto-commit WIP checkpoint — src/orchestrator/run.ts
問題：auto-commit「保險」區塊在中斷分支（timeout→failed ~L155-158；breaker/user→blocked ~L159-163）**提早 return 之後**，永遠跑不到，導致被中斷的未提交工作遺失、resume 無 checkpoint。
修正：在 finishRun 之後（~L152）、中斷分支**之前**，對 !isMock 且 interrupted_by ∈ {breaker,timeout,user} 的 run，若 worktree 為 dirty，先以 `loop(<taskid>): checkpoint (interrupted: <reason>)` commit（重用 src/git 既有的 commitAll / isDirty）。加一個測試：breaker 中斷時 dirty worktree 會被 commit。

## 2. 計費邊界強制新鮮用量讀數 — src/orchestrator/run.ts
問題：before/after session% 未帶 {force:true}，短於快取 TTL 的 run 記到 ~0% delta，把估算器訓練偏零。
修正：after 用 `readUsage({ force: true }).session.percent`（必要），before 亦盡量 force。若 readUsage 尚不支援 force 選項（src/token/usage.ts）則補上。

## 3. 校準只吃乾淨完成的 run + 安全裕度 — src/token/accounting.ts
問題：runDeltas 收錄所有 before/after 非空的 run（含 breaker/timeout 砍掉的截斷樣本），且無安全裕度。
修正：查詢加 `AND r.interrupted_by IS NULL AND r.exit_code = 0`（並忽略 resume 腿）。估算改用高百分位（如 p75）或 median*1.15，而非單純 median。

## 4. resume 額度耗盡的 blocked 升級 failed — src/orchestrator/run.ts
問題：breaker/user 分支無條件 bumpResume + setStatus('blocked')；tick 只 resume resume_count<2 的 blocked，耗盡後變殭屍（永不 resume 也永不 failed）。
修正：bumpResume 後讀新 resume_count，超過上限則 setStatus('failed', detail:'resume limit exceeded')（比照 recovery.ts）。把上限抽成單一設定 `max_resumes`（預設 2）於 config.ts，並在 tick.ts / run.ts / recovery.ts 共用。

## 5. 逼近上限「事前」警告通知 — src/server.ts, src/config.ts, src/notify.ts
問題：唯一預算警報是 breaker（95% 硬上限、已中斷才響）。
修正：新增設定 `warn_margin_pct`（預設 5）。在 pumpNotifications（或 tick）中，當 session.percent 首次越過 (hard_limit_pct - warn_margin_pct) 且有 run 進行中時，發**一次** edge-triggered 高優先 ntfy「逼近用量上限」。以邊緣觸發避免重複洗頻。

## 6. 看板即時進度更豐富 — src/server/board.ts (+ web/app.js)
6a. 擴充 tailLog()：解析 Claude Code stream-json 的工具活動——走訪 assistant message 的 content blocks，tool_use 輸出如「→ Edit src/foo.ts」「→ Bash: npm test」，保留 text/result/system 處理。
6b. 匯出/複製 per-complexity timeout（timeoutMinFor 目前私有於 run.ts），為執行中的卡片加 `timeoutMin` 與 `elapsedPct = elapsedMin/timeoutMin` 到 BoardCard；web/app.js 渲染執行進度指示（timeoutMin 不存在時**不要**假造進度）。

## 7. 引擎產物別混進分支/PR — src/orchestrator/
問題：LOOP_TASK.md（worktree 根）與 .claude/settings.local.json 在 checkout 樹內，被 commitAll 的 `git add -A` 一起 staged 進任務分支/PR。
修正：在寫出這兩者後，立即把它們加入 worktree 的 .git/info/exclude（或等效 local ignore），使 commitAll 不再 stage 它們。驗證 auto-commit 不再含這兩個檔案。

## 限制
- 不得削弱任何預算安全保證。
- 除第 4 項外，不改動 timeout→failed 與 breaker→blocked 的區別。
- 小 commit、盡量每項一個。完成前 typecheck + test 全綠。


## Verification steps (must all pass before you finish)
- `npm run typecheck`
- `npm test`

## Rules
- Only modify files needed for this task; do not touch anything outside its scope.
- Commit your work in small, conventional commits.
- Before finishing, run the verification steps yourself and fix until they pass.
- If you cannot complete the task, clearly explain the blocker and stop — do not force a workaround.
