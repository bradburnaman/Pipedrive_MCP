// PD-001 / PD-001b: env-override gating and break-glass audit trail.
// These test the pure logic of envOverrideAllowed() and the in-process
// audit path when break-glass is activated.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { envOverrideAllowed } from '../../src/lib/secret-store.js';
import {
  createTestDeps, cleanupTestDeps, dispatch, makeToolMap, mockCreateTool, readAuditRows,
  type TestDeps,
} from './_harness.js';

describe('PD-001 — env-override gating', () => {
  it('allows override in test mode (NODE_ENV=test)', () => {
    const r = envOverrideAllowed({ NODE_ENV: 'test' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('test_mode');
  });

  it('allows override when CI=true (CI environment)', () => {
    const r = envOverrideAllowed({ CI: 'true' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('test_mode');
  });

  it('blocks override in production (no special vars)', () => {
    const r = envOverrideAllowed({});
    expect(r.allowed).toBe(false);
  });

  it('blocks when break-glass flag is set without a reason', () => {
    const r = envOverrideAllowed({ BHG_PIPEDRIVE_BREAK_GLASS: '1', BHG_PIPEDRIVE_BREAK_GLASS_REASON: '' });
    expect(r.allowed).toBe(false);
  });

  it('blocks when break-glass reason is only whitespace', () => {
    const r = envOverrideAllowed({ BHG_PIPEDRIVE_BREAK_GLASS: '1', BHG_PIPEDRIVE_BREAK_GLASS_REASON: '   ' });
    expect(r.allowed).toBe(false);
  });

  it('allows with break-glass=1 + non-empty reason', () => {
    const r = envOverrideAllowed({
      BHG_PIPEDRIVE_BREAK_GLASS: '1',
      BHG_PIPEDRIVE_BREAK_GLASS_REASON: 'incident-2026-04-25',
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('break_glass:incident-2026-04-25');
  });

  it('retired BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE is not honored', () => {
    const r = envOverrideAllowed({ BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE: '1' });
    expect(r.allowed).toBe(false);
  });
});

// PD-001b: break-glass activation leaves a forensic audit row.
// Simulates what index.ts does when it detects break-glass on startup.
describe('PD-001b — break-glass activation creates audit row', () => {
  let deps: TestDeps;
  let toolMap: ReturnType<typeof makeToolMap>;

  beforeEach(() => {
    deps = createTestDeps();
    toolMap = makeToolMap([mockCreateTool('create-deal')]);
  });

  afterEach(() => cleanupTestDeps(deps));

  it('break-glass audit row is queryable after being written', async () => {
    // Simulate what index.ts does after detecting break-glass
    deps.auditLog.insert({
      tool: '_startup',
      category: 'policy',
      entity_type: null,
      entity_id: null,
      status: 'break_glass',
      reason_code: 'BREAK_GLASS_ENV_OVERRIDE',
      request_hash: '',
      target_summary: 'BHG_PIPEDRIVE_BREAK_GLASS_REASON=incident-2026-04-25',
      diff_summary: null,
      idempotency_key: null,
    });

    // Writes should still succeed (break-glass does NOT degrade the session)
    const r = await dispatch('create-deal', { title: 'Post-break-glass create' }, toolMap, deps);
    expect(r.id).toBe(42);

    const rows = readAuditRows(deps.dbPath);
    const bgRow = rows.find(row => row.reason_code === 'BREAK_GLASS_ENV_OVERRIDE');
    expect(bgRow).toBeDefined();
    expect(bgRow?.status).toBe('break_glass');
    expect(bgRow?.category).toBe('policy');
  });
});
