/**
 * PPTX weekly-report contract layer: types + fault-tolerant validators for the deck
 * spec that scripts/report_pptx.py fills into the company template, plus the
 * template-authoring manifest and the (forward-looking, T2-consumed) roadmap/registry
 * config shapes. Field names here are canonical -- scripts/report_pptx.py,
 * scripts/report_pptx_fixture.py's MANIFEST, and every downstream PPTX task (T2-T4)
 * key off these exact names.
 *
 * Validator style mirrors src/orchestrator/planner.ts's parsePlan: clamp/drop bad
 * items, default missing fields, never throw -- only a wholesale-garbage input (no
 * usable content at all) returns `{ok:false}`.
 */

export interface StatusItem {
  text: string;
  color: 'black' | 'blue' | 'red';
  sources?: SourceRef[];
}

export type SourceRef = { wp: number } | { commit: string } | { node: string };

export interface ExplainPage {
  title: string;
  note: string;
  images: { path: string; caption?: string }[];
  sources?: SourceRef[];
}

export interface Checkpoint {
  label: string;
  date: string;
  at?: string;
  wp?: number | null;
}

export interface DeckProject {
  key: string;
  pillar: string;
  fab: string;
  name: string;
  benefit?: string;
  roadmap: { checkpoints: Checkpoint[]; current_index: number };
  status_items: StatusItem[]; // <=2, single line
  explain_pages: ExplainPage[]; // <=2
  quality_flags?: string[]; // quality-gate markers (T3 populates; T1 only reserves the field)
}

export interface SummaryRow {
  pillar: string;
  project: string;
  fab_line: string;
  status_items: StatusItem[];
}

export interface DeckSpec {
  version: 1;
  week: string;
  generated_at?: string;
  summary: { rows: SummaryRow[] };
  projects: DeckProject[];
}

export interface ManifestPoolEntry {
  slide: number;
  kind: 'summary' | 'main' | 'explain';
  slot?: number;
  sub?: number;
}

export interface ManifestSummary {
  table_shape: string;
  columns: { pillar: number; project: number; fab_line: number; status: number };
  header_rows: number;
  rows_per_pillar: Record<string, number>;
  font_size_pt: number;
  max_item_chars: number;
}

export interface ManifestMain {
  shapes: { title: string; benefit: string; status: string; marker: string };
  checkpoints: number;
  checkpoint_shapes: { label: string; date: string; at: string };
}

export interface ManifestExplain {
  shapes: { title: string; note: string; image_box: string };
}

export interface ManifestColors {
  carried: string;
  new: string;
  highlight: string;
}

export interface Manifest {
  version: 1;
  template_file: string;
  template_sha256: string;
  shape_prefix: string;
  capacity: { projects: number; explain_per_project: number };
  pool: ManifestPoolEntry[];
  summary: ManifestSummary;
  main: ManifestMain;
  explain: ManifestExplain;
  colors: ManifestColors;
}

export interface RoadmapConfig {
  benefit?: string;
  checkpoints: Checkpoint[];
}

export interface RegistryProject {
  key: string;
  pillar: string;
  name: string;
  fab: string;
  fab_line: string;
  op_project?: string;
  op_project_id?: number | null;
  gitea_dir?: string;
  enabled: boolean;
}

export interface ProjectRegistry {
  version: 1;
  pillars: string[];
  projects: RegistryProject[];
}

const VALID_COLORS = new Set(['black', 'blue', 'red']);
const MAX_STATUS_ITEMS = 2;
const MAX_EXPLAIN_PAGES = 2;

/** Line breaks and repeated whitespace collapse to a single space -- status/title/note
 * text is meant to render on one line inside a fixed-size template shape. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function parseSourceRef(raw: unknown): SourceRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.wp === 'number' && Number.isFinite(o.wp)) return { wp: o.wp };
  if (typeof o.commit === 'string' && o.commit.trim()) return { commit: o.commit.trim() };
  if (typeof o.node === 'string' && o.node.trim()) return { node: o.node.trim() };
  return null;
}

function parseSourceRefs(raw: unknown): SourceRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs = raw.map(parseSourceRef).filter((r): r is SourceRef => r !== null);
  return refs.length ? refs : undefined;
}

function parseStatusItem(raw: unknown): StatusItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === 'string' ? collapseWhitespace(o.text) : '';
  if (!text) return null;
  const color = typeof o.color === 'string' && VALID_COLORS.has(o.color) ? (o.color as StatusItem['color']) : 'blue';
  const sources = parseSourceRefs(o.sources);
  return { text, color, ...(sources ? { sources } : {}) };
}

/** Drops invalid items, then clamps to MAX_STATUS_ITEMS (the template only reserves
 * room for that many status lines). */
