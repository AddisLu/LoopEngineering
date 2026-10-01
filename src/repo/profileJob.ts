import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getBool, logEvent } from '../db/index.js';
import { getRepo, type Repo } from './store.js';
import { analyseRepo } from './profile/analyse.js';
import type { RepoProfileFacets } from './profile/types.js';
import { getProfileRow, readFacets, saveStageA, setProfileState } from './profileStore.js';
import { chatLocal } from '../local/chat.js';
import { repoScope } from '../knowledge/types.js';
import { upsertLearned } from '../knowledge/learn.js';

/**
 * Repo 檔案 job. Stage A (src/repo/profile/analyse.ts) is deterministic and fast: it runs on import
 * (repo_profile_auto) and whenever an analysis sees HEAD moved. Stage B asks the served local model
 * — a handful of short calls — for what statistics cannot say: what each module is for, the style as
 * rules with examples, pitfall seeds (TODO/FIXME/HACK, encodings, GUI-only, hardware), and what
 * the config parameters mean. Everything stage B writes is a DRAFT knowledge node (source
 * 'inferred'); a person approves it on the 知識 page before any prompt sees it.
 */

export interface ProfileJobDeps {
  localChat?: typeof chatLocal;
  /** stage A override (tests) */
  analyse?: typeof analyseRepo;
}

const running = new Map<string, Promise<void>>();

export function profileRunning(repoId: string): boolean {
  return running.has(repoId);
}

export async function awaitProfile(repoId: string): Promise<void> {
  await running.get(repoId);
}

function head(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Run stage A (and stage B when asked). One job per repo at a time; never throws. */
export function runProfile(db: Database.Database, repoId: string, o: { infer?: boolean } = {}, deps: ProfileJobDeps = {}): Promise<void> {
  const prev = running.get(repoId);
  if (prev) return prev;
  const job = (async () => {
    let repo: Repo | null;
    try {
      repo = getRepo(db, repoId);
    } catch {
      return;
    }
    if (!repo) return;
    try {
      setProfileState(db, repoId, 'running', { stage: 'a' });
      await new Promise((r) => setImmediate(r));
      const a = (deps.analyse ?? analyseRepo)(repo.local_path);
      saveStageA(db, repoId, a.facets as unknown as { sha: string | null } & Record<string, unknown>, a.index);
      logEvent(db, { kind: 'note', detail: `Repo 檔案：${repo.name} 分析完成（需求 ${a.facets.requirements.length}、模組 ${a.facets.modules.length}、索引 ${a.index.length}，${a.facets.built_ms} ms）` });
      if (o.infer) {
        setProfileState(db, repoId, 'running', { stage: 'b' });
        const n = await inferDrafts(db, repo, a.facets, deps);
        db.prepare("UPDATE repo_profiles SET status = 'ready', stage = NULL, inferred_sha = sha, inferred_at = datetime('now') WHERE repo_id = ?").run(repoId);
        logEvent(db, { kind: 'note', detail: `Repo 檔案：${repo.name} 本地模型整理了 ${n} 條草稿` });
      }
    } catch (err) {
      try {
        setProfileState(db, repoId, 'failed', { error: (err as Error).message.slice(0, 300) });
      } catch {
        /* the database is gone (shutdown): nothing to record */
      }
    }
  })().finally(() => running.delete(repoId));
  running.set(repoId, job);
  return job;
}

/** When HEAD moved since the last stage A (an analysis is about to read it): rebuild in the background. */
export function refreshProfileIfStale(db: Database.Database, repo: Repo): void {
  if (!getBool(db, 'repo_profile_auto', true) || running.has(repo.id)) return;
  const row = getProfileRow(db, repo.id);
  const sha = head(repo.local_path);
  if (row?.sha && sha && row.sha === sha) return;
  void runProfile(db, repo.id, { infer: false });
}

// ---- stage B -------------------------------------------------------------------------------------

function excerpt(dir: string, rel: string, lines = 40): string {
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) return '';
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 512 * 1024) return '';
    return fs.readFileSync(abs, 'utf8').split('\n').slice(0, lines).join('\n');
  } catch {
    return '';
  }
}

