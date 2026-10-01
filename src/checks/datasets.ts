import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { CheckError } from './store.js';

/**
 * 圖資: a git repo (on Gitea) holding an images folder and an answer file — the ground truth a
 * 圖資回歸 check compares the software's output with (src/checks/compare.ts). The engine or a
 * 機台 clones it on first use; only the answer file and the output come back to the engine.
 */

export const ANSWER_FORMATS = ['auto', 'json', 'csv', 'labels'] as const;
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

export interface Dataset {
  id: string;
  name: string;
  remote_url: string;
  /** relative to the dataset repo's root */
  images_dir: string;
  /** a file (json / csv) or a folder of YOLO .txt labels, relative to the root */
  answer_file: string;
  answer_format: AnswerFormat;
  cases: number | null;
  created_by: string | null;
  created_at: string;
}

export interface DatasetInput {
  name?: string | null;
  remote_url?: string | null;
  images_dir?: string | null;
  answer_file?: string | null;
  answer_format?: string | null;
  cases?: number | string | null;
}

// letters, digits, CJK, dot, dash, underscore: it becomes a folder name on Linux and Windows
// machines and is pasted into commands unquoted, so no spaces, separators or shell characters
const CJK = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
export const DATASET_NAME_RE = new RegExp(`^[A-Za-z0-9${CJK}][A-Za-z0-9${CJK}._-]{0,79}$`);
const SEGMENT_RE = new RegExp(`^[A-Za-z0-9${CJK}._-]+$`);

/** A path inside the dataset repo ('images', 'labels/val', 'answers.json'): relative, no '..'. */
function relPath(label: string, raw: string | null | undefined, fallback: string): string {
  const p = (raw ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '') || fallback;
  const segs = p.split('/');
  if (p.startsWith('/') || segs.some((s) => s === '' || s === '.' || s === '..' || !SEGMENT_RE.test(s))) {
    throw new CheckError(`${label}要寫圖資 repo 裡的相對路徑（英數、中文、. _ -，用 / 分層）：${p}`);
  }
  return p;
}

/** Where the dataset lives: an http(s)/ssh/git/file URL, scp-style git@host:owner/repo, or an absolute path. */
function remoteUrl(raw: string | null | undefined): string {
  const u = (raw ?? '').trim();
  if (!u) throw new CheckError('要填圖資 repo 的網址');
  if (u.length > 500 || /[\s\0]/.test(u)) throw new CheckError('圖資 repo 的網址不對');
  const scp = /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(u);
  if (!scp && !/^(https?|ssh|git|file):\/\/\S+$/i.test(u) && !u.startsWith('/')) {
    throw new CheckError('圖資 repo 的網址要是 http(s)://、ssh://、git@主機:路徑 或本機的絕對路徑');
  }
  // credentials never go into the database: the engine and the machines authenticate themselves
  if (/^https?:\/\/[^/]*@/i.test(u) || /^[a-z][a-z0-9+.-]*:\/\/[^/@:]*:[^/@]*@/i.test(u)) {
    throw new CheckError('網址裡不要放帳號密碼或 token（引擎與機台各自登入 Gitea）');
  }
  return u;
}

function normalize(input: DatasetInput): Omit<Dataset, 'id' | 'created_by' | 'created_at'> {
  const name = (input.name ?? '').trim();
  if (!name) throw new CheckError('圖資名稱不能空白');
  if (!DATASET_NAME_RE.test(name) || name.includes('..')) {
    throw new CheckError(`圖資名稱只能用英數、中文、. _ -（不含空白與 /，最多 80 字）：${name}`);
  }
  const format = ((input.answer_format ?? '').trim() || 'auto') as AnswerFormat;
  if (!(ANSWER_FORMATS as readonly string[]).includes(format)) throw new CheckError(`答案格式只能是 ${ANSWER_FORMATS.join(' / ')}`);
  let cases: number | null = null;
  if (input.cases !== undefined && input.cases !== null && input.cases !== '') {
    cases = Number(input.cases);
    if (!Number.isInteger(cases) || cases < 0) throw new CheckError('張數要是 0 以上的整數');
  }
  return {
    name,
    remote_url: remoteUrl(input.remote_url),
    images_dir: relPath('圖片資料夾', input.images_dir, 'images'),
    answer_file: relPath('答案檔', input.answer_file, 'answers.json'),
    answer_format: format,
    cases,
  };
}

function isUnique(err: unknown): boolean {
  return (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function createDataset(db: Database.Database, input: DatasetInput, by: string | null = null): Dataset {
  const row = normalize(input);
  const id = `ds_${nanoid(8)}`;
  try {
    db.prepare(
      `INSERT INTO datasets (id, name, remote_url, images_dir, answer_file, answer_format, cases, created_by)
       VALUES (@id, @name, @remote_url, @images_dir, @answer_file, @answer_format, @cases, @by)`,
    ).run({ ...row, id, by });
  } catch (err) {
    if (isUnique(err)) throw new CheckError(`已經有叫「${row.name}」的圖資`, 409);
    throw err;
  }
  return getDataset(db, id)!;
}

export function getDataset(db: Database.Database, id: string): Dataset | null {
  return (db.prepare('SELECT * FROM datasets WHERE id = ?').get(id) as Dataset | undefined) ?? null;
}

export function listDatasets(db: Database.Database): Dataset[] {
  return db.prepare('SELECT * FROM datasets ORDER BY name').all() as Dataset[];
}

/** PATCH semantics like updateCheck. Checks already snapshotted into a task keep their copy. */
export function updateDataset(db: Database.Database, id: string, patch: DatasetInput): Dataset | null {
  const cur = getDataset(db, id);
  if (!cur) return null;
  const merged: DatasetInput = { ...cur };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  const row = normalize(merged);
  try {
    db.prepare(
      `UPDATE datasets SET name=@name, remote_url=@remote_url, images_dir=@images_dir, answer_file=@answer_file,
         answer_format=@answer_format, cases=@cases WHERE id=@id`,
    ).run({ ...row, id });
  } catch (err) {
    if (isUnique(err)) throw new CheckError(`已經有叫「${row.name}」的圖資`, 409);
    throw err;
  }
  return getDataset(db, id);
}

/** Refuses while a check still points at it: its 圖資回歸 would silently lose its ground truth. */
export function deleteDataset(db: Database.Database, id: string): boolean {
  if (!getDataset(db, id)) return false;
  const users = db.prepare('SELECT name FROM checks WHERE dataset_id = ? ORDER BY name').all(id) as Array<{ name: string }>;
  if (users.length) throw new CheckError(`還有檢查在用這個圖資：${users.map((u) => u.name).join('、')}`, 409);
  return db.prepare('DELETE FROM datasets WHERE id = ?').run(id).changes > 0;
}
