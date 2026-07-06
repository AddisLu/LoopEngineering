import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { setCachedUsage } from '../token/usage.js';
import { transcribe, type TranscribeExec } from '../voice/transcribe.js';
import { structureTranscript, parseStructured, type StructureExec } from '../voice/structure.js';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
});
afterEach(async () => {
  await app?.close();
  db.close();
});

// ---- 1. parseStructured ----

describe('parseStructured', () => {
  it('parses valid strict JSON into task fields', () => {
    const out = parseStructured(
      JSON.stringify({
        title: 'Fix login bug',
        goal: 'the login button 沒反應 on mobile',
        verify_steps: ['npm test'],
        repo_path: '/repo',
        environment: 'home',
        coding_tool: 'claude-code',
        complexity: 'S',
      }),
    );
    expect(out).toEqual({
      title: 'Fix login bug',
      goal: 'the login button 沒反應 on mobile',
      verify_steps: ['npm test'],
      repo_path: '/repo',
      environment: 'home',
      coding_tool: 'claude-code',
      complexity: 'S',
      task_type: 'unknown',
      missing: [],
      clarify: [],
    });
  });

  it('defaults missing fields (coding_tool=claude-code, complexity=M, verify_steps=[], task_type=unknown)', () => {
    const out = parseStructured(JSON.stringify({ title: 't', goal: 'g' }));
    expect(out).toEqual({
      title: 't',
      goal: 'g',
      verify_steps: [],
      repo_path: '',
      environment: '',
      coding_tool: 'claude-code',
      complexity: 'M',
      task_type: 'unknown',
      missing: [],
      clarify: [],
    });
  });

  it('parses task_type/missing/clarify when present', () => {
    const out = parseStructured(
      JSON.stringify({
        title: 't',
        goal: 'g',
        task_type: 'coding',
        missing: ['repo_path', ''],
        clarify: [
          { field: 'repo_path', question: '這個 repo 在哪？' },
          { field: 'complexity', question: '大概多大？', options: ['S', 'M', 'L'] },
          { field: '', question: 'dropped: no field' },
          'not an object',
        ],
      }),
    );
    expect(out?.task_type).toBe('coding');
    expect(out?.missing).toEqual(['repo_path']);
    expect(out?.clarify).toEqual([
      { field: 'repo_path', question: '這個 repo 在哪？' },
      { field: 'complexity', question: '大概多大？', options: ['S', 'M', 'L'] },
    ]);
  });

  it('falls back to task_type=unknown for an invalid value', () => {
    const out = parseStructured(JSON.stringify({ title: 't', goal: 'g', task_type: 'bogus' }));
    expect(out?.task_type).toBe('unknown');
  });

  it('returns null for malformed JSON', () => {
    expect(parseStructured('not json {{{')).toBeNull();
  });

  it('returns null when title or goal is missing', () => {
    expect(parseStructured(JSON.stringify({ title: '', goal: 'g' }))).toBeNull();
    expect(parseStructured(JSON.stringify({ title: 't', goal: '' }))).toBeNull();
  });

  it('strips a ```json fenced block before parsing', () => {
    const out = parseStructured('```json\n' + JSON.stringify({ title: 't', goal: 'g' }) + '\n```');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('t');
  });
});

// ---- 2. structureTranscript: guards + exec injection ----

describe('structureTranscript', () => {
  it('cleans a messy mixed zh/en transcript via the injected exec', async () => {
    const exec: StructureExec = async () =>
      JSON.stringify({
        title: '修 login 按鈕',
        goal: '手機上 login 按鈕點了沒反應，欸就是，要修一下',
        verify_steps: [],
        repo_path: '',
        environment: '',
        coding_tool: 'claude-code',
        complexity: 'M',
      });
    const out = await structureTranscript(db, '欸那個 login 按鈕...手機上點了沒反應 need to fix that', exec);
    expect(out?.title).toBe('修 login 按鈕');
    expect(out?.coding_tool).toBe('claude-code');
  });

  it('returns null when the model output fails to parse', async () => {
    const exec: StructureExec = async () => 'garbage, not json';
    expect(await structureTranscript(db, 'transcript', exec)).toBeNull();
  });

  it('returns null (never calls exec) when session usage is already at/over hard_limit_pct', async () => {
    setCachedUsage(96, 10); // hard_limit_pct default is 95
    let calls = 0;
    const exec: StructureExec = async () => {
      calls++;
      return JSON.stringify({ title: 't', goal: 'g' });
    };
    const out = await structureTranscript(db, 'transcript', exec);
    expect(out).toBeNull();
    expect(calls).toBe(0);
  });
});

