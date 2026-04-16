import { describe, it, expect } from 'vitest';
import { classifyLabel, practiceMatches } from '../../src/lib/pipeline-classifier.js';
import { createEmptyBucket, addToBucket } from '../../src/lib/pipeline-classifier.js';
import { sortWonDeals, sortByCloseDate } from '../../src/lib/pipeline-classifier.js';
import { classifyDeals } from '../../src/lib/pipeline-classifier.js';
import type { CanonicalDeal, ClassificationParams, ClassificationResult } from '../../src/lib/pipeline-classifier.js';

function makeDeal(overrides: Partial<CanonicalDeal> = {}): CanonicalDeal {
  return {
    dealId: 1,
    title: 'Test Deal',
    value: 50000,
    status: 'open',
    wonTime: null,
    expectedCloseDate: '2026-05-15',
    stage: 'Qualified',
    labels: [],
    organization: 'Acme Corp',
    practiceValues: ['Varicent'],
    ...overrides,
  };
}

describe('classifyLabel', () => {
  it('returns commit when labels include Commit', () => {
    expect(classifyLabel(['Commit'])).toBe('commit');
  });

  it('returns upside when labels include Upside', () => {
    expect(classifyLabel(['Upside'])).toBe('upside');
  });

  it('returns commit when both Commit and Upside present (precedence)', () => {
    expect(classifyLabel(['Commit', 'Upside'])).toBe('commit');
    expect(classifyLabel(['Upside', 'Commit'])).toBe('commit');
  });

  it('returns null for empty labels', () => {
    expect(classifyLabel([])).toBeNull();
  });

  it('returns null for unrecognized labels', () => {
    expect(classifyLabel(['Hot'])).toBeNull();
  });

  it('uses exact match, not substring', () => {
    expect(classifyLabel(['Committed'])).toBeNull();
    expect(classifyLabel(['UpsideRisk'])).toBeNull();
  });
});

describe('practiceMatches', () => {
  it('returns true when practices overlap', () => {
    expect(practiceMatches(['Varicent'], ['Varicent'])).toBe(true);
  });

  it('returns true when one of multiple deal practices matches', () => {
    expect(practiceMatches(['Advisory', 'AI Product'], ['AI Product'])).toBe(true);
  });

  it('returns true when one of multiple requested practices matches', () => {
    expect(practiceMatches(['Advisory'], ['Advisory', 'AI Product'])).toBe(true);
  });

  it('returns false when no overlap', () => {
    expect(practiceMatches(['Varicent'], ['Xactly'])).toBe(false);
  });

  it('returns false for empty deal practices', () => {
    expect(practiceMatches([], ['Varicent'])).toBe(false);
  });

  it('uses exact string match, not case-insensitive', () => {
    expect(practiceMatches(['varicent'], ['Varicent'])).toBe(false);
  });
});

describe('bucket accumulator', () => {
  it('createEmptyBucket returns zeroed bucket', () => {
    const bucket = createEmptyBucket();
    expect(bucket.totalValue).toBe(0);
    expect(bucket.dealCount).toBe(0);
    expect(bucket.deals).toEqual([]);
  });

  it('addToBucket increments totals and appends deal', () => {
    const bucket = createEmptyBucket();
    addToBucket(bucket, makeDeal({ dealId: 1, value: 100000 }));
    addToBucket(bucket, makeDeal({ dealId: 2, value: 50000 }));
    expect(bucket.totalValue).toBe(150000);
    expect(bucket.dealCount).toBe(2);
    expect(bucket.deals).toHaveLength(2);
  });

  it('totals remain accurate even with many deals (pre-truncation)', () => {
    const bucket = createEmptyBucket();
    for (let i = 0; i < 60; i++) {
      addToBucket(bucket, makeDeal({ dealId: i, value: 1000 }));
    }
    expect(bucket.totalValue).toBe(60000);
    expect(bucket.dealCount).toBe(60);
    expect(bucket.deals).toHaveLength(60); // all stored; truncation is in render
  });
});

describe('sortWonDeals', () => {
  it('sorts by wonTime descending (most recent first)', () => {
    const deals = [
      makeDeal({ dealId: 1, wonTime: '2026-04-05T10:00:00Z' }),
      makeDeal({ dealId: 2, wonTime: '2026-04-15T10:00:00Z' }),
      makeDeal({ dealId: 3, wonTime: '2026-04-10T10:00:00Z' }),
    ];
    const sorted = [...deals].sort(sortWonDeals);
    expect(sorted.map(d => d.dealId)).toEqual([2, 3, 1]);
  });

  it('uses dealId ascending as tie-breaker for same wonTime', () => {
    const deals = [
      makeDeal({ dealId: 5, wonTime: '2026-04-10T10:00:00Z' }),
      makeDeal({ dealId: 2, wonTime: '2026-04-10T10:00:00Z' }),
    ];
    const sorted = [...deals].sort(sortWonDeals);
    expect(sorted.map(d => d.dealId)).toEqual([2, 5]);
  });
});

