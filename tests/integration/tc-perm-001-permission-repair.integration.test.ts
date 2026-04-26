// TC-PERM-1: Permission repair — enforceSensitivePerms() detects and repairs
// files with permissions wider than 0o600, and populates permissionRepairEvents
// for the startup audit path.
//
// PD-009 note: The macOS Keychain ACL on a Node.js interpreter cannot constrain
// the credential entry to this specific binary — any same-user code can read it
// via `security find-generic-password`. This is a documented residual risk per
// spec §7.6; there is no automated test that can verify the absence of ACL bypass
// since the bypass succeeds by design on this platform.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enforceSensitivePerms, permissionRepairEvents, sensitiveFilesInConfigDir } from '../../src/lib/secret-store.js';

describe('TC-PERM-1 — sensitive file permission repair', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bhg-perm-'));
    originalHome = process.env.HOME;

    // Point HOME at temp dir so configDir() → tmpDir/.bhg-pipedrive-mcp
    process.env.HOME = tmpDir;
    mkdirSync(join(tmpDir, '.bhg-pipedrive-mcp'), { mode: 0o700 });

    // Clear module-level buffer between tests
    permissionRepairEvents.length = 0;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
    permissionRepairEvents.length = 0;
  });

  it('no repair events when all files are already 0o600', () => {
    const files = sensitiveFilesInConfigDir();
    for (const f of files) {
      writeFileSync(f, 'test', { mode: 0o600 });
    }

    enforceSensitivePerms();
    expect(permissionRepairEvents).toHaveLength(0);
  });

  it('repairs a file at 0o644 to 0o600 and records the event', () => {
    const files = sensitiveFilesInConfigDir();
    // Create one file with wrong permissions (0o644 = world-readable)
    writeFileSync(files[0], 'test');
    require('node:fs').chmodSync(files[0], 0o644);

    enforceSensitivePerms();

    expect(permissionRepairEvents).toHaveLength(1);
    expect(permissionRepairEvents[0].before).toBe(0o644);
    expect(permissionRepairEvents[0].after).toBe(0o600);
    expect(permissionRepairEvents[0].path).toBe(files[0]);

    // Verify the repair actually happened on disk
    const mode = statSync(files[0]).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('repairs multiple mis-permissioned files and records each event', () => {
    const files = sensitiveFilesInConfigDir();
    for (const f of files) {
      writeFileSync(f, 'test');
      require('node:fs').chmodSync(f, 0o644);
    }

    enforceSensitivePerms();

    expect(permissionRepairEvents.length).toBe(files.length);
    for (const evt of permissionRepairEvents) {
      expect(evt.before).toBe(0o644);
      expect(evt.after).toBe(0o600);
    }
  });

  it('skips non-existent files silently (file does not have to exist)', () => {
    // Don't create any files — enforceSensitivePerms should not throw
    expect(() => enforceSensitivePerms()).not.toThrow();
    expect(permissionRepairEvents).toHaveLength(0);
  });
});
