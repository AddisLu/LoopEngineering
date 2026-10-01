// 機況 (production machine condition) — what an engineer pastes or uploads from a CF-AOI
// machine, parsed into structured events. Pure data types; the parser is ./parse.ts.

export interface DiagInput { name: string; text: string }

export interface SrcRef { file: string; line: number | null; func: string | null }

export type DiagEventType = 'session' | 'recipe' | 'incident' | 'incident_suppressed' | 'log' | 'other';

export interface DiagEvent {
  type: DiagEventType;
  ts: string | null;          // as written
  kind: string | null;        // incident kind, or log level (ERROR/WARN/…)
  detail: string | null;      // ≤ 1000 chars
  src: SrcRef[];              // code locations named by the event (incident src, stack frames, file:line in a log line)
  codes: string[];            // error/alarm codes found
  input: string;              // DiagInput.name
  line: number | null;        // line number in that input
  raw: string;                // ≤ 2000 chars
  data: Record<string, unknown> | null; // the parsed JSON object for jsonl/json events (session/recipe/incident)
}

export interface IniFile { name: string; sections: Record<string, Record<string, string>>; }

export interface DiagSession {
  ts: string | null;
  ip_name: string | null;
  mode: string | null;
  ini: string | null;
  recipe: string | null;
  gpu: { name: string | null; sm: number | null; free_mb: number | null; total_mb: number | null } | null;
  ai_active: boolean | null;
}

export interface ParsedDiag {
  events: DiagEvent[];             // in input order, capped at 2000
  sessions: DiagSession[];
  incidents: DiagEvent[];          // incident + incident_suppressed, de-duplicated (same kind+src+detail within one input counted once; totals in summary)
  ini: IniFile[];
  errors: DiagEvent[];             // log events of level ERROR/FATAL/Exception + incidents
  summary: {
    inputs: number;
    first_ts: string | null; last_ts: string | null;
    incidents_by_kind: Record<string, number>;   // includes suppressed counts
    codes: Record<string, number>;
    src_files: Record<string, number>;           // file → mentions
    levels: Record<string, number>;
  };
  /** stable keys to match past cases: e.g. 'incident:bad_json@ip/src/control_server.cpp', 'code:ERR_GRAB_TIMEOUT', 'src:ip/src/control_server.cpp:407' — sorted, deduped, ≤ 30 */
  signature: string[];
  warnings: string[];
}

export interface IniChange { section: string; key: string; current: string | null; baseline: string | null }
