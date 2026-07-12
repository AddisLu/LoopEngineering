# 企業週報 PPTX — 模板製作流程

給「拿到公司公版 `週報公版_DAMAC.pptx` 之後」的一次性製作流程。公版 .pptx 是公司機密，**絕不進
repo**——本文件走完之後你會得到 `fillready.pptx` + `manifest.json` 兩個檔案，放進
`<report_pptx_dir>/template/`（`report_pptx_dir` 設定，預設 `~/.local/share/
loop-engineering/report-pptx/`），本身也不進 repo。

整體架構（4 條任務鏈的第 1 條，T1）：**LLM 只產出結構化 DeckSpec JSON → 確定性渲染器
（`scripts/report_pptx.py`）打開 fillready.pptx 只填值**，絕不在執行期生成版面或複製投影片。
這份文件只處理「把公版變成 fillready.pptx + manifest.json」這一次性、人工/agent 協作的步驟；渲染器
本身的行為見 `scripts/report_pptx.py` 的 docstring 與 `src/report/pptx/spec.ts` 的型別定義。

## 附錄先讀：fixture 當 worked example

在拿到真正的公版之前，`scripts/report_pptx_fixture.py` 產生一個結構完全相同、但縮小容量（1 個專案
槽、3 個 checkpoint、2 個小 pillar）的假模板，可以先跑一遍整個流程練習：

```bash
python3 scripts/report_pptx_fixture.py /tmp/pptx-fixture
# -> /tmp/pptx-fixture/fixture-template.pptx
# -> /tmp/pptx-fixture/manifest.json
```

`report_pptx_fixture.py` 裡的 `MANIFEST` dict 就是下面每個章節提到的欄位的完整 worked example
——真模板的 manifest 只是把數字放大（8 個專案槽、9 個 checkpoint、5 個 pillar）。

## Step 1：source 放哪

把使用者提供的公版檔案原封不動放到一個工作目錄（不是 repo，例如
`~/pptx-work/週報公版_DAMAC.pptx`），後續步驟都在這個工作目錄操作，只有最終產出的
`fillready.pptx` + `manifest.json` 會被複製進 `<report_pptx_dir>/template/`。

## Step 2：`--probe` 盤點

```bash
python3 scripts/report_pptx.py --probe ~/pptx-work/週報公版_DAMAC.pptx > probe.jsonl
```

每個 shape 一行 JSON：`{"slide": i, "shape_id": id, "name": "...", "type": "...", "text":
"前80字", "is_table": bool, "rows": n?, "cols": n?}`。用這份輸出確認：

- 總表在哪一頁、幾列幾欄。
- 主頁的標題／benefit／status／checkpoint／marker 分別是哪個 shape（用 `shape_id` + `text`
  前 80 字辨認，此時它們的 `name` 通常還是 PowerPoint 預設的 `TextBox 12` 之類，還沒重新命名）。
- 說明頁的 title／note／image 佔位框在哪。

## Step 3：用 Claude Code + Anthropic pptx skill 複製原型頁成 pool，重新命名 shape

公版通常只有「一頁總表原型 + 一頁主頁原型 + 一頁說明頁原型」，需要用 Claude Code 內建的
Anthropic pptx skill（`unpack` / `add_slide` / `clean` / `pack` 一套工具）把原型頁複製成足量的
**pool**（固定容量、不在執行期 clone），公司目前的目標容量是：

- 1 頁總表
- 8 頁主頁（`capacity.projects = 8`）
- 16 頁說明頁（`capacity.explain_per_project = 2`，即每個專案槽 2 頁）

複製時把每個可填 shape 重新命名成 `LOOP:` 慣例（`shape_prefix`，見下面 manifest 範例），命名要
**逐頁全部一致**——`index_shapes()`／`fill_main()`／`fill_explain()` 是靠 shape 名字找位置，不是靠
順序或座標。checkpoint 相關的三個 shape（label/date/at）用 `LOOP:main:cp{n}:label` 這種帶編號的
樣式命名，`{n}` 是 1-based 的 checkpoint 序號（1..9）。

同一步驟裡，把總表裡屬於同一 pillar 的儲存格**合併**成該 pillar 容量對應的列數（例如 AMC 若容量 4
列，總表裡預留 4 列高的合併區塊）——**合併是模板製作期一次性做的，渲染器執行期絕不合併/刪列**，只
會往合併好的儲存格裡填值或清空文字。

完成後用 `pack` 存成 `fillready.pptx`。

## Step 4：撰寫 `manifest.json`

依 Step 2 的 probe 輸出、Step 3 重新命名後的 shape 名，手寫或請 agent 產生 manifest。**欄位名固定
（正典範例，`src/report/pptx/spec.ts` 的 `Manifest` 型別對應）**：

