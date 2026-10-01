// src/repo/profile/types.ts
export interface Evidence { file: string; line?: number | null; text?: string | null }
export type RequirementKind = 'os' | 'arch' | 'toolchain' | 'sdk' | 'library' | 'runtime' | 'hardware' | 'license' | 'gpu';
export interface Requirement {
  kind: RequirementKind;
  /** e.g. 'Windows', 'x64', 'Visual Studio 2022 (v143)', 'CUDA', 'MIL', 'OpenCV', 'Matrox 擷取卡', '.NET', 'Python' */
  name: string;
  version: string | null;
  /** short Chinese note for a person, e.g. '需要 Matrox 擷取卡與 MIL runtime 授權' */
  note: string | null;
  /** module (project/target/dir) it comes from; null = whole repo */
  module: string | null;
  evidence: Evidence[];
}
export interface StyleProfile {
  module: string; // '' = repo-wide
  files_sampled: number;
  languages: string[];
  encoding: { utf8: number; utf8_bom: number; big5: number; other: number; dominant: 'utf8' | 'utf8_bom' | 'big5' | 'mixed' | null };
  eol: 'crlf' | 'lf' | 'mixed' | null;
  indent: 'tab' | '2' | '4' | 'mixed' | null;
  brace: 'same_line' | 'next_line' | 'mixed' | null;
  /** observed conventions, Chinese short phrases with an example, e.g. '成員變數 m_ 前綴（m_width）', '類別 PascalCase', '函式 snake_case' */
  naming: string[];
  header_guard: 'pragma_once' | 'ifndef' | 'mixed' | null;
  comment_lang: 'zh' | 'en' | 'mixed' | null;
  /** e.g. '例外（throw/try）', '回傳錯誤碼', 'MIL：MappGetError 檢查' */
  error_handling: string[];
  /** logging calls seen, e.g. 'fmt::print', 'std::cerr', 'spdlog', 'Console.WriteLine', 'ILogger', 'logging' */
  logging: string[];
  /** string types, e.g. 'std::string', 'CString', 'std::wstring' */
  strings: string[];
  /** style config files found: .clang-format, .editorconfig, .clang-tidy, stylecop.json, ruff/black/flake8 sections */
  configs: Evidence[];
}
export interface ModuleInfo {
  name: string;
  path: string; // repo-relative dir
  kind: 'cmake_target' | 'vs_project' | 'csproj' | 'python_pkg' | 'dir';
  language: string | null;
  output: 'exe' | 'gui_exe' | 'lib' | 'dll' | 'script' | null;
  depends_on: string[];
  entry_points: string[];
  files: number;
  evidence: Evidence[];
}
export interface VerifyProfile {
  frameworks: Array<{ name: string; module: string | null; evidence: Evidence[] }>;
  test_dirs: string[];
  commands: Array<{ label: string; command: string; module: string | null }>;
  /** modules that can run without a GUI, and how */
  headless: Array<{ module: string; how: string; evidence: Evidence[] }>;
  /** modules that only have a GUI (WinExe / SubSystem Windows / WinForms/WPF/Avalonia app) */
  gui_only: string[];
  eval_scripts: string[];
  answer_files: string[];
  /** suggested protected paths (eval scripts, answer files, golden data) */
  protected_suggestions: string[];
}
export interface Hotspot { file: string; commits: number; fix_commits: number; last: string | null }
export type IndexKind = 'param' | 'param_use' | 'log' | 'incident' | 'error_code';
export interface IndexEntry {
  kind: IndexKind;
  /** param: the key; log: the message text (format string); incident: the kind; error_code: the symbol */
  key: string;
  /** ini section / enum name / null */
  section: string | null;
  file: string;
  line: number;
  /** the source line, trimmed, ≤ 200 chars */
  text: string;
  /** param: default value in the config file; error_code: numeric value; else null */
  value: string | null;
  /** param: the comment lines right above it in the config file (≤ 300 chars); else null */
  meaning: string | null;
}
export interface RepoProfileFacets {
  sha: string | null;
  requirements: Requirement[];
  style: StyleProfile[];
  modules: ModuleInfo[];
  verify: VerifyProfile;
  hotspots: Hotspot[];
  built_ms: number;
  warnings: string[];
}
export type GitExec = (args: string[], cwd: string) => string;
export interface AnalyseOptions { git?: GitExec; maxStyleFiles?: number; now?: () => number }
export interface RepoAnalysis { facets: RepoProfileFacets; index: IndexEntry[] }
