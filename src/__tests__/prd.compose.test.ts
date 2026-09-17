import { describe, it, expect } from 'vitest';
import { composePrd, datasetCommand, emptyDataset, emptyForm, verifyModes } from '../../web/prd-compose.js';
import { parsePrdToForm, type PrdForm } from '../prd/compose.js';
import { lintPrd, sectionKey } from '../prd/lint.js';

/**
 * The wizard composes in the browser and the gate parses on the server. These tests run the real
 * browser composer against the real server linter, so the two can never drift into "the wizard
 * produced a PRD the gate rejects".
 */

const exists = () => true;

function algoForm(): PrdForm {
  const f = emptyForm() as PrdForm;
  f.kind = 'algo';
  f.repo = { path: '/home/x/cf-aoi', branch: 'main', module: 'ip' };
  f.change = {
    title: 'ROI 邊緣誤判修正',
    symptom: 'ROI 邊緣常把正常紋路判成刮傷',
    expected: '邊緣 50px 內的紋路不再判成刮傷，其他缺陷 bit-exact 不變',
    files: [{ path: 'ip/src/defect_rules.h', why: 'bypass_edge_x 的預設值' }],
    extra: ['更新 docs/STATUS.md 的參數表'],
  };
  f.verify = {
    commands: ['ctest --test-dir ip/build'],
    dataset: { ...emptyDataset(), input: '/data/imgs', golden: '/data/golden', recipe: 'T550', fp_rate: 1, miss: 0, tol: 0.5 },
    manual: [{ given: '一片有邊緣紋路的板', when: '跑完整 pipeline', then: '不出現刮傷判定' }],
    llm: false,
  };
  f.scope = { non_goals: ['不改 recipe 格式'], constraints: ['GL_Mean 容差 0.5 內視為相同'], domain: 'cuda', complexity: 'M', setup: ['cmake --build ip/build -j8'] };
  f.acceptance = ['Given 20260615 圖集 When 重跑 Then 邊緣誤判為 0'];
  return f;
}

function manualOnlyForm(): PrdForm {
  const f = emptyForm() as PrdForm;
  f.kind = 'feature';
  f.repo = { path: '/home/x/cf-aoi', branch: 'develop', module: 'control' };
  f.change = { title: '缺陷清單加排序', symptom: '清單只能照時間排', expected: '可依大小與類型排序', files: [], extra: ['control/src/Views/DefectList.axaml'] };
  f.verify = { commands: [], dataset: null, manual: [{ given: '一個有 50 筆缺陷的結果', when: '點「大小」欄', then: '由大到小排列' }], llm: false };
  f.scope = { non_goals: ['不改資料格式'], constraints: [], domain: 'csharp', complexity: 'S', setup: [] };
  f.acceptance = ['排序後第一筆是最大的缺陷'];
  return f;
}