```json
{
  "version": 1,
  "template_file": "fillready.pptx",
  "template_sha256": "",
  "shape_prefix": "LOOP:",
  "capacity": { "projects": 8, "explain_per_project": 2 },
  "pool": [
    { "slide": 0, "kind": "summary" },
    { "slide": 1, "kind": "main", "slot": 0 },
    { "slide": 2, "kind": "explain", "slot": 0, "sub": 0 },
    { "slide": 3, "kind": "explain", "slot": 0, "sub": 1 }
  ],
  "summary": {
    "table_shape": "LOOP:summary:table",
    "columns": { "pillar": 0, "project": 1, "fab_line": 2, "status": 3 },
    "header_rows": 1,
    "rows_per_pillar": { "AMC": 4, "Energy": 3, "DSBG": 3, "ISBG": 3, "Others": 2 },
    "font_size_pt": 10,
    "max_item_chars": 60
  },
  "main": {
    "shapes": { "title": "LOOP:main:title", "benefit": "LOOP:main:benefit", "status": "LOOP:main:status", "marker": "LOOP:main:marker" },
    "checkpoints": 9,
    "checkpoint_shapes": { "label": "LOOP:main:cp{n}:label", "date": "LOOP:main:cp{n}:date", "at": "LOOP:main:cp{n}:at" }
  },
  "explain": { "shapes": { "title": "LOOP:explain:title", "note": "LOOP:explain:note", "image_box": "LOOP:explain:imgbox" } },
  "colors": { "carried": "000000", "new": "0000FF", "highlight": "FF0000" }
}
```

`pool` 陣列要窮舉每一個 pool 頁（1 個 summary + 8 個 main + 16 個 explain = 25 筆）；上面只列前 4
筆示意，實際檔案要列滿。`colors` 三個 key 是**業務語意**（carried＝沿用中／new＝新增／
highlight＝需高層關注），不是顏色本身的名字——`StatusItem.color`（`black|blue|red`）會被渲染器
內部固定映射到這三個 key（black→carried、blue→new、red→highlight），manifest 只需要提供對應的
16 進位色碼即可。

## Step 5：`--validate`

```bash
loop config set report_pptx_enabled true
loop config set report_pptx_template ~/pptx-work/fillready.pptx
loop config set report_pptx_manifest ~/pptx-work/manifest.json
loop report pptx validate
```

驗證 manifest 宣告的每個 shape 名都能在 template 對應 slide 找到、summary 表格列數是否足夠涵蓋
`rows_per_pillar` 加總、（若已填 `template_sha256`）檔案 hash 是否相符。**全部缺漏會一次列出**，不是
遇到第一個就停，照著清單逐一修正模板或 manifest。

## Step 6：`render` 煙霧測試

用 repo 內建的假資料 spec 過一次完整流程：

```bash
loop report pptx render --spec seed/report-pptx/sample-deck-spec.json
```

stdout 會印出 `{"output": "...", "slides": N, "warnings": [...]}`。這份 sample spec 的說明頁圖片是
假路徑（`/tmp/...`），**缺圖跳頁是預期行為**——如果 render 結果的頁數比你預期少，先確認是不是因為
sample spec 本身就故意用了不存在的圖片路徑。

## Step 7：`qa` 視覺比對

```bash
loop report pptx qa --file <上一步 render 出來的 .pptx>
```

會呼叫 LibreOffice（`soffice --headless --convert-to pdf`）轉 PDF 再用 `pdftoppm -png` 轉圖，
產物在該 .pptx 同目錄的 `qa/` 下。用這些 PNG 對照公版原始排版，確認：文字沒有跑版/被截斷、顏色正確、
checkpoint marker 有對齊、圖片沒有變形。若 `soffice`/`pdftoppm` 未安裝，這個指令會印警告並直接結束
（不算失敗），改用 PowerPoint 手動開檔比對即可。

## Step 8：記錄 SHA-256

模板定案後，把 `fillready.pptx` 的 SHA-256 填進 `manifest.json` 的 `template_sha256`（可以用
`sha256sum fillready.pptx`，或直接跑一次 `--validate`——若留空不會檢查，之後任何人不小心把模板
換成別的版本，`--validate` 就會抓到 hash 不符）。

## 完成後

把定案的 `fillready.pptx` + `manifest.json` 放進 `<report_pptx_dir>/template/`
（或用 `report_pptx_template`／`report_pptx_manifest` 指向任意路徑），之後 `loop report pptx
render --spec <週報 DeckSpec>` 就能直接產出正式週報。真正的週組裝、LLM 內容生成、一鍵 API 是後續
任務（T2-T4），本文件到「模板可用」為止。