describe('sortByCloseDate', () => {
  it('sorts by expectedCloseDate ascending (soonest first)', () => {
    const deals = [
      makeDeal({ dealId: 1, expectedCloseDate: '2026-06-15' }),
      makeDeal({ dealId: 2, expectedCloseDate: '2026-04-01' }),
      makeDeal({ dealId: 3, expectedCloseDate: '2026-05-10' }),
    ];
    const sorted = [...deals].sort(sortByCloseDate);
    expect(sorted.map(d => d.dealId)).toEqual([2, 3, 1]);
  });

  it('puts null expectedCloseDate last', () => {
    const deals = [
      makeDeal({ dealId: 1, expectedCloseDate: null }),
      makeDeal({ dealId: 2, expectedCloseDate: '2026-05-10' }),
    ];
    const sorted = [...deals].sort(sortByCloseDate);
    expect(sorted.map(d => d.dealId)).toEqual([2, 1]);
  });

  it('uses dealId ascending as tie-breaker for same date', () => {
    const deals = [
      makeDeal({ dealId: 7, expectedCloseDate: '2026-05-10' }),
      makeDeal({ dealId: 3, expectedCloseDate: '2026-05-10' }),
    ];
    const sorted = [...deals].sort(sortByCloseDate);
    expect(sorted.map(d => d.dealId)).toEqual([3, 7]);
  });
});

const baseParams: ClassificationParams = {
  monthEnd: '2026-04-30',
  quarterEnd: '2026-06-30',
  nextQuarterStart: '2026-07-01',
  nextQuarterEnd: '2026-09-30',
  wonPeriodStart: '2026-04-01',
  wonPeriodEnd: '2026-04-17',
  wonQuarterStart: '2026-04-01',
  nextMonthEnd: '2026-05-31',
  nextThreeMonthsEnd: '2026-07-31',
};

