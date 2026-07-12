/**
 * Weekly two-stage flow: `prepareWeekly` fetches WP snapshots, generates LLM status
 * candidates (see status.ts/quality.ts — best-effort, any failure carries last week's
 * items forward per assemble.ts's fallback rule) and drafts a deck-spec + an
 * explain-pages gate file for a human to edit; `renderWeekly` re-validates + re-colors
 * deterministically (so manual text edits still diff correctly), applies the human's
 * approve/reject gate on explain pages, drops any page whose image is missing, renders,
 * and writes the *actual shipped* deck-spec back to disk — that's what next week's diff
 * reads.
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../../db/index.js';
import { DEFAULT_SETTINGS } from '../../config.js';
import { fetchProjectWorkPackages, type OpDataExec, type OpWorkPackage } from '../opdata.js';
import { renderDeck, qaRender, resolveManifestPath, type PptxRenderExec } from './render.js';
import {
  validateDeckSpec,
  parseManifest,
  parseRegistry,
  parseRoadmap,
  type DeckSpec,
  type ExplainPage,
  type RegistryProject,
  type RoadmapConfig,
} from './spec.js';
import { classifyStatusItems, type StatusCandidate } from './diff.js';
import { assembleDeckSpec, findPrevWeekSpec, weekId, defaultAssembleFs, type AssembleFs } from './assemble.js';
import { detectChangedWps, generateStatusCandidates, type ContentExec } from './status.js';
import { polishItems, judgeDeckContent } from './quality.js';

export interface WeeklyDeps {
  dataExec?: OpDataExec;
  renderExec?: PptxRenderExec;
  /** Test injection for status.ts/quality.ts's LLM calls (generate/polish/judge all
   * share this one hook — see CLAUDE.md's "ContentExec 全注入" hermeticity constraint). */
  contentExec?: ContentExec;
  fs?: AssembleFs;
  now?: () => Date;
}

export interface PrepareWeeklyResult {
  specPath: string;
  explainPath: string;
  warnings: string[];
}

export interface RenderWeeklyResult {
  output: string;
  slides: number;
  warnings: string[];
}

const SAMPLE_REGISTRY_JSON = JSON.stringify(
  {
    version: 1,
    pillars: ['AMC', 'Energy'],
    projects: [
      {
        key: 'aoi-amc',
        pillar: 'AMC',
        name: 'AOI 專案',
        fab: 'Fab1',
        fab_line: 'Fab1/LineA',
        op_project: 'AOI',
        enabled: true,
      },
    ],
  },
  null,
  2,
);

function registryPath(pptxDir: string): string {
  return path.join(pptxDir, 'projects.json');
}
function roadmapPath(pptxDir: string, key: string): string {
  return path.join(pptxDir, 'projects', key, 'roadmap.json');
}
function weekDir(pptxDir: string, week: string): string {
  return path.join(pptxDir, 'weeks', week);
}
function specPathFor(pptxDir: string, week: string): string {
  return path.join(weekDir(pptxDir, week), 'deck-spec.json');
}
function explainPathFor(pptxDir: string, week: string): string {
  return path.join(weekDir(pptxDir, week), 'explain-pages.json');
}
function wpSnapshotPath(pptxDir: string, week: string, key: string): string {
  return path.join(weekDir(pptxDir, week), 'workpackages', `${key}.json`);
}

function readJson(assembleFs: AssembleFs, p: string): unknown | null {
  if (!assembleFs.exists(p)) return null;
  try {
    return JSON.parse(assembleFs.readFile(p));
  } catch {
    return null;
  }
}

function resolvePptxDir(db: Database.Database): string {
  return getSetting(db, 'report_pptx_dir') || DEFAULT_SETTINGS.report_pptx_dir || '';
}

// spec.ts's own parseManifest default when summary.max_item_chars is missing/invalid —
// reused here so an unwritten/unreadable manifest.json degrades to the exact same number.
const DEFAULT_MAX_ITEM_CHARS = 200;

