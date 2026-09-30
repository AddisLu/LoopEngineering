import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { chatLocal } from '../local/chat.js';
import { getLocalModel } from '../local/models.js';

/**
 * 截圖理解 at intake: what a screenshot says, as text the 分析 step and the implementation model
 * can use. A served model with a vision tower reads it directly (Qwen3.8-Flash-Next, GLM-5.3);
 * otherwise an OCR command (`intake_ocr_cmd`, e.g. tesseract) is the fallback; with neither the
 * image is kept but marked 未辨識. Never throws; never blocks a ticket on a failed reading.
 */

export interface ImageFile {
  file: string;
  mime: string;
}

export interface ImageReading {
  text: string;
  via: 'model' | 'ocr' | 'none';
  note?: string;
}

export type VisionExec = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string }>;

export interface VisionDeps {
  localChat?: typeof chatLocal;
  exec?: VisionExec;
}

const PROMPT = '這是一張軟體畫面的截圖。請只列出畫面上看得到的文字：錯誤訊息、視窗標題、按鈕文字、欄位名稱與數值。一行一項，照畫面上的原文，不要解釋、不要翻譯。';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function defaultExec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = err ? (err as { code?: number | string }).code : 0;
      resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}` });
    });
  });
}

/** The served model can read images (local_models.vision, kept in step by the catalog). */
export function visionModelReady(db: Database.Database): boolean {
  if (getSetting(db, 'local_model_status') !== 'ready') return false;
  const id = getSetting(db, 'local_model_loaded');
  const m = id ? getLocalModel(db, id) : undefined;
  return Boolean(m && m.vision);
}

/** OCR command from the setting: `tesseract {file} - -l eng+chi_tra` → cmd + args with {file} filled in. */
export function ocrCommand(template: string, file: string): { cmd: string; args: string[] } | null {
  const parts = template.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const filled = parts.map((p) => p.replace(/\{file\}/g, file));
  if (!parts.some((p) => p.includes('{file}'))) filled.push(file);
  return { cmd: filled[0]!, args: filled.slice(1) };
}

export async function readImages(db: Database.Database, images: ImageFile[], deps: VisionDeps = {}): Promise<ImageReading[]> {
  const mode = getSetting(db, 'intake_vision') || 'auto';
  if (mode === 'off') return images.map(() => ({ text: '', via: 'none', note: '截圖辨識已關閉（intake_vision=off）' }));
  const chat = deps.localChat ?? chatLocal;
  const exec = deps.exec ?? defaultExec;
  const useModel = (mode === 'auto' || mode === 'model') && visionModelReady(db);
  const ocr = mode === 'auto' || mode === 'ocr' ? (getSetting(db, 'intake_ocr_cmd') || '').trim() : '';
  const out: ImageReading[] = [];

  for (const im of images) {
    let done: ImageReading | null = null;
    if (useModel) {
      try {
        if (fs.statSync(im.file).size <= MAX_IMAGE_BYTES) {
          const base64 = fs.readFileSync(im.file).toString('base64');
          const r = await chat(db, { system: '你是畫面文字擷取器。', user: PROMPT, maxTokens: 1200, thinking: false, images: [{ mime: im.mime, base64 }] });
          if (r.ok && r.content.trim()) done = { text: r.content.trim(), via: 'model' };
        }
      } catch {
        done = null;
      }
    }
    if (!done && ocr) {
      const c = ocrCommand(ocr, im.file);
      if (c) {
        try {
          const r = await exec(c.cmd, c.args, 60_000);
          const text = r.out.trim();
          done = r.code === 0 && text ? { text, via: 'ocr' } : { text: '', via: 'none', note: `OCR 失敗（exit ${r.code ?? '?'}）：${text.slice(0, 160)}` };
        } catch (err) {
          done = { text: '', via: 'none', note: `OCR 執行失敗：${String(err).slice(0, 160)}` };
        }
      }
    }
    out.push(
      done ?? {
        text: '',
        via: 'none',
        note: useModel ? '視覺模型沒有回應' : ocr ? '沒有辨識結果' : '截圖未辨識：目前的模型不能看圖，也沒有設定 OCR（intake_ocr_cmd）',
      },
    );
  }
  return out;
}
