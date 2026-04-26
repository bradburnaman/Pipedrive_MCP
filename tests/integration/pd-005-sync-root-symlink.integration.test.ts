// PD-005: Startup blocks when the config dir resolves under a cloud-synced path.
// Uses a fake HOME so the real ~/.bhg-pipedrive-mcp is not touched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnProcess } from './_harness.js';

describe('PD-005 — sync-root symlink → startup exit 1', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bhg-pd005-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 1 when .bhg-pipedrive-mcp is symlinked into Library/CloudStorage', () => {
    const fakeHome = join(tmpDir, 'home');
    const cloudRoot = join(fakeHome, 'Library', 'CloudStorage', 'OneDrive-Personal');
    mkdirSync(cloudRoot, { recursive: true });

    // Symlink config dir into cloud-synced location
    symlinkSync(cloudRoot, join(fakeHome, '.bhg-pipedrive-mcp'));

    const result = spawnProcess('npx', ['tsx', 'src/index.ts'], {
      env: { HOME: fakeHome },
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cloud-synced/i);
  });

  it('exits 1 when .bhg-pipedrive-mcp is symlinked into iCloud (Mobile Documents)', () => {
    const fakeHome = join(tmpDir, 'home-icloud');
    const iCloudRoot = join(fakeHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    mkdirSync(iCloudRoot, { recursive: true });

    symlinkSync(iCloudRoot, join(fakeHome, '.bhg-pipedrive-mcp'));

    const result = spawnProcess('npx', ['tsx', 'src/index.ts'], {
      env: { HOME: fakeHome },
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cloud-synced/i);
  });

  it('does NOT exit 1 when config dir is a plain directory under HOME (sanity check)', () => {
    const fakeHome = join(tmpDir, 'home-clean');
    // Create the config dir as a normal directory — not symlinked to cloud
    mkdirSync(join(fakeHome, '.bhg-pipedrive-mcp'), { recursive: true });

    const result = spawnProcess('npx', ['tsx', 'src/index.ts'], {
      env: { HOME: fakeHome },
      timeoutMs: 10_000,
    });

    // Server will still fail (no token), but NOT because of cloud-sync
    expect(result.stderr).not.toMatch(/cloud-synced/i);
    expect(result.stderr).not.toMatch(/SyncRootError/i);
  });
});
