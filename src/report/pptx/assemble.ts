/**
 * Weekly deck-spec assembly: ISO week ids, previous-week lookup (skip-week safe),
 * roadmap checkpoint-date parsing, current_index resolution, and the pure `assembleDeckSpec`
 * that ties registry + roadmaps + prior spec + status candidates + WP snapshots together
 * into one DeckSpec. All fs access goes through the injectable `AssembleFs` (mirrors
 * src/report/persist.ts's PersistWriteFns style) so weekly.ts's callers stay hermetic in tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OpWorkPackage } from '../opdata.js';
import { classifyStatusItems, type StatusCandidate } from './diff.js';
import {
  validateDeckSpec,
  type Checkpoint,
  type DeckProject,
  type DeckSpec,
  type ExplainPage,
  type ProjectRegistry,
  type RoadmapConfig,
  type SummaryRow,
} from './spec.js';

/** fs dependency-injection interface (mirrors persist.ts's PersistWriteFns) — default
 * implementation uses node:fs synchronously, tests inject an in-memory fake. */
export interface AssembleFs {
  readFile: (p: string) => string;
  writeFile: (p: string, content: string) => void;
  readdir: (dir: string) => string[];
  exists: (p: string) => boolean;
  mkdir: (dir: string) => void;
}

export const defaultAssembleFs: AssembleFs = {
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, content) => fs.writeFileSync(p, content, 'utf8'),
  readdir: (dir) => fs.readdirSync(dir),
  exists: (p) => fs.existsSync(p),
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
};

/** ISO 8601 week id ('YYYY-Www') — standard "shift to the Thursday of this week" algorithm,
 * so year boundaries resolve correctly either direction (e.g. 2027-01-01 is a Friday,
 * which falls in week 53 of 2026, not week 1 of 2027). Zero-padded week numbers keep
 * lexicographic string ordering equal to chronological ordering across year boundaries
 * too (findPrevWeekSpec below relies on this). */
