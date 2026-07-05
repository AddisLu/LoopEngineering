# Loop task: Loop 自我優化 Phase 3 — Large

## Goal
實作 Loop Engineering 優化路線圖第三階段（Large，需謹慎設計 + 完整測試）：4 項核心排程語意改動。盡量以設定開關保護、補完整測試、保留所有預算安全保證。完成前 typecheck + test 全綠。前置：建議先合併 Phase 1、2。詳見 plan。

## Plan
# Phase 3 — Large（設計敏感；謹慎實作 + 完整測試）

實作以下 4 項核心排程語意改動。盡量以設定開關（feature flag）保護，補完整測試，保留所有預算安全保證，並在 src/config.ts 記錄新設定。

## 1. 日夜窗口切換時 checkpoint 執行中任務 — src/scheduler/tick.ts, breaker.ts, run.ts
問題：tick 只 gate 新派工；夜間起跑的任務會流入（甚至撐爆）日間預算。
修正：createRun 時記錄該 run 的 dispatch window（policy.window）。加軟性窗口切換 checkpoint：當進行中 run 的 dispatch window != 當前 window 時，優雅 checkpoint（重用 breaker 機制：SIGINT → commit WIP → blocked 待 resume），使其在新窗口預算下重新進場。以設定開關啟用。加測試。

## 2. weekly 預算納入 packing — src/scheduler/tick.ts, token/accounting.ts, orchestrator/run.ts, db/schema.sql
問題：weekly 僅為起跑閘門；fit/pack 數學只看 session。
修正：與 session 對一起記錄 weekly_pct_before/after（schema 遷移 + finishRun），加 weekly 估算器（per-complexity median weekly delta），tick 對 min(sessionFitBudget, weeklyFitBudget) fit。使逼近 weekly 上限時 packing 正確。

## 3. 併發預留計算 — src/scheduler/tick.ts, tasks.ts
問題：max_concurrency>1 時，in-flight run 的剩餘成本未預留，packing 過度承諾。
修正：packing 迴圈前，對每個 active run 從 headroom 減去尚未花費的估算：max(0, est(complexity) - (session% - run.session_pct_before))。使提高 max_concurrency 變安全。

## 4. 優先序 aging 防餓死 — src/scheduler/tick.ts, tasks.ts
問題：高優先大任務會被便宜低優先工作無限插隊餓死。
修正：加優先序 aging（effective priority += floor(waitMinutes / age_step)）；並/或預留規則：當最高優先的 ready 任務等待超過門檻，停止派發會佔用其所需 headroom 的低優先任務。以設定調整。

## 限制
- 這些改變核心排程語意——盡量放在設定後、補完整測試、保留所有預算安全保證。於 config.ts 記錄新設定。typecheck + test 全綠。


## Verification steps (must all pass before you finish)
- `npm run typecheck`
- `npm test`

## Rules
- Only modify files needed for this task; do not touch anything outside its scope.
- Commit your work in small, conventional commits.
- Before finishing, run the verification steps yourself and fix until they pass.
- If you cannot complete the task, clearly explain the blocker and stop — do not force a workaround.
