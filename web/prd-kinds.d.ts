// Types for web/prd-kinds.js: the change-type presets the 工作流程 page and 對話操作 share.
export type PrdKindKey = 'algo' | 'feature' | 'bugfix' | 'perf';
export interface PrdKindPreset {
  label: string;
  blurb: string;
  methods: string[];
  domain: string;
  complexity: 'S' | 'M' | 'L';
  hints: { symptom: string; expected: string };
  nonGoals: string[];
  constraints: string[];
  acceptance: string[];
}
export const KINDS: Record<PrdKindKey, PrdKindPreset>;
