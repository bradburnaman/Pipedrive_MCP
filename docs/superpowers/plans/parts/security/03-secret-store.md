# Part sec-03: Secret Store (Keychain + encryption wrapper) + Setup / Rotate / Revoke CLIs

> Part 3 of 9.
> **Depends on:** sec-01, sec-02.
> **Produces:** `src/lib/secret-store.ts`, `src/bin/setup.ts`, `src/bin/revoke.ts`, `tests/lib/secret-store.test.ts`, revised `src/index.ts` token read path, updated `src/config.ts`.

Implements spec §7. The architecture's §4.1 "Keychain ACL testing + encryption-wrapper fallback" requirement is satisfied here: we use the wrapper unconditionally because the Keychain ACL on a Node interpreter cannot reliably constrain to this script.

---

## Task 1: `SecretStore` module

### 1.1 Keychain layout

- Service `bhg-pipedrive-mcp`: Base64(nonce || tag || ciphertext || issued_at_iso) — token wrapped.
- Service `bhg-pipedrive-mcp-kdf`: 32 random bytes, base64 — seed for scrypt KDF.
- File `<configDir>/salt.bin`: 32 random bytes, mode 0600 — per-install salt.

### 1.2 Crypto

```typescript
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(scrypt) as (password: Buffer, salt: Buffer, keylen: number, opts?: any) => Promise<Buffer>;

async function deriveKey(kdfSeed: Buffer, salt: Buffer): Promise<Buffer> {
  return scryptAsync(kdfSeed, salt, 32, { N: 1 << 15, r: 8, p: 1 });
}

function encrypt(token: string, key: Buffer): { payload: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const issuedAt = new Date().toISOString();
  const payload = Buffer.concat([
    nonce, tag, ciphertext, Buffer.from('|' + issuedAt, 'utf8'),
  ]).toString('base64');
  return { payload };
}

function decrypt(payload: string, key: Buffer): { token: string; issuedAt: string } {
  const buf = Buffer.from(payload, 'base64');
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const rest = buf.subarray(28);
  const sep = rest.lastIndexOf(0x7c); // '|'
  const ciphertext = rest.subarray(0, sep);
  const issuedAt = rest.subarray(sep + 1).toString('utf8');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return { token, issuedAt };
}
```

### 1.3 Module skeleton

`src/lib/secret-store.ts`:

```typescript
import keytar from 'keytar';
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { configDir, assertPathSafe } from './path-safety.js';
// ...crypto helpers above

const SERVICE_TOKEN = 'bhg-pipedrive-mcp';
const SERVICE_KDF = 'bhg-pipedrive-mcp-kdf';

function account(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'default';
}

function saltPath(): string { return join(configDir(), 'salt.bin'); }

async function ensureKdfSeed(): Promise<Buffer> {
  const existing = await keytar.getPassword(SERVICE_KDF, account());
  if (existing) return Buffer.from(existing, 'base64');
  const seed = randomBytes(32);
  await keytar.setPassword(SERVICE_KDF, account(), seed.toString('base64'));
  return seed;
}

function ensureSalt(): Buffer {
  assertPathSafe(configDir(), { purpose: 'config' });
  if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  if (!existsSync(saltPath())) {
    writeFileSync(saltPath(), randomBytes(32), { mode: 0o600 });
  }
  // Enforce mode 0600 on every read — audit on repair.
  const before = statSync(saltPath()).mode & 0o777;
  if (before !== 0o600) {
    chmodSync(saltPath(), 0o600);
    const after = statSync(saltPath()).mode & 0o777;
    if (after !== 0o600) {
      throw new Error(`Unable to enforce 0600 on salt.bin (mode now ${after.toString(8)})`);
    }
    // Caller (index.ts or SecretStore wrapper) should emit PERMISSION_REPAIRED audit row.
    permissionRepairEvents.push({ path: saltPath(), before, after });
  }
  return readFileSync(saltPath());
}

// Module-level buffer for permission-repair events observed during startup.
// index.ts reads this after audit-log init and emits one audit row per entry.
export const permissionRepairEvents: { path: string; before: number; after: number }[] = [];

// Enumerated once — sec-06 and sec-10 add audit.db and exceptions.log here.
export function sensitiveFilesInConfigDir(): string[] {
  const dir = configDir();
  const candidates = ['salt.bin', 'config.json', 'audit.db', 'exceptions.log'];
  return candidates.map(name => join(dir, name));
}

export function enforceSensitivePerms(): void {
  for (const p of sensitiveFilesInConfigDir()) {
    if (!existsSync(p)) continue;
    const mode = statSync(p).mode & 0o777;
    if (mode !== 0o600) {
      try {
        chmodSync(p, 0o600);
        permissionRepairEvents.push({ path: p, before: mode, after: 0o600 });
      } catch (err) {
        // Caller (index.ts) will observe the absence of a repair event for this file
        // by re-statting and flip safeDegraded. For now, push a sentinel.
        permissionRepairEvents.push({ path: p, before: mode, after: -1 });
      }
    }
  }
}

export async function storeToken(token: string): Promise<void> {
  const kdf = await ensureKdfSeed();
  const salt = ensureSalt();
  const key = await deriveKey(kdf, salt);
  const { payload } = encrypt(token, key);
  await keytar.setPassword(SERVICE_TOKEN, account(), payload);
}

export async function getToken(): Promise<{ token: string; issuedAt: string } | null> {
  const payload = await keytar.getPassword(SERVICE_TOKEN, account());
  if (!payload) return null;
  const kdf = await ensureKdfSeed();
  const salt = ensureSalt();
  const key = await deriveKey(kdf, salt);
  return decrypt(payload, key);
}

export async function clearToken(): Promise<void> {
  await keytar.deletePassword(SERVICE_TOKEN, account());
  await keytar.deletePassword(SERVICE_KDF, account());
}

export interface RotationStatus {
  issuedAt: Date;
  ageDays: number;
  status: 'fresh' | 'due' | 'degraded' | 'refuse';
}

// Tightened thresholds per spec §7.5 (design v1.1):
//   0–74 silent, 75–89 warn, 90–119 degraded (warn every call), 120+ refuse.
export function evaluateRotation(issuedAtIso: string): RotationStatus {
  const issuedAt = new Date(issuedAtIso);
  const ageDays = (Date.now() - issuedAt.getTime()) / 86_400_000;
  let status: RotationStatus['status'];
  if (ageDays < 75) status = 'fresh';
  else if (ageDays < 90) status = 'due';
  else if (ageDays < 120) status = 'degraded';
  else status = 'refuse';
  return { issuedAt, ageDays, status };
}

// Restricted env-override gating per spec §7.4.
export interface EnvOverrideResult { allowed: boolean; reason?: string; }

export function envOverrideAllowed(env = process.env): EnvOverrideResult {
  const isTest = env.NODE_ENV === 'test' || env.CI === 'true';
  if (isTest) return { allowed: true, reason: 'test_mode' };
  const breakGlass = env.BHG_PIPEDRIVE_BREAK_GLASS === '1';
  const reason = (env.BHG_PIPEDRIVE_BREAK_GLASS_REASON ?? '').trim();
  if (breakGlass && reason.length > 0) {
    return { allowed: true, reason: `break_glass:${reason}` };
  }
  return { allowed: false };
}
```

- [ ] Implement the module.

### 1.4 Tests

`tests/lib/secret-store.test.ts` — mock `keytar` with an in-memory map (inject via `vi.mock`). Use a tempdir for `configDir` (mock `path-safety.configDir` or inject via env). Test:

- Round-trip: storeToken → getToken returns same string; `issuedAt` is ISO string.
- Tampering: flip a byte in the stored payload; getToken throws (GCM auth failure).
- Missing salt.bin: `ensureSalt()` recreates with mode 0600.
- **Loose permissions repair:** `chmodSync(saltPath(), 0o644)` then call `ensureSalt()`; mode returns to 0600 and `permissionRepairEvents` has one entry. Same harness covers `config.json`, `audit.db`, and `exceptions.log` (once present). Every permission-sensitive file is enumerated in a shared `SENSITIVE_FILES` list so future additions don't slip through.
- `evaluateRotation` returns correct status for 10, 80, 95, 125 days ago (`fresh` / `due` / `degraded` / `refuse`).
- `envOverrideAllowed`:
  - `{ NODE_ENV: 'test' }` → allowed (test_mode).
  - `{ CI: 'true' }` → allowed (test_mode).
  - `{ BHG_PIPEDRIVE_BREAK_GLASS: '1' }` alone → not allowed.
  - `{ BHG_PIPEDRIVE_BREAK_GLASS: '1', BHG_PIPEDRIVE_BREAK_GLASS_REASON: '   ' }` → not allowed (empty after trim).
  - `{ BHG_PIPEDRIVE_BREAK_GLASS: '1', BHG_PIPEDRIVE_BREAK_GLASS_REASON: 'rotating' }` → allowed, reason starts `break_glass:`.
  - Legacy `{ BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE: '1' }` alone → not allowed (the flag is retired).

- [ ] Write tests. Run. Fix. Green.

## Task 2: Setup CLI

`src/bin/setup.ts`:

