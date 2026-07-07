import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { setCachedUsage } from '../token/usage.js';
import { transcribe, type TranscribeExec } from '../voice/transcribe.js';
import { structureTranscript, parseStructured, type StructureExec } from '../voice/structure.js';
import { seedGlossaryTerms, glossaryTermsForPrompt } from '../voice/glossary.js';
import { listNodes, upsertNode, invalidateNode } from '../knowledge/store.js';
import { WarmWorker, type ChildLike, type SpawnFn } from '../voice/daemon.js';

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

// ---- 5. glossary: knowledge-base-backed term list ----

describe('seedGlossaryTerms', () => {
  it('imports each line/comma-separated term as an approved glossary knowledge node', () => {
    const readFile = () => 'TGV, CPO\n光學檢測\n';
    const result = seedGlossaryTerms(db, '/fake/terms.txt', readFile);
    expect(result).toEqual({ created: 3, skipped: 0 });
    const nodes = listNodes(db, { kind: 'tech' });
    expect(nodes.map((n) => n.title).sort()).toEqual(['CPO', 'TGV', '光學檢測'].sort());
    for (const n of nodes) {
      expect(JSON.parse(n.tags)).toContain('glossary');
      expect(n.scope).toBe('global');
      expect(n.status).toBe('approved');
      expect(n.source).toBe('seed');
    }
  });

  it('is idempotent: seeding twice does not duplicate nodes', () => {
    const readFile = () => 'TGV, CPO\n';
    seedGlossaryTerms(db, '/fake/terms.txt', readFile);
    const second = seedGlossaryTerms(db, '/fake/terms.txt', readFile);
    expect(second).toEqual({ created: 0, skipped: 2 });
    expect(listNodes(db, { kind: 'tech' })).toHaveLength(2);
  });

  it('gracefully returns zero when the terms file is missing/unreadable', () => {
    const readFile = () => { throw new Error('ENOENT'); };
    expect(seedGlossaryTerms(db, '/nope.txt', readFile)).toEqual({ created: 0, skipped: 0 });
  });

  it('returns zero for an empty terms path', () => {
    expect(seedGlossaryTerms(db, '', () => 'unused')).toEqual({ created: 0, skipped: 0 });
  });
});

describe('glossaryTermsForPrompt', () => {
  it('uses the knowledge base only when it has glossary nodes, ignoring terms.txt content entirely', () => {
    upsertNode(db, { title: 'CPO', kind: 'tech', tags: ['glossary'], scope: 'global', status: 'approved' });
    upsertNode(db, { title: '學到的新詞', kind: 'tech', tags: ['glossary'], scope: 'global', status: 'approved' });
    const readFile = () => 'TGV, only-in-file\n';
    const terms = glossaryTermsForPrompt(db, '/fake/terms.txt', readFile);
    expect(terms).toEqual(['CPO', '學到的新詞']);
    expect(terms).not.toContain('TGV');
    expect(terms).not.toContain('only-in-file');
  });

  it('ignores non-glossary or non-approved knowledge nodes', () => {
    upsertNode(db, { title: 'not-glossary', kind: 'tech', tags: ['other'], scope: 'global', status: 'approved' });
    upsertNode(db, { title: 'draft-glossary', kind: 'tech', tags: ['glossary'], scope: 'global', status: 'draft' });
    const terms = glossaryTermsForPrompt(db, '', () => '');
    expect(terms).toEqual([]);
  });

  it('drops a term once its knowledge node is invalidated', () => {
    const node = upsertNode(db, { title: 'CPO', kind: 'tech', tags: ['glossary'], scope: 'global', status: 'approved' });
    upsertNode(db, { title: 'TGV', kind: 'tech', tags: ['glossary'], scope: 'global', status: 'approved' });
    expect(glossaryTermsForPrompt(db, '', () => '')).toEqual(['CPO', 'TGV']);
    invalidateNode(db, node.id);
    expect(glossaryTermsForPrompt(db, '', () => '')).toEqual(['TGV']);
  });

  it('falls back to terms.txt when the knowledge base has no glossary nodes at all', () => {
    const readFile = () => 'TGV, CPO\n';
    expect(glossaryTermsForPrompt(db, '/fake/terms.txt', readFile)).toEqual(['TGV', 'CPO']);
  });

  it('falls back to empty when the knowledge base is empty and terms.txt is missing/unreadable', () => {
    const readFile = () => { throw new Error('ENOENT'); };
    expect(glossaryTermsForPrompt(db, '/nope.txt', readFile)).toEqual([]);
  });

  it('falls back to empty when the knowledge base is empty and every glossary node has been invalidated', () => {
    const node = upsertNode(db, { title: 'CPO', kind: 'tech', tags: ['glossary'], scope: 'global', status: 'approved' });
    invalidateNode(db, node.id);
    const readFile = () => 'TGV\n';
    expect(glossaryTermsForPrompt(db, '/fake/terms.txt', readFile)).toEqual(['TGV']);
  });
});

// ---- 6. WarmWorker: singleton daemon lifecycle, all via a fake child (no real python) ----

interface FakeChild {
  child: ChildLike;
  writes: string[];
  emitData: (s: string) => void;
  emitExit: () => void;
  emitError: (e: Error) => void;
}

