import type { PrdKind } from '../chat/intent.js';

/**
 * A PRD-wizard form pre-filled from a chat answer. Mirrors `emptyForm()` in web/prd-compose.js
 * (the wizard owns the shape and the markdown composer; the server only fills fields, leaves
 * `markdown` empty and lets the page recompose on load). Only fields the answer can honestly
 * supply are set — scope defaults still come from the kind presets when the wizard applies them.
 */

export interface PrefillInput {
  kind: PrdKind;
  title: string;
  symptom: string;
  expected: string;
  repo_path: string | null;
  module: string | null;
  sources: Array<{ title: string; url: string }>;
  conversationTitle: string;
}

export function prefillForm(p: PrefillInput): Record<string, unknown> {
  const extra = [
    ...p.sources.slice(0, 5).map((s) => `參考來源：${s.title === s.url ? '' : `${s.title} `}${s.url}`),
    p.conversationTitle ? `來自對話：${p.conversationTitle}` : '',
  ].filter(Boolean);
  return {
    kind: p.kind,
    repo: { path: p.repo_path ?? '', branch: 'main', module: p.module },
    change: { title: p.title, symptom: p.symptom, expected: p.expected, files: [], extra },
    verify: { commands: [], dataset: null, manual: [], llm: false },
    scope: { non_goals: [], constraints: [], domain: 'other', complexity: p.kind === 'bugfix' ? 'S' : 'M', setup: [] },
    acceptance: [],
    markdown_override: null,
  };
}
