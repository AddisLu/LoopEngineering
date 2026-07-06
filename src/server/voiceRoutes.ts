import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getBool } from '../db/index.js';
import { paths } from '../config.js';
import { transcribe, type TranscribeExec } from '../voice/transcribe.js';
import { structureTranscript, type StructureExec } from '../voice/structure.js';

export interface VoiceRouteOptions {
  transcribeExec?: TranscribeExec;
  structureExec?: StructureExec;
}

/**
 * Mobile voice -> task intake: upload one audio recording, get back the raw transcript
 * plus (best-effort) structured task fields for the client to PREFILL its new-task form.
 * Never creates a task itself. 404s when voice_intake_enabled is off (default) — zero
 * behavior change for anyone who hasn't opted in.
 */
export function registerVoiceRoutes(app: FastifyInstance, db: Database.Database, opts: VoiceRouteOptions = {}): void {
  app.post('/api/voice/intake', async (req, reply) => {
    if (!getBool(db, 'voice_intake_enabled')) {
      return reply.code(404).send({ error: 'voice intake disabled' });
    }
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no audio file uploaded' });

    const ext = path.extname(data.filename || '') || '.webm';
    const audioPath = path.join(paths.voiceDir, `${nanoid(12)}${ext}`);
    fs.writeFileSync(audioPath, await data.toBuffer());
    try {
      const t = await transcribe(db, audioPath, opts.transcribeExec);
      const fields = await structureTranscript(db, t, opts.structureExec);
      return { transcript: t, fields };
    } catch (err) {
      return reply.code(500).send({ error: `voice intake failed: ${String(err).slice(-300)}` });
    } finally {
      fs.rm(audioPath, { force: true }, () => {});
    }
  });
}
