import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, symlinkSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { isSyncRootPath, assertPathSafe, assertCwdClean, SyncRootError } from '../../src/lib/path-safety.js';

describe('path-safety', () => {
  describe('isSyncRootPath', () => {
    it('flags OneDrive paths', () => {
      expect(isSyncRootPath(join(homedir(), 'Library/CloudStorage/OneDrive-Test/foo'))).toBe(true);
    });
    it('flags iCloud paths', () => {
      expect(isSyncRootPath(join(homedir(), 'Library/Mobile Documents/com~apple~Foo/Bar'))).toBe(true);
    });
    it('flags Dropbox paths', () => {
      expect(isSyncRootPath(join(homedir(), 'Dropbox/foo'))).toBe(true);
    });
    it('flags Google Drive paths', () => {
      expect(isSyncRootPath(join(homedir(), 'Google Drive/foo'))).toBe(true);
      expect(isSyncRootPath(join(homedir(), 'GoogleDrive/foo'))).toBe(true);
    });
    it('allows a plain home-directory subpath', () => {
      expect(isSyncRootPath(join(homedir(), '.bhg-pipedrive-mcp'))).toBe(false);
    });
    it('allows /tmp paths', () => {
      expect(isSyncRootPath('/tmp/anything')).toBe(false);
    });
  });

  describe('assertPathSafe', () => {
    let syncRoot: string;
    let symlinkSrc: string;

    beforeEach(() => {
      syncRoot = mkdtempSync(join(tmpdir(), 'fake-onedrive-'));
      symlinkSrc = mkdtempSync(join(tmpdir(), 'link-src-'));
    });

    afterEach(() => {
      rmSync(syncRoot, { recursive: true, force: true });
      rmSync(symlinkSrc, { recursive: true, force: true });
    });

    it('resolves symlinks before checking', () => {
      const customDenylist = [syncRoot];
      const linked = join(symlinkSrc, 'config');
      symlinkSync(syncRoot, linked);
      expect(() =>
        assertPathSafe(linked, { purpose: 'test', denylist: customDenylist })
      ).toThrow(SyncRootError);
    });

    it('succeeds for a safe path', () => {
      expect(() =>
        assertPathSafe('/tmp/bhg-test', { purpose: 'test', denylist: [] })
      ).not.toThrow();
    });

    it('SyncRootError names the offending prefix', () => {
      try {
        assertPathSafe(join(syncRoot, 'x'), { purpose: 'config', denylist: [syncRoot] });
      } catch (e) {
        expect(e).toBeInstanceOf(SyncRootError);
        expect((e as SyncRootError).message).toContain(syncRoot);
        expect((e as SyncRootError).message).toContain('config');
      }
    });
  });

  describe('assertCwdClean', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cwd-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('passes for a clean directory', () => {
      writeFileSync(join(tmpDir, 'harmless.txt'), 'nothing here');
      expect(() => assertCwdClean(tmpDir)).not.toThrow();
    });

    it('rejects exact-name .env', () => {
      writeFileSync(join(tmpDir, '.env'), 'PIPEDRIVE_API_TOKEN=abc');
      expect(() => assertCwdClean(tmpDir)).toThrow(/Forbidden file.*\.env/);
    });

    it('rejects .env.local', () => {
      writeFileSync(join(tmpDir, '.env.local'), 'x=y');
      expect(() => assertCwdClean(tmpDir)).toThrow(/\.env\.local/);
    });

    it('rejects .npmrc', () => {
      writeFileSync(join(tmpDir, '.npmrc'), '//registry:_authToken=abc');
      expect(() => assertCwdClean(tmpDir)).toThrow(/\.npmrc/);
    });

    it('rejects *.db files', () => {
      writeFileSync(join(tmpDir, 'audit.db'), '');
      expect(() => assertCwdClean(tmpDir)).toThrow(/extension blocked/);
    });

    it('rejects *.log files', () => {
      writeFileSync(join(tmpDir, 'debug.log'), '');
      expect(() => assertCwdClean(tmpDir)).toThrow(/extension blocked/);
    });

    it('rejects 40-hex-character filenames', () => {
      writeFileSync(join(tmpDir, 'a'.repeat(40)), '');
      expect(() => assertCwdClean(tmpDir)).toThrow(/looks like a raw token/);
    });

    it('rejects file containing PIPEDRIVE_API_TOKEN= marker', () => {
      writeFileSync(join(tmpDir, 'my-secrets'), 'PIPEDRIVE_API_TOKEN=abc123');
      expect(() => assertCwdClean(tmpDir)).toThrow(/PIPEDRIVE_API_TOKEN/);
    });

    it('does not scan .md files for token marker', () => {
      writeFileSync(join(tmpDir, 'README.md'), 'PIPEDRIVE_API_TOKEN=example');
      expect(() => assertCwdClean(tmpDir)).not.toThrow();
    });

    it('does not scan .example files for token marker', () => {
      writeFileSync(join(tmpDir, '.env.example'), 'PIPEDRIVE_API_TOKEN=your-token');
      expect(() => assertCwdClean(tmpDir)).not.toThrow();
    });

    it('ignores subdirectories during scan', () => {
      const sub = join(tmpDir, 'subdir');
      mkdirSync(sub);
      writeFileSync(join(sub, '.env'), 'PIPEDRIVE_API_TOKEN=abc');
      expect(() => assertCwdClean(tmpDir)).not.toThrow();
    });
  });
});
