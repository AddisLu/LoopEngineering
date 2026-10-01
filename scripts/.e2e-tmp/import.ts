import { getDb } from '../../src/db/index.js';
import { importRepo, awaitImport } from '../../src/repo/import.js';
const db = getDb();
const job = importRepo(db, { url: 'file:///tmp/claude-1000/-home-auo001-Addis-LoopEngineering/6e1a9092-c746-4f6a-8bb6-789485b295ca/scratchpad/e2e/origin/aoi.git' } as never, { allowFileUrls: true });
const done = await awaitImport(job.id, { ingest: false });
console.log(JSON.stringify(done, null, 1).slice(0, 1500));
