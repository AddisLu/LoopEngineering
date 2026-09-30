import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

/** 檢查 (src/checks/*): /api/repos/:id/checks*, POST /api/checks/:id/trial, POST /api/checks/:id/baseline, GET /api/checks/:id/runs. */
export interface CheckRouteOptions {
  // test injection seams are added with the routes
  _reserved?: never;
}

// Registered from app.ts before the static handler (auth hook covers /api/*). Filled in by its own link.
export function registerCheckRoutes(_app: FastifyInstance, _db: Database.Database, _opts: CheckRouteOptions = {}): void {}