function makeFakeChild(): FakeChild {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const stdoutListeners: Record<string, Array<(chunk: Buffer | string) => void>> = {};
  const writes: string[] = [];
  let killed = false;
  const child: ChildLike = {
    stdin: { write: (chunk: string) => { writes.push(chunk); return true; } },
    stdout: { on: (event, cb) => { (stdoutListeners[event] ??= []).push(cb); } },
    stderr: { on: () => {} },
    on: (event, cb) => { (listeners[event] ??= []).push(cb as (...args: unknown[]) => void); },
    kill: () => { killed = true; },
    get killed() { return killed; },
  };
  return {
    child,
    writes,
    emitData: (s) => (stdoutListeners['data'] ?? []).forEach((cb) => cb(s)),
    emitExit: () => (listeners['exit'] ?? []).forEach((cb) => cb()),
    emitError: (e) => (listeners['error'] ?? []).forEach((cb) => cb(e)),
  };
}

describe('WarmWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns once and reuses the same child across requests', async () => {
    const fakes: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const worker = new WarmWorker(spawnFn, '/fake/python', '/fake/daemon.py', () => 10, 5000);

    const p1 = worker.transcribe('/a.webm', '/terms.txt');
    fakes[0].emitData(JSON.stringify({ text: 'first' }) + '\n');
    expect(await p1).toBe('first');

    const p2 = worker.transcribe('/b.webm', '/terms.txt');
    fakes[0].emitData(JSON.stringify({ text: 'second' }) + '\n');
    expect(await p2).toBe('second');

    expect(fakes).toHaveLength(1);
    expect(fakes[0].writes).toHaveLength(2);
  });

  it('respawns a fresh child after the worker dies', async () => {
    const fakes: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const worker = new WarmWorker(spawnFn, '/fake/python', '/fake/daemon.py', () => 10, 5000);

    const p1 = worker.transcribe('/a.webm', '/terms.txt');
    fakes[0].emitExit();
    await expect(p1).rejects.toThrow(/exited/);

    const p2 = worker.transcribe('/b.webm', '/terms.txt');
    expect(fakes).toHaveLength(2);
    fakes[1].emitData(JSON.stringify({ text: 'after respawn' }) + '\n');
    expect(await p2).toBe('after respawn');
  });

  it('shuts the worker down after the configured idle period, freeing VRAM', async () => {
    vi.useFakeTimers();
    const fakes: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const worker = new WarmWorker(spawnFn, '/fake/python', '/fake/daemon.py', () => 10, 5000);

    const p1 = worker.transcribe('/a.webm', '/terms.txt');
    fakes[0].emitData(JSON.stringify({ text: 'ok' }) + '\n');
    await p1;
    expect(worker.isAlive()).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(worker.isAlive()).toBe(false);
  });

  it('rejects and kills the worker on a response timeout', async () => {
    vi.useFakeTimers();
    const fakes: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const worker = new WarmWorker(spawnFn, '/fake/python', '/fake/daemon.py', () => 10, 5000);

    const p1 = worker.transcribe('/a.webm', '/terms.txt');
    const assertion = expect(p1).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(worker.isAlive()).toBe(false);
  });
});

// ---- 7. transcribe.ts: merged terms + warm-worker fallback (all hermetic) ----

describe('transcribe: knowledge-base glossary + warm worker', () => {
  it('seeds terms.txt into the knowledge base, then writes the KB glossary to the terms file passed to exec', async () => {
    upsertNode(db, { title: 'CPO', kind: 'tech', tags: ['glossary'], scope: 'global', status: 'approved' });
    setSetting(db, 'voice_terms_path', '/fake/terms.txt');
    setSetting(db, 'voice_warm_worker', 'false');
    const written: Record<string, string> = {};
    const exec: TranscribeExec = async () => 'ok';
    await transcribe(db, '/tmp/rec.webm', exec, {
      readFile: () => 'TGV\n',
      writeFile: (p, content) => { written[p] = content; },
    });
    const content = Object.values(written)[0];
    expect(content).toContain('TGV');
    expect(content).toContain('CPO');
  });

  it('uses the warm worker when voice_warm_worker=true (default) and never calls the one-shot exec', async () => {
    let oneShotCalls = 0;
    const exec: TranscribeExec = async () => { oneShotCalls++; return 'should not be used'; };
    const warmWorker = { transcribe: async () => 'from warm worker' };
    const out = await transcribe(db, '/tmp/rec.webm', exec, { warmWorker, readFile: () => '', writeFile: () => {} });
    expect(out).toBe('from warm worker');
    expect(oneShotCalls).toBe(0);
  });

  it('falls back to the one-shot script when the warm worker throws', async () => {
    const exec: TranscribeExec = async () => 'fallback transcript';
    const warmWorker = { transcribe: async () => { throw new Error('daemon down'); } };
    const out = await transcribe(db, '/tmp/rec.webm', exec, { warmWorker, readFile: () => '', writeFile: () => {} });
    expect(out).toBe('fallback transcript');
  });

  it('skips the warm worker entirely when voice_warm_worker=false', async () => {
    setSetting(db, 'voice_warm_worker', 'false');
    let warmCalls = 0;
    const warmWorker = { transcribe: async () => { warmCalls++; return 'warm'; } };
    const exec: TranscribeExec = async () => 'one-shot';
    const out = await transcribe(db, '/tmp/rec.webm', exec, { warmWorker, readFile: () => '', writeFile: () => {} });
    expect(out).toBe('one-shot');
    expect(warmCalls).toBe(0);
  });
});