function resolveMaxItemChars(db: Database.Database, assembleFs: AssembleFs): number {
  const manifestRaw = readJson(assembleFs, resolveManifestPath(db));
  if (manifestRaw === null) return DEFAULT_MAX_ITEM_CHARS;
  const parsed = parseManifest(manifestRaw);
  return parsed.ok ? parsed.manifest.summary.max_item_chars : DEFAULT_MAX_ITEM_CHARS;
}

interface StatusCandidatesResult {
  candidates: Map<string, StatusCandidate[]>;
  qualityFlags: Map<string, string[]>;
}

/**
 * LLM status-candidate generation for every enabled project: changedWps (diffed against
 * last week's persisted WP snapshot) -> generateStatusCandidates -> polishItems ->
 * (report_pptx_judge on) judge -> on fail, one regenerate-with-feedback pass -> judge
 * again -> still failing -> quality_flags. A project whose generation didn't actually
 * use the LLM (guard tripped, exec null, unparseable) is left OUT of `candidates`
 * entirely (not set to []) so assembleDeckSpec's `.has(key)` seam falls through to its
 * own carry-last-week-forward fallback — the deck must never ship blank over an LLM
 * hiccup. `llm=false` (the `--no-llm` CLI flag) skips this whole pass, matching T2's
 * original all-black-carryover behavior exactly (and never touches contentExec at all).
 */
async function buildStatusCandidates(
  db: Database.Database,
  opts: {
    enabledProjects: RegistryProject[];
    wps: Map<string, OpWorkPackage[]>;
    prevSpec: DeckSpec | null;
    pptxDir: string;
    assembleFs: AssembleFs;
    llm: boolean;
    contentExec?: ContentExec;
    warnings: string[];
  },
): Promise<StatusCandidatesResult> {
  const candidates = new Map<string, StatusCandidate[]>();
  const qualityFlags = new Map<string, string[]>();
  if (!opts.llm) return { candidates, qualityFlags };

  const maxItemChars = resolveMaxItemChars(db, opts.assembleFs);
  const budgetChars = getNum(db, 'report_budget_chars', 4000);
  const qualityGateOn = getBool(db, 'report_pptx_judge', true);
  const prevWeek = opts.prevSpec?.week ?? null;
  const prevByKey = new Map((opts.prevSpec?.projects ?? []).map((p) => [p.key, p]));

  for (const project of opts.enabledProjects) {
    const currentWps = opts.wps.get(project.key) ?? [];
    const prevProject = prevByKey.get(project.key);
    const prevItems = prevProject?.status_items.map((i) => i.text) ?? [];

    let prevWps: OpWorkPackage[] | null = null;
    if (prevWeek) {
      const raw = readJson(opts.assembleFs, wpSnapshotPath(opts.pptxDir, prevWeek, project.key));
      if (Array.isArray(raw)) prevWps = raw as OpWorkPackage[];
    }
    const changedWps = detectChangedWps(currentWps, prevWps);

    const genInput = { projectName: project.name, changedWps, allOpenWps: currentWps, prevItems, maxItemChars, budgetChars };
    const gen = await generateStatusCandidates(db, genInput, opts.contentExec);
    if (!gen.usedLlm) {
      opts.warnings.push(`${project.key}: LLM status generation unavailable/failed — falling back to last week's items`);
      continue;
    }

    let items = await polishItems(db, gen.items, maxItemChars, opts.contentExec);

    if (qualityGateOn) {
      const judgeInput = { projectName: project.name, items, explainPages: [] as ExplainPage[], changedWpCount: changedWps.length };
      let verdict = await judgeDeckContent(db, judgeInput, opts.contentExec);
      if (!verdict.pass) {
        const regen = await generateStatusCandidates(db, { ...genInput, feedback: verdict.feedback }, opts.contentExec);
        if (regen.usedLlm) {
          items = await polishItems(db, regen.items, maxItemChars, opts.contentExec);
          verdict = await judgeDeckContent(db, { ...judgeInput, items }, opts.contentExec);
        }
        if (!verdict.pass) {
          qualityFlags.set(project.key, [verdict.feedback]);
          opts.warnings.push(`⚠ ${project.name} 品質未達標，請把關時特別確認`);
        }
      }
    }

    candidates.set(project.key, items);
  }

  return { candidates, qualityFlags };
}

