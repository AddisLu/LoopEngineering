/**
 * Weekly two-stage flow: `prepareWeekly` fetches WP snapshots + drafts a deck-spec (all
 * carried-over black, per assemble.ts's fallback rule) and an explain-pages gate file for
 * a human to edit; `renderWeekly` re-validates + re-colors deterministically (so manual
 * text edits still diff correctly), applies the human's approve/reject gate on explain
 * pages, drops any page whose image is missing, renders, and writes the *actual shipped*
 * deck-spec back to disk — that's what next week's diff reads. LLM status generation is
 * T3's job; `statusCandidates` here is always an empty Map, an explicit seam for it.
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool, getSetting } from '../../db/index.js';
import { DEFAULT_SETTINGS } from '../../config.js';
import { fetchProjectWorkPackages, type OpDataExec, type OpWorkPackage } from '../opdata.js';
import { renderDeck, qaRender, type PptxRenderExec } from './render.js';
import { validateDeckSpec, parseRegistry, parseRoadmap, type DeckSpec, type ExplainPage, type RoadmapConfig } from './spec.js';
import { classifyStatusItems, type StatusCandidate } from './diff.js';
import { assembleDeckSpec, findPrevWeekSpec, weekId, defaultAssembleFs, type AssembleFs } from './assemble.js';

export interface WeeklyDeps {
  dataExec?: OpDataExec;
  renderExec?: PptxRenderExec;
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
  opts: { week?: string; currentOverrides?: Record<string, number> },
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

  const deckSpec = assembleDeckSpec({
    week,
    registry,
    roadmaps,
    prevSpec,
    statusCandidates: new Map<string, StatusCandidate[]>(), // LLM candidate seam — T3 wires this
    explain: new Map<string, ExplainPage[]>(), // explain pages are gated through explain-pages.json at render time
    wps,
    currentOverrides,
    now,
  });

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