```typescript
#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertConfigDirSafe, configDir } from '../lib/path-safety.js';
import { storeToken, getToken } from '../lib/secret-store.js';
import { PipedriveClient } from '../lib/pipedrive-client.js';
import pino from 'pino';

const args = process.argv.slice(2);
const isRotate = args.includes('--rotate');

async function main() {
  assertConfigDirSafe();
  if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true, mode: 0o700 });

  if (isRotate) {
    const existing = await getToken();
    if (!existing) {
      console.error('No existing token to rotate. Run `npm run setup` (without --rotate).');
      process.exit(1);
    }
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const token = (await rl.question('Paste Pipedrive API token: ')).trim();
  rl.close();

  if (!/^[a-f0-9]{40}$/.test(token)) {
    console.error('Token shape is unexpected. Pipedrive tokens are 40 lowercase hex characters.');
    process.exit(1);
  }

  const logger = pino({ level: 'info' }, pino.destination(2));
  const client = new PipedriveClient(token, logger);
  try {
    const user = await client.validateToken();
    console.log(`Token validated: user ${user.name} (id=${user.id}).`);
  } catch (err) {
    console.error('Token rejected by Pipedrive. Not saved.');
    process.exit(1);
  }

  await storeToken(token);

  const configPath = join(configDir(), 'config.json');
  const nextRotation = new Date(Date.now() + 90 * 86400_000).toISOString();
  writeFileSync(
    configPath,
    JSON.stringify({ setupAt: new Date().toISOString(), nextRotationDue: nextRotation }, null, 2),
    { mode: 0o600 }
  );

  console.log(`Token stored in macOS Keychain. Next rotation due: ${nextRotation.slice(0, 10)}.`);
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
```

- [ ] Implement.

## Task 3: Revoke CLI

`src/bin/revoke.ts`:

```typescript
#!/usr/bin/env node
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, assertConfigDirSafe } from '../lib/path-safety.js';
import { clearToken } from '../lib/secret-store.js';

async function main() {
  assertConfigDirSafe();
  await clearToken();
  const saltP = join(configDir(), 'salt.bin');
  if (existsSync(saltP)) rmSync(saltP);
  const db = join(configDir(), 'audit.db');
  if (existsSync(db)) {
    renameSync(db, join(configDir(), `audit-${Date.now()}.db.archive`));
  }
  console.log('Keychain entry removed; salt deleted; audit.db archived. Rotate or revoke the token in Pipedrive UI now.');
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] Implement.

## Task 4: Wire server startup to Keychain

Edit `src/config.ts`:

```typescript
// Remove: const apiToken = (process.env.PIPEDRIVE_API_TOKEN ?? '').trim();
// config.ts is now sync and does NOT read the token.
// Token resolution moves to index.ts via SecretStore.
```

- [ ] Remove `apiToken` from `parseConfig`'s return and from `ServerConfig`.
- [ ] Update `src/types.ts` `ServerConfig` accordingly.

Edit `src/index.ts`:

```typescript
import { getToken, evaluateRotation, envOverrideAllowed, permissionRepairEvents } from './lib/secret-store.js';

async function main() {
  assertConfigDirSafe();
  assertCwdClean();

  const config = parseConfig();  // no longer includes apiToken

  // --- Token resolution (Keychain first; env override is restricted) ---
  let token: string;
  let issuedAt: string | null = null;
  let envOverrideReason: string | null = null;

  const ov = envOverrideAllowed();
  if (ov.allowed && process.env.PIPEDRIVE_API_TOKEN) {
    token = process.env.PIPEDRIVE_API_TOKEN.trim();
    envOverrideReason = ov.reason ?? null;
    if (envOverrideReason && envOverrideReason.startsWith('break_glass:')) {
      // Loud signal; audit row written after auditLog is initialized.
      process.stderr.write(
        `WARNING: break-glass env override active. Reason: ${envOverrideReason.slice('break_glass:'.length)}\n`
      );
    }
  } else {
    const entry = await getToken();
    if (!entry) {
      console.error('No token in Keychain. Run `npm run setup`.');
      process.exit(1);
    }
    token = entry.token;
    issuedAt = entry.issuedAt;
  }

  // --- Rotation gate (75/90/120) ---
  if (issuedAt) {
    const r = evaluateRotation(issuedAt);
    const staleReason = (process.env.BHG_PIPEDRIVE_STALE_REASON ?? '').trim();
    if (r.status === 'refuse') {
      if (process.env.BHG_PIPEDRIVE_ALLOW_STALE !== '1' || staleReason.length === 0) {
        console.error(
          `Token is ${Math.floor(r.ageDays)} days old (hard-block >= 120d). ` +
          `Run \`npm run setup -- --rotate\`. Override requires BHG_PIPEDRIVE_ALLOW_STALE=1 AND BHG_PIPEDRIVE_STALE_REASON="...".`
        );
        process.exit(1);
      }
      // STALE_TOKEN_EXCEPTION audit row after auditLog init.
    }
    if (r.status === 'due' || r.status === 'degraded') {
      console.error(`Token is ${Math.floor(r.ageDays)} days old. Rotate soon (\`npm run setup -- --rotate\`).`);
    }
  }

  const logger = pino({ level: config.logLevel }, pino.destination(2));
  const client = new PipedriveClient(token, logger);

  // After auditLog init (sec-06), emit:
  //  - PERMISSION_REPAIRED rows for each entry in permissionRepairEvents
  //  - BREAK_GLASS_ENV_OVERRIDE row if envOverrideReason starts with 'break_glass:'
  //  - STALE_TOKEN_EXCEPTION row if we passed the rotation gate via override
  // and also append to exceptions.log where applicable.
}
```

- [ ] Implement.
- [ ] Ensure the token is never logged. (Sec-04 adds the Pino redact filter; for now just keep the value out of `logger.info()` calls.)

## Task 4b: Claude Desktop config probe

`src/lib/claude-desktop-probe.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATHS = [
  join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json'),
  // Windows / Linux candidates added later if cross-platform support is added.
];

