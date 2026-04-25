# Part sec-06: Hash-Chained Audit Log

> Part 6 of 9.
> **Depends on:** sec-02 (path safety), sec-05 (version ID).
> **Produces:** `src/lib/audit-log.ts`, `src/lib/audit-middleware.ts`, `src/bin/audit-verify.ts`, `tests/lib/audit-log.test.ts`, updated `src/server.ts` tool registration, safe-degraded mode plumbing.

Implements spec §10.

---

## Task 1: SQLite schema + library

Dependency is `better-sqlite3` (synchronous API; fine for audit writes).

`src/lib/audit-log.ts`:

```typescript
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { configDir, assertPathSafe } from './path-safety.js';
import { VERSION_ID, versionString, POLICY_HASH } from './version-id.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_rows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  tool            TEXT NOT NULL,
  category        TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  status          TEXT NOT NULL,
  reason_code     TEXT,
  request_hash    TEXT NOT NULL,
  target_summary  TEXT,
  diff_summary    TEXT,
  idempotency_key TEXT,
  correlation_id  TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  policy_hash     TEXT NOT NULL,
  previous_hash   TEXT NOT NULL,
  row_hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ts ON audit_rows(ts);
`;

function canonicalize(row: Omit<AuditRow, 'row_hash'>): string {
  return [
    row.previous_hash,
    row.ts,
    row.tool,
    row.category,
    row.entity_type ?? '',
    row.entity_id ?? '',
    row.status,
    row.reason_code ?? '',
    row.request_hash,
    row.target_summary ?? '',
    row.diff_summary ?? '',
    row.idempotency_key ?? '',
    row.correlation_id,
    row.version_id,
    row.policy_hash,
  ].join('\n');
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export type AuditCategory =
  | 'create' | 'update' | 'delete'
  | 'read_budget' | 'broad_query' | 'policy' | 'kill_switch' | 'break_glass';

export type AuditStatus =
  | 'success' | 'failure' | 'rejected' | 'safe_degraded_rejected';

export interface AuditRow {
  id?: number;
  ts: string;
  tool: string;
  category: AuditCategory;
  entity_type: string | null;
  entity_id: string | null;
  status: AuditStatus;
  reason_code: string | null;
  request_hash: string;
  target_summary: string | null;
  diff_summary: string | null;
  idempotency_key: string | null;
  correlation_id: string;
  version_id: string;
  policy_hash: string;
  previous_hash: string;
  row_hash: string;
}

export type InsertInput =
  Omit<AuditRow, 'id' | 'ts' | 'version_id' | 'policy_hash' | 'previous_hash' | 'row_hash' | 'correlation_id'>
  & { correlation_id?: string };

export class AuditLog {
  private db: Database.Database;

  constructor(dbPath: string = join(configDir(), 'audit.db')) {
    assertPathSafe(dbPath, { purpose: 'audit-db' });
    if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  private lastHash(): string {
    const row = this.db.prepare('SELECT row_hash FROM audit_rows ORDER BY id DESC LIMIT 1').get() as { row_hash: string } | undefined;
    if (row) return row.row_hash;
    return hash('GENESIS|' + versionString());
  }

  insert(input: InsertInput): AuditRow {
    const ts = new Date().toISOString();
    const correlation_id = input.correlation_id ?? randomUUID();
    const previous_hash = this.lastHash();
    const row_no_hash: Omit<AuditRow, 'row_hash'> = {
      ts,
      tool: input.tool,
      category: input.category,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      status: input.status,
      reason_code: input.reason_code,
      request_hash: input.request_hash,
      target_summary: input.target_summary,
      diff_summary: input.diff_summary,
      idempotency_key: input.idempotency_key,
      correlation_id,
      version_id: versionString(),
      policy_hash: POLICY_HASH,  // imported from version-id.js; emitted in every row
      previous_hash,
    };
    const row_hash = hash(canonicalize(row_no_hash));
    this.db.prepare(`
      INSERT INTO audit_rows (
        ts, tool, category, entity_type, entity_id, status, reason_code,
        request_hash, target_summary, diff_summary,
        idempotency_key, correlation_id, version_id, policy_hash, previous_hash, row_hash
      ) VALUES (
        @ts, @tool, @category, @entity_type, @entity_id, @status, @reason_code,
        @request_hash, @target_summary, @diff_summary,
        @idempotency_key, @correlation_id, @version_id, @policy_hash, @previous_hash, @row_hash
      )
    `).run({ ...row_no_hash, row_hash });
    return { ...row_no_hash, row_hash };
  }

  verifyChain(): { ok: true } | { ok: false; breakAtId: number } {
    const rows = this.db.prepare('SELECT * FROM audit_rows ORDER BY id ASC').all() as AuditRow[];
    let expected = hash('GENESIS|' + versionString());
    for (const row of rows) {
      if (row.previous_hash !== expected) return { ok: false, breakAtId: row.id! };
      const recomputed = hash(canonicalize(row));
      if (recomputed !== row.row_hash) return { ok: false, breakAtId: row.id! };
      expected = row.row_hash;
    }
    return { ok: true };
  }

  close() { this.db.close(); }
}
```

**Note:** `lastHash()` / `verifyChain()` both use `versionString()` for the genesis marker. This means if the version changes between runs, the genesis marker changes too — which would break the chain across builds. Fix: genesis marker uses a fixed string (`'GENESIS'`) and the version ID travels in each row. Update both functions accordingly:

```typescript
const GENESIS = hash('GENESIS');
// …
private lastHash(): string {
  const row = this.db.prepare('SELECT row_hash FROM audit_rows ORDER BY id DESC LIMIT 1').get() as { row_hash: string } | undefined;
  return row?.row_hash ?? GENESIS;
}
// and in verifyChain:
let expected = GENESIS;
```

- [ ] Implement with the corrected genesis marker.

## Task 2: Tests

`tests/lib/audit-log.test.ts`:

- Round-trip insert; verify chain passes.
- Insert 5 rows; verify chain passes.
- Tamper: update `row_hash` of row 3 directly; verifyChain returns `{ ok: false, breakAtId: 3 }`.
- Tamper: update `entity_id` of row 3 directly (row_hash no longer matches canonical); verifyChain returns break at 3.
- Tamper: update `target_summary` of row 3 (new audit field); verifyChain returns break at 3.
- Delete row 4 (direct SQL); row 5's `previous_hash` no longer matches row 4's `row_hash` → break at 5.
- Verify each stored row's `version_id` matches the current `versionString()` and each row's `policy_hash` equals `POLICY_HASH`.

Use a tempfile for `dbPath`.

- [ ] Write and run. Green.

## Task 3: `auditWrite` middleware

`src/lib/audit-middleware.ts`:

```typescript
import type { AuditLog } from './audit-log.js';
import { randomUUID } from 'node:crypto';

type WriteCategory = 'create' | 'update' | 'delete';

export interface AuditMiddlewareOptions {
  auditLog: AuditLog;
  safeDegraded: { value: boolean };  // shared by reference — flipped by startup on chain break
  tool: string;
  category: WriteCategory;
  entityType: string;
  // Caller derives entity_id and reason_code from the handler's result.
  extractEntityId?: (result: unknown) => string | null;
}

export function auditWrite<TParams, TResult>(
  opts: AuditMiddlewareOptions,
  handler: (params: TParams) => Promise<TResult>
): (params: TParams) => Promise<TResult | { error: true; code: 503; message: string }> {
  return async (params: TParams) => {
    if (opts.safeDegraded.value) {
      opts.auditLog.insert({
        tool: opts.tool,
        category: opts.category,
        entity_type: opts.entityType,
        entity_id: null,
        status: 'safe_degraded_rejected',
        reason_code: 'AUDIT_CHAIN_BROKEN',
        idempotency_key: null,
      });
      return { error: true, code: 503, message: 'Audit chain integrity failure — writes disabled. Contact owner.' };
    }
    const correlation_id = randomUUID();
    try {
      const result = await handler(params);
      const entity_id = opts.extractEntityId ? opts.extractEntityId(result) : null;
      const isError = typeof result === 'object' && result !== null && (result as { error?: boolean }).error === true;
      opts.auditLog.insert({
        tool: opts.tool,
        category: opts.category,
        entity_type: opts.entityType,
        entity_id,
        status: isError ? 'failure' : 'success',
        reason_code: isError ? ((result as { code?: number | string }).code?.toString() ?? 'API_ERROR') : null,
        idempotency_key: null,
        correlation_id,
      });
      return result;
    } catch (err) {
      opts.auditLog.insert({
        tool: opts.tool,
        category: opts.category,
        entity_type: opts.entityType,
        entity_id: null,
        status: 'failure',
        reason_code: 'EXCEPTION',
        idempotency_key: null,
        correlation_id,
      });
      throw err;
    }
  };
}
```

- [ ] Implement.

## Task 3b: `buildTargetSummary` + `buildDiffSummary` + `requestHash`

Each write tool gains two tiny helpers (co-located with the tool file) that the `auditWrite` middleware calls:

```typescript
// e.g. in src/tools/deals.ts
export function dealTargetSummary(params: Record<string, unknown>, resolved?: { title?: string; pipeline?: string; status?: string }): string {
  const id = params.id ?? params.deal_id ?? '?';
  const bits: string[] = [`deal:${id}`];
  if (resolved?.title) bits.push(`'${resolved.title}'`);
  if (resolved?.pipeline) bits.push(`pipeline:${resolved.pipeline}`);
  if (resolved?.status) bits.push(`status:${resolved.status}`);
  return bits.join(' ');
}

export function dealDiffSummary(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const scalars = ['title', 'status', 'stage_id', 'pipeline_id', 'value', 'owner_id'];
  const parts: string[] = [];
  for (const k of scalars) {
    if (before[k] !== after[k]) parts.push(`${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`);
  }
  return parts.join(' | ') || '(no scalar change)';
}
```

`requestHash` is shared in `src/lib/audit-middleware.ts`:

```typescript
import { createHash } from 'node:crypto';

const PII_KEYS = new Set(['content', 'note', 'description', 'email', 'phone']);

export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (PII_KEYS.has(k) && typeof v === 'string') {
      out[k] = { hash: createHash('sha256').update(v).digest('hex').slice(0, 16) };
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = sanitizeParams(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function canonicalJson(v: unknown): string { /* same sorted-keys canonical as elsewhere */ }

export function requestHash(tool: string, params: Record<string, unknown>): string {
  return createHash('sha256').update(tool + '\n' + canonicalJson(sanitizeParams(params))).digest('hex');
}
```

Add unit tests:
- `sanitizeParams` replaces PII fields with `{ hash }` deterministically.
- `requestHash` is stable across key order and unchanged params.

- [ ] Implement.

## Task 4: Wire into `src/server.ts`

`createServer` already receives `config`, `client`, `resolver`, `entityResolver`, `logger`. Add `auditLog` and `safeDegradedRef` parameters. For every write-category tool (create/update/delete), wrap the handler with `requestHash` + `target_summary` + `diff_summary` computed inside the middleware:

```typescript
import { AuditLog } from './lib/audit-log.js';
import { auditWrite } from './lib/audit-middleware.js';

// Example for create-deal — repeat the pattern for every create/update/delete tool.
const handler = auditWrite(
  {
    auditLog,
    safeDegraded: safeDegradedRef,
    tool: 'create-deal',
    category: 'create',
    entityType: 'deal',
    extractEntityId: (result) => (result as { id?: number })?.id?.toString() ?? null,
  },
  originalCreateDealHandler
);
```

- [ ] Enumerate every write tool from `src/tools/*.ts` (deals, persons, organizations, activities, notes — create/update/delete only). Wrap.
- [ ] Read-category tools are **not** wrapped.

## Task 4b: Verification schedule

`AuditLog` exposes two verification helpers:

```typescript
verifyChain(): { ok: true } | { ok: false; breakAtId: number }
  // Full walk from row 1 to end. Used at startup and by the idle re-verify job.

verifyTail(n: number = 100): { ok: true } | { ok: false; breakAtId: number }
  // Walks only the last N rows (chain built from the row immediately before them).
  // Used by the 60s hot-check. Does NOT catch modifications to older rows made
  // after startup — those are caught at next startup or by the idle re-verify.
```

Idle re-verify scheduler (in `src/index.ts` after server connect):

```typescript
let lastActivity = Date.now();
server.on('request', () => { lastActivity = Date.now(); });  // or wrap tool dispatch

setInterval(() => {
  if (safeDegradedRef.value) return;
  if (Date.now() - lastActivity < 30_000) return;  // not idle enough
  const result = auditLog.verifyChain();  // full
  if (!result.ok) {
    safeDegradedRef.value = true;
    safeDegradedRef.reason = 'AUDIT_CHAIN_BROKEN_IDLE_VERIFY';
    logger.error({ breakAtId: result.breakAtId }, 'AUDIT_CHAIN_BROKEN — idle re-verify detected post-startup tampering');
  }
}, 15 * 60_000).unref();  // every 15 minutes when idle
```

Hot-check (existing 60s timer) switches to `verifyTail(100)`.

- [ ] Implement both methods + idle scheduler. Add a unit test that tampers with row 2 after `verifyChain()` has been run once and asserts `verifyTail(100)` does not catch it but a follow-up `verifyChain()` does.

## Task 5: Startup wiring in `index.ts` + read-side warning prefix

```typescript
import { AuditLog } from './lib/audit-log.js';

// ... after logger init:
const auditLog = new AuditLog();
const verification = auditLog.verifyChain();
const safeDegradedRef = { value: false, reason: null as string | null };
if (!verification.ok) {
  // Emit to stderr only — NOT to the tampered DB.
  logger.error({ breakAtId: verification.breakAtId }, 'AUDIT_CHAIN_BROKEN — entering safe-degraded mode.');
  safeDegradedRef.value = true;
  safeDegradedRef.reason = 'AUDIT_CHAIN_BROKEN';
}

const server = createServer(config, client, resolver, entityResolver, logger, auditLog, safeDegradedRef);
```

Read-side warning prefix: add a helper `src/lib/safe-degraded-decorator.ts`:

```typescript
export function decorateReadResponse<T>(result: T, safeDegradedRef: { value: boolean; reason: string | null }): T | (T & { _security_notice: unknown }) {
  if (!safeDegradedRef.value) return result;
  if (result && typeof result === 'object') {
    return {
      _security_notice: { severity: 'high', message: `Audit integrity failure (${safeDegradedRef.reason}). Results may have been shaped by a compromised process. Investigate before acting.` },
      ...(result as object),
    } as T & { _security_notice: unknown };
  }
  return result;
}
```

Wrap every read-tool handler's response through `decorateReadResponse` before returning.

- [ ] Update.

## Task 6: `audit-verify` CLI

Replace `src/bin/audit-verify.ts` stub:

```typescript
#!/usr/bin/env node
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from '../lib/audit-log.js';
import { configDir } from '../lib/path-safety.js';

const acknowledgeAndReset = process.argv.includes('--acknowledge-and-reset');
const dbPath = join(configDir(), 'audit.db');

const auditLog = new AuditLog(dbPath);
const result = auditLog.verifyChain();
auditLog.close();

if (result.ok) {
  console.log('Audit chain verified — OK.');
  process.exit(0);
}

console.error(`Audit chain broken at row id ${result.breakAtId}.`);

if (!acknowledgeAndReset) {
  console.error('To acknowledge and reset: npm run audit-verify -- --acknowledge-and-reset');
  process.exit(1);
}

// Archive and reset.
if (existsSync(dbPath)) {
  const archive = `${dbPath}.broken-${Date.now()}.archive`;
  renameSync(dbPath, archive);
  console.error(`Archived broken DB to ${archive}.`);
}

// Fresh DB — emit CHAIN_RESET row.
const fresh = new AuditLog(dbPath);
fresh.insert({
  tool: '_audit', category: 'update', entity_type: null, entity_id: null,
  status: 'success', reason_code: 'CHAIN_RESET',
  request_hash: '', target_summary: `reset from broken chain at row ${result.breakAtId}`,
  diff_summary: null, idempotency_key: null,
});
fresh.close();
console.log('Fresh audit chain started with CHAIN_RESET row.');
```

- [ ] Replace.

## Task 7: Commit

```bash
git add src/lib/audit-log.ts src/lib/audit-middleware.ts src/bin/audit-verify.ts \
        src/server.ts src/index.ts tests/lib/audit-log.test.ts
git commit -m "feat(security): hash-chained SQLite audit log with safe-degraded mode"
```

---

**Done when:** writes produce audit rows; `npm run audit-verify` passes on a freshly populated DB; direct SQL tampering causes verification failure and next startup enters safe-degraded mode (writes rejected with 503, reads unaffected); tests cover all tamper patterns.
