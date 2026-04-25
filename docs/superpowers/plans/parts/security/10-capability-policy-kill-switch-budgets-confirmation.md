# Part sec-10: Capability Policy, Kill Switch, Read Budgets, Typed Destructive Confirmation

> Part 10 of the security hardening plan (revised for v1.2).
> **Depends on:** sec-05 (VERSION_ID + POLICY_HASH), sec-06 (audit log).
> **Produces:** `capabilities.json`, `src/lib/capability-policy.ts`, `src/lib/kill-switch.ts`, `src/bin/kill-switch.ts`, `src/lib/read-budget.ts`, `src/lib/typed-confirmation.ts`, middleware wiring in `src/server.ts`, updated `src/lib/audit-middleware.ts`, corresponding unit tests.

Implements spec §§11–14. This is the largest behavioral change in the plan — split the work into four sub-tasks below.

**Key framing (spec v1.2):** typed confirmations and broad-query confirmations are **friction + audit**, not authorization or proof of user intent. A prompt-injected model can echo any string. The real controls are: the budget (reads), the kill switch (writes), and the audit trail (both). The `user_chat_message` requirement for high-risk deletes makes fabrication visible in the audit log without claiming to prevent it.

---

## Task A: `capabilities.json` + `CapabilityPolicy` module + hash attestation

### A.1 Author `capabilities.json` at repo root

Enumerate all 31 tools. Template:

```json
{
  "version": "1.0.0",
  "writes_enabled_default": true,
  "tools": {
    "list-deals":            { "enabled": true, "category": "read",   "max_page_size": 100 },
    "get-deal":              { "enabled": true, "category": "read" },
    "search-deals":          { "enabled": true, "category": "read",   "max_page_size": 100 },
    "create-deal":           { "enabled": true, "category": "create", "destructive": false },
    "update-deal":           { "enabled": true, "category": "update", "destructive": false,
                               "destructive_updates": ["status", "value", "pipeline_id", "owner_id"] },
    "delete-deal":           { "enabled": true, "category": "delete", "destructive": true,
                               "confirmation_format": "DELETE-DEAL:<id>",
                               "prefer_soft_delete_hint": "status=lost" },
    "list-persons":          { "enabled": true, "category": "read",   "max_page_size": 100 },
    "get-person":            { "enabled": true, "category": "read" },
    "search-persons":        { "enabled": true, "category": "read",   "max_page_size": 100 },
    "create-person":         { "enabled": true, "category": "create", "destructive": false },
    "update-person":         { "enabled": true, "category": "update", "destructive": false,
                               "destructive_updates": ["owner_id"] },
    "delete-person":         { "enabled": true, "category": "delete", "destructive": true,
                               "confirmation_format": "DELETE-PERSON:<id>" },
    "list-organizations":    { "enabled": true, "category": "read",   "max_page_size": 100 },
    "get-organization":      { "enabled": true, "category": "read" },
    "search-organizations":  { "enabled": true, "category": "read",   "max_page_size": 100 },
    "create-organization":   { "enabled": true, "category": "create" },
    "update-organization":   { "enabled": true, "category": "update",
                               "destructive_updates": ["owner_id"] },
    "list-activities":       { "enabled": true, "category": "read",   "max_page_size": 100 },
    "get-activity":          { "enabled": true, "category": "read" },
    "create-activity":       { "enabled": true, "category": "create" },
    "update-activity":       { "enabled": true, "category": "update" },
    "delete-activity":       { "enabled": true, "category": "delete", "destructive": true,
                               "confirmation_format": "DELETE-ACTIVITY:<id>" },
    "list-notes":            { "enabled": true, "category": "read",   "max_page_size": 100 },
    "get-note":              { "enabled": true, "category": "read" },
    "create-note":           { "enabled": true, "category": "create" },
    "update-note":           { "enabled": true, "category": "update" },
    "delete-note":           { "enabled": true, "category": "delete", "destructive": true,
                               "confirmation_format": "DELETE-NOTE:<id>" },
    "list-pipelines":        { "enabled": true, "category": "read" },
    "list-stages":           { "enabled": true, "category": "read" },
    "list-users":            { "enabled": true, "category": "read" },
    "get-fields":            { "enabled": true, "category": "read" },
    "get-practice-pipeline": { "enabled": true, "category": "read" }
  },
  "read_budgets": {
    "max_records_per_session": 2000,
    "max_bytes_per_session":   2097152,
    "max_pagination_depth":    20,
    "broad_query_confirmation": true,
    "broad_query_confirmation_format": "BROAD-READ:<tool>"
  },
  "bulk_detector": {
    "window_seconds": 60,
    "threshold": 10,
    "confirmation_format": "BULK:<count>"
  }
}
```