function json<T>(text: string): T | null {
  const m = /[[{][\s\S]*[\]}]/.exec(text.replace(/```(?:json)?/g, ''));
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** A draft knowledge node of the repo for one inferred fact (keyed, so re-running updates it instead of piling up). */
export function upsertInferred(db: Database.Database, scope: string, kind: 'module' | 'style' | 'param', key: string, title: string, body: string, evidence: Array<{ file?: string; line?: number }> = []): void {
  const same = db
    .prepare("SELECT id, status FROM knowledge_nodes WHERE scope = ? AND kind = ? AND invalid_at IS NULL AND json_extract(meta_json, '$.key') = ?")
    .get(scope, kind, key) as { id: string; status: string } | undefined;
  const meta = JSON.stringify({ key, evidence });
  if (same) {
    // a person's decision stands: an approved or rejected node is not overwritten by a new guess
    if (same.status === 'draft') db.prepare("UPDATE knowledge_nodes SET title = ?, body = ?, meta_json = ?, updated_at = datetime('now') WHERE id = ?").run(title, body, meta, same.id);
    return;
  }
  db.prepare(
    `INSERT INTO knowledge_nodes (id, kind, title, body, tags, scope, source, status, weight, facet, meta_json)
     VALUES (?, ?, ?, ?, '[]', ?, 'inferred', 'draft', 3, ?, ?)`,
  ).run(`k_${nanoid(10)}`, kind, title, body, scope, kind, meta);
}

const SYS = '你是資深工程師，替團隊整理一個 repo 的說明，給之後要改這個 repo 的本地模型看。只根據提供的資料，不要編造。用繁體中文。只輸出 JSON，不要其他文字。';

export async function inferDrafts(db: Database.Database, repo: Repo, f: RepoProfileFacets, deps: ProfileJobDeps = {}): Promise<number> {
  const chat = deps.localChat ?? chatLocal;
  const scope = repoScope(repo.local_path);
  let n = 0;
  const ask = async (user: string, maxTokens = 1500) => {
    const r = await chat(db, { system: SYS, user, maxTokens, thinking: false });
    return r.ok ? r.content : null;
  };

  // 1. what each module is for
  if (f.modules.length) {
    const readme = excerpt(repo.local_path, 'README.md', 60);
    const mods = f.modules.slice(0, 12).map((m) => {
      const entry = m.entry_points[0] ? excerpt(repo.local_path, m.entry_points[0], 30) : '';
      return `### ${m.name}（${m.path || '.'}，${m.kind}，${m.output ?? '?'}，${m.files} 檔；依賴：${m.depends_on.join('、') || '無'}）${entry ? `\n\`\`\`\n${entry.slice(0, 1200)}\n\`\`\`` : ''}`;
    });
    const out = await ask(`${readme ? `## README（節錄）\n${readme.slice(0, 2500)}\n\n` : ''}## 模組\n${mods.join('\n\n')}\n\n每個模組一句到兩句：用途、主要做什麼、和誰互動。輸出 [{"module":"名稱","summary":"…"}]`);
    for (const x of json<Array<{ module?: string; summary?: string }>>(out ?? '') ?? []) {
      const mod = f.modules.find((m) => m.name === x.module);
      if (!mod || !x.summary) continue;
      upsertInferred(db, scope, 'module', `module:${mod.name}`, mod.name, clip(x.summary, 400), mod.entry_points.slice(0, 2).map((file) => ({ file })));
      n++;
    }
  }

  // 2. style as rules (per module that differs from the repo-wide profile)
  if (f.style.length) {
    const out = await ask(`## 統計出來的寫法\n${JSON.stringify(f.style.slice(0, 6)).slice(0, 5000)}\n\n寫成「照這樣寫」的規則，最多 8 條，每條一句加一個簡短例子；模組之間不同的地方要講明是哪個模組。編碼是 Big5 或混用的，一定要有一條提醒不要轉成 UTF-8。輸出 [{"title":"規則","body":"說明與例子"}]`);
    for (const x of json<Array<{ title?: string; body?: string }>>(out ?? '') ?? []) {
      const title = clip(x.title, 80);
      if (!title) continue;
      upsertInferred(db, scope, 'style', `style:${title}`, title, clip(x.body, 400));
      n++;
    }
  }

  // 3. pitfall seeds: TODO / FIXME / HACK, GUI-only, hardware, encodings
  const marks = (() => {
    try {
      return execFileSync('git', ['-C', repo.local_path, 'grep', '-n', '-I', '-E', '(TODO|FIXME|HACK|XXX|注意|不要|小心)[:：]', '--', ':!*.md', ':!docs'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .filter(Boolean)
        .slice(0, 60)
        .map((l) => l.slice(0, 200));
    } catch {
      return [] as string[];
    }
  })();
  const hw = f.requirements.filter((r) => ['hardware', 'license', 'gpu'].includes(r.kind)).map((r) => `${r.name}${r.version ? ` ${r.version}` : ''}${r.note ? `（${r.note}）` : ''}`);
  const enc = f.style.filter((s) => s.encoding.dominant === 'big5' || s.encoding.dominant === 'mixed').map((s) => `${s.module || '整個 repo'}：${s.encoding.dominant}`);
  if (marks.length || hw.length || enc.length || f.verify.gui_only.length) {
    const out = await ask(
      [
        marks.length ? `## 程式裡的提醒（git grep）\n${marks.join('\n')}` : '',
        hw.length ? `## 硬體／授權需求\n${hw.join('\n')}` : '',
        enc.length ? `## 編碼\n${enc.join('\n')}` : '',
        f.verify.gui_only.length ? `## 只有 GUI 的模組\n${f.verify.gui_only.join('、')}` : '',
        '整理成「改這個 repo 時最容易出錯的地方」，最多 5 條，要具體（哪個檔案或模組、會出什麼錯、怎麼避免）。words 放能在錯誤訊息或任務描述裡辨認它的字。輸出 [{"title":"…","symptom":"…","avoid":"…","words":["…"],"files":["…"]}]',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    for (const x of json<Array<{ title?: string; symptom?: string; avoid?: string; words?: unknown; files?: unknown }>>(out ?? '') ?? []) {
      const title = clip(x.title, 80);
      if (!title) continue;
      const list = (v: unknown) => (Array.isArray(v) ? v.map((s) => clip(s, 100)).filter(Boolean).slice(0, 6) : []);
      const body = [x.symptom && `會看到：${clip(x.symptom, 300)}`, x.avoid && `避免：${clip(x.avoid, 300)}`].filter(Boolean).join('；');
      const { id } = upsertLearned(db, scope, 'pitfall', title, body, { trigger: { words: list(x.words), files: list(x.files), kinds: [] }, evidence: [] });
      db.prepare("UPDATE knowledge_nodes SET source = 'inferred' WHERE id = ? AND source = 'learned' AND status = 'draft'").run(id);
      n++;
    }
  }

  // 4. what the config parameters mean (the ones the config file does not explain)
  const params = db
    .prepare("SELECT key, section, file, line, value, meaning FROM code_index WHERE repo_id = ? AND kind = 'param' ORDER BY file, line LIMIT 400")
    .all(repo.id) as Array<{ key: string; section: string | null; file: string; line: number; value: string | null; meaning: string | null }>;
  const unexplained = params.filter((p) => !p.meaning).slice(0, 60);
  if (unexplained.length) {
    const uses = db.prepare("SELECT file, line, text FROM code_index WHERE repo_id = ? AND kind = 'param_use' AND key = ? LIMIT 2");
    const lines = unexplained.map((p) => {
      const u = uses.all(repo.id, p.key) as Array<{ file: string; line: number; text: string }>;
      return `- [${p.section ?? ''}] ${p.key} = ${p.value ?? ''}（${p.file}）${u.map((x) => `\n  讀取：${x.file}:${x.line} ${x.text}`).join('')}`;
    });
    const out = await ask(`## 沒有說明的設定參數\n${lines.join('\n')}\n\n根據名稱、預設值與程式讀取處，推論每個參數的意義、單位與合理範圍；看不出來就略過。輸出 [{"key":"…","section":"…","meaning":"一句話（單位、範圍）"}]`, 2500);
    for (const x of json<Array<{ key?: string; section?: string; meaning?: string }>>(out ?? '') ?? []) {
      const p = unexplained.find((q) => q.key === x.key && (!x.section || (q.section ?? '') === x.section));
      if (!p || !x.meaning) continue;
      upsertInferred(db, scope, 'param', `param:${p.section ?? ''}.${p.key}`, `[${p.section ?? ''}] ${p.key}`, clip(x.meaning, 300), [{ file: p.file, line: p.line }]);
      n++;
    }
  }
  return n;
}

/** Facts for code that only has the stored profile (re-export for the page and the diagnosis). */
export function storedFacets(db: Database.Database, repoId: string): RepoProfileFacets | null {
  return readFacets<RepoProfileFacets>(getProfileRow(db, repoId));
}
