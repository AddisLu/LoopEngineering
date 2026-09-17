# <標題>

## 目標 (Goal)
<一兩段話：要達成什麼、為什麼。寫給「不能反問」的實作者看，所以把關鍵名稱、檔案、介面都寫出來。>

## 範圍 (Scope)
- <要做的事 1（具體到檔案 / 函式 / API）>
- <要做的事 2>

## 非範圍 (Non-goals)
- <明確不做的事，避免實作者越做越多>

## 驗收標準 (Acceptance)
- [ ] <Given … When … Then …，每條都能被驗證>
- [ ] <…>

## 驗證指令 (Verify)
```bash
<npm test>
```

## Repo
- path: <主機上的 repo 絕對路徑，例如 /home/me/projects/foo>
- branch: main

## 領域 (Domain)
<cuda | cv | cpp | csharp | typescript | python | other 擇一>

## 複雜度 (Complexity)
<S | M | L>

## 限制 (Constraints)
- <不能動的東西、效能要求、相容性要求…（可省略）>

<!-- 選填段落（PRD 精靈會自動產生；手寫時可加）：
## 圖集比對 (Dataset)        演算法修正用 — 只以路徑引用，禁止複製
- 輸入圖集: /abs/dir
- 期望結果: /abs/golden
- 配方: DEFAULT
- 門檻: 誤判率 ≤ 1%；漏檢 = 0；GL_Mean 容差 0.5
## 人工驗收 (Manual checks)  一行一條 Given … When … Then …（任務會停在待人工驗證）
## 驗證方式 (Verify mode)    command, manual, llm 任意組合；省略時依上面段落推導
## 需求能力 (Requires)       gpu, camera, os:windows …（本機沒有時自動改為人工驗證）
## 前置指令 (Setup)          ```bash 區塊；在花任何 token 之前先跑，失敗就停
-->