- [ ] Commit `capabilities.json`.

### A.2 Extend `scripts/embed-version.mjs`

Append to the generator (sec-05) so it also computes `POLICY_HASH`:

```javascript
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

const policyJson = JSON.parse(readFileSync('capabilities.json', 'utf8'));
const policyHash = createHash('sha256').update(canonicalJson(policyJson)).digest('hex');

// Append to the generated version-id.ts body:
const body =
`// generated by scripts/embed-version.mjs — do not edit
export const VERSION_ID = Object.freeze({
  sha: ${JSON.stringify(sha)},
  ts: ${JSON.stringify(ts)},
  dirty: ${dirty},
});
export const POLICY_HASH = ${JSON.stringify(policyHash)};
export const POLICY_VERSION = ${JSON.stringify(policyJson.version)};
export function versionString() {
  return VERSION_ID.sha.slice(0, 12) + '@' + VERSION_ID.ts + (VERSION_ID.dirty ? '-dirty' : '');
}
`;
```

- [ ] Update. Rebuild. Confirm `POLICY_HASH` appears in `src/lib/version-id.ts`.

### A.3 `CapabilityPolicy` module

`src/lib/capability-policy.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { POLICY_HASH } from './version-id.js';

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
}

export interface CapabilityPolicy {
  version: string;
  writes_enabled_default: boolean;
  tools: Record<string, ToolPolicy>;
  read_budgets: ReadBudgetPolicy;
  bulk_detector: BulkDetectorPolicy;
}

export interface ToolPolicy {
  enabled: boolean;
  category: 'read' | 'create' | 'update' | 'delete';
  destructive?: boolean;
  confirmation_format?: string;
  destructive_updates?: string[];
  max_page_size?: number;
  prefer_soft_delete_hint?: string;
}

export interface ReadBudgetPolicy {
  max_records_per_session: number;
  max_bytes_per_session: number;
  max_pagination_depth: number;
  broad_query_confirmation: boolean;
  broad_query_confirmation_format: string;
}

export interface BulkDetectorPolicy {
  window_seconds: number;
  threshold: number;
  confirmation_format: string;
}

export class PolicyHashMismatchError extends Error {
  constructor(public expected: string, public got: string) {
    super(`Capability policy hash mismatch. expected=${expected} got=${got}`);
    this.name = 'PolicyHashMismatchError';
  }
}

export function loadPolicy(path = 'capabilities.json'): CapabilityPolicy {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as CapabilityPolicy;
  const hash = createHash('sha256').update(canonicalJson(parsed)).digest('hex');
  if (hash !== POLICY_HASH) {
    throw new PolicyHashMismatchError(POLICY_HASH, hash);
  }
  return parsed;
}

export function recomputeHash(path = 'capabilities.json'): string {
  const raw = readFileSync(path, 'utf8');
  return createHash('sha256').update(canonicalJson(JSON.parse(raw))).digest('hex');
}
```

### A.4 Wire into startup + hot-check