describe('classifyDeals', () => {
  it('classifies won deal into month.won and quarter.won', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'won', value: 50000,
      wonTime: '2026-04-10T14:00:00Z',
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.month.won.totalValue).toBe(50000);
    expect(result.month.won.dealCount).toBe(1);
    expect(result.quarter.won.totalValue).toBe(50000);
    expect(result.quarter.won.dealCount).toBe(1);
  });

  it('classifies won deal in quarter but not month window', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'won', value: 75000,
      wonTime: '2026-04-20T10:00:00Z', // after wonPeriodEnd
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.month.won.totalValue).toBe(0);
    expect(result.quarter.won.totalValue).toBe(0);
  });

  it('classifies open Commit deal into month.commit, quarter.commit, and pipeline health', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'open', value: 100000,
      expectedCloseDate: '2026-04-20',
      labels: ['Commit'],
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.month.commit.totalValue).toBe(100000);
    expect(result.quarter.commit.totalValue).toBe(100000);
    expect(result.totalOpenPipeline.totalValue).toBe(100000);
    expect(result.nextMonthPipeline.totalValue).toBe(100000); // 04-20 <= 05-31
    expect(result.nextThreeMonthsPipeline.totalValue).toBe(100000); // 04-20 <= 07-31
  });

  it('classifies open Upside deal into next-quarter bucket with bounded window', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'open', value: 80000,
      expectedCloseDate: '2026-08-15',
      labels: ['Upside'],
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.nextQuarter.upside.totalValue).toBe(80000); // 08-15 in [07-01, 09-30]
    expect(result.month.upside.totalValue).toBe(0); // 08-15 > monthEnd 04-30
    expect(result.totalOpenPipeline.totalValue).toBe(80000);
    // 08-15 > nextThreeMonthsEnd 07-31, so NOT included in nextThreeMonths
    expect(result.nextThreeMonthsPipeline.totalValue).toBe(0);
  });

  it('excludes deals that do not match requested practices', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'open', value: 100000,
      practiceValues: ['Xactly'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.totalOpenPipeline.totalValue).toBe(0);
  });

  it('open unlabeled deal enters only pipeline health buckets', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'open', value: 60000,
      expectedCloseDate: '2026-05-01',
      labels: [],
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.totalOpenPipeline.totalValue).toBe(60000);
    expect(result.nextMonthPipeline.totalValue).toBe(60000);
    expect(result.nextThreeMonthsPipeline.totalValue).toBe(60000);
    expect(result.month.commit.totalValue).toBe(0);
    expect(result.month.upside.totalValue).toBe(0);
  });

  it('won deals never enter open-deal buckets', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'won', value: 50000,
      wonTime: '2026-04-10T14:00:00Z',
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.totalOpenPipeline.totalValue).toBe(0);
    expect(result.nextMonthPipeline.totalValue).toBe(0);
  });

  it('Commit precedence: deal with both labels classified as commit only', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'open', value: 100000,
      expectedCloseDate: '2026-05-15',
      labels: ['Commit', 'Upside'],
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.quarter.commit.totalValue).toBe(100000);
    expect(result.quarter.upside.totalValue).toBe(0);
  });

  it('nesting invariant: nextMonth ⊆ nextThreeMonths ⊆ totalOpen', () => {
    const deals = [
      makeDeal({ dealId: 1, value: 50000, expectedCloseDate: '2026-05-01', practiceValues: ['Varicent'] }),
      makeDeal({ dealId: 2, value: 75000, expectedCloseDate: '2026-06-15', practiceValues: ['Varicent'] }),
      makeDeal({ dealId: 3, value: 100000, expectedCloseDate: '2026-09-01', practiceValues: ['Varicent'] }),
    ];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    const nextMonthIds = result.nextMonthPipeline.deals.map(d => d.dealId);
    const nextThreeIds = result.nextThreeMonthsPipeline.deals.map(d => d.dealId);
    const totalOpenIds = result.totalOpenPipeline.deals.map(d => d.dealId);
    expect(nextMonthIds).toEqual([1]);
    expect(nextThreeIds).toEqual(expect.arrayContaining([1, 2]));
    expect(nextThreeIds).toHaveLength(2);
    expect(totalOpenIds).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(totalOpenIds).toHaveLength(3);
    expect(nextMonthIds.every(id => nextThreeIds.includes(id))).toBe(true);
    expect(nextThreeIds.every(id => totalOpenIds.includes(id))).toBe(true);
    expect(result.nextMonthPipeline.totalValue).toBeLessThanOrEqual(result.nextThreeMonthsPipeline.totalValue);
    expect(result.nextThreeMonthsPipeline.totalValue).toBeLessThanOrEqual(result.totalOpenPipeline.totalValue);
  });

  it('null wonTime: won deal excluded from all won buckets', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'won', value: 50000,
      wonTime: null,
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.month.won.totalValue).toBe(0);
    expect(result.quarter.won.totalValue).toBe(0);
  });

  it('null expectedCloseDate on open labeled deal: enters totalOpen only', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'open', value: 80000,
      expectedCloseDate: null,
      labels: ['Commit'],
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent'], baseParams);
    expect(result.totalOpenPipeline.totalValue).toBe(80000);
    expect(result.month.commit.totalValue).toBe(0);
    expect(result.nextMonthPipeline.totalValue).toBe(0);
  });

  it('duplicate practice values do not double-count', () => {
    const deals = [makeDeal({
      dealId: 1, status: 'open', value: 50000,
      practiceValues: ['Varicent'],
    })];
    const result = classifyDeals(deals, ['Varicent', 'Varicent'], baseParams);
    expect(result.totalOpenPipeline.dealCount).toBe(1);
    expect(result.totalOpenPipeline.totalValue).toBe(50000);
  });

  it('returns finalized buckets: sorted, truncated, flag set', () => {
    const deals: CanonicalDeal[] = [];
    for (let i = 0; i < 55; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      deals.push(makeDeal({
        dealId: 100 + i,
        value: 1000,
        status: 'open',
        expectedCloseDate: `2026-05-${day}`,
        practiceValues: ['Varicent'],
      }));
    }
    const result = classifyDeals(deals, ['Varicent'], baseParams);

    expect(result.totalOpenPipeline.dealCount).toBe(55);
    expect(result.totalOpenPipeline.totalValue).toBe(55000);
    expect(result.totalOpenPipeline.deals).toHaveLength(50);
    expect(result.totalOpenPipeline.truncated).toBe(true);

    for (let i = 1; i < result.totalOpenPipeline.deals.length; i++) {
      const prev = result.totalOpenPipeline.deals[i - 1];
      const curr = result.totalOpenPipeline.deals[i];
      const prevDate = prev.expectedCloseDate ?? '\uffff';
      const currDate = curr.expectedCloseDate ?? '\uffff';
      if (prevDate === currDate) {
        expect(prev.dealId).toBeLessThan(curr.dealId);
      } else {
        expect(prevDate <= currDate).toBe(true);
      }
    }
  });
});
