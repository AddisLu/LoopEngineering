// D5: ADO/GitHub work-item integration bridge — provider abstraction. Loop plugs INTO
// the company's ADO/GitHub as the autonomous execution layer, never replaces it.

export interface WorkItem {
  id: string; // provider-native id (GitHub issue number, ADO work item id) — a string for URL-safety
  title: string;
  body: string;
  url: string;
  repo?: string; // GitHub only: 'owner/name'
  branch?: string;
}

export interface PushResultInput {
  pr_url: string | null;
  status: string;
  merge_status: string | null;
}

export interface WorkProvider {
  name: 'github' | 'ado';
  /** Never throws — a query/network failure resolves to []. */
  listWorkItems(query: string): Promise<WorkItem[]>;
  /** Never throws — comments the PR link + outcome onto the origin work item, best-effort. */
  pushResult(item: WorkItem, result: PushResultInput): Promise<void>;
}

/** Shared comment body both providers post back onto the origin work item. */
export function formatPushComment(result: PushResultInput): string {
  const lines = [`Loop status: ${result.status}`];
  if (result.pr_url) lines.push(`PR: ${result.pr_url}`);
  if (result.merge_status) lines.push(`merge: ${result.merge_status}`);
  return lines.join('\n');
}
