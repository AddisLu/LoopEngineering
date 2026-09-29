// Types for web/prd-compose.js, so server code (src/chatops) composes PRDs with the page's own composer.
export interface WebPrdFile {
  path: string;
  why?: string;
}
export interface WebPrdManual {
  given: string;
  when: string;
  then: string;
}
export interface WebPrdDataset {
  input: string;
  golden: string;
  recipe: string;
  fp_rate: number | string | null;
  miss: number | string | null;
  tol: number | string | null;
  commands: string[];
  requires: string[];
  host?: string | null;
}
export interface WebPrdForm {
  kind: string | null;
  repo: { path: string; branch: string; module: string | null };
  change: { title: string; symptom: string; expected: string; files: WebPrdFile[]; extra: string[] };
  verify: {
    commands: string[];
    dataset: WebPrdDataset | null;
    manual: Array<WebPrdManual | string>;
    llm: boolean;
    metrics: string[];
    artifacts: string[];
  };
  scope: { non_goals: string[]; constraints: string[]; domain: string; complexity: string; setup: string[]; protected: string[] };
  acceptance: string[];
  plan_id: string | null;
  markdown_override: string | null;
  /** the 工作流程 canvas: what kind of flow this form drives and who runs / judges it */
  flow?: { type: string; models: string[]; judges: string[] };
}
export const KIND_LABEL: Record<'algo' | 'feature' | 'bugfix' | 'perf', string>;
export const DATASET_NOTICE: string;
export function emptyForm(): WebPrdForm;
export function emptyDataset(): WebPrdDataset;
export function datasetCommand(ds: WebPrdDataset): string;
export function composePrd(form: Partial<WebPrdForm>): string;
export function verifyModes(form: Partial<WebPrdForm>): string[];
