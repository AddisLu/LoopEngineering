import type { Complexity } from '../config.js';

/** Mirrors gate/validateTask.ts's ALLOWED_TOOLS — a stage is just a task spec fragment. */
const ALLOWED_TOOLS = new Set(['claude-code', 'mock', 'generic', 'plan', 'deploy']);
const VALID_COMPLEXITY = new Set<Complexity>(['S', 'M', 'L']);

export interface PipelineStageSpec {
  name: string;
  coding_tool: string;
  verify_mode?: string;
  rubric_hint?: string;
  complexity?: Complexity;
  environment?: string;
}

export interface PipelineDef {
  name: string;
  description?: string;
  stages: PipelineStageSpec[];
}

/**
 * Strict validation of one stage — unlike parsePlan's per-item drop-and-continue (an AI
 * planner's output), a pipeline template is a FIXED decomposition a human authored: a
 * missing/invalid field is a template bug, not something to silently default around (see
 * the "plan task silent chain stall" lesson — defaulting a required field instead of
 * rejecting leaves the depends_on chain stalled with no visible cause). Returns an error
 * string, or null when the stage is well-formed.
 */
function validateStage(raw: unknown, index: number): string | null {
  if (!raw || typeof raw !== 'object') return `stage[${index}]: not an object`;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) return `stage[${index}]: name is required`;
  if (typeof o.coding_tool !== 'string' || !ALLOWED_TOOLS.has(o.coding_tool)) {
    return `stage[${index}] '${o.name}': coding_tool must be one of ${[...ALLOWED_TOOLS].join(', ')}`;
  }
  if (o.verify_mode !== undefined && typeof o.verify_mode !== 'string') {
    return `stage[${index}] '${o.name}': verify_mode must be a string`;
  }
  if (o.rubric_hint !== undefined && typeof o.rubric_hint !== 'string') {
    return `stage[${index}] '${o.name}': rubric_hint must be a string`;
  }
  if (o.complexity !== undefined && !VALID_COMPLEXITY.has(o.complexity as Complexity)) {
    return `stage[${index}] '${o.name}': complexity must be S|M|L`;
  }
  if (o.environment !== undefined && typeof o.environment !== 'string') {
    return `stage[${index}] '${o.name}': environment must be a string`;
  }
  return null;
}

function toStage(raw: Record<string, unknown>): PipelineStageSpec {
  const stage: PipelineStageSpec = {
    name: (raw.name as string).trim(),
    coding_tool: raw.coding_tool as string,
  };
  if (typeof raw.verify_mode === 'string' && raw.verify_mode.trim()) stage.verify_mode = raw.verify_mode.trim();
  if (typeof raw.rubric_hint === 'string' && raw.rubric_hint.trim()) stage.rubric_hint = raw.rubric_hint.trim();
  if (raw.complexity !== undefined) stage.complexity = raw.complexity as Complexity;
  if (typeof raw.environment === 'string' && raw.environment.trim()) stage.environment = raw.environment.trim();
  return stage;
}

/**
 * Parse + validate a pipeline template: bad shape, a missing name, an empty stages array,
 * or ANY invalid stage rejects the WHOLE template (returns null) — a fixed decomposition
 * has no safe partial-success mode, unlike the AI planner's per-item leniency. Never throws.
 */
export function parsePipelineDef(raw: unknown): PipelineDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) return null;
  if (!Array.isArray(o.stages) || o.stages.length === 0) return null;
  for (let i = 0; i < o.stages.length; i++) {
    if (validateStage(o.stages[i], i)) return null;
  }
  const def: PipelineDef = {
    name: o.name.trim(),
    stages: (o.stages as Record<string, unknown>[]).map(toStage),
  };
  if (typeof o.description === 'string' && o.description.trim()) def.description = o.description.trim();
  return def;
}

/** Same as parsePipelineDef, but returns the rejection reason instead of swallowing it. */
export function validatePipelineDef(raw: unknown): { ok: true; def: PipelineDef } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not an object' };
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) return { ok: false, error: 'name is required' };
  if (!Array.isArray(o.stages) || o.stages.length === 0) return { ok: false, error: 'stages must be a non-empty array' };
  for (let i = 0; i < o.stages.length; i++) {
    const err = validateStage(o.stages[i], i);
    if (err) return { ok: false, error: err };
  }
  const def = parsePipelineDef(raw);
  return def ? { ok: true, def } : { ok: false, error: 'invalid template' };
}
