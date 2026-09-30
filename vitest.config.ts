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
      // local model weights are looked up here: an empty cache, never the machine's real one
      HF_HOME: path.join(TEST_DATA, 'hf'),
      // No Claude login and no TokenBar: a usage read that reaches past the cache must find nothing
      // to send. With this host's login it hit the account's usage endpoint, and the 429s it earned
      // lock the real engine out too.
      CLAUDE_CONFIG_DIR: path.join(TEST_DATA, 'claude'),
      CLAUDE_CODE_OAUTH_TOKEN: '',
      TOKENBAR_MCP_DIR: '',
      TOKENBAR_TOKEN_CACHE: path.join(TEST_DATA, 'tokenbar-token'),
      // built-in benchmark questions (評比, 快篩) create real git repos under spike_root
      LOOP_SPIKE_ROOT: path.join(TEST_DATA, 'spikes'),
      // no push notifications from a test, whatever the shell exports
      NTFY_SERVER: '',
      NTFY_TOPIC: '',
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