function parseStatusItems(raw: unknown): StatusItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseStatusItem)
    .filter((i): i is StatusItem => i !== null)
    .slice(0, MAX_STATUS_ITEMS);
}

function parseImage(raw: unknown): { path: string; caption?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const p = typeof o.path === 'string' ? o.path.trim() : '';
  if (!p) return null;
  const caption = typeof o.caption === 'string' && o.caption.trim() ? collapseWhitespace(o.caption) : undefined;
  return { path: p, ...(caption ? { caption } : {}) };
}

function parseExplainPage(raw: unknown): ExplainPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? collapseWhitespace(o.title) : '';
  const note = typeof o.note === 'string' ? collapseWhitespace(o.note) : '';
  if (!title && !note) return null;
  const images = Array.isArray(o.images)
    ? o.images.map(parseImage).filter((i): i is { path: string; caption?: string } => i !== null)
    : [];
  const sources = parseSourceRefs(o.sources);
  return { title, note, images, ...(sources ? { sources } : {}) };
}

function parseExplainPages(raw: unknown): ExplainPage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseExplainPage)
    .filter((p): p is ExplainPage => p !== null)
    .slice(0, MAX_EXPLAIN_PAGES);
}

function parseCheckpoint(raw: unknown): Checkpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === 'string' ? collapseWhitespace(o.label) : '';
  const date = typeof o.date === 'string' ? o.date.trim() : '';
  if (!label || !date) return null;
  const at = typeof o.at === 'string' && o.at.trim() ? o.at.trim() : undefined;
  const wp = typeof o.wp === 'number' && Number.isFinite(o.wp) ? o.wp : o.wp === null ? null : undefined;
  return { label, date, ...(at ? { at } : {}), ...(wp !== undefined ? { wp } : {}) };
}

function parseCheckpoints(raw: unknown): Checkpoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseCheckpoint).filter((c): c is Checkpoint => c !== null);
}

/** current_index is clamped into [0, checkpoints.length-1] (0 when there are none) --
 * a stale/out-of-range index from a previous, longer roadmap must never crash the
 * renderer's move_marker step. */
function parseRoadmapField(raw: unknown): { checkpoints: Checkpoint[]; current_index: number } {
  const o = asRecord(raw);
  const checkpoints = parseCheckpoints(o.checkpoints);
  const rawIdx = typeof o.current_index === 'number' && Number.isFinite(o.current_index) ? Math.round(o.current_index) : 0;
  const current_index = checkpoints.length ? Math.min(Math.max(0, rawIdx), checkpoints.length - 1) : 0;
  return { checkpoints, current_index };
}

function parseDeckProject(raw: unknown): DeckProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const key = typeof o.key === 'string' ? o.key.trim() : '';
  const name = typeof o.name === 'string' ? collapseWhitespace(o.name) : '';
  if (!key || !name) return null;
  const pillar = typeof o.pillar === 'string' ? o.pillar.trim() : '';
  const fab = typeof o.fab === 'string' ? o.fab.trim() : '';
  const benefit = typeof o.benefit === 'string' && o.benefit.trim() ? collapseWhitespace(o.benefit) : undefined;
  const quality_flags = Array.isArray(o.quality_flags)
    ? o.quality_flags.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    : [];

  return {
    key,
    pillar,
    fab,
    name,
    ...(benefit ? { benefit } : {}),
    roadmap: parseRoadmapField(o.roadmap),
    status_items: parseStatusItems(o.status_items),
    explain_pages: parseExplainPages(o.explain_pages),
    ...(quality_flags.length ? { quality_flags } : {}),
  };
}

function parseSummaryRow(raw: unknown): SummaryRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const pillar = typeof o.pillar === 'string' ? o.pillar.trim() : '';
  const project = typeof o.project === 'string' ? collapseWhitespace(o.project) : '';
  if (!pillar || !project) return null;
  const fab_line = typeof o.fab_line === 'string' ? o.fab_line.trim() : '';
  return { pillar, project, fab_line, status_items: parseStatusItems(o.status_items) };
}

/**
 * Fault-tolerant DeckSpec validator: clamp/drop bad items, default missing fields,
 * never throw. Returns `{ok:false}` only when there is nothing usable at all (no
 * `week`, or zero valid projects AND zero valid summary rows after dropping garbage).
 */
