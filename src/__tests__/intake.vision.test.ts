import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { registerRecipe, syncVision, getLocalModel } from '../local/models.js';
import { chatLocal } from '../local/chat.js';
import { readImages, ocrCommand } from '../intake/vision.js';

let db: Database.Database;
let dir: string;
let png: string;

beforeEach(() => {
  db = openTestDb();
  setSetting(db, 'local_models_enabled', 'true');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-'));
  png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function ready(vision: boolean): void {
  const m = registerRecipe(db, { recipe: 'qwen-vl', name: 'Qwen VL', model: 'x/qwen-vl' });
  syncVision(db, m, vision);
  setSetting(db, 'local_model_loaded', m.id);
  setSetting(db, 'local_model_status', 'ready');
}

describe('截圖理解 at intake', () => {
  it('a vision model reads the screenshot; the picture goes out as an image_url part', async () => {
    ready(true);
    const calls: unknown[] = [];
    const localChat: typeof chatLocal = async (_db, req) => {
      calls.push(req);
      return { ok: true, content: 'LOAD_RECIPE OK\nbypass_edge_x = 12' };
    };
    const r = await readImages(db, [{ file: png, mime: 'image/png' }], { localChat, exec: async () => ({ code: 1, out: 'never' }) });
    expect(r).toEqual([{ text: 'LOAD_RECIPE OK\nbypass_edge_x = 12', via: 'model' }]);
    expect((calls[0] as { images: { mime: string; base64: string }[] }).images[0]).toMatchObject({ mime: 'image/png', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64') });
    expect(getLocalModel(db, 'qwen-vl')!.vision).toBe(1);
  });

  it('falls back to OCR when the served model cannot see, and reports when neither can', async () => {
    ready(false);
    setSetting(db, 'intake_ocr_cmd', 'tesseract {file} - -l eng+chi_tra');
    const argv: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      argv.push([cmd, ...args]);
      return { code: 0, out: '錯誤：找不到 recipe\n' };
    };
    const r = await readImages(db, [{ file: png, mime: 'image/png' }], { exec, localChat: async () => ({ ok: false, reason: 'not_ready', detail: 'x' }) });
    expect(r).toEqual([{ text: '錯誤：找不到 recipe', via: 'ocr' }]);
    expect(argv).toEqual([['tesseract', png, '-', '-l', 'eng+chi_tra']]);

    setSetting(db, 'intake_ocr_cmd', '');
    const none = await readImages(db, [{ file: png, mime: 'image/png' }], { exec, localChat: async () => ({ ok: false, reason: 'not_ready', detail: 'x' }) });
    expect(none[0]).toMatchObject({ text: '', via: 'none' });
    expect(none[0]!.note).toContain('截圖未辨識');

    setSetting(db, 'intake_vision', 'off');
    expect((await readImages(db, [{ file: png, mime: 'image/png' }], { exec }))[0]!.via).toBe('none');
  });

  it('a failing OCR run is a note, never a throw; the file lands at the end when the template has no {file}', async () => {
    ready(false);
    setSetting(db, 'intake_ocr_cmd', 'my-ocr --lang zh');
    expect(ocrCommand('my-ocr --lang zh', '/a/b.png')).toEqual({ cmd: 'my-ocr', args: ['--lang', 'zh', '/a/b.png'] });
    const r = await readImages(db, [{ file: png, mime: 'image/png' }], { exec: async () => ({ code: 127, out: 'not found' }) });
    expect(r[0]).toMatchObject({ via: 'none' });
    expect(r[0]!.note).toContain('OCR 失敗');
  });

  it('chatLocal sends images as OpenAI-style content parts', async () => {
    ready(true);
    let body: Record<string, unknown> = {};
    await chatLocal(db, { system: 's', user: 'u', images: [{ mime: 'image/png', base64: 'AAAA' }] }, async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }) };
    });
    const user = (body.messages as { role: string; content: unknown }[])[1]!;
    expect(user.content).toEqual([{ type: 'text', text: 'u' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  });
});
