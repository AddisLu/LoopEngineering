# 週報說明頁 agent 任務模板

給「互動 Claude Code session，或未來 Loop generic 任務」使用的完整指示模板。把下面所有
`{{占位符}}` 換成實際值後，整段貼給 agent 執行即可——這份文件本身**只是模板**，不是可直接執行的
腳本。

目前只交模板本身；自動排程一個 Loop generic 任務來跑這份模板是未來工作（`report_pptx_explain_agent`
設定已註冊，見 `src/config.ts`，尚未接自動派工）。

## 佔位符

| 佔位符 | 說明 |
| --- | --- |
| `{{gitea_dir}}` | 該專案原始碼所在的本機 git 目錄（絕對路徑） |
| `{{week}}` | 本週 ISO week id（例如 `2026-W29`） |
| `{{prev_week}}` | 上週 ISO week id |
| `{{project}}` | 專案顯示名稱（`projects.json` 裡的 `name`） |
| `{{wp_changes}}` | 本週變動的工作項目摘要（id/subject/status/percent_done，通常從 `weeks/{{week}}/workpackages/<key>.json` 摘要而來） |
| `{{output_path}}` | 要寫入的 `explain-pages.json` 路徑（`<report_pptx_dir>/weeks/{{week}}/explain-pages.json`） |

---

## 任務指示（把這一段連同上面替換好的佔位符一起交給 agent）

你要為週報 PPTX 的「{{project}}」專案挑選本週的說明頁素材。**只產出一份 JSON 草稿，不渲染
PPTX、不修改除 `{{output_path}}` 以外的任何檔案。**

### 第 1 步：收集本週變動

1. 在 `{{gitea_dir}}` 執行 `git log --since="{{prev_week}}" --stat`，看本週有哪些 commit、改了
   哪些檔案。
2. 執行 `git diff --name-only --diff-filter=A` 找出本週**新出現**的圖檔（`.png`/`.jpg`/`.svg`），
   這些通常是量測結果、架構圖、儀表板截圖等最適合當說明頁素材的東西。
3. 對照以下工作項目變動摘要，理解這些程式碼/圖檔變動對應到哪些 WP：

```
{{wp_changes}}
```

4. 如果知識庫裡有這個專案的背景資訊（架構決策、已知限制等），一併納入判斷，但**不要**把知識庫內容
   當成本週新產出。

### 第 2 步：選材

選材標準只有一個：**本週最有影響力的新產出**。

- 優先順序：新完成的量測結果／驗證圖表 > 新的架構圖／流程圖 > 其他新截圖。
- **上週已經展示過的圖，這週不要重複選**（除非圖的內容本身有實質更新，例如同一張良率趨勢圖但
  數字/曲線已經不同——這種情況要在 `note` 裡說明「延續上週追蹤，本週更新至 X」）。
- 找不到任何本週新產出時，`explain_pages` 留空陣列即可，不要為了湊頁數硬選舊圖或不相關的圖。

### 第 3 步：寫出 JSON 草稿

產出**至多 2 頁**，合併寫入 `{{output_path}}` 這個檔案的 `projects.{{project}}` 段（如果檔案已
存在，只覆寫這個專案對應的鍵，不要動其他專案已有的內容；如果整個檔案還不存在，用
`{"approved": false, "projects": {}}` 當骨架）。每頁格式：

```json
{
  "title": "一句話標題",
  "note": "一句話說明（現況/意義，不要流水帳）",
  "images": [
    { "path": "/絕對路徑/圖檔.png", "caption": "選填，圖說" }
  ],
  "sources": [{ "commit": "sha" }, { "wp": 123 }]
}
```

規則：

- `images` 陣列 1–3 張，`path` 必須是**絕對路徑**（相對路徑在渲染時會找不到檔案）。
- `sources` 至少附一個（對應的 commit sha 或 WP id），讓人工把關時能追溯依據。
- 檔案最外層的 `approved` 欄位**維持 `false`**——你只負責產出草稿，核准與否是人工把關後自己把它
  改成 `true` 的動作，agent 絕不能自己核准。
- 只寫這一個 JSON 檔案。不要跑 `loop report weekly render`、不要改 `deck-spec.json`、不要改任何
  程式碼或其他設定。

完成後，把你選了哪些圖、為什麼選它們（本週最有影響力的新產出的判斷依據）簡短說明給人看，方便把關者
快速確認。
