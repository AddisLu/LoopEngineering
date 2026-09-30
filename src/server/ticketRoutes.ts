import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

/** 問題單 (src/intake/*): POST /api/tickets, GET/PATCH /api/tickets/:id, /analyse, /start, /approve-start, /reject-start, /cancel, POST /api/tickets/resolve-link. */
export interface TicketRouteOptions {
  // test injection seams are added with the routes
  _reserved?: never;
}

// Registered from app.ts before the static handler (auth hook covers /api/*). Filled in by its own link.
export function registerTicketRoutes(_app: FastifyInstance, _db: Database.Database, _opts: TicketRouteOptions = {}): void {}
