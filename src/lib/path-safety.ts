import { realpathSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, extname } from 'node:path';

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
    join(h, 'Library/CloudStorage'),     // OneDrive-*, Box, and others via macOS CloudStorage
    join(h, 'Library/Mobile Documents'), // iCloud
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
  const rawDenylist = opts.denylist ?? defaultDenylist();
  // Resolve symlinks on both the path and each denylist entry so that macOS
  // /tmp → /private/tmp and similar aliasing don't create false negatives.
  let resolved: string;
  try {
    resolved = realpathSync(p);
  } catch {
    resolved = normalize(p);
  }
  for (const raw of rawDenylist) {
    let root: string;
    try { root = realpathSync(raw); } catch { root = normalize(raw); }
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

const CWD_FORBIDDEN_FILES = ['.env', '.env.local', '.env.production', '.env.development', '.npmrc'];
const CWD_FORBIDDEN_EXT = ['.db', '.db-journal', '.log'];
const HEX40 = /^[a-f0-9]{40}$/;

// Extensions excluded from the token-marker scan — these are known-safe project file types
// (docs, code, config templates). The scan targets files with unusual/no extensions that
// could be renamed .env files. Keeping this list prevents README.md and .env.example from
// false-positiving while maintaining the protective intent.
const MARKER_SCAN_SKIP_EXT = new Set([
  '.md', '.example', '.ts', '.js', '.mjs', '.cjs', '.json', '.sh',
  '.yaml', '.yml', '.txt', '.tsbuildinfo', '.lock', '.toml', '.xml',
]);

export function assertCwdClean(cwd: string = process.cwd()): void {
  // Exact-name forbidden files
  for (const f of CWD_FORBIDDEN_FILES) {
    if (existsSync(join(cwd, f))) {
      throw new Error(
        `Forbidden file in CWD: ${join(cwd, f)}. Delete it and re-run. ` +
        `Token-bearing files must not live in the project directory.`
      );
    }
  }

  let entries: string[];
  try { entries = readdirSync(cwd); } catch { return; }

  for (const name of entries) {
    // Extension-based block
    if (CWD_FORBIDDEN_EXT.some(ext => name.endsWith(ext))) {
      throw new Error(`Forbidden file in CWD: ${join(cwd, name)} (extension blocked).`);
    }
    // 40-hex basename looks like a raw token
    if (HEX40.test(name)) {
      throw new Error(`Forbidden file in CWD: ${join(cwd, name)} (looks like a raw token).`);
    }
  }

  // First-4KB marker scan for renamed .env files — skip directories and known-safe extensions
  for (const name of entries) {
    if (MARKER_SCAN_SKIP_EXT.has(extname(name))) continue;
    const full = join(cwd, name);
    try {
      if (!statSync(full).isFile()) continue;
      const head = readFileSync(full, { encoding: 'utf8' }).slice(0, 4096);
      if (/PIPEDRIVE_API_TOKEN\s*=/.test(head)) {
        throw new Error(`Forbidden content in CWD: ${full} contains PIPEDRIVE_API_TOKEN= marker.`);
      }
    } catch (e) {
      if ((e as Error).message?.startsWith('Forbidden')) throw e;
      // Unreadable files — ignore
    }
  }
}
