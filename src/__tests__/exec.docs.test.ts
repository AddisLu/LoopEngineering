import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('the manual documents the GPU 執行沙盒', () => {
  it('chapter 26b is in the TOC and covers setup, the chat gates, tasks and the verify prefix', () => {
    const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '操作說明.html'), 'utf8');
    expect(manual).toContain('<section id="sandbox">');
    expect(manual).toContain('href="#sandbox"');
    for (const s of ['loop exec check', 'exec_enabled', 'exec_allowed_users', 'NVreg_RestrictProfilingToAdminUsers=0', 'sandbox: ', '--network none', 'mcp__loop-exec__run']) {
      expect(manual, s).toContain(s);
    }
  });
});
