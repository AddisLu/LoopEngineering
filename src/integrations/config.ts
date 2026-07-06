import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { createGithubProvider } from './github.js';
import { createAdoProvider } from './ado.js';
import type { WorkProvider } from './types.js';

/**
 * Resolves the active provider from the `integration_provider` setting (none|github|ado,
 * default none — see config.ts DEFAULT_SETTINGS) + credentials read from process.env
 * (populated by the systemd EnvironmentFile ~/.config/loop-engineering/env — never the
 * DB, never logged). Returns null when the feature is off OR credentials are missing,
 * so every call site degrades to "no external calls" without special-casing.
 */
export function resolveProvider(db: Database.Database, fetchImpl?: typeof fetch): WorkProvider | null {
  const kind = (getSetting(db, 'integration_provider') ?? 'none').trim();
  if (kind === 'github') {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return null;
    return createGithubProvider({ token, apiUrl: process.env.GITHUB_API_URL, fetchImpl });
  }
  if (kind === 'ado') {
    const pat = process.env.ADO_PAT;
    const org = process.env.ADO_ORG;
    const project = process.env.ADO_PROJECT;
    if (!pat || !org || !project) return null;
    return createAdoProvider({ pat, org, project, fetchImpl });
  }
  return null;
}
