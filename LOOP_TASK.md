# Loop task: Loop 自我優化 Phase 2 — Medium

## Goal
實作 Loop Engineering 優化路線圖第二階段（Medium）：8 項改動。這些觸及核心排程/協作，務必保留預算安全保證並補測試。完成前 typecheck + test 全綠。詳見 plan。前置：建議先合併 Phase 1。

## Plan
# Phase 2 — Medium（值得做，需多點測試）

實作以下 8 項。觸及核心排程/協作，保留所有預算安全保證，並為 fit-budget 與 retry 邏輯補測試。完成前 typecheck + test 全綠。

## 1. Worktree 用完清理 — src/git/worktree.ts, run.ts, cli.ts, app.ts, tick.ts
removeWorktree() 已實作但**零呼叫** → 24/7 磁碟無限膨脹（每次派工留完整 checkout）。在工作已外化的持久終態呼叫它：PR 建立成功後、以及 'closed' 轉態時。保留 'failed'/'blocked' 的 worktree（供 triage/resume）。

## 2. Fit budget 改用 hard-limit band — src/scheduler/tick.ts, config.ts
packing 用 headroom = sessionMax - session% 拒絕估算超過者，浪費了 sessionMax→hard_limit 整段頻寬。拆兩概念：`percent >= sessionMax` 維持為**起跑**閘門；per-run **fit budget** 對硬上限計算並留安全裕度：fitBudget = (hard_limit_pct - safety_reserve_pct) - session%。新增設定 safety_reserve_pct。務必謹慎保留安全性、補測試。

## 3. MCP auto-queue 上限 — src/config.ts, src/server/app.ts, mcp/loop-mcp.mjs
因 queue 已預設 true，新增設定 `max_autoqueue`（預設 3）。新增受控 queue 路徑：當 (queued+running) >= max_autoqueue 時拒絕入列並回傳清楚訊息，讓 MCP 呈現。防止大量自動花費湧入。

## 4. MCP 結果/等待工具 — src/server/app.ts, src/server/board.ts, mcp/loop-mcp.mjs
新增 GET /api/tasks/:id/result 回傳 {status, pr_url, review_md, fail_detail, log_tail, branch, elapsedMin}。新增 MCP 工具 loop_task_result(id) 與 loop_wait_task(id, timeout_sec)（輪詢至終態），讓編輯器不開看板就看到 PR 連結 / verify 輸出 / 失敗原因。

## 5. HANDOFF 交接檔 + resume 專用提示 — src/orchestrator/prompt.ts, run.ts, adapters/claudeCode.ts, adapters/types.ts
在 LOOP_TASK.md 加規則：要求 agent 維護 HANDOFF.md（已完成／待辦／關鍵決策／如何續跑），並在長/風險步驟前更新、commit 之。透過 DispatchContext 傳 `resume` 布林 + handoff 文字，resume 時發專用提示（「你在逼近上限時被中斷；--resume 與 HANDOFF.md 已還原狀態，從那裡續做」），取代與 fresh 相同的提示。加 --resume 失敗時的冷啟動 fallback。

## 6. 看板顯示排程「為何在等」 — src/server.ts, src/server/board.ts, src/notify.ts
tick() 每次算出豐富的 TickInfo.reason 卻在 server loop 被丟棄。捕捉它、reason **變化**時持久化成 task_events（kind='scheduler', task_id=null），並把當前 reason + policy.window 放進 BoardState，看板即可顯示「holding: session 82% ≥ 65%」。回答「怎麼都不跑？」。

## 7. verify 失敗可續修 — src/orchestrator/run.ts, prompt.ts, tick.ts, config.ts
verify 失敗時，若 run 有 session_id 且 resume_count < 上限：把失敗步驟名 + 擷取的輸出尾巴寫入 resume-context 檔、bumpResume、設 'blocked'（可續）而非終態 'failed'；續跑帶著失敗脈絡去修。以小上限約束。

## 8. resume 跳過重跑 setup_cmd — src/orchestrator/run.ts
resume 時 worktree 重用，但 setup_cmd（npm install 等）每次重跑。resume 時跳過 runSetup，或首次成功後於 worktree 放 `.loop-setup-done` sentinel，存在則跳過（setup_cmd 變更才重跑）。

## 限制
- 保留所有預算安全保證；fit-budget 與 retry 需補測試。typecheck + test 全綠。


## Verification steps (must all pass before you finish)
- `npm run typecheck`
- `npm test`

## Rules
- Only modify files needed for this task; do not touch anything outside its scope.
- Commit your work in small, conventional commits.
- Before finishing, run the verification steps yourself and fix until they pass.
- If you cannot complete the task, clearly explain the blocker and stop — do not force a workaround.
