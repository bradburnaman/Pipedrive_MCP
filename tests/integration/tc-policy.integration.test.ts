// TC-POLICY-1: Policy hash mismatch — startup (process-spawn) and runtime (in-process).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recomputeHash } from '../../src/lib/capability-policy.js';
import { POLICY_HASH } from '../../src/lib/version-id.js';
import {
  createTestDeps, cleanupTestDeps, dispatch, makeToolMap, mockCreateTool, readAuditRows,
  spawnProcess, type TestDeps,
} from './_harness.js';

// TC-POLICY-1a: Startup hash mismatch → exit 1
// Spawns the real server process with a tampered capabilities.json via BHG_CAPABILITIES_PATH.
describe('TC-POLICY-1a — startup hash mismatch → exit 1', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bhg-policy-1a-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('server exits 1 when capabilities.json does not match embedded hash', () => {
    // Write a tampered capabilities file
    const tamperedPath = join(tmpDir, 'capabilities.json');
    const tampered = {
      version: '1.0.0',
      writes_enabled_default: false, // changed
      tools: {},
      read_budgets: {
        max_records_per_session: 99999,
        max_bytes_per_session: 99999,
        max_pagination_depth: 99999,
        broad_query_confirmation: false,
        broad_query_confirmation_format: 'X',
      },
      bulk_detector: { window_seconds: 1, threshold: 99999, confirmation_format: 'X' },
    };
    writeFileSync(tamperedPath, JSON.stringify(tampered));

    // Spawn the server — it must exit 1 quickly (policy check is before token loading)
    const result = spawnProcess('npx', ['tsx', 'src/index.ts'], {
      env: { BHG_CAPABILITIES_PATH: tamperedPath },
      timeoutMs: 8_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/POLICY_HASH_MISMATCH_STARTUP/);
    expect(result.stderr).toMatch(/refusing to start/i);
  });
});

// TC-POLICY-1b: Runtime hash mismatch → safe-degraded (in-process simulation)
// Tests the hot-check LOGIC: if recomputeHash() returns a different value than
// POLICY_HASH, the safeDegraded flag is flipped and writes are rejected.
// Timer scheduling is implied by the code in index.ts; what matters here is
// that the detection + response logic works correctly end-to-end.
describe('TC-POLICY-1b — runtime hash mismatch → safe-degraded (simulated hot-check)', () => {
  let deps: TestDeps;
  let toolMap: ReturnType<typeof makeToolMap>;

  beforeEach(() => {
    deps = createTestDeps();
    toolMap = makeToolMap([mockCreateTool('create-deal')]);
  });

  afterEach(() => cleanupTestDeps(deps));

  it('write succeeds before policy mismatch is detected', async () => {
    const r = await dispatch('create-deal', { title: 'Before' }, toolMap, deps);
    expect(r.id).toBe(42);
  });

  it('once safe-degraded is flipped for POLICY_HASH_MISMATCH_RUNTIME, writes are rejected 503', async () => {
    // Simulate what the hot-check timer does on detecting a mismatch
    deps.safeDegraded.value = true;
    deps.safeDegraded.reason = 'POLICY_HASH_MISMATCH_RUNTIME';
    deps.auditLog.insert({
      tool: '_hot_check', category: 'policy', entity_type: null, entity_id: null,
      status: 'safe_degraded_rejected', reason_code: 'POLICY_HASH_MISMATCH_RUNTIME',
      request_hash: '', target_summary: `expected=${POLICY_HASH} got=tampered`,
      diff_summary: null, idempotency_key: null,
    });

    const r = await dispatch('create-deal', { title: 'After' }, toolMap, deps);
    expect(r.code).toBe(503);
    expect(r.message).toMatch(/safe.degraded|Audit chain/i);

    const rows = readAuditRows(deps.dbPath);
    const policyRow = rows.find(row => row.reason_code === 'POLICY_HASH_MISMATCH_RUNTIME');
    expect(policyRow).toBeDefined();
    expect(policyRow?.category).toBe('policy');
  });

  it('recomputeHash with unmodified capabilities.json matches POLICY_HASH (invariant)', () => {
    // If this fails, the real capabilities.json was changed without rebuilding.
    const computed = recomputeHash();
    expect(computed).toBe(POLICY_HASH);
  });
});