// ---- 3. transcribe: exec injection ----

describe('transcribe', () => {
  it('returns the injected exec stdout, trimmed', async () => {
    const exec: TranscribeExec = async () => '  hello from fake whisper  \n';
    const out = await transcribe(db, '/tmp/fake-audio.webm', exec);
    expect(out).toBe('hello from fake whisper');
  });

  it('passes the audio path and voice settings through to exec', async () => {
    setSetting(db, 'voice_model', 'small');
    let seenArgs: string[] = [];
    const exec: TranscribeExec = async (_bin, args) => {
      seenArgs = args;
      return 'ok';
    };
    await transcribe(db, '/tmp/rec.webm', exec);
    expect(seenArgs).toContain('/tmp/rec.webm');
    expect(seenArgs).toContain('small');
  });
});

// ---- 4. POST /api/voice/intake ----

function buildMultipart(fieldName: string, filename: string, contentType: string, data: Buffer): { body: Buffer; boundary: string } {
  const boundary = '----loopTestBoundary';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return { body: Buffer.concat([Buffer.from(head), data, Buffer.from(tail)]), boundary };
}

describe('POST /api/voice/intake', () => {
  it('404s with voice_intake_enabled=false (default) — zero behavior change', async () => {
    app = buildApp({ db, apiToken: null });
    const { body, boundary } = buildMultipart('audio', 'rec.webm', 'audio/webm', Buffer.from('fake audio bytes'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/intake',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/disabled/);
  });

  it('enabled: transcribes + structures an uploaded recording via injected execs', async () => {
    setSetting(db, 'voice_intake_enabled', 'true');
    app = buildApp({
      db,
      apiToken: null,
      voiceTranscribeExec: async () => 'fake transcript from injected exec',
      voiceStructureExec: async () => JSON.stringify({ title: 'Voice task', goal: 'do the voice thing' }),
    });
    const { body, boundary } = buildMultipart('audio', 'rec.webm', 'audio/webm', Buffer.from('fake audio bytes'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/intake',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.transcript).toBe('fake transcript from injected exec');
    expect(j.fields).toEqual({
      title: 'Voice task',
      goal: 'do the voice thing',
      verify_steps: [],
      repo_path: '',
      environment: '',
      coding_tool: 'claude-code',
      complexity: 'M',
      task_type: 'unknown',
      missing: [],
      clarify: [],
    });
  });

  it('enabled: fields is null when the structuring pass fails, transcript still returned', async () => {
    setSetting(db, 'voice_intake_enabled', 'true');
    app = buildApp({
      db,
      apiToken: null,
      voiceTranscribeExec: async () => 'a transcript',
      voiceStructureExec: async () => null,
    });
    const { body, boundary } = buildMultipart('audio', 'rec.webm', 'audio/webm', Buffer.from('fake audio bytes'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/intake',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.transcript).toBe('a transcript');
    expect(j.fields).toBeNull();
  });

  it('enabled: 400s when the multipart body has no file part', async () => {
    setSetting(db, 'voice_intake_enabled', 'true');
    app = buildApp({ db, apiToken: null });
    const boundary = '----loopTestBoundaryEmpty';
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/intake',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}--\r\n`),
    });
    expect(res.statusCode).toBe(400);
  });

  it('enabled: 500s and never creates a task when transcribe throws', async () => {
    setSetting(db, 'voice_intake_enabled', 'true');
    app = buildApp({
      db,
      apiToken: null,
      voiceTranscribeExec: async () => { throw new Error('boom'); },
    });
    const { body, boundary } = buildMultipart('audio', 'rec.webm', 'audio/webm', Buffer.from('fake audio bytes'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/intake',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(500);
    const board = await app.inject({ method: 'GET', url: '/api/board' });
    expect(board.json().counts.draft ?? 0).toBe(0);
  });
});
