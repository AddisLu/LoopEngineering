import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

/** Repo registry + import (src/repo/*): GET/POST /api/repos, GET/PATCH/DELETE /api/repos/:id, POST /api/repos/import. */
export interface RepoRouteOptions {
  // test injection seams are added with the routes
  _reserved?: never;
}

// Registered from app.ts before the static handler (auth hook covers /api/*). Filled in by its own link.
export function registerRepoRoutes(_app: FastifyInstance, _db: Database.Database, _opts: RepoRouteOptions = {}): void {}