export function weekId(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Monday=1 .. Sunday=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Scans `<dir>/weeks/` for every subdirectory that has a deck-spec.json, and returns the
 * one with the lexicographically-largest week id strictly less than `currentWeek` (skip-week
 * safe: a holiday-skipped week still finds the last real prior one). Returns null when
 * there is none (first week ever, or the weeks/ dir doesn't exist). Never throws. */
export function findPrevWeekSpec(dir: string, currentWeek: string, assembleFs: AssembleFs): DeckSpec | null {
  const weeksDir = path.join(dir, 'weeks');
  if (!assembleFs.exists(weeksDir)) return null;

  let entries: string[];
  try {
    entries = assembleFs.readdir(weeksDir);
  } catch {
    return null;
  }

  let bestWeek: string | null = null;
  for (const entry of entries) {
    if (entry >= currentWeek) continue;
    if (!assembleFs.exists(path.join(weeksDir, entry, 'deck-spec.json'))) continue;
    if (!bestWeek || entry > bestWeek) bestWeek = entry;
  }
  if (!bestWeek) return null;

  try {
    const raw = JSON.parse(assembleFs.readFile(path.join(weeksDir, bestWeek, 'deck-spec.json')));
    const validated = validateDeckSpec(raw);
    return validated.ok ? validated.spec : null;
  } catch {
    return null;
  }
}

/** Roadmap checkpoint date shorthand used in projects/<key>/roadmap.json: "YY/MM" means
 * the last day of that month; "YY/MM/B" (B = second-half-of-month cutoff) means the 15th.
 * Anything else doesn't parse -- that checkpoint just doesn't participate in date-based
 * current_index inference (rule 3 below), it isn't a hard error. */
export function parseCheckpointDate(s: string): Date | null {
  const trimmed = s.trim();

  const half = trimmed.match(/^(\d{2})\/(\d{2})\/B$/);
  if (half) {
    const year = 2000 + Number(half[1]);
    const month = Number(half[2]);
    if (month < 1 || month > 12) return null;
    return new Date(Date.UTC(year, month - 1, 15));
  }

  const full = trimmed.match(/^(\d{2})\/(\d{2})$/);
  if (full) {
    const year = 2000 + Number(full[1]);
    const month = Number(full[2]);
    if (month < 1 || month > 12) return null;
    return new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
  }

  return null;
}

/**
 * Resolve the roadmap marker's current_index, highest-priority rule wins:
 * 1. `override` given → clamp into [0, checkpoints.length-1] and use directly.
 * 2. Any checkpoint bound to a `wp` found in `wpsById` → the last (highest-index) such
 *    checkpoint that's `is_closed` (none closed → 0).
 * 3. Otherwise → the last checkpoint whose `parseCheckpointDate(date) <= today` (none → 0).
 */
export function computeCurrentIndex(
  roadmap: { checkpoints: Checkpoint[] },
  wpsById: Map<number, OpWorkPackage>,
  today: Date,
  override?: number,
): number {
  const checkpoints = roadmap.checkpoints;
  const maxIdx = checkpoints.length ? checkpoints.length - 1 : 0;

  if (override !== undefined) return Math.min(Math.max(0, Math.round(override)), maxIdx);
  if (!checkpoints.length) return 0;

  const resolvable = checkpoints
    .map((cp, idx) => ({ idx, wp: cp.wp != null ? wpsById.get(cp.wp) : undefined }))
    .filter((r): r is { idx: number; wp: OpWorkPackage } => r.wp !== undefined);

  if (resolvable.length) {
    let lastClosed = -1;
    for (const r of resolvable) if (r.wp.is_closed) lastClosed = r.idx;
    return lastClosed >= 0 ? lastClosed : 0;
  }

  let lastDated = -1;
  for (let i = 0; i < checkpoints.length; i++) {
    const date = parseCheckpointDate(checkpoints[i]?.date ?? '');
    if (date && date.getTime() <= today.getTime()) lastDated = i;
  }
  return lastDated >= 0 ? lastDated : 0;
}

export interface AssembleDeckSpecInput {
  week: string;
  registry: ProjectRegistry;
  roadmaps: Map<string, RoadmapConfig>;
  prevSpec: DeckSpec | null;
  statusCandidates: Map<string, StatusCandidate[]>;
  explain: Map<string, ExplainPage[]>;
  wps: Map<string, OpWorkPackage[]>;
  currentOverrides?: Map<string, number>;
  now: Date;
}

/**
 * Pure assembly of one week's DeckSpec: for each enabled registry project, deterministically
 * color its status items (diffed against prevSpec), resolve its roadmap current_index, and
 * attach its roadmap/benefit/explain pages/WP-derived data. `statusCandidates` missing a key
 * falls back to prevSpec's own items for that project (text kept, recolored -- ends up all
 * black, "nothing changed but still ships"); missing from prevSpec too → empty. Summary rows
 * are grouped by registry.pillars order and share the exact same (already-colored) status_items
 * as the corresponding main-page project, so the two views never disagree on color.
 */
export function assembleDeckSpec(input: AssembleDeckSpecInput): DeckSpec {
  const enabledProjects = input.registry.projects.filter((p) => p.enabled);
  const prevByKey = new Map((input.prevSpec?.projects ?? []).map((p) => [p.key, p]));

  const deckProjects: DeckProject[] = enabledProjects.map((project) => {
    const { key } = project;
    const roadmapConfig = input.roadmaps.get(key) ?? { checkpoints: [] };
    const prevProject = prevByKey.get(key);
    const prevTexts = prevProject?.status_items.map((i) => i.text) ?? [];

    const candidates: StatusCandidate[] = input.statusCandidates.has(key)
      ? input.statusCandidates.get(key)!
      : prevProject
        ? prevProject.status_items.map((i) => ({ text: i.text }))
        : [];
    const status_items = classifyStatusItems(prevTexts, candidates);

    const wpsById = new Map<number, OpWorkPackage>();
    for (const wp of input.wps.get(key) ?? []) {
      const id = typeof wp.id === 'number' ? wp.id : Number(wp.id);
      if (Number.isFinite(id)) wpsById.set(id, wp);
    }
    const current_index = computeCurrentIndex(roadmapConfig, wpsById, input.now, input.currentOverrides?.get(key));

    return {
      key,
      pillar: project.pillar,
      fab: project.fab,
      name: project.name,
      ...(roadmapConfig.benefit ? { benefit: roadmapConfig.benefit } : {}),
      roadmap: { checkpoints: roadmapConfig.checkpoints, current_index },
      status_items,
      explain_pages: input.explain.get(key) ?? [],
    };
  });

  // Summary rows: grouped by registry.pillars declared order, any project whose pillar
  // isn't listed there falls back to the end in registry order (never silently dropped).
  const orderedKeys: string[] = [];
  for (const pillar of input.registry.pillars) {
    for (const project of enabledProjects) if (project.pillar === pillar) orderedKeys.push(project.key);
  }
  for (const project of enabledProjects) if (!orderedKeys.includes(project.key)) orderedKeys.push(project.key);

  const projectByKey = new Map(enabledProjects.map((p) => [p.key, p]));
  const deckProjectByKey = new Map(deckProjects.map((p) => [p.key, p]));
  const rows: SummaryRow[] = orderedKeys.map((key) => {
    const project = projectByKey.get(key)!;
    const deckProject = deckProjectByKey.get(key)!;
    return {
      pillar: project.pillar,
      project: project.name,
      fab_line: project.fab_line,
      status_items: deckProject.status_items,
    };
  });

  return {
    version: 1,
    week: input.week,
    generated_at: input.now.toISOString(),
    summary: { rows },
    projects: deckProjects,
  };
}
