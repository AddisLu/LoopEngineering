import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

// Isolate all runtime data (db, worktrees, logs, usage cache) under a temp dir so
// tests never touch the real ~/.local/share/loop-engineering.
const TEST_DATA = path.join(os.tmpdir(), `loop-eng-test-${process.pid}`);

export default defineConfig({
  test: {
    env: {
      LOOP_DATA_DIR: TEST_DATA,
      // Neutralize any ambient API token so buildApp({ apiToken: null }) really
      // means "no auth" — keeps the REST tests hermetic across dev shells.
      LOOP_API_TOKEN: '',
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
