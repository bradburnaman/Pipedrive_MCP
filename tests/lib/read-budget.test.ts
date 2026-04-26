import { describe, it, expect, beforeEach } from 'vitest';
import { ReadBudget } from '../../src/lib/read-budget.js';
import type { ReadBudgetPolicy } from '../../src/lib/capability-policy.js';

const defaultPolicy: ReadBudgetPolicy = {
  max_records_per_session: 100,
  max_bytes_per_session: 10_000,
  max_pagination_depth: 5,
  broad_query_confirmation: true,
  broad_query_confirmation_format: 'BROAD-READ:<tool>',
};

let budget: ReadBudget;

beforeEach(() => {
  budget = new ReadBudget(defaultPolicy);
});

describe('record limit', () => {
  it('allows calls below limit', () => {
    budget.add('list-deals', 99, 100, false);
    expect(budget.checkRecords().ok).toBe(true);
  });

  it('blocks at the limit', () => {
    budget.add('list-deals', 100, 100, false);
    const r = budget.checkRecords();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('SESSION_READ_BUDGET_RECORDS_EXCEEDED');
  });

  it('accumulates across multiple calls', () => {
    budget.add('list-deals', 60, 100, false);
    budget.add('list-persons', 60, 100, false);
    expect(budget.checkRecords().ok).toBe(false);
  });
});

describe('byte limit', () => {
  it('allows calls below limit', () => {
    budget.add('list-deals', 1, 9_999, false);
    expect(budget.checkBytes().ok).toBe(true);
  });

  it('blocks at the limit', () => {
    budget.add('list-deals', 1, 10_000, false);
    const r = budget.checkBytes();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('SESSION_READ_BUDGET_BYTES_EXCEEDED');
  });
});

describe('pagination depth', () => {
  it('tracks depth per tool independently', () => {
    for (let i = 0; i < 5; i++) budget.add('list-deals', 1, 10, true);
    expect(budget.checkPagination('list-deals').ok).toBe(false);
    expect(budget.checkPagination('list-persons').ok).toBe(true);
  });

  it('allows up to but not including the limit', () => {
    for (let i = 0; i < 4; i++) budget.add('list-deals', 1, 10, true);
    expect(budget.checkPagination('list-deals').ok).toBe(true);
    budget.add('list-deals', 1, 10, true);
    expect(budget.checkPagination('list-deals').ok).toBe(false);
  });

  it('non-paginated calls do not increment depth', () => {
    budget.add('list-deals', 1, 10, false);
    expect(budget.checkPagination('list-deals').ok).toBe(true);
  });
});

describe('isBroadQuery', () => {
  it('list-deals with no params is broad', () => {
    expect(budget.isBroadQuery('list-deals', {})).toBe(true);
  });

  it('list-deals with owner filter is not broad', () => {
    expect(budget.isBroadQuery('list-deals', { owner: 'alice' })).toBe(false);
  });

  it('list-deals with pipeline_id filter is not broad', () => {
    expect(budget.isBroadQuery('list-deals', { pipeline_id: '5' })).toBe(false);
  });

  it('list-deals with empty string filter is still broad', () => {
    expect(budget.isBroadQuery('list-deals', { owner: '' })).toBe(true);
  });

  it('search-deals with empty query is broad', () => {
    expect(budget.isBroadQuery('search-deals', { query: '' })).toBe(true);
  });

  it('search-deals with single-char query is broad', () => {
    expect(budget.isBroadQuery('search-deals', { query: 'a' })).toBe(true);
  });

  it('search-deals with 3-char query is not broad', () => {
    expect(budget.isBroadQuery('search-deals', { query: 'abc' })).toBe(false);
  });

  it('get-deal is not broad (point lookup)', () => {
    expect(budget.isBroadQuery('get-deal', {})).toBe(false);
  });
});

describe('needsBroadConfirmation', () => {
  it('requires confirmation for broad list with no confirm', () => {
    const r = budget.needsBroadConfirmation('list-deals', {}, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.required).toBe('BROAD-READ:list-deals');
  });

  it('accepts correct confirmation string', () => {
    const r = budget.needsBroadConfirmation('list-deals', {}, 'BROAD-READ:list-deals');
    expect(r.ok).toBe(true);
  });

  it('rejects wrong confirmation string', () => {
    const r = budget.needsBroadConfirmation('list-deals', {}, 'BROAD-READ:list-persons');
    expect(r.ok).toBe(false);
  });

  it('once confirmed, subsequent broad calls to same tool pass without re-confirm', () => {
    budget.needsBroadConfirmation('list-deals', {}, 'BROAD-READ:list-deals');
    const r = budget.needsBroadConfirmation('list-deals', {}, undefined);
    expect(r.ok).toBe(true);
  });

  it('confirmation for one tool does not carry over to another tool', () => {
    budget.needsBroadConfirmation('list-deals', {}, 'BROAD-READ:list-deals');
    const r = budget.needsBroadConfirmation('list-persons', {}, undefined);
    expect(r.ok).toBe(false);
  });

  it('non-broad query passes without confirmation', () => {
    const r = budget.needsBroadConfirmation('list-deals', { owner: 'alice' }, undefined);
    expect(r.ok).toBe(true);
  });

  it('passes immediately when broad_query_confirmation is disabled', () => {
    const b = new ReadBudget({ ...defaultPolicy, broad_query_confirmation: false });
    const r = b.needsBroadConfirmation('list-deals', {}, undefined);
    expect(r.ok).toBe(true);
  });
});