Spec v1.2 clarified behavior:
- **Startup mismatch → exit 1** (no safe-degraded; operator intervention required before server starts).
- **Runtime mismatch (60s hot-check) → safe-degraded** (don't abruptly exit a running user session).

In `src/index.ts`:

```typescript
import { loadPolicy, recomputeHash, PolicyHashMismatchError } from './lib/capability-policy.js';
import { POLICY_HASH } from './lib/version-id.js';

let policy;
try {
  policy = loadPolicy();
} catch (err) {
  if (err instanceof PolicyHashMismatchError) {
    // Audit row first (so the event is durable), then exit.
    auditLog.insert({
      tool: '_startup', category: 'policy', entity_type: null, entity_id: null,
      status: 'failure', reason_code: 'POLICY_HASH_MISMATCH_STARTUP',
      request_hash: '', target_summary: `expected=${err.expected} got=${err.got}`,
      diff_summary: null, idempotency_key: null,
    });
    logger.fatal({ expected: err.expected, got: err.got },
      'POLICY_HASH_MISMATCH_STARTUP — refusing to start. Rebuild from clean source or investigate tampering.');
    process.exit(1);
  }
  throw err;
}

// Hot-check every 60s — runtime mismatch flips safe-degraded; does NOT exit.
const hotCheck = setInterval(() => {
  if (safeDegradedRef.value) return; // already flipped
  try {
    const got = recomputeHash();
    if (got !== POLICY_HASH) {
      safeDegradedRef.value = true;
      safeDegradedRef.reason = 'POLICY_HASH_MISMATCH_RUNTIME';
      logger.error({ expected: POLICY_HASH, got }, 'POLICY_HASH_MISMATCH_RUNTIME');
      auditLog.insert({
        tool: '_hot_check', category: 'policy', entity_type: null, entity_id: null,
        status: 'safe_degraded_rejected', reason_code: 'POLICY_HASH_MISMATCH_RUNTIME',
        request_hash: '', target_summary: `expected=${POLICY_HASH} got=${got}`,
        diff_summary: null, idempotency_key: null,
      });
    }
  } catch (err) {
    logger.error({ err }, 'policy hot-check failed');
  }
}, 60_000);
hotCheck.unref();
```

### A.5 Tests

`tests/lib/capability-policy.test.ts`:
- loadPolicy with matching hash returns policy.
- loadPolicy with mutated file throws `PolicyHashMismatchError`.
- `recomputeHash` over canonical form stable across key-order permutations of source.

- [ ] Implement all of Task A. Unit tests green.

---

## Task B: Kill Switch

### B.1 `src/lib/kill-switch.ts`

```typescript
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './path-safety.js';

interface ConfigJson {
  setupAt?: string;
  nextRotationDue?: string;
  writes_enabled?: boolean;
}

export class KillSwitch {
  private _writesEnabled: boolean;
  private path: string;

  constructor() {
    this.path = join(configDir(), 'config.json');
    const cfg = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as ConfigJson)
      : {};
    this._writesEnabled = cfg.writes_enabled ?? true;
  }

  get writesEnabled(): boolean { return this._writesEnabled; }

  setWritesEnabled(enabled: boolean): void {
    this._writesEnabled = enabled;
    const cfg: ConfigJson = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : {};
    cfg.writes_enabled = enabled;
    writeFileSync(this.path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
}
```

### B.2 `src/bin/kill-switch.ts`

```typescript
#!/usr/bin/env node
import { KillSwitch } from '../lib/kill-switch.js';
import { AuditLog } from '../lib/audit-log.js';
import { assertConfigDirSafe } from '../lib/path-safety.js';

const args = process.argv.slice(2);
const off = args.includes('--off');
const on = args.includes('--on');
const reasonIdx = args.indexOf('--reason');
const reason = reasonIdx >= 0 ? args[reasonIdx + 1] ?? '' : '';

if ((off && on) || (!off && !on)) {
  console.error('Use exactly one of --off or --on. Optional: --reason "text".');
  process.exit(1);
}

assertConfigDirSafe();
const ks = new KillSwitch();
const before = ks.writesEnabled;
ks.setWritesEnabled(!off);
const after = ks.writesEnabled;

const auditLog = new AuditLog();
auditLog.insert({
  tool: '_kill_switch', category: 'update', entity_type: null, entity_id: null,
  status: 'success', reason_code: before === after ? 'KILL_SWITCH_NO_CHANGE' : 'KILL_SWITCH_FLIP',
  request_hash: '', target_summary: `writes_enabled: ${before} -> ${after}`,
  diff_summary: `reason: ${reason || '(none)'}`,
  idempotency_key: null,
});

console.log(`writes_enabled: ${before} -> ${after}${reason ? ` (reason: ${reason})` : ''}`);
```

### B.3 Tests

`tests/lib/kill-switch.test.ts`:
- Default `writesEnabled = true` when no config.json.
- `setWritesEnabled(false)` persists; a new `KillSwitch()` reads it.
- Mode of written `config.json` is 0600.

### B.4 Middleware wiring

Add to `src/lib/audit-middleware.ts`'s `auditWrite`:

```typescript
if (opts.killSwitch && !opts.killSwitch.writesEnabled) {
  opts.auditLog.insert({
    tool: opts.tool, category: opts.category, entity_type: opts.entityType, entity_id: null,
    status: 'rejected', reason_code: 'WRITES_DISABLED',
    request_hash: '', target_summary: null, diff_summary: null, idempotency_key: null,
  });
  return { error: true, code: 503, reason: 'WRITES_DISABLED', message: 'Writes are currently disabled. Re-enable via `npm run kill-switch -- --on`.' } as TResult;
}
```

- [ ] Implement Task B. Tests green.

---

## Task C: Session Read Budgets + Broad-Query Confirmation

### C.1 `src/lib/read-budget.ts`

```typescript
import type { ReadBudgetPolicy } from './capability-policy.js';

export class ReadBudget {
  private records = 0;
  private bytes = 0;
  private depthByTool = new Map<string, number>();
  private broadConfirmedThisSession = new Set<string>();

  constructor(private policy: ReadBudgetPolicy) {}

  add(tool: string, newRecords: number, newBytes: number, incrementDepth: boolean): void {
    this.records += newRecords;
    this.bytes += newBytes;
    if (incrementDepth) {
      this.depthByTool.set(tool, (this.depthByTool.get(tool) ?? 0) + 1);
    }
  }

  checkRecords(): { ok: boolean; reason?: string } {
    if (this.records >= this.policy.max_records_per_session)
      return { ok: false, reason: 'SESSION_READ_BUDGET_RECORDS_EXCEEDED' };
    return { ok: true };
  }
  checkBytes(): { ok: boolean; reason?: string } {
    if (this.bytes >= this.policy.max_bytes_per_session)
      return { ok: false, reason: 'SESSION_READ_BUDGET_BYTES_EXCEEDED' };
    return { ok: true };
  }
  checkPagination(tool: string): { ok: boolean; reason?: string } {
    const d = this.depthByTool.get(tool) ?? 0;
    if (d >= this.policy.max_pagination_depth)
      return { ok: false, reason: 'PAGINATION_DEPTH_EXCEEDED' };
    return { ok: true };
  }

  // Broad-query detection: unfiltered list* calls or empty/single-char search* queries.
  isBroadQuery(tool: string, params: Record<string, unknown>): boolean {
    if (tool.startsWith('search-')) {
      const q = (params.query as string | undefined)?.trim() ?? '';
      return q.length < 2;
    }
    if (tool.startsWith('list-')) {
      const filterKeys = ['owner', 'owner_id', 'pipeline', 'pipeline_id', 'stage', 'stage_id',
        'status', 'updated_since', 'org', 'organization_id', 'person', 'person_id', 'type'];
      return !filterKeys.some(k => params[k] !== undefined && params[k] !== '');
    }
    return false;
  }

  needsBroadConfirmation(tool: string, params: Record<string, unknown>, confirm: string | undefined): { ok: true } | { ok: false; required: string } {
    if (!this.policy.broad_query_confirmation) return { ok: true };
    if (!this.isBroadQuery(tool, params)) return { ok: true };
    const required = this.policy.broad_query_confirmation_format.replace('<tool>', tool);
    if (confirm === required) {
      this.broadConfirmedThisSession.add(tool);
      return { ok: true };
    }
    if (this.broadConfirmedThisSession.has(tool)) return { ok: true };
    return { ok: false, required };
  }
}
```

### C.2 Wire reads

In `src/server.ts`, wrap every read-tool handler:

```typescript
async function readHandler(params) {
  // 1. Broad-query confirmation
  const confirm = typeof params.confirm === 'string' ? params.confirm : undefined;
  const broad = readBudget.needsBroadConfirmation(toolName, params, confirm);
  if (!broad.ok) {
    auditLog.insert({ tool: toolName, category: 'read_budget', /* … */ reason_code: 'BROAD_READ_CONFIRMATION_REQUIRED', /* … */ });
    return { error: true, code: 428, reason: 'BROAD_READ_CONFIRMATION_REQUIRED', required_confirmation: broad.required };
  }
  // 2. Budget pre-checks
  const rec = readBudget.checkRecords(); if (!rec.ok) return budgetError(rec);
  const byt = readBudget.checkBytes();   if (!byt.ok) return budgetError(byt);
  const pag = readBudget.checkPagination(toolName); if (!pag.ok) return budgetError(pag);

  // 3. Run original handler
  const result = await originalHandler(params);

  // 4. Post-accounting (records + bytes)
  if (result && Array.isArray((result as any).items)) {
    const n = (result as any).items.length;
    const b = Buffer.byteLength(JSON.stringify((result as any).items));
    readBudget.add(toolName, n, b, params.cursor !== undefined || params.start !== undefined);
  }
  return result;
}
```

Note: "session" in stdio mode is the process lifetime; the `ReadBudget` instance lives as long as the server. For SSE (future), one per client connection.

### C.3 Tests

`tests/lib/read-budget.test.ts`:
- Records counter blocks at limit.
- Bytes counter blocks at limit.
- Pagination depth per tool — `list-deals` depth limited independent from `list-persons`.
- `isBroadQuery`: `list-deals` with no params → true; with `{ owner: 'X' }` → false; `search-deals` with `''` → true; with `'abc'` → false.
- Once broad confirmed, subsequent calls to the same tool pass without re-confirm (within session).

- [ ] Implement Task C. Tests green.

---

## Task D: Typed Destructive Confirmation

### D.1 `src/lib/typed-confirmation.ts`

**Framing reminder:** This is **friction + audit**, not proof of user intent. The `user_chat_message` parameter for high-risk deletes exists so a fabricating model leaves forensic artifacts — not so that fabrication is impossible.

```typescript
import type { ToolPolicy } from './capability-policy.js';
import { createHash } from 'node:crypto';

// Tools that require user_chat_message alongside `confirm`.
// Configured by naming convention; could be moved into capabilities.json.
export const HIGH_RISK_DELETES = new Set(['delete-deal', 'delete-person', 'delete-activity', 'delete-note']);

export function isHighRiskDelete(tool: string): boolean { return HIGH_RISK_DELETES.has(tool); }

export function resolveDeleteConfirmation(toolPolicy: ToolPolicy, entityId: string | number): string {
  return toolPolicy.confirmation_format!.replace('<id>', String(entityId));
}

export function checkUserChatMessage(userChatMessage: string | undefined, requiredConfirm: string):
  | { ok: true; hash: string }
  | { ok: false; reason: 'MISSING' | 'MISMATCH' } {
  if (typeof userChatMessage !== 'string' || userChatMessage.length === 0) {
    return { ok: false, reason: 'MISSING' };
  }
  if (!userChatMessage.includes(requiredConfirm)) {
    return { ok: false, reason: 'MISMATCH' };
  }
  // Store a short hash in audit diff_summary — not the message itself (may contain PII).
  const hash = createHash('sha256').update(userChatMessage).digest('hex').slice(0, 16);
  return { ok: true, hash };
}

export function needsUpdateConfirmation(
  toolPolicy: ToolPolicy,
  params: Record<string, unknown>,
): { required: string; field: string } | null {
  const destructiveFields = toolPolicy.destructive_updates ?? [];
  for (const f of destructiveFields) {
    if (params[f] !== undefined) {
      const map: Record<string, string> = {
        status: 'STATUS-CHANGE',
        value: 'VALUE-CHANGE',
        pipeline_id: 'PIPELINE-CHANGE',
        owner_id: 'OWNER-CHANGE',
      };
      return { required: map[f] ?? `FIELD-CHANGE:${f.toUpperCase()}`, field: f };
    }
  }
  return null;
}

export class BulkDetector {
  private history: { tool: string; ts: number }[] = [];
  constructor(private windowSeconds: number, private threshold: number) {}
  record(tool: string): number {
    const now = Date.now();
    const cutoff = now - this.windowSeconds * 1000;
    this.history = this.history.filter(h => h.ts >= cutoff);
    this.history.push({ tool, ts: now });
    return this.history.filter(h => h.tool === tool).length;
  }
  needsConfirmation(tool: string, confirm: string | undefined, format: string): { ok: true } | { ok: false; required: string } {
    const count = this.record(tool);
    if (count <= this.threshold) return { ok: true };
    const required = format.replace('<count>', String(count));
    if (confirm === required) return { ok: true };
    return { ok: false, required };
  }
}
```

### D.2 Middleware wiring

Extend `auditWrite` middleware (sec-06) so before the handler runs:

```typescript
// 1. Typed confirmation for destructive tools (deletes)
if (opts.toolPolicy.destructive && opts.toolPolicy.confirmation_format) {
  const entityId = (params as { id?: string | number })?.id ?? '?';
  const required = resolveDeleteConfirmation(opts.toolPolicy, entityId);

  if ((params as { confirm?: string }).confirm !== required) {
    opts.auditLog.insert({
      tool: opts.tool, category: opts.category, entity_type: opts.entityType, entity_id: String(entityId),
      status: 'rejected', reason_code: 'CONFIRMATION_REQUIRED',
      request_hash: '', target_summary: null, diff_summary: null, idempotency_key: null,
    });
    return {
      error: true, code: 428, reason: 'CONFIRMATION_REQUIRED',
      required_confirmation: required,
      message: `Destructive action. Re-invoke with confirm: "${required}". ` +
        (isHighRiskDelete(opts.tool)
          ? `Also include user_chat_message: the user's literal chat message that contains "${required}".`
          : ''),
    } as TResult;
  }

  // 1b. High-risk deletes: verify user_chat_message contains the confirm string.
  if (isHighRiskDelete(opts.tool)) {
    const ucm = (params as { user_chat_message?: string }).user_chat_message;
    const check = checkUserChatMessage(ucm, required);
    if (!check.ok) {
      opts.auditLog.insert({
        tool: opts.tool, category: opts.category, entity_type: opts.entityType, entity_id: String(entityId),
        status: 'rejected',
        reason_code: check.reason === 'MISSING' ? 'CONFIRMATION_USER_MESSAGE_MISSING' : 'CONFIRMATION_USER_MESSAGE_MISMATCH',
        request_hash: '', target_summary: null, diff_summary: null, idempotency_key: null,
      });
      return {
        error: true, code: 428, reason: 'CONFIRMATION_USER_MESSAGE_REQUIRED',
        required_confirmation: required,
        message: `High-risk delete. Include user_chat_message (the user's literal chat message) containing "${required}".`,
      } as TResult;
    }
    // Stash the hash on the opts for the success-path audit row to pick up.
    (opts as any)._userChatMessageHash = check.hash;
  }
}

