// PD-003: Broad CRM scrape blocked by session budget.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReadBudget } from '../../src/lib/read-budget.js';
import {
  createTestDeps, cleanupTestDeps, dispatch, makeToolMap, mockReadTool, readAuditRows,
  type TestDeps,
} from './_harness.js';

let deps: TestDeps;
let toolMap: ReturnType<typeof makeToolMap>;

beforeEach(() => {
  deps = createTestDeps();
  toolMap = makeToolMap([
    mockReadTool('list-deals', { items: Array.from({ length: 50 }, (_, i) => ({ id: i })) }),
  ]);
});

afterEach(() => cleanupTestDeps(deps));

describe('PD-003 — broad scrape + session budget', () => {
  it('step 1: unfiltered list-deals requires broad-query confirmation', async () => {
    const r = await dispatch('list-deals', {}, toolMap, deps);
    expect(r.reason).toBe('BROAD_READ_CONFIRMATION_REQUIRED');
    expect(r.code).toBe(428);
    expect(typeof r.required_confirmation).toBe('string');
    expect(r.required_confirmation).toBe('BROAD-READ:list-deals');

    const rows = readAuditRows(deps.dbPath);
    expect(rows.at(-1)?.reason_code).toBe('BROAD_READ_CONFIRMATION_REQUIRED');
    expect(rows.at(-1)?.category).toBe('broad_query');
  });

  it('step 3: with correct confirm string, broad query proceeds', async () => {
    const r = await dispatch('list-deals', { confirm: 'BROAD-READ:list-deals' }, toolMap, deps);
    expect(r.items).toBeDefined();
    expect(Array.isArray(r.items)).toBe(true);
  });

  it('step 3b: confirmed once, subsequent broad calls to same tool pass without re-confirm', async () => {
    await dispatch('list-deals', { confirm: 'BROAD-READ:list-deals' }, toolMap, deps);
    const r = await dispatch('list-deals', {}, toolMap, deps);
    expect(r.items).toBeDefined();
  });

  it('step 5: exceeding record budget blocks further reads', async () => {
    // Override with a tiny budget for this test
    deps.readBudget = new ReadBudget({
      max_records_per_session: 10,
      max_bytes_per_session: 10_485_760,
      max_pagination_depth: 20,
      broad_query_confirmation: false,
      broad_query_confirmation_format: 'BROAD-READ:<tool>',
    });

    // Consume 10 records (the limit)
    const smallTool = makeToolMap([
      mockReadTool('list-deals', { items: Array.from({ length: 10 }, (_, i) => ({ id: i })) }),
    ]);
    await dispatch('list-deals', {}, smallTool, deps);

    // Next call should be blocked
    const r = await dispatch('list-deals', {}, smallTool, deps);
    expect(r.reason).toBe('SESSION_READ_BUDGET_RECORDS_EXCEEDED');
    expect(r.code).toBe(429);

    const rows = readAuditRows(deps.dbPath);
    expect(rows.at(-1)?.category).toBe('read_budget');
    expect(rows.at(-1)?.reason_code).toBe('SESSION_READ_BUDGET_RECORDS_EXCEEDED');
  });
});