export interface ProbeFinding {
  path: string;
  servers: string[];  // names of servers with PIPEDRIVE_API_TOKEN in env block
}

export function probeClaudeDesktopConfig(): ProbeFinding | null {
  for (const p of CONFIG_PATHS) {
    if (!existsSync(p)) continue;
    let cfg: any;
    try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const servers = cfg?.mcpServers ?? {};
    const hits: string[] = [];
    for (const [name, srv] of Object.entries(servers)) {
      const env = (srv as any)?.env ?? {};
      if ('PIPEDRIVE_API_TOKEN' in env) hits.push(name);
    }
    if (hits.length > 0) return { path: p, servers: hits };
  }
  return null;
}
```

Wire into `src/index.ts`:

```typescript
import { probeClaudeDesktopConfig } from './lib/claude-desktop-probe.js';

// After auditLog init:
const probe = probeClaudeDesktopConfig();
if (probe) {
  const msg = `WARNING: Claude Desktop config ${probe.path} has PIPEDRIVE_API_TOKEN in env block(s): ${probe.servers.join(', ')}. Remove the env block — this server reads the token from Keychain.`;
  process.stderr.write(msg + '\n');
  auditLog.insert({
    tool: '_claude_desktop_probe', category: 'update', entity_type: null, entity_id: null,
    status: 'failure', reason_code: 'CLAUDE_DESKTOP_TOKEN_IN_CONFIG',
    request_hash: '', target_summary: probe.path, diff_summary: `servers=${probe.servers.join(',')}`,
    idempotency_key: null,
  });
}
```

Test `tests/lib/claude-desktop-probe.test.ts`:
- No file → returns null.
- File with no `PIPEDRIVE_API_TOKEN` → returns null.
- File with one server having the token → returns one hit.
- Multiple hits aggregate into one finding.

- [ ] Implement.

## Task 5: ACL probe

Run this manually and record the result in `docs/superpowers/specs/2026-04-24-api-key-security-design.md` as a new appendix or in a comment at the top of `secret-store.ts`:

```bash
# From a separate shell, as the same user:
security find-generic-password -s bhg-pipedrive-mcp -w
```

If this prints the ciphertext without a prompt for keychain unlock / ACL allow, note: "Keychain ACL does not constrain to this script — encryption wrapper is the live control." (This is the expected result for a Node interpreter.)

- [ ] Probe and document.

## Task 6: Commit

```bash
git add src/lib/secret-store.ts src/lib/claude-desktop-probe.ts src/bin/setup.ts src/bin/revoke.ts \
        src/config.ts src/types.ts src/index.ts \
        tests/lib/secret-store.test.ts tests/lib/claude-desktop-probe.test.ts
git commit -m "feat(security): Keychain-backed store, restricted env override, rotation 75/90/120, perm enforcement, Claude Desktop probe"
```

---

**Done when:** `npm run setup` stores a token end-to-end; a fresh `npm start` reads the token from Keychain without any env var; running with `BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE=1` **alone** ignores the env var (the flag is retired); `NODE_ENV=test` or `CI=true` or break-glass-with-reason allows env override; rotation status `fresh`/`due`/`degraded`/`refuse` mapped correctly; `salt.bin` loose-perms repaired with an audit event; Claude Desktop config probe emits a warning when a hardcoded token is detected; `npm run revoke` wipes Keychain + salt + archives audit DB; ACL probe result documented; round-trip and tamper tests pass.

---

## Implementation Status

**Shipped:** commit `a67d930` on `security/api-key-hardening`. As-spec.

**Token rotation event:** the previous Pipedrive API token had been replicating to OneDrive via the synced project folder and was treated as leaked. New token issued 2026-04-25 and stored encrypted in macOS Keychain. The project was relocated out of OneDrive to `~/Documents/Apps/Pipedrive_MCP/` on the same date.