// 2. Destructive-field updates
if (opts.category === 'update') {
  const hit = needsUpdateConfirmation(opts.toolPolicy, params as Record<string, unknown>);
  if (hit && (params as { confirm?: string }).confirm !== hit.required) {
    opts.auditLog.insert({
      tool: opts.tool, category: 'update', entity_type: opts.entityType,
      entity_id: String((params as { id?: string | number })?.id ?? '?'),
      status: 'rejected', reason_code: 'CONFIRMATION_REQUIRED',
      request_hash: '', target_summary: `destructive_update_field=${hit.field}`,
      diff_summary: null, idempotency_key: null,
    });
    return {
      error: true, code: 428, reason: 'CONFIRMATION_REQUIRED',
      required_confirmation: hit.required,
      message: `Update touches destructive field "${hit.field}". Re-invoke with confirm: "${hit.required}".`,
    } as TResult;
  }
}

// 3. Bulk detector
const bulkCheck = opts.bulkDetector.needsConfirmation(
  opts.tool, (params as { confirm?: string }).confirm, opts.bulkFormat
);
if (!bulkCheck.ok) {
  opts.auditLog.insert({
    tool: opts.tool, category: opts.category, entity_type: opts.entityType, entity_id: null,
    status: 'rejected', reason_code: 'BULK_CONFIRMATION_REQUIRED',
    request_hash: '', target_summary: null, diff_summary: null, idempotency_key: null,
  });
  return { error: true, code: 428, reason: 'BULK_CONFIRMATION_REQUIRED',
    required_confirmation: bulkCheck.required,
    message: `Bulk pattern detected. Re-invoke with confirm: "${bulkCheck.required}".` } as TResult;
}
```

On the **success** path for high-risk deletes, the audit row's `diff_summary` includes the truncated hash of `user_chat_message`, e.g. `"deleted:deal:42 user_chat_message_hash=abc123def456..."`. This is what lets a later investigation detect fabrication (user claims "I never said delete that deal" — compare audit rows across a session; a hash tied to every delete that doesn't match any actual user message is a strong signal).

### D.3 Tests

`tests/lib/typed-confirmation.test.ts`:
- `resolveDeleteConfirmation` replaces `<id>` correctly (deal 42 → `DELETE-DEAL:42`).
- Missing `confirm` → reject.
- `confirm: true` (boolean) → reject (string compare fails).
- `confirm: "delete-deal:42"` (wrong case) → reject.
- Correct string → accept.
- `checkUserChatMessage`:
  - Missing → `{ ok: false, reason: 'MISSING' }`.
  - Present but does not contain the required substring → `{ ok: false, reason: 'MISMATCH' }`.
  - Contains the required substring → `{ ok: true, hash }` with 16-char hex hash.
  - Same message hashes deterministically.
- `needsUpdateConfirmation` returns correct `required` for each mapped field.
- `BulkDetector` opens after threshold+1 calls in window; closes after window elapses.
- **Framing test:** include a test that explicitly documents the design — a model that reissues the call with `confirm` + a synthetic `user_chat_message` containing the string passes. The test assertion notes this is expected behavior (friction + audit, not proof) and references spec §11.

- [ ] Implement Task D. Tests green.

---

## Task E: End-to-End Wiring

In `src/server.ts`:

```typescript
import { KillSwitch } from './lib/kill-switch.js';
import { ReadBudget } from './lib/read-budget.js';
import { BulkDetector } from './lib/typed-confirmation.js';
import { loadPolicy } from './lib/capability-policy.js';