export function validateDeckSpec(o: unknown): { ok: true; spec: DeckSpec } | { ok: false; error: string } {
  if (!o || typeof o !== 'object') return { ok: false, error: 'not an object' };
  const raw = o as Record<string, unknown>;

  const week = typeof raw.week === 'string' ? raw.week.trim() : '';
  if (!week) return { ok: false, error: 'week is required' };

  const projects = Array.isArray(raw.projects)
    ? raw.projects.map(parseDeckProject).filter((p): p is DeckProject => p !== null)
    : [];
  const summaryRaw = asRecord(raw.summary);
  const rows = Array.isArray(summaryRaw.rows)
    ? summaryRaw.rows.map(parseSummaryRow).filter((r): r is SummaryRow => r !== null)
    : [];

  if (!projects.length && !rows.length) return { ok: false, error: 'no valid projects or summary rows' };

  const generated_at = typeof raw.generated_at === 'string' && raw.generated_at.trim() ? raw.generated_at.trim() : undefined;

  return {
    ok: true,
    spec: {
      version: 1,
      week,
      ...(generated_at ? { generated_at } : {}),
      summary: { rows },
      projects,
    },
  };
}

function parseManifestPoolEntry(raw: unknown): ManifestPoolEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const slide = typeof o.slide === 'number' && Number.isFinite(o.slide) ? o.slide : null;
  const kind = o.kind === 'summary' || o.kind === 'main' || o.kind === 'explain' ? o.kind : null;
  if (slide === null || !kind) return null;
  const slot = typeof o.slot === 'number' && Number.isFinite(o.slot) ? o.slot : undefined;
  const sub = typeof o.sub === 'number' && Number.isFinite(o.sub) ? o.sub : undefined;
  return { slide, kind, ...(slot !== undefined ? { slot } : {}), ...(sub !== undefined ? { sub } : {}) };
}

function parseNumberRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(raw))) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Fault-tolerant Manifest validator (template-authoring artifact, not user input, but
 * still never throws -- a hand-edited manifest.json is exactly the kind of file that
 * gets a stray typo). `{ok:false}` only when there are zero valid pool entries, since
 * a manifest with no pool cannot address a single slide.
 */
export function parseManifest(o: unknown): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  if (!o || typeof o !== 'object') return { ok: false, error: 'not an object' };
  const raw = o as Record<string, unknown>;

  const pool = Array.isArray(raw.pool)
    ? raw.pool.map(parseManifestPoolEntry).filter((p): p is ManifestPoolEntry => p !== null)
    : [];
  if (!pool.length) return { ok: false, error: 'manifest has no valid pool entries' };

  const shape_prefix = typeof raw.shape_prefix === 'string' && raw.shape_prefix.trim() ? raw.shape_prefix : 'LOOP:';
  const template_file = typeof raw.template_file === 'string' ? raw.template_file : '';
  const template_sha256 = typeof raw.template_sha256 === 'string' ? raw.template_sha256 : '';

  const capacityRaw = asRecord(raw.capacity);
  const capacity = {
    projects: typeof capacityRaw.projects === 'number' ? capacityRaw.projects : 0,
    explain_per_project: typeof capacityRaw.explain_per_project === 'number' ? capacityRaw.explain_per_project : 0,
  };

  const summaryRaw = asRecord(raw.summary);
  const columnsRaw = asRecord(summaryRaw.columns);
  const summary: ManifestSummary = {
    table_shape: typeof summaryRaw.table_shape === 'string' ? summaryRaw.table_shape : '',
    columns: {
      pillar: typeof columnsRaw.pillar === 'number' ? columnsRaw.pillar : 0,
      project: typeof columnsRaw.project === 'number' ? columnsRaw.project : 1,
      fab_line: typeof columnsRaw.fab_line === 'number' ? columnsRaw.fab_line : 2,
      status: typeof columnsRaw.status === 'number' ? columnsRaw.status : 3,
    },
    header_rows: typeof summaryRaw.header_rows === 'number' ? summaryRaw.header_rows : 1,
    rows_per_pillar: parseNumberRecord(summaryRaw.rows_per_pillar),
    font_size_pt: typeof summaryRaw.font_size_pt === 'number' ? summaryRaw.font_size_pt : 10,
    max_item_chars: typeof summaryRaw.max_item_chars === 'number' ? summaryRaw.max_item_chars : 200,
  };

  const mainRaw = asRecord(raw.main);
  const mainShapesRaw = asRecord(mainRaw.shapes);
  const cpShapesRaw = asRecord(mainRaw.checkpoint_shapes);
  const main: ManifestMain = {
    shapes: {
      title: typeof mainShapesRaw.title === 'string' ? mainShapesRaw.title : '',
      benefit: typeof mainShapesRaw.benefit === 'string' ? mainShapesRaw.benefit : '',
      status: typeof mainShapesRaw.status === 'string' ? mainShapesRaw.status : '',
      marker: typeof mainShapesRaw.marker === 'string' ? mainShapesRaw.marker : '',
    },
    checkpoints: typeof mainRaw.checkpoints === 'number' ? mainRaw.checkpoints : 0,
    checkpoint_shapes: {
      label: typeof cpShapesRaw.label === 'string' ? cpShapesRaw.label : '',
      date: typeof cpShapesRaw.date === 'string' ? cpShapesRaw.date : '',
      at: typeof cpShapesRaw.at === 'string' ? cpShapesRaw.at : '',
    },
  };

  const explainRaw = asRecord(raw.explain);
  const explainShapesRaw = asRecord(explainRaw.shapes);
  const explain: ManifestExplain = {
    shapes: {
      title: typeof explainShapesRaw.title === 'string' ? explainShapesRaw.title : '',
      note: typeof explainShapesRaw.note === 'string' ? explainShapesRaw.note : '',
      image_box: typeof explainShapesRaw.image_box === 'string' ? explainShapesRaw.image_box : '',
    },
  };

  const colorsRaw = asRecord(raw.colors);
  const colors: ManifestColors = {
    carried: typeof colorsRaw.carried === 'string' ? colorsRaw.carried : '000000',
    new: typeof colorsRaw.new === 'string' ? colorsRaw.new : '0000FF',
    highlight: typeof colorsRaw.highlight === 'string' ? colorsRaw.highlight : 'FF0000',
  };

  return {
    ok: true,
    manifest: { version: 1, template_file, template_sha256, shape_prefix, capacity, pool, summary, main, explain, colors },
  };
}