/**
 * Stage 1: read the registry + each enabled project's roadmap, fetch a fresh WP snapshot
 * (falling back to an empty set + warning on anything but a live hit), assemble a
 * carried-over-black draft deck-spec against last week's persisted one, and write out the
 * disk layout under `report_pptx_dir` (mkdir'ing `weeks/<week>/` as needed) for a human to
 * edit. Never overwrites an existing deck-spec.json/explain-pages.json in place — the spec
 * gets backed up to `.bak` first (a human may be mid-edit when prepare is re-run); the
 * explain-pages skeleton is left untouched if it already exists. Returns null (logging to
 * stderr) when the flag is off or the registry is missing/invalid.
 */
export async function prepareWeekly(
  db: Database.Database,
  opts: { week?: string; currentOverrides?: Record<string, number>; llm?: boolean },
  deps: WeeklyDeps = {},
): Promise<PrepareWeeklyResult | null> {
  if (!getBool(db, 'report_pptx_enabled', false)) {
    console.error('report_pptx_enabled is false — enable it first: loop config set report_pptx_enabled true');
    return null;
  }

  const assembleFs = deps.fs ?? defaultAssembleFs;
  const now = deps.now ? deps.now() : new Date();
  const week = opts.week?.trim() || weekId(now);
  const pptxDir = resolvePptxDir(db);

  const registryRaw = readJson(assembleFs, registryPath(pptxDir));
  if (registryRaw === null) {
    console.error(`registry not found: ${registryPath(pptxDir)}\nexample projects.json:\n${SAMPLE_REGISTRY_JSON}`);
    return null;
  }
  const parsedRegistry = parseRegistry(registryRaw);
  if (!parsedRegistry.ok) {
    console.error(`invalid registry (${registryPath(pptxDir)}): ${parsedRegistry.error}\nexample projects.json:\n${SAMPLE_REGISTRY_JSON}`);
    return null;
  }
  const registry = parsedRegistry.registry;
  const enabledProjects = registry.projects.filter((p) => p.enabled);

  const warnings: string[] = [];
  assembleFs.mkdir(path.join(weekDir(pptxDir, week), 'workpackages'));

  const roadmaps = new Map<string, RoadmapConfig>();
  const wps = new Map<string, OpWorkPackage[]>();
  let registryChanged = false;

  for (const project of enabledProjects) {
    const roadmapRaw = readJson(assembleFs, roadmapPath(pptxDir, project.key));
    if (roadmapRaw !== null) {
      const parsedRoadmap = parseRoadmap(roadmapRaw);
      if (parsedRoadmap.ok) roadmaps.set(project.key, parsedRoadmap.roadmap);
      else warnings.push(`${project.key}: invalid roadmap.json (${parsedRoadmap.error})`);
    }

    const fetchName = project.op_project ?? project.name;
    let items: OpWorkPackage[] = [];
    try {
      const fetched = await fetchProjectWorkPackages(db, { project: fetchName }, deps.dataExec);
      if (fetched.source === 'live') {
        items = fetched.items as OpWorkPackage[];
        if (fetched.project?.id && project.op_project_id == null) {
          const idNum = Number(fetched.project.id);
          if (Number.isFinite(idNum)) {
            project.op_project_id = idNum;
            registryChanged = true;
          }
        }
      } else {
        warnings.push(`${project.key}: live WP fetch unavailable, using empty WP set`);
      }
    } catch {
      warnings.push(`${project.key}: live WP fetch failed, using empty WP set`);
    }
    wps.set(project.key, items);
    assembleFs.writeFile(wpSnapshotPath(pptxDir, week, project.key), JSON.stringify(items, null, 2));
  }

  if (registryChanged) {
    assembleFs.writeFile(registryPath(pptxDir), JSON.stringify(registry, null, 2));
  }

  const prevSpec = findPrevWeekSpec(pptxDir, week, assembleFs);
  const currentOverrides = new Map<string, number>(Object.entries(opts.currentOverrides ?? {}));

  const { candidates: statusCandidates, qualityFlags } = await buildStatusCandidates(db, {
    enabledProjects,
    wps,
    prevSpec,
    pptxDir,
    assembleFs,
    llm: opts.llm !== false,
    contentExec: deps.contentExec,
    warnings,
  });

  const deckSpec = assembleDeckSpec({
    week,
    registry,
    roadmaps,
    prevSpec,
    statusCandidates,
    explain: new Map<string, ExplainPage[]>(), // explain pages are gated through explain-pages.json at render time
    wps,
    currentOverrides,
    now,
  });
  if (qualityFlags.size) {
    deckSpec.projects = deckSpec.projects.map((p) => (qualityFlags.has(p.key) ? { ...p, quality_flags: qualityFlags.get(p.key)! } : p));
  }

  const specPath = specPathFor(pptxDir, week);
  if (assembleFs.exists(specPath)) {
    assembleFs.writeFile(`${specPath}.bak`, assembleFs.readFile(specPath));
    warnings.push(`${specPath} already existed — backed up to deck-spec.json.bak and overwritten`);
  }
  assembleFs.writeFile(specPath, JSON.stringify(deckSpec, null, 2));

  const explainPath = explainPathFor(pptxDir, week);
  if (!assembleFs.exists(explainPath)) {
    assembleFs.writeFile(explainPath, JSON.stringify({ approved: false, projects: {} }, null, 2));
  }

  console.error(`deck spec: ${specPath}`);
  console.error(`explain pages: ${explainPath}`);
  console.error('請編輯以上檔案後把 explain-pages.json 的 approved 改成 true，再跑 render');

  return { specPath, explainPath, warnings };
}