export function createServer(config, client, resolver, entityResolver, logger, auditLog, safeDegradedRef) {
  const policy = loadPolicy();
  const killSwitch = new KillSwitch();
  const readBudget = new ReadBudget(policy.read_budgets);
  const bulkDetector = new BulkDetector(policy.bulk_detector.window_seconds, policy.bulk_detector.threshold);

  // For every write/delete tool:
  //   wrap with auditWrite({ ..., killSwitch, toolPolicy: policy.tools[name], bulkDetector, bulkFormat: policy.bulk_detector.confirmation_format })
  // For every read tool:
  //   wrap with readHandler(readBudget)
  // ...
}
```

- [ ] Wire. Make sure every existing tool in `src/tools/*.ts` is covered.

## Task F: Commit

```bash
git add capabilities.json scripts/embed-version.mjs \
        src/lib/capability-policy.ts src/lib/kill-switch.ts src/lib/read-budget.ts src/lib/typed-confirmation.ts \
        src/lib/audit-middleware.ts src/server.ts src/index.ts src/bin/kill-switch.ts \
        tests/lib/capability-policy.test.ts tests/lib/kill-switch.test.ts tests/lib/read-budget.test.ts tests/lib/typed-confirmation.test.ts
git commit -m "feat(security): capability policy + kill switch + read budgets + typed destructive confirmation"
```

---

**Done when:** all unit tests green; editing `capabilities.json` and **restarting** causes **exit 1** (startup mismatch); editing `capabilities.json` on a running server causes safe-degraded within 60s (runtime mismatch); `npm run kill-switch -- --off` rejects every write; broad `list-deals` requires `BROAD-READ:list-deals` but budget caps still apply regardless of confirm; `delete-deal` with `confirm: true` is rejected, with `confirm: "DELETE-DEAL:42"` alone is rejected (`CONFIRMATION_USER_MESSAGE_MISSING`), and with both `confirm` + `user_chat_message` containing the string succeeds (audit row carries the 16-char hash); 11th `update-deal` in 60s requires `BULK:11`.