describe('composePrd → lintPrd', () => {
  it('an algorithm-fix form passes the gate with zero structural gaps', () => {
    const md = composePrd(algoForm());
    const r = lintPrd(md, { exists });
    expect(r.missing).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(md).not.toMatch(/<[^>]*>|TODO|TBD/);
    // everything the intake needs is where the linter looks for it
    expect(r.fields.verify_steps[0]).toBe('ctest --test-dir ip/build');
    expect(r.fields.verify_steps[1]).toContain('compare_results.py');
    expect(r.fields.dataset).toMatchObject({ input: '/data/imgs', golden: '/data/golden', recipe: 'T550' });
    expect(r.fields.dataset?.thresholds).toContain('誤判率 ≤ 1%');
    expect(r.fields.manual_checks).toHaveLength(1);
    expect(r.fields.verify_mode).toEqual(['command', 'manual']);
    expect(r.fields.requires).toBe('gpu');
    expect(r.fields.setup_steps).toEqual(['cmake --build ip/build -j8']);
    // the rule every image set travels with
    expect(md).toContain('僅引用路徑，禁止複製');
    expect(r.fields.constraints.some((c) => c.includes('禁止複製'))).toBe(true);
  });

  it('a human-checklist-only form passes with no commands and runs as manual', () => {
    const md = composePrd(manualOnlyForm());
    const r = lintPrd(md, { exists });
    expect(r.missing).toEqual([]);
    expect(r.fields.verify_steps).toEqual([]);
    expect(r.fields.verify_mode).toEqual(['manual']);
    expect(r.fields.manual_checks[0]).toMatch(/^Given .* When .* Then /);
  });

  it('round-trips: parse(compose(form)) gives the form back', () => {
    for (const make of [algoForm, manualOnlyForm]) {
      const f = make();
      const { form, lint } = parsePrdToForm(composePrd(f), { exists });
      expect(lint.ok).toBe(true);
      expect(form.kind).toBe(f.kind);
      expect(form.repo).toEqual(f.repo);
      expect(form.change).toEqual(f.change);
      expect(form.verify.commands).toEqual(f.verify.commands);
      expect(form.verify.manual).toEqual(f.verify.manual);
      expect(form.verify.llm).toBe(f.verify.llm);
      if (f.verify.dataset) {
        expect(form.verify.dataset).toMatchObject({ input: '/data/imgs', golden: '/data/golden', recipe: 'T550', fp_rate: 1, miss: 0, tol: 0.5, requires: ['gpu'] });
        expect(form.verify.dataset?.commands[0]).toBe(datasetCommand(f.verify.dataset));
      } else {
        expect(form.verify.dataset).toBeNull();
      }
      expect(form.scope).toEqual(f.scope);
      expect(form.acceptance).toEqual(f.acceptance);
      // and composing the parsed form is a fixed point
      expect(composePrd(form)).toBe(composePrd(f));
    }
  });

  it('opens a hand-written PRD too, keeping the whole goal as the symptom', () => {
    const md = `# 手寫的

## 目標
把 slugify 改成支援中文，因為現在中文標題全變成空字串。

## 範圍
- src/slugify.ts

## 非範圍
- 不動 router

## 驗收標準
- [ ] slugify("你好") 不是空字串

## 驗證指令
\`\`\`bash
npm test
\`\`\`

## Repo
- path: /home/x/repo

## 領域
typescript
`;
    const { form, lint } = parsePrdToForm(md, { exists });
    expect(lint.ok).toBe(true);
    expect(form.kind).toBeNull();
    expect(form.change.symptom).toContain('把 slugify 改成支援中文');
    expect(form.change.extra).toEqual(['src/slugify.ts']);
    expect(form.verify.commands).toEqual(['npm test']);
    expect(form.verify.dataset).toBeNull();
    expect(form.scope.complexity).toBe('M');
  });

  it('never writes placeholders, even for an empty form', () => {
    const md = composePrd(emptyForm());
    expect(md).not.toMatch(/<[^>]*>|TODO|TBD/);
    expect(lintPrd(md, { exists }).ok).toBe(false); // empty is still incomplete — honestly so
  });

  it('reports the verify modes the composed PRD will carry', () => {
    expect(verifyModes(algoForm())).toEqual(['command', 'manual']);
    expect(verifyModes(manualOnlyForm())).toEqual(['manual']);
    const f = algoForm();
    f.verify.llm = true;
    expect(verifyModes(f)).toEqual(['command', 'llm', 'manual']);
  });

  it('the dataset command is one shell line that starts the IP server and compares against golden', () => {
    const cmd = datasetCommand({ ...emptyDataset(), input: '/imgs', golden: '/gold', recipe: 'R1', tol: 0.25 });
    expect(cmd.split('\n')).toHaveLength(1);
    expect(cmd).toContain('cfaoi_ip --mode offline-tcp');
    expect(cmd).toContain('control_test.py --image "$f" --recipe R1');
    expect(cmd).toContain('compare_results.py');
    expect(cmd).toContain('--glmean-tol 0.25');
    expect(cmd).toContain('trap "kill $IP" EXIT');
  });
});

describe('section aliases', () => {
  it('resolve every heading to its own section — including the ones that contain another alias', () => {
    const table: [string, string][] = [
      ['非範圍 (Non-goals)', 'non_goals'],
      ['目標 (Goal)', 'goal'],
      ['範圍 (Scope)', 'scope'],
      ['驗收標準 (Acceptance)', 'acceptance'],
      ['人工驗收 (Manual checks)', 'manual'],
      ['驗證指令 (Verify)', 'verify'],
      ['驗證方式 (Verify mode)', 'verify_mode'],
      ['圖集比對 (Dataset)', 'dataset'],
      ['需求能力 (Requires)', 'requires'],
      ['前置指令 (Setup)', 'setup'],
      ['Repo', 'repo'],
      ['領域 (Domain)', 'domain'],
      ['複雜度 (Complexity)', 'complexity'],
      ['限制 (Constraints)', 'constraints'],
    ];
    for (const [heading, key] of table) expect(sectionKey(heading), heading).toBe(key);
  });
});