interface ExplainPagesFile {
  approved: boolean;
  projects: Record<string, unknown>;
}

function parseExplainPagesFile(raw: unknown): ExplainPagesFile {
  if (!raw || typeof raw !== 'object') return { approved: false, projects: {} };
  const o = raw as Record<string, unknown>;
  const approved = o.approved === true;
  const projects = o.projects && typeof o.projects === 'object' ? (o.projects as Record<string, unknown>) : {};
  return { approved, projects };
}

/**
 * Stage 2: re-validate the (possibly hand-edited) deck-spec.json, re-run the deterministic
 * diff/coloring against last week's persisted spec (a manual `"color":"red"` survives as a
 * highlight), gate explain pages on explain-pages.json's `approved` flag (or `--allow-unapproved`),
 * drop any explain page with a missing image, render to .pptx, then write the *actual shipped*
 * deck-spec back to disk (source of truth for next week's diff). Returns null (logging to
 * stderr) when the flag is off, deck-spec.json is missing/invalid, or the render itself fails.
 */
export async function renderWeekly(
  db: Database.Database,
  opts: { week?: string; allowUnapproved?: boolean; qa?: boolean },
  deps: WeeklyDeps = {},
): Promise<RenderWeeklyResult | null> {
  if (!getBool(db, 'report_pptx_enabled', false)) {
    console.error('report_pptx_enabled is false — enable it first: loop config set report_pptx_enabled true');
    return null;
  }

  const assembleFs = deps.fs ?? defaultAssembleFs;
  const now = deps.now ? deps.now() : new Date();
  const week = opts.week?.trim() || weekId(now);
  const pptxDir = resolvePptxDir(db);

  const specPath = specPathFor(pptxDir, week);
  const specRaw = readJson(assembleFs, specPath);
  if (specRaw === null) {
    console.error(`deck-spec.json not found/unreadable: ${specPath} — run 'loop report weekly prepare' first`);
    return null;
  }
  const rawValidated = validateDeckSpec(specRaw);
  if (!rawValidated.ok) {
    console.error(`invalid deck-spec.json (${specPath}): ${rawValidated.error}`);
    return null;
  }

  const warnings: string[] = [];
  const explainFile = parseExplainPagesFile(readJson(assembleFs, explainPathFor(pptxDir, week)));
  const includeExplain = explainFile.approved || opts.allowUnapproved === true;
  if (!includeExplain) warnings.push('explain-pages.json not approved — all explain pages dropped');

  const prevSpec = findPrevWeekSpec(pptxDir, week, assembleFs);

  // Recolor deterministically + merge in explain-pages.json's gated content, then run the
  // whole thing back through validateDeckSpec so the (untrusted, hand-edited) explain-page
  // JSON gets the exact same clamping/whitespace-collapse as everything else -- no need to
  // duplicate spec.ts's own parsing logic here.
  const draft = {
    ...rawValidated.spec,
    projects: rawValidated.spec.projects.map((project) => {
      const prevProject = prevSpec?.projects.find((pp) => pp.key === project.key);
      const prevTexts = prevProject?.status_items.map((i) => i.text) ?? [];
      const candidates: StatusCandidate[] = project.status_items.map((i) => ({
        text: i.text,
        ...(i.color === 'red' ? { highlight: true } : {}),
        ...(i.sources ? { sources: i.sources } : {}),
      }));
      return {
        ...project,
        status_items: classifyStatusItems(prevTexts, candidates),
        explain_pages: includeExplain ? (explainFile.projects[project.key] ?? []) : [],
      };
    }),
  };

  const finalValidated = validateDeckSpec(draft);
  if (!finalValidated.ok) {
    console.error(`internal error re-validating merged deck spec: ${finalValidated.error}`);
    return null;
  }

  const projectsAfterImageCheck = finalValidated.spec.projects.map((project) => {
    const kept = project.explain_pages.filter((page) => {
      const missing = page.images.some((img) => !assembleFs.exists(img.path));
      if (missing) warnings.push(`${project.key}: explain page "${page.title}" dropped (missing image: ${page.images.find((i) => !assembleFs.exists(i.path))?.path})`);
      return !missing;
    });
    return { ...project, explain_pages: kept };
  });

  // Summary rows share the exact same status_items as their main-page project (matched by
  // name -- SummaryRow carries no project key) so the two views never disagree on color.
  const statusByName = new Map(projectsAfterImageCheck.map((p) => [p.name, p.status_items]));
  const rows = finalValidated.spec.summary.rows.map((row) => {
    const items = statusByName.get(row.project);
    return items ? { ...row, status_items: items } : row;
  });

  const finalSpec: DeckSpec = { ...finalValidated.spec, projects: projectsAfterImageCheck, summary: { rows } };

  const dateStr = now.toISOString().slice(0, 10);
  const outPath = path.join(weekDir(pptxDir, week), `weekly-${dateStr}.pptx`);
  const result = await renderDeck(db, finalSpec, { out: outPath }, deps.renderExec);
  if (!result) {
    console.error('render failed (check report_pptx_python / template / manifest / logs)');
    return null;
  }
  warnings.push(...result.warnings);

  // Render succeeded -- this is now the actual shipped content, so it becomes next week's
  // diff input, reflecting any explain-page/image drops above.
  assembleFs.writeFile(specPath, JSON.stringify(finalSpec, null, 2));

  if (opts.qa) {
    const qa = await qaRender(db, result.output);
    if (!qa) warnings.push('qa: soffice/pdftoppm unavailable or failed (see stderr)');
  }

  return { output: result.output, slides: result.slides, warnings };
}
