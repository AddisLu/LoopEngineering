#!/usr/bin/env node
// PreToolUse hook — the in-flight INNER safeguard. Reads the shared usage cache
// and blocks further tool use when session% >= the hard limit, so a running task
// stops itself even if the engine-side circuit breaker hasn't ticked yet.
//
// Config via env (set by the engine when it spawns claude):
//   LOOP_USAGE_CACHE     absolute path to usage-cache.json (written by TokenClient)
//   LOOP_HARD_LIMIT_PCT  session% at/above which to block (default 95)
//
// Contract (claude 2.1.201): exit 2 + stderr = block and show reason to the model.
// NOTE: confirm hook JSON/exit contract against code.claude.com/docs on the host.
import fs from 'node:fs';

const cachePath = process.env.LOOP_USAGE_CACHE;
const limit = Number(process.env.LOOP_HARD_LIMIT_PCT ?? '95');

function sessionPct() {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return Number(j?.reading?.session?.percent ?? 0);
  } catch {
    return 0; // fail-open: never block on a read error
  }
}

const pct = sessionPct();
if (Number.isFinite(pct) && pct >= limit) {
  process.stderr.write(
    `Loop budget guard: session usage ${pct}% >= ${limit}% — stop now. ` +
      `Commit any finished work and end the session; the scheduler will resume later.\n`,
  );
  process.exit(2);
}
process.exit(0);
