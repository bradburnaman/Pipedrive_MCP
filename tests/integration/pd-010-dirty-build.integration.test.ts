// PD-010: embed-version.mjs refuses to complete when CI=true and the tree is dirty.
// A dirty build would bake an inaccurate VERSION_ID into the binary, undermining
// reproducibility and the forensic value of the version string.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnProcess } from './_harness.js';

// Absolute path to the script so it can be run from a different CWD
const EMBED_SCRIPT = resolve(process.cwd(), 'scripts', 'embed-version.mjs');

describe('PD-010 — dirty build blocked in CI', () => {
  let tmpDir: string;
  let fakeRepo: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bhg-pd010-'));
    fakeRepo = join(tmpDir, 'repo');
    mkdirSync(join(fakeRepo, 'src', 'lib'), { recursive: true });

    // Copy capabilities.json so the script can read it
    copyFileSync(resolve(process.cwd(), 'capabilities.json'), join(fakeRepo, 'capabilities.json'));

    // Bootstrap a minimal git repo with a clean initial commit
    spawnProcess('git', ['init'], { cwd: fakeRepo, timeoutMs: 5_000 });
    spawnProcess('git', ['config', 'user.email', 'ci@test.local'], { cwd: fakeRepo, timeoutMs: 3_000 });
    spawnProcess('git', ['config', 'user.name', 'CI Test'], { cwd: fakeRepo, timeoutMs: 3_000 });
    spawnProcess('git', ['add', 'capabilities.json'], { cwd: fakeRepo, timeoutMs: 3_000 });
    spawnProcess('git', ['commit', '-m', 'init'], { cwd: fakeRepo, timeoutMs: 5_000 });

    // Make the working tree dirty — untracked file is enough for `git status --porcelain`
    writeFileSync(join(fakeRepo, 'dirty.txt'), 'uncommitted change');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 1 in CI when the tree is dirty', () => {
    const result = spawnProcess('node', [EMBED_SCRIPT], {
      cwd: fakeRepo,
      env: { CI: 'true' },
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/dirty|Refusing/i);
  });

  it('exits 0 in CI when dirty tree is permitted via BHG_ALLOW_DIRTY_BUILD=1', () => {
    const result = spawnProcess('node', [EMBED_SCRIPT], {
      cwd: fakeRepo,
      env: { CI: 'true', BHG_ALLOW_DIRTY_BUILD: '1' },
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    // Script should still log that the build is dirty
    expect(result.stderr).toMatch(/dirty/i);
  });

  it('exits 0 outside CI even with a dirty tree (CI gate only applies in CI)', () => {
    const result = spawnProcess('node', [EMBED_SCRIPT], {
      cwd: fakeRepo,
      // Explicitly clear CI so this test also passes when run inside a CI environment
      env: { CI: '' },
      timeoutMs: 10_000,
    });

    // No CI guard applies — exits 0 even though tree is dirty
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/dirty/i);
  });
});
