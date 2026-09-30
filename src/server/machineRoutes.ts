import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

/** 機台 registry + health check (src/exec/{machines,remote}.ts): /api/machines*, POST /api/machines/:name/check. */
export interface MachineRouteOptions {
  // test injection seams are added with the routes
  _reserved?: never;
}

// Registered from app.ts before the static handler (auth hook covers /api/*). Filled in by its own link.
export function registerMachineRoutes(_app: FastifyInstance, _db: Database.Database, _opts: MachineRouteOptions = {}): void {}
