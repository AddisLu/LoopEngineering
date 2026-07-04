// Copy non-TS runtime assets into dist so the built engine can find them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copies = [['src/db/schema.sql', 'dist/db/schema.sql']];

for (const [from, to] of copies) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`copied ${from} -> ${to}`);
}
