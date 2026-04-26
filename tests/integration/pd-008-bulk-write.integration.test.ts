// PD-008: Bulk-write triggers BULK confirmation after threshold.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestDeps, cleanupTestDeps, dispatch, makeToolMap, mockUpdateTool, readAuditRows,
  type TestDeps,
} from './_harness.js';
import { BulkDetector } from '../../src/lib/typed-confirmation.js';

let deps: TestDeps;
let toolMap: ReturnType<typeof makeToolMap>;

beforeEach(() => {
  // Override bulk detector to a low threshold for fast testing
  deps = createTestDeps();
  deps.bulkDetector = new BulkDetector(60, 3); // block on 4th call
  toolMap = makeToolMap([mockUpdateTool('update-deal')]);
});

afterEach(() => cleanupTestDeps(deps));

describe('PD-008 — bulk write confirmation', () => {
  it('calls 1-3 succeed without confirmation', async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await dispatch('update-deal', { id: i, title: `Deal ${i}` }, toolMap, deps);
      expect(r.id).toBe(42);
    }
  });

  it('4th call requires BULK:<count> confirmation', async () => {
    for (let i = 1; i <= 3; i++) {
      await dispatch('update-deal', { id: i, title: `Deal ${i}` }, toolMap, deps);
    }

    const r = await dispatch('update-deal', { id: 4, title: 'Deal 4' }, toolMap, deps);
    expect(r.reason).toBe('BULK_CONFIRMATION_REQUIRED');
    expect(r.code).toBe(428);
    expect(r.required_confirmation).toBe('BULK:4');

    const rows = readAuditRows(deps.dbPath);
    expect(rows.at(-1)?.reason_code).toBe('BULK_CONFIRMATION_REQUIRED');
  });

  it('4th call with correct BULK:4 confirm succeeds', async () => {
    for (let i = 1; i <= 3; i++) {
      await dispatch('update-deal', { id: i, title: `Deal ${i}` }, toolMap, deps);
    }
    // First blocked attempt to know the count
    await dispatch('update-deal', { id: 4, title: 'Deal 4' }, toolMap, deps);

    // Re-issue with correct confirm — count is now 5
    const r = await dispatch('update-deal', { id: 4, title: 'Deal 4', confirm: 'BULK:5' }, toolMap, deps);
    expect(r.id).toBe(42);
  });
});
