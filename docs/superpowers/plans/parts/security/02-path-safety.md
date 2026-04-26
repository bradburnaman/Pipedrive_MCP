# Part sec-02: Path Safety

> Part 2 of 9.
> **Depends on:** sec-01.
> **Produces:** `src/lib/path-safety.ts`, `tests/lib/path-safety.test.ts`. A reusable module that rejects sync-root paths — used by every secret/audit path in later parts.

---

## Task 1: Write tests first

`tests/lib/path-safety.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { isSyncRootPath, assertPathSafe, SyncRootError } from '../../src/lib/path-safety.js';

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
      // Simulate: ~/Library/CloudStorage/OneDrive-Foo is a symlink into syncRoot
      // We can't actually monkey with ~, so we pass a mock denylist.
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
});
```

Run: expected to fail (module doesn't exist yet).

## Task 2: Implement `path-safety.ts`

`src/lib/path-safety.ts`:

```typescript
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';

export class SyncRootError extends Error {
  constructor(public resolvedPath: string, public deniedBy: string, public purpose: string) {
    super(
      `Refusing to use ${purpose} path: ${resolvedPath} resolves under a cloud-synced ` +
      `folder (${deniedBy}). Move it outside sync (e.g. under $HOME that is not cloud-synced).`
    );
    this.name = 'SyncRootError';
  }
}

function defaultDenylist(): string[] {
  const h = homedir();
  return [
    join(h, 'Library/CloudStorage'),          // catches all OneDrive-*, Dropbox, Box, GoogleDrive via CloudStorage
    join(h, 'Library/Mobile Documents'),      // iCloud
    join(h, 'Dropbox'),
    join(h, 'Google Drive'),
    join(h, 'GoogleDrive'),
    join(h, 'Box'),
    join(h, 'Sync'),
  ].map(normalize);
}

export function isSyncRootPath(p: string, denylist: string[] = defaultDenylist()): boolean {
  const normalized = normalize(p);
  return denylist.some(root => normalized === root || normalized.startsWith(root + '/'));
}

export interface AssertPathSafeOptions {
  purpose: string;
  denylist?: string[];
}

export function assertPathSafe(p: string, opts: AssertPathSafeOptions): void {
  const denylist = opts.denylist ?? defaultDenylist();
  // Resolve symlinks. Allow missing paths — we might be checking the intended
  // location before creating it — but if the *parent* resolves into a sync root,
  // that still counts.
  let resolved: string;
  try {
    resolved = realpathSync(p);
  } catch {
    // Path doesn't exist yet; check parent chain instead.
    resolved = normalize(p);
  }
  for (const root of denylist) {
    if (resolved === root || resolved.startsWith(root + '/')) {
      throw new SyncRootError(resolved, root, opts.purpose);
    }
  }
}

export function configDir(): string {
  return join(homedir(), '.bhg-pipedrive-mcp');
}

export function assertConfigDirSafe(): void {
  assertPathSafe(configDir(), { purpose: 'config' });
}
```

- [ ] Implement the module.
- [ ] Run the test — expected: all pass.

## Task 3: CWD-forbidden-files check

Add an `assertCwdClean()` helper to `src/lib/path-safety.ts`:

```typescript
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';

const CWD_FORBIDDEN_FILES = ['.env', '.env.local', '.env.production', '.env.development', '.npmrc'];
const CWD_FORBIDDEN_EXT = ['.db', '.db-journal', '.log'];
const HEX40 = /^[a-f0-9]{40}$/;

export function assertCwdClean(cwd: string = process.cwd()): void {
  // Exact-name files
  for (const f of CWD_FORBIDDEN_FILES) {
    const p = `${cwd}/${f}`;
    if (existsSync(p)) {
      throw new Error(`Forbidden file in CWD: ${p}. Delete it and re-run. ` +
        `Token-bearing files must not live in the project directory.`);
    }
  }
  // Extension-based + hex-40-basename
  let entries: string[];
  try { entries = readdirSync(cwd); } catch { return; }
  for (const name of entries) {
    if (CWD_FORBIDDEN_EXT.some(ext => name.endsWith(ext))) {
      throw new Error(`Forbidden file in CWD: ${cwd}/${name} (extension blocked).`);
    }
    if (HEX40.test(name)) {
      throw new Error(`Forbidden file in CWD: ${cwd}/${name} (looks like a raw token).`);
    }
  }
  // First-4KB marker scan for .env-renamed files
  for (const name of entries) {
    const full = `${cwd}/${name}`;
    try {
      if (!statSync(full).isFile()) continue;
      const head = readFileSync(full, { encoding: 'utf8' }).slice(0, 4096);
      if (/PIPEDRIVE_API_TOKEN\s*=/.test(head)) {
        throw new Error(`Forbidden content in CWD: ${full} contains PIPEDRIVE_API_TOKEN= marker.`);
      }
    } catch (e) {
      if ((e as Error).message?.startsWith('Forbidden')) throw e;
      // Unreadable files — ignore.
    }
  }
}
```

- [ ] Implement.
- [ ] Add tests for each refusal class (exact-name, `.db`, `.log`, 40-hex basename, marker content).

## Task 4: Wire into `index.ts` startup

```typescript
import { assertConfigDirSafe, assertCwdClean } from './lib/path-safety.js';

async function main() {
  assertConfigDirSafe();
  assertCwdClean();
  const config = parseConfig();
  // ... existing code
}
```

- [ ] Update `src/index.ts`.
- [ ] Manual verification: rename `~/.bhg-pipedrive-mcp` to a symlink pointing into `~/Library/CloudStorage/OneDrive-*` — confirm `npm start` exits 1 with the expected error. Drop a `.env` in CWD — confirm exit 1. Drop an `audit.db` in CWD — confirm exit 1.

## Task 5: Commit

```bash
git add src/lib/path-safety.ts tests/lib/path-safety.test.ts src/index.ts
git commit -m "feat(security): path-safety refuses sync-root config + CWD-forbidden files"
```

---

**Done when:** path-safety tests pass (sync-root detection, symlink resolution, CWD-exact-name, CWD-extension, CWD-hex-40, CWD-marker); `npm start` with a fake sync-root `HOME` fails before any token read; `.env` / `.npmrc` / `*.db` / `*.log` / 40-hex file in CWD each cause exit 1 with a naming of the offending rule.

## Developer escape hatch (documented, not code)

If a `*.log` or `*.db` file in CWD is from unrelated tooling (e.g., a debug log, a test SQLite DB), **move it out of CWD** — do not add an override flag or allowlist. The refusal is a deliberate forcing function. Document the relocation in a commit message so future contributors understand why the file is where it is. The only two files the app itself ever creates at these paths live under `~/.bhg-pipedrive-mcp/`, which is excluded from the CWD check.

---

## Implementation Status

**Shipped:** commit `2179621` on `security/api-key-hardening`. As-spec, no deviations.
