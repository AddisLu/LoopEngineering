// Types for web/prd-form.js (form builders shared by web/flow.js and src/chatops/compose.ts).
import type { WebPrdForm } from './prd-compose.js';
export interface WebVerifyPlan {
  id: string;
  name: string;
  host?: string | null;
  steps?: string[];
  dataset_root?: string | null;
  dataset_default?: string | null;
  metrics?: string | null;
  artifacts?: string[];
  protected_paths?: string[];
  manual_checks?: string[];
  setup_cmd?: string | null;
  domain?: string | null;
  repo_path?: string | null;
}
export function baseName(p: string | null | undefined): string;
export function mergeForm(stored: Partial<WebPrdForm> | null | undefined): WebPrdForm & { flow: { type: string; models: string[]; judges: string[] } };
export function planSteps(plan: Pick<WebVerifyPlan, 'host' | 'steps'>, dataset: string | null): string[];
export function applyPlan(f: WebPrdForm, plan: WebVerifyPlan): void;
export function applyKind(f: WebPrdForm, key: string): void;