/** Fault-tolerant RoadmapConfig validator (per-project default checkpoints, T2 input).
 * `{ok:false}` only when there are zero valid checkpoints. */
export function parseRoadmap(o: unknown): { ok: true; roadmap: RoadmapConfig } | { ok: false; error: string } {
  if (!o || typeof o !== 'object') return { ok: false, error: 'not an object' };
  const raw = o as Record<string, unknown>;
  const checkpoints = parseCheckpoints(raw.checkpoints);
  if (!checkpoints.length) return { ok: false, error: 'no valid checkpoints' };
  const benefit = typeof raw.benefit === 'string' && raw.benefit.trim() ? collapseWhitespace(raw.benefit) : undefined;
  return { ok: true, roadmap: { ...(benefit ? { benefit } : {}), checkpoints } };
}

function parseRegistryProject(raw: unknown): RegistryProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const key = typeof o.key === 'string' ? o.key.trim() : '';
  const name = typeof o.name === 'string' ? collapseWhitespace(o.name) : '';
  if (!key || !name) return null;
  const pillar = typeof o.pillar === 'string' ? o.pillar.trim() : '';
  const fab = typeof o.fab === 'string' ? o.fab.trim() : '';
  const fab_line = typeof o.fab_line === 'string' ? o.fab_line.trim() : '';
  const op_project = typeof o.op_project === 'string' && o.op_project.trim() ? o.op_project.trim() : undefined;
  const op_project_id =
    typeof o.op_project_id === 'number' && Number.isFinite(o.op_project_id)
      ? o.op_project_id
      : o.op_project_id === null
        ? null
        : undefined;
  const gitea_dir = typeof o.gitea_dir === 'string' && o.gitea_dir.trim() ? o.gitea_dir.trim() : undefined;
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : true;
  return {
    key,
    pillar,
    name,
    fab,
    fab_line,
    ...(op_project ? { op_project } : {}),
    ...(op_project_id !== undefined ? { op_project_id } : {}),
    ...(gitea_dir ? { gitea_dir } : {}),
    enabled,
  };
}

/** Fault-tolerant ProjectRegistry validator. `{ok:false}` only when there are zero
 * valid projects after dropping garbage entries. */
export function parseRegistry(o: unknown): { ok: true; registry: ProjectRegistry } | { ok: false; error: string } {
  if (!o || typeof o !== 'object') return { ok: false, error: 'not an object' };
  const raw = o as Record<string, unknown>;
  const pillars = Array.isArray(raw.pillars)
    ? raw.pillars.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : [];
  const projects = Array.isArray(raw.projects)
    ? raw.projects.map(parseRegistryProject).filter((p): p is RegistryProject => p !== null)
    : [];
  if (!projects.length) return { ok: false, error: 'no valid projects' };
  return { ok: true, registry: { version: 1, pillars, projects } };
}
