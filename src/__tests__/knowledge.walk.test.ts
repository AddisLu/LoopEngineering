import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { walkGitSource, walkFolderSource, walkSource, isGoverned, maskSecrets } from '../knowledge/ingest/walk.js';
import type { SourceRow } from '../knowledge/ingest/types.js';

let tmpRoots: string[] = [];
function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-walk-${tag}-`));
  tmpRoots.push(d);
  return d;
}
afterEach(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  tmpRoots = [];
});

function makeSource(kind: SourceRow['kind'], uri: string, config: Record<string, unknown> = {}): SourceRow {
  return {
    id: 'src_test',
    kind,
    uri,
    config: JSON.stringify(config),
    enabled: 1,
    last_ingested_at: null,
    created_at: '',
    updated_at: '',
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

describe('walkGitSource: git ls-files respects .gitignore, tracked-only', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkTmpDir('git');
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\nnode_modules/\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'should not be tracked\n');
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '--no-verify', '-m', 'seed']);
    // an untracked file present on disk but never `git add`ed
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'not added\n');
  });

  it('lists only tracked files, excluding gitignored and untracked ones', () => {
    const files = walkGitSource(makeSource('git', repo), 1024);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['.gitignore', 'README.md', 'src.ts']);
  });

  it('reads file content and byte size correctly', () => {
    const files = walkGitSource(makeSource('git', repo), 1024);
    const readme = files.find((f) => f.path === 'README.md')!;
    expect(readme.text).toBe('# hello\n');
    expect(readme.bytes).toBe(Buffer.byteLength('# hello\n'));
    expect(readme.mtime).not.toBeNull();
  });

  it('walkSource dispatches kind=git to walkGitSource', () => {
    const files = walkSource(makeSource('git', repo), 1024);
    expect(files.map((f) => f.path).sort()).toEqual(['.gitignore', 'README.md', 'src.ts']);
  });
});

describe('walkFolderSource: governed recursive walk (folder/vault)', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmpDir('folder');
    fs.writeFileSync(path.join(root, 'note.md'), '# note\ncontent\n');
    fs.writeFileSync(path.join(root, 'code.ts'), 'export {};\n');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=2\n');
    fs.writeFileSync(path.join(root, 'id_rsa'), 'fake key\n');
    fs.writeFileSync(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // a file with a NUL byte but an unrecognized extension — binary sniff should catch it
    fs.writeFileSync(path.join(root, 'weird.dat'), Buffer.from([0x00, 0x01, 0x02]));
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'deep.md'), '# deep\n');
  });

  it('excludes node_modules/dist/.git, lockfiles, binaries, secret filenames, and NUL-byte content', () => {
    const files = walkFolderSource(makeSource('folder', root), 1024);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['code.ts', 'note.md', 'sub/deep.md']);
  });

  it('walkSource dispatches kind=folder and kind=vault to walkFolderSource', () => {
    expect(walkSource(makeSource('folder', root)).map((f) => f.path).sort()).toEqual(['code.ts', 'note.md', 'sub/deep.md']);
    expect(walkSource(makeSource('vault', root)).map((f) => f.path).sort()).toEqual(['code.ts', 'note.md', 'sub/deep.md']);
  });

  it('walkSource returns [] for github-issues (not a file-tree walk)', () => {
    expect(walkSource(makeSource('github-issues', root))).toEqual([]);
  });

  it('honors a size cap: a file over maxFileKb is excluded', () => {
    fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(2048));
    const files = walkFolderSource(makeSource('folder', root), 1); // 1 KB cap
    expect(files.map((f) => f.path)).not.toContain('big.md');
  });

  it('honors include/exclude globs from source config', () => {
    const onlyMd = walkFolderSource(makeSource('folder', root, { include: ['**/*.md'] }), 1024);
    expect(onlyMd.map((f) => f.path).sort()).toEqual(['note.md', 'sub/deep.md']);

    const noSub = walkFolderSource(makeSource('folder', root, { exclude: ['sub/**'] }), 1024);
    expect(noSub.map((f) => f.path).sort()).toEqual(['code.ts', 'note.md']);
  });
});

describe('isGoverned', () => {
  it('flags default excludes, glob excludes, missing-include, and oversized files', () => {
    expect(isGoverned('node_modules/x.js', 10, {}, 1024).allowed).toBe(false);
    expect(isGoverned('a.md', 10, { exclude: ['*.md'] }, 1024).allowed).toBe(false);
    expect(isGoverned('a.md', 10, { include: ['*.ts'] }, 1024).allowed).toBe(false);
    expect(isGoverned('a.ts', 10, { include: ['*.ts'] }, 1024).allowed).toBe(true);
    expect(isGoverned('a.ts', 5 * 1024 * 1024, {}, 1).allowed).toBe(false);
    expect(isGoverned('a.ts', 10, {}, 1024).allowed).toBe(true);
  });
});

describe('maskSecrets', () => {
  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----';
    const { text, redactions } = maskSecrets(`before\n${pem}\nafter`);
    expect(redactions).toBe(1);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('MIIBogIBAAJ');
  });

  it('redacts an AWS access key id', () => {
    const { text, redactions } = maskSecrets('AKIA_KEY=AKIAABCDEFGHIJKLMNOP');
    expect(redactions).toBe(1);
    expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('redacts a GitHub token and a generic api_key="..." assignment', () => {
    const ghResult = maskSecrets('token = "ghp_abcdefghijklmnopqrstuvwxyz012345"');
    expect(ghResult.redactions).toBeGreaterThanOrEqual(1);
    expect(ghResult.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');

    const genericResult = maskSecrets('api_key: "abcdefghij0123456789ABCDEF"');
    expect(genericResult.redactions).toBe(1);
    expect(genericResult.text).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched (0 redactions)', () => {
    const { text, redactions } = maskSecrets('just some ordinary code, no secrets here');
    expect(redactions).toBe(0);
    expect(text).toBe('just some ordinary code, no secrets here');
  });
});
