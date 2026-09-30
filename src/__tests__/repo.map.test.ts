import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRepoMap, renderRepoMap, saveRepoMap, scanSymbols, listRepoFiles } from '../repo/map.js';
import { extractClues, locateIssue } from '../repo/locate.js';

let repo: string;
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const RECIPE_LOADER = `#include "recipe_loader.h"
// loads a recipe and applies it to the running controller
namespace control {

class RecipeLoader {
 public:
  bool load(const std::string& file);
};

void apply_recipe(const Recipe& r, bool recipe_changed)
{
  if (!recipe_changed) return;
  set_param("bypass_edge_x", r.bypass_edge_x);
  log_info("LOAD_RECIPE OK");
}

static int helper(int a, int b) {
  return a + b;
}

}  // namespace control
`;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-'));
  fs.mkdirSync(path.join(repo, 'src', 'control'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'CMakeLists.txt'), 'project(cfaoi)\nadd_executable(cfaoi_ip src/main.cpp)\n');
  fs.writeFileSync(path.join(repo, 'src', 'main.cpp'), 'int main(int argc, char** argv)\n{\n  return 0;\n}\n');
  fs.writeFileSync(path.join(repo, 'src', 'control', 'recipe_loader.cpp'), RECIPE_LOADER);
  fs.writeFileSync(path.join(repo, 'src', 'control', 'recipe_loader.h'), '#pragma once\nnamespace control { void apply_recipe(const Recipe& r, bool recipe_changed); }\n');
  fs.writeFileSync(path.join(repo, 'src', 'control', 'params.py'), 'class Params:\n    def merge(self, other):\n        return self\n\nasync def reload_all():\n    pass\n');
  fs.writeFileSync(path.join(repo, 'ui', 'recipe_panel.cs'), 'public partial class RecipePanel : Form {\n    private void OnLoadClicked(object sender, EventArgs e)\n    {\n        Log("LOAD_RECIPE OK");\n    }\n}\n');
  fs.writeFileSync(path.join(repo, 'ui', 'panel.ts'), 'export function mountPanel(el: HTMLElement) {}\nexport const paintRecipe = async (x: number) => x;\nclass Drawer {}\n');
  fs.writeFileSync(path.join(repo, 'tests', 'test_recipe_reload.py'), 'def test_second_load():\n    assert apply_recipe(second=True)\n');
  fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'index.js'), 'function shouldNotAppear() {}\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'feat(control): recipe loader']);
  fs.appendFileSync(path.join(repo, 'src', 'control', 'recipe_loader.cpp'), '// touched\n');
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'fix(control): 減少重複載入']);
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('repo 地圖', () => {
  it('lists tracked files without the skipped directories', () => {
    const files = listRepoFiles(repo);
    expect(files).toContain('src/control/recipe_loader.cpp');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('finds functions and classes across C++, Python, C# and TypeScript without false hits on control flow', () => {
    const cpp = scanSymbols('a.cpp', RECIPE_LOADER, 'cpp');
    expect(cpp.map((s) => `${s.kind}:${s.name}:${s.line}`)).toEqual(['class:RecipeLoader:5', 'function:apply_recipe:10', 'function:helper:17']);
    expect(scanSymbols('p.py', fs.readFileSync(path.join(repo, 'src/control/params.py'), 'utf8'), 'python').map((s) => s.name)).toEqual(['Params', 'merge', 'reload_all']);
    expect(scanSymbols('r.cs', fs.readFileSync(path.join(repo, 'ui/recipe_panel.cs'), 'utf8'), 'csharp').map((s) => s.name)).toEqual(['RecipePanel', 'OnLoadClicked']);
    expect(scanSymbols('p.ts', fs.readFileSync(path.join(repo, 'ui/panel.ts'), 'utf8'), 'typescript').map((s) => s.name)).toEqual(['mountPanel', 'paintRecipe', 'Drawer']);
  });

  it('builds the map: languages, dirs, entry points, build commands, symbols, sha', () => {
    const map = buildRepoMap(repo);
    expect(map.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(Object.keys(map.languages)[0]).toBe('cpp');
    expect(map.languages.python).toBeGreaterThan(0);
    expect(map.dirs.map((d) => d.name)).toContain('src/');
    expect(map.entryPoints).toContain('CMakeLists.txt');
    expect(map.entryPoints).toContain('CMakeLists.txt: add_executable(cfaoi_ip)');
    expect(map.entryPoints).toContain('src/main.cpp');
    expect(map.build[0]).toContain('cmake');
    expect(map.symbols.find((s) => s.name === 'apply_recipe')).toMatchObject({ file: 'src/control/recipe_loader.cpp', line: 10 });
    expect(map.truncated).toBe(false);
    const md = renderRepoMap('cf-aoi', map);
    expect(md).toContain('# Repo 地圖 — cf-aoi @ ');
    expect(md).toContain('C++');
    expect(md).toContain('- src/control/recipe_loader.cpp: RecipeLoader{}:5, apply_recipe():10, helper():17');
    // the budget cuts whole symbol lines, never the head
    const small = renderRepoMap('cf-aoi', map, 420);
    expect(small).toContain('## 符號索引');
    expect(small).toContain('…（其餘省略）');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-maps-'));
    const file = saveRepoMap('r_abc', md, dir);
    expect(fs.readFileSync(file, 'utf8')).toBe(md);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps the symbol index and says so', () => {
    const map = buildRepoMap(repo, { maxSymbols: 2 });
    expect(map.symbols).toHaveLength(2);
    expect(map.truncated).toBe(true);
  });
});

describe('問題定位', () => {
  it('pulls error strings, identifiers, paths and UI labels out of a description', () => {
    const clues = extractClues([
      '連續兩次 LOAD_RECIPE 後第二次的 bypass_edge_x 沒生效，附截圖；應該每次都套用最新值。',
      '畫面上顯示「LOAD_RECIPE OK」但值沒變，按「重新載入」按鈕也一樣。',
      'Error: apply_recipe skipped (recipe_changed=false) in src/control/recipe_loader.cpp',
      'Params::merge 只比對整數',
    ].join('\n'));
    expect(clues.identifiers).toEqual(expect.arrayContaining(['LOAD_RECIPE', 'bypass_edge_x', 'apply_recipe', 'recipe_changed', 'Params', 'merge'].filter((s) => s.length >= 5)));
    expect(clues.identifiers).not.toContain('Error');
    expect(clues.paths).toEqual(['src/control/recipe_loader.cpp']);
    expect(clues.labels).toEqual(['重新載入']);
    expect(clues.errors).toContain('LOAD_RECIPE OK'); // an ASCII quote is a message, not a UI label
    expect(clues.errors.some((e) => e.startsWith('Error: apply_recipe skipped'))).toBe(true);
  });

  it('ranks the file the clues point at first, with evidence lines and recent commits', () => {
    const clues = extractClues('第二次 LOAD_RECIPE 後 bypass_edge_x 沒生效：apply_recipe 因為 recipe_changed 是 false 直接跳過。Params::merge 只比對整數。');
    const map = buildRepoMap(repo);
    const cands = locateIssue(repo, clues, { symbols: map.symbols });
    expect(cands[0]!.file).toBe('src/control/recipe_loader.cpp');
    expect(cands[0]!.evidence.some((e) => e.text.includes('bypass_edge_x'))).toBe(true);
    expect(cands[0]!.recent[0]).toMatch(/fix\(control\): 減少重複載入/);
    expect(cands.map((c) => c.file)).toContain('ui/recipe_panel.cs');
    expect(cands.map((c) => c.file)).toContain('src/control/params.py');
    expect(cands.every((c) => !c.file.startsWith('node_modules/'))).toBe(true);
  });

  it('a path clue alone finds its file even when nothing else matches', () => {
    const cands = locateIssue(repo, { errors: [], identifiers: [], paths: ['recipe_panel.cs'], labels: [] });
    expect(cands[0]!.file).toBe('ui/recipe_panel.cs');
    expect(locateIssue(repo, { errors: [], identifiers: ['nothing_like_this_anywhere'], paths: [], labels: [] })).toEqual([]);
  });
});
