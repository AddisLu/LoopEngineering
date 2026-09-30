/**
 * Change-type presets for 工作流程 and 對話操作. Picking a kind fills empty fields only — it never
 * overwrites what the engineer already typed. Everything here is a hint or a default the gate
 * will still check; the actual verification tooling lives in the repo (cf-aoi: control_test.py,
 * compare_results.py, scripts/verify_*.py).
 */
export const KINDS = {
  algo: {
    label: '演算法修正',
    blurb: '判錯／漏檢／誤判——改的是影像處理或規則，要用圖集證明沒有退步。',
    methods: ['dataset', 'cmd'],
    domain: 'cuda',
    complexity: 'M',
    hints: {
      symptom: '例：20260615 那批圖，X 區的亮缺陷被判成暗缺陷',
      expected: '例：判型正確，且其他缺陷的結果 bit-exact 不變',
    },
    nonGoals: ['不改 recipe 格式', '不動 control/'],
    constraints: ['GL_Mean 容差 0.5 內視為相同；幾何欄位必須完全一致'],
    acceptance: ['Given 指定圖集 When 用 offline-tcp 重跑 Then compare_results.py 全數 PASS'],
  },
  feature: {
    label: '功能新增',
    blurb: '多一個功能或畫面，要有測試，也要有人看過一眼。',
    methods: ['cmd', 'manual'],
    domain: 'other',
    complexity: 'M',
    hints: {
      symptom: '例：缺陷清單只能照時間排，現場想依大小排',
      expected: '例：點欄位標題可依大小／類型排序，預設仍照時間',
    },
    nonGoals: ['不改資料格式', '不動既有 API 的回傳欄位'],
    constraints: [],
    acceptance: ['Given 一個有 50 筆缺陷的結果 When 點「大小」欄 Then 由大到小排列'],
  },
  bugfix: {
    label: '錯誤修復',
    blurb: '先寫一個會重現 bug 的測試，修到它過，其他測試不能壞。',
    methods: ['cmd'],
    domain: 'other',
    complexity: 'S',
    hints: {
      symptom: '例：連續兩次 LOAD_RECIPE 後第二次的 bypass_edge_x 沒生效',
      expected: '例：每次 LOAD_RECIPE 都套用最新值，並有測試守住',
    },
    nonGoals: ['不順手重構相鄰程式'],
    constraints: ['先新增重現此 bug 的測試，再修'],
    acceptance: ['Given 重現 bug 的測試 When 修正前 Then 失敗；When 修正後 Then 通過'],
  },
  perf: {
    label: '效能',
    blurb: '要快、要省，但結果不能變——先量測，再改，再量測。',
    methods: ['cmd'],
    domain: 'cuda',
    complexity: 'M',
    hints: {
      symptom: '例：單張 8192×5000 處理 420 ms，現場要求 300 ms 內',
      expected: '例：p95 ≤ 300 ms（寫數字），輸出 bit-exact 不變',
    },
    nonGoals: ['不換演算法、不改輸出格式'],
    constraints: ['輸出結果必須與修改前 bit-exact 一致'],
    acceptance: ['Given 同一組 20 張圖 When 修改前後各跑 3 次 Then p95 從 N ms 降到 ≤ M ms（填數字）'],
  },
};
