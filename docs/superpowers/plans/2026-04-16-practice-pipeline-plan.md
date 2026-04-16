# get-practice-pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `get-practice-pipeline` tool that returns practice-level pipeline summaries for BHG Weekly Ops Scorecard automation.

**Architecture:** Fetch-and-classify — fetch all BHG Pipeline deals (open + won separately via v2 API), normalize into canonical model, classify into scorecard buckets using pure functions, render response. Four phases: Fetch → Normalize → Classify → Render. Classification logic lives in a separate module with no API dependencies, fully testable with plain objects.

**Tech Stack:** TypeScript, Node 20, vitest, MCP SDK, Pipedrive v2 API

**Spec:** `docs/superpowers/specs/2026-04-16-practice-pipeline-tool-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/date-utils.ts` (create) | Strict YYYY-MM-DD parser, three date comparison predicates |
| `src/lib/pipeline-classifier.ts` (create) | CanonicalDeal type, classifyLabel, practiceMatches, bucket accumulation, sort comparators, full classifyDeals orchestration |
| `src/tools/practice-pipeline.ts` (create) | Tool factory, input validation, deal normalization, paginated fetch, response rendering, handler wiring |
| `src/server.ts` (modify:36) | Add import + registration for createPracticePipelineTools |
| `tests/lib/date-utils.test.ts` (create) | Tier 1: parser + predicate unit tests |
| `tests/lib/pipeline-classifier.test.ts` (create) | Tier 1+2: classification unit tests + integration tests |
| `tests/tools/practice-pipeline.test.ts` (create) | Handler tests, validation tests, pagination tests, fixture parity tests, metadata drift tests |

---

### Task 1: Strict Date Parser

**Files:**
- Create: `src/lib/date-utils.ts`
- Create: `tests/lib/date-utils.test.ts`

- [ ] **Step 1: Write failing tests for parseStrictDate**

```typescript
// tests/lib/date-utils.test.ts
import { describe, it, expect } from 'vitest';
import { parseStrictDate } from '../../src/lib/date-utils.js';

describe('parseStrictDate', () => {
  it('accepts valid YYYY-MM-DD dates', () => {
    expect(parseStrictDate('2026-04-16', 'testParam')).toBe('2026-04-16');
    expect(parseStrictDate('2026-01-01', 'testParam')).toBe('2026-01-01');
    expect(parseStrictDate('2026-12-31', 'testParam')).toBe('2026-12-31');
  });

  it('accepts leap year date', () => {
    expect(parseStrictDate('2028-02-29', 'testParam')).toBe('2028-02-29');
  });

  it('rejects non-leap year Feb 29', () => {
    expect(() => parseStrictDate('2026-02-29', 'monthEnd'))
      .toThrow("Invalid date for monthEnd: '2026-02-29'");
  });

  it('rejects impossible calendar date', () => {
    expect(() => parseStrictDate('2026-02-31', 'quarterEnd'))
      .toThrow("Invalid date for quarterEnd: '2026-02-31'");
  });

  it('rejects month out of range', () => {
    expect(() => parseStrictDate('2026-13-01', 'testParam'))
      .toThrow('Invalid date');
    expect(() => parseStrictDate('2026-00-15', 'testParam'))
      .toThrow('Invalid date');
  });

  it('rejects malformed formats', () => {
    expect(() => parseStrictDate('2026-2-09', 'testParam')).toThrow('Invalid date format');
    expect(() => parseStrictDate('2026-02-9', 'testParam')).toThrow('Invalid date format');
    expect(() => parseStrictDate('not-a-date', 'testParam')).toThrow('Invalid date format');
    expect(() => parseStrictDate('', 'testParam')).toThrow('Invalid date format');
  });

  it('rejects whitespace-padded inputs', () => {
    expect(() => parseStrictDate(' 2026-04-16', 'testParam')).toThrow('Invalid date format');
    expect(() => parseStrictDate('2026-04-16 ', 'testParam')).toThrow('Invalid date format');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/date-utils.test.ts`
Expected: FAIL — `parseStrictDate` is not exported (module does not exist yet)

- [ ] **Step 3: Implement parseStrictDate**

```typescript
// src/lib/date-utils.ts

/**
 * Parse and validate a strict YYYY-MM-DD date string.
 * Rejects malformed formats, impossible calendar dates, and whitespace.
 * Returns the validated string unchanged.
 */
export function parseStrictDate(value: string, paramName: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date format for ${paramName}: '${value}'. Expected YYYY-MM-DD.`);
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid date for ${paramName}: '${value}'. Month ${month} is out of range.`);
  }
  // Use Date constructor to get last day of month (day 0 of next month = last day of this month)
  const maxDays = new Date(year, month, 0).getDate();
  if (day < 1 || day > maxDays) {
    throw new Error(`Invalid date for ${paramName}: '${value}'. Day ${day} is out of range for month ${month}.`);
  }
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/date-utils.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/date-utils.ts tests/lib/date-utils.test.ts
git commit -m "feat: strict YYYY-MM-DD date parser with calendar validation"
```

---

### Task 2: Date Predicates

**Files:**
- Modify: `src/lib/date-utils.ts`
- Modify: `tests/lib/date-utils.test.ts`

- [ ] **Step 1: Write failing tests for all three predicates**

Append to `tests/lib/date-utils.test.ts`:

```typescript
import { isWonInPeriod, isClosingByDate, isClosingInWindow } from '../../src/lib/date-utils.js';

describe('isWonInPeriod', () => {
  it('returns true when wonTime is within [start, end] inclusive', () => {
    expect(isWonInPeriod('2026-04-10T14:30:00Z', '2026-04-01', '2026-04-17')).toBe(true);
  });

  it('returns true on exact start boundary', () => {
    expect(isWonInPeriod('2026-04-01T00:00:00Z', '2026-04-01', '2026-04-17')).toBe(true);
  });

  it('returns true on exact end boundary', () => {
    expect(isWonInPeriod('2026-04-17T23:59:59Z', '2026-04-01', '2026-04-17')).toBe(true);
  });

  it('returns false when wonTime is before start', () => {
    expect(isWonInPeriod('2026-03-31T23:59:59Z', '2026-04-01', '2026-04-17')).toBe(false);
  });

  it('returns false when wonTime is after end', () => {
    expect(isWonInPeriod('2026-04-18T00:00:00Z', '2026-04-01', '2026-04-17')).toBe(false);
  });

  it('returns false when wonTime is null', () => {
    expect(isWonInPeriod(null, '2026-04-01', '2026-04-17')).toBe(false);
  });
});

describe('isClosingByDate', () => {
  it('returns true when expectedCloseDate is before ceiling', () => {
    expect(isClosingByDate('2026-04-15', '2026-04-30')).toBe(true);
  });

  it('returns true on exact ceiling boundary', () => {
    expect(isClosingByDate('2026-04-30', '2026-04-30')).toBe(true);
  });

  it('returns true for overdue dates (ceiling-only, no floor)', () => {
    expect(isClosingByDate('2026-01-15', '2026-04-30')).toBe(true);
  });

  it('returns false when expectedCloseDate is after ceiling', () => {
    expect(isClosingByDate('2026-05-01', '2026-04-30')).toBe(false);
  });

  it('returns false when expectedCloseDate is null', () => {
    expect(isClosingByDate(null, '2026-04-30')).toBe(false);
  });
});

describe('isClosingInWindow', () => {
  it('returns true when expectedCloseDate is within [floor, ceiling]', () => {
    expect(isClosingInWindow('2026-08-15', '2026-07-01', '2026-09-30')).toBe(true);
  });

  it('returns true on exact floor boundary', () => {
    expect(isClosingInWindow('2026-07-01', '2026-07-01', '2026-09-30')).toBe(true);
  });

  it('returns true on exact ceiling boundary', () => {
    expect(isClosingInWindow('2026-09-30', '2026-07-01', '2026-09-30')).toBe(true);
  });

  it('returns false one day before floor', () => {
    expect(isClosingInWindow('2026-06-30', '2026-07-01', '2026-09-30')).toBe(false);
  });

  it('returns false one day after ceiling', () => {
    expect(isClosingInWindow('2026-10-01', '2026-07-01', '2026-09-30')).toBe(false);
  });

  it('returns false when expectedCloseDate is null', () => {
    expect(isClosingInWindow(null, '2026-07-01', '2026-09-30')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/date-utils.test.ts`
Expected: FAIL — functions not exported yet

- [ ] **Step 3: Implement the three predicates**

Append to `src/lib/date-utils.ts`:

```typescript
/**
 * Extract the YYYY-MM-DD date portion from an ISO timestamp.
 * "2026-04-08T14:30:00Z" → "2026-04-08"
 */
function toDateOnly(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * Check if wonTime falls within [start, end] inclusive.
 * Compares date portion only (ignores time-of-day).
 * Returns false if wonTime is null.
 */
export function isWonInPeriod(
  wonTime: string | null,
  start: string,
  end: string
): boolean {
  if (wonTime === null) return false;
  const date = toDateOnly(wonTime);
  return date >= start && date <= end;
}

/**
 * Check if expectedCloseDate is at or before ceiling.
 * Ceiling-only — no floor. Intentionally includes overdue deals.
 * Returns false if expectedCloseDate is null.
 */
export function isClosingByDate(
  expectedCloseDate: string | null,
  ceiling: string
): boolean {
  if (expectedCloseDate === null) return false;
  return expectedCloseDate <= ceiling;
}

/**
 * Check if expectedCloseDate falls within [floor, ceiling] inclusive.
 * Both boundaries enforced. Used only for next-quarter commit/upside.
 * Returns false if expectedCloseDate is null.
 */
export function isClosingInWindow(
  expectedCloseDate: string | null,
  floor: string,
  ceiling: string
): boolean {
  if (expectedCloseDate === null) return false;
  return expectedCloseDate >= floor && expectedCloseDate <= ceiling;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/date-utils.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/date-utils.ts tests/lib/date-utils.test.ts
git commit -m "feat: date predicates for won-period, ceiling-only, and bounded-window checks"
```

---

### Task 3: Classification Primitives

**Files:**
- Create: `src/lib/pipeline-classifier.ts`
- Create: `tests/lib/pipeline-classifier.test.ts`

- [ ] **Step 1: Write failing tests for classifyLabel and practiceMatches**

```typescript
// tests/lib/pipeline-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyLabel, practiceMatches } from '../../src/lib/pipeline-classifier.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/pipeline-classifier.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement types, classifyLabel, and practiceMatches**

```typescript
// src/lib/pipeline-classifier.ts

export interface CanonicalDeal {
  dealId: number;
  title: string;
  value: number;
  status: 'open' | 'won';
  wonTime: string | null;
  expectedCloseDate: string | null;
  stage: string;
  labels: string[];
  organization: string | null;
  practiceValues: string[];
}

export type LabelClass = 'commit' | 'upside' | null;

/**
 * Classify a deal's label set into commit, upside, or null.
 * Uses exact set membership. Commit takes precedence if both present.
 */
export function classifyLabel(labels: string[]): LabelClass {
  if (labels.includes('Commit')) return 'commit';
  if (labels.includes('Upside')) return 'upside';
  return null;
}

/**
 * Check if a deal's practice values overlap with the requested set.
 * Uses exact string match — no case normalization.
 */
export function practiceMatches(
  dealPractices: string[],
  requestedPractices: string[]
): boolean {
  return dealPractices.some(p => requestedPractices.includes(p));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/pipeline-classifier.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Write failing tests for bucket accumulator**

Append to `tests/lib/pipeline-classifier.test.ts`:

```typescript
import { createEmptyBucket, addToBucket } from '../../src/lib/pipeline-classifier.js';
import type { CanonicalDeal } from '../../src/lib/pipeline-classifier.js';

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
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/lib/pipeline-classifier.test.ts`
Expected: FAIL — functions not exported yet

- [ ] **Step 7: Implement BucketAccumulator, createEmptyBucket, addToBucket**

Append to `src/lib/pipeline-classifier.ts`:

```typescript
export interface BucketAccumulator {
  totalValue: number;
  dealCount: number;
  deals: CanonicalDeal[];
}

/**
 * Create a zeroed bucket accumulator.
 */
export function createEmptyBucket(): BucketAccumulator {
  return { totalValue: 0, dealCount: 0, deals: [] };
}

/**
 * Add a deal to a bucket. Always increments aggregates.
 * All deals are stored; truncation + sorting happens at render time.
 */
export function addToBucket(bucket: BucketAccumulator, deal: CanonicalDeal): void {
  bucket.totalValue += deal.value;
  bucket.dealCount += 1;
  bucket.deals.push(deal);
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/lib/pipeline-classifier.test.ts`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/lib/pipeline-classifier.ts tests/lib/pipeline-classifier.test.ts
git commit -m "feat: classification primitives — classifyLabel, practiceMatches, bucket accumulator"
```

---

### Task 4: Full Classification Pipeline

**Files:**
- Modify: `src/lib/pipeline-classifier.ts`
- Modify: `tests/lib/pipeline-classifier.test.ts`

- [ ] **Step 1: Write failing tests for classifyDeals**

Append to `tests/lib/pipeline-classifier.test.ts`:

```typescript
import { classifyDeals } from '../../src/lib/pipeline-classifier.js';
import type { ClassificationParams, ClassificationResult } from '../../src/lib/pipeline-classifier.js';

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
    // Still in quarter because wonQuarterStart <= 2026-04-20 <= wonPeriodEnd? No — wonPeriodEnd is 04-17
    // So it's NOT in quarter either
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
    expect(result.nextQuarter.upside.totalValue).toBe(80000);
    expect(result.month.upside.totalValue).toBe(0); // 08-15 > monthEnd 04-30
    expect(result.totalOpenPipeline.totalValue).toBe(80000);
    expect(result.nextThreeMonthsPipeline.totalValue).toBe(80000); // 08-15 > 07-31? No! 08-15 > 07-31, so NOT included
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
    // nextMonth: deals closing <= 05-31 → dealId 1
    expect(nextMonthIds).toEqual([1]);
    // nextThreeMonths: deals closing <= 07-31 → dealIds 1, 2
    expect(nextThreeIds).toEqual(expect.arrayContaining([1, 2]));
    expect(nextThreeIds).toHaveLength(2);
    // totalOpen: all → dealIds 1, 2, 3
    expect(totalOpenIds).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(totalOpenIds).toHaveLength(3);
    // Verify subset relationship
    expect(nextMonthIds.every(id => nextThreeIds.includes(id))).toBe(true);
    expect(nextThreeIds.every(id => totalOpenIds.includes(id))).toBe(true);
    // Verify value ordering
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/pipeline-classifier.test.ts`
Expected: FAIL — `classifyDeals` not exported

- [ ] **Step 3: Implement classifyDeals**

Append to `src/lib/pipeline-classifier.ts`:

```typescript
import { isWonInPeriod, isClosingByDate, isClosingInWindow } from './date-utils.js';
import type { Logger } from 'pino';

export interface ClassificationParams {
  monthEnd: string;
  quarterEnd: string;
  nextQuarterStart: string;
  nextQuarterEnd: string;
  wonPeriodStart: string;
  wonPeriodEnd: string;
  wonQuarterStart: string;
  nextMonthEnd: string;
  nextThreeMonthsEnd: string;
}

export interface ClassificationResult {
  month: { won: BucketAccumulator; commit: BucketAccumulator; upside: BucketAccumulator };
  quarter: { won: BucketAccumulator; commit: BucketAccumulator; upside: BucketAccumulator };
  nextQuarter: { commit: BucketAccumulator; upside: BucketAccumulator };
  totalOpenPipeline: BucketAccumulator;
  nextMonthPipeline: BucketAccumulator;
  nextThreeMonthsPipeline: BucketAccumulator;
}

function createEmptyResult(): ClassificationResult {
  return {
    month: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
    quarter: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
    nextQuarter: { commit: createEmptyBucket(), upside: createEmptyBucket() },
    totalOpenPipeline: createEmptyBucket(),
    nextMonthPipeline: createEmptyBucket(),
    nextThreeMonthsPipeline: createEmptyBucket(),
  };
}

/**
 * Classify deals into scorecard buckets.
 * Applies practice gate, then status-driven eligibility, then date/label predicates.
 */
export function classifyDeals(
  deals: CanonicalDeal[],
  requestedPractices: string[],
  params: ClassificationParams,
  logger?: Logger
): ClassificationResult {
  const result = createEmptyResult();
  // De-duplicate requested practices
  const practices = [...new Set(requestedPractices)];

  let anomalyNullWonTime = 0;
  let anomalyNullCloseDate = 0;

  for (const deal of deals) {
    // Practice gate — central, evaluated once
    if (!practiceMatches(deal.practiceValues, practices)) continue;

    if (deal.status === 'won') {
      // Won deals: eligible for won buckets only
      if (deal.wonTime === null) {
        anomalyNullWonTime++;
        continue;
      }
      if (isWonInPeriod(deal.wonTime, params.wonPeriodStart, params.wonPeriodEnd)) {
        addToBucket(result.month.won, deal);
      }
      if (isWonInPeriod(deal.wonTime, params.wonQuarterStart, params.wonPeriodEnd)) {
        addToBucket(result.quarter.won, deal);
      }
    } else if (deal.status === 'open') {
      // Track A — Pipeline Health (label-free)
      addToBucket(result.totalOpenPipeline, deal);
      if (isClosingByDate(deal.expectedCloseDate, params.nextMonthEnd)) {
        addToBucket(result.nextMonthPipeline, deal);
      }
      if (isClosingByDate(deal.expectedCloseDate, params.nextThreeMonthsEnd)) {
        addToBucket(result.nextThreeMonthsPipeline, deal);
      }

      // Track B — Commit/Upside (label-driven)
      const labelClass = classifyLabel(deal.labels);
      if (labelClass !== null) {
        if (deal.expectedCloseDate === null) {
          anomalyNullCloseDate++;
          continue; // Skip dated commit/upside buckets, already in pipeline health
        }
        const bucketKey = labelClass; // 'commit' | 'upside'
        // Month (ceiling-only)
        if (isClosingByDate(deal.expectedCloseDate, params.monthEnd)) {
          addToBucket(result.month[bucketKey], deal);
        }
        // Quarter (ceiling-only)
        if (isClosingByDate(deal.expectedCloseDate, params.quarterEnd)) {
          addToBucket(result.quarter[bucketKey], deal);
        }
        // Next Quarter (bounded window)
        if (isClosingInWindow(deal.expectedCloseDate, params.nextQuarterStart, params.nextQuarterEnd)) {
          addToBucket(result.nextQuarter[bucketKey], deal);
        }
      }
    }
  }

  // Aggregate anomaly logging
  if (anomalyNullWonTime > 0) {
    logger?.warn({ count: anomalyNullWonTime }, 'Won deals with null wonTime excluded from won buckets');
  }
  if (anomalyNullCloseDate > 0) {
    logger?.warn({ count: anomalyNullCloseDate }, 'Open labeled deals with null expectedCloseDate excluded from dated buckets');
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/pipeline-classifier.test.ts`
Expected: All tests PASS. Note: the "open Upside deal into next-quarter" test expects `nextThreeMonthsPipeline.totalValue` to be 0 because `2026-08-15 > 2026-07-31`. Verify this is correct and fix the test assertion if the initial write was wrong.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline-classifier.ts tests/lib/pipeline-classifier.test.ts
git commit -m "feat: full deal classification pipeline with practice gate, status eligibility, and bucket assignment"
```

---

### Task 5: Sort Comparators

**Files:**
- Modify: `src/lib/pipeline-classifier.ts`
- Modify: `tests/lib/pipeline-classifier.test.ts`

- [ ] **Step 1: Write failing tests for sort comparators**

Append to `tests/lib/pipeline-classifier.test.ts`:

```typescript
import { sortWonDeals, sortByCloseDate } from '../../src/lib/pipeline-classifier.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/pipeline-classifier.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement sort comparators**

Append to `src/lib/pipeline-classifier.ts`:

```typescript
/**
 * Sort won deals: wonTime descending (most recent first), dealId ascending tie-breaker.
 */
export function sortWonDeals(a: CanonicalDeal, b: CanonicalDeal): number {
  if (a.wonTime && b.wonTime) {
    if (a.wonTime > b.wonTime) return -1;
    if (a.wonTime < b.wonTime) return 1;
  }
  if (a.wonTime && !b.wonTime) return -1;
  if (!a.wonTime && b.wonTime) return 1;
  return a.dealId - b.dealId;
}

/**
 * Sort by expectedCloseDate ascending (soonest first), nulls last, dealId ascending tie-breaker.
 */
export function sortByCloseDate(a: CanonicalDeal, b: CanonicalDeal): number {
  if (a.expectedCloseDate && b.expectedCloseDate) {
    if (a.expectedCloseDate < b.expectedCloseDate) return -1;
    if (a.expectedCloseDate > b.expectedCloseDate) return 1;
  }
  if (a.expectedCloseDate && !b.expectedCloseDate) return -1;
  if (!a.expectedCloseDate && b.expectedCloseDate) return 1;
  return a.dealId - b.dealId;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/pipeline-classifier.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline-classifier.ts tests/lib/pipeline-classifier.test.ts
git commit -m "feat: sort comparators for won-deals and close-date ordering"
```

---

### Task 6: Input Validation

**Files:**
- Create: `src/tools/practice-pipeline.ts`
- Create: `tests/tools/practice-pipeline.test.ts`

- [ ] **Step 1: Write failing tests for validateParams**

```typescript
// tests/tools/practice-pipeline.test.ts
import { describe, it, expect } from 'vitest';
import { validateParams } from '../../src/tools/practice-pipeline.js';

describe('validateParams', () => {
  const validParams = {
    practiceValues: ['Varicent'],
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

  it('accepts valid parameters', () => {
    expect(() => validateParams(validParams)).not.toThrow();
  });

  it('rejects empty practiceValues', () => {
    expect(() => validateParams({ ...validParams, practiceValues: [] }))
      .toThrow('practiceValues must be a non-empty array');
  });

  it('rejects unknown practice values', () => {
    expect(() => validateParams({ ...validParams, practiceValues: ['Variecent'] }))
      .toThrow("Unknown practice value 'Variecent'");
  });

  it('de-duplicates practice values', () => {
    const result = validateParams({ ...validParams, practiceValues: ['Varicent', 'Varicent'] });
    expect(result.practiceValues).toEqual(['Varicent']);
  });

  it('rejects invalid date format', () => {
    expect(() => validateParams({ ...validParams, monthEnd: '2026-2-28' }))
      .toThrow('Invalid date format for monthEnd');
  });

  it('rejects calendar-invalid date', () => {
    expect(() => validateParams({ ...validParams, quarterEnd: '2026-02-31' }))
      .toThrow('Invalid date for quarterEnd');
  });

  it('rejects monthEnd > quarterEnd', () => {
    expect(() => validateParams({ ...validParams, monthEnd: '2026-07-31', quarterEnd: '2026-06-30' }))
      .toThrow('Invalid date range: monthEnd (2026-07-31) is after quarterEnd (2026-06-30)');
  });

  it('rejects nextQuarterStart > nextQuarterEnd', () => {
    expect(() => validateParams({ ...validParams, nextQuarterStart: '2026-10-01', nextQuarterEnd: '2026-09-30' }))
      .toThrow('Invalid date range');
  });

  it('rejects nextMonthEnd > nextThreeMonthsEnd', () => {
    expect(() => validateParams({ ...validParams, nextMonthEnd: '2026-08-31', nextThreeMonthsEnd: '2026-07-31' }))
      .toThrow('Invalid date range');
  });

  it('rejects wonPeriodStart > wonPeriodEnd', () => {
    expect(() => validateParams({ ...validParams, wonPeriodStart: '2026-04-20', wonPeriodEnd: '2026-04-17' }))
      .toThrow('Invalid date range');
  });

  it('rejects wonQuarterStart > wonPeriodStart', () => {
    expect(() => validateParams({ ...validParams, wonQuarterStart: '2026-04-05', wonPeriodStart: '2026-04-01' }))
      .toThrow('Invalid date range');
  });

  it('accepts all five canonical practice values', () => {
    for (const v of ['Varicent', 'Xactly', 'CIQ/Emerging', 'Advisory', 'AI Product']) {
      expect(() => validateParams({ ...validParams, practiceValues: [v] })).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement validateParams**

```typescript
// src/tools/practice-pipeline.ts
import type { ToolDefinition } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { parseStrictDate } from '../lib/date-utils.js';
import type { Logger } from 'pino';

const CANONICAL_PRACTICES = ['Varicent', 'Xactly', 'CIQ/Emerging', 'Advisory', 'AI Product'] as const;
const BHG_PRACTICES_FIELD_LABEL = 'BHG Practices';
const BHG_PIPELINE_NAME = 'BHG Pipeline';

export interface ValidatedParams {
  practiceValues: string[];
  monthEnd: string;
  quarterEnd: string;
  nextQuarterStart: string;
  nextQuarterEnd: string;
  wonPeriodStart: string;
  wonPeriodEnd: string;
  wonQuarterStart: string;
  nextMonthEnd: string;
  nextThreeMonthsEnd: string;
}

/**
 * Validate and normalize input parameters.
 * Fail-fast: presence, format, canonical values, date coherence.
 */
export function validateParams(params: Record<string, unknown>): ValidatedParams {
  // Layer 1: presence and type
  const rawPractices = params.practiceValues;
  if (!Array.isArray(rawPractices) || rawPractices.length === 0) {
    throw new Error('practiceValues must be a non-empty array of strings.');
  }

  // De-duplicate
  const practiceValues = [...new Set(rawPractices as string[])];

  // Layer 2: canonical practice values
  for (const v of practiceValues) {
    if (!(CANONICAL_PRACTICES as readonly string[]).includes(v)) {
      throw new Error(
        `Unknown practice value '${v}'. Valid values: ${CANONICAL_PRACTICES.join(', ')}.`
      );
    }
  }

  // Layer 2: strict date parsing
  const dateFields = [
    'monthEnd', 'quarterEnd', 'nextQuarterStart', 'nextQuarterEnd',
    'wonPeriodStart', 'wonPeriodEnd', 'wonQuarterStart',
    'nextMonthEnd', 'nextThreeMonthsEnd',
  ] as const;

  const dates: Record<string, string> = {};
  for (const field of dateFields) {
    const raw = params[field];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`${field} is required and must be a non-empty string.`);
    }
    dates[field] = parseStrictDate(raw, field);
  }

  // Layer 3: date coherence
  const coherenceChecks: [string, string][] = [
    ['monthEnd', 'quarterEnd'],
    ['nextQuarterStart', 'nextQuarterEnd'],
    ['nextMonthEnd', 'nextThreeMonthsEnd'],
    ['wonPeriodStart', 'wonPeriodEnd'],
    ['wonQuarterStart', 'wonPeriodStart'],
  ];

  for (const [earlier, later] of coherenceChecks) {
    if (dates[earlier] > dates[later]) {
      throw new Error(
        `Invalid date range: ${earlier} (${dates[earlier]}) is after ${later} (${dates[later]}).`
      );
    }
  }

  return {
    practiceValues,
    monthEnd: dates.monthEnd,
    quarterEnd: dates.quarterEnd,
    nextQuarterStart: dates.nextQuarterStart,
    nextQuarterEnd: dates.nextQuarterEnd,
    wonPeriodStart: dates.wonPeriodStart,
    wonPeriodEnd: dates.wonPeriodEnd,
    wonQuarterStart: dates.wonQuarterStart,
    nextMonthEnd: dates.nextMonthEnd,
    nextThreeMonthsEnd: dates.nextThreeMonthsEnd,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/practice-pipeline.ts tests/tools/practice-pipeline.test.ts
git commit -m "feat: input validation with strict date parsing, canonical practice values, and coherence checks"
```

---

### Task 7: Deal Normalization

**Files:**
- Modify: `src/tools/practice-pipeline.ts`
- Modify: `tests/tools/practice-pipeline.test.ts`

- [ ] **Step 1: Write failing tests for normalizeDeal**

Append to `tests/tools/practice-pipeline.test.ts`:

```typescript
import { vi, beforeEach } from 'vitest';
import { normalizeDeal } from '../../src/tools/practice-pipeline.js';

function mockFieldResolver() {
  return {
    resolveInputField: vi.fn((label: string) => {
      if (label === 'BHG Practices') return 'abc_bhg_practices';
      return label;
    }),
    resolveInputValue: vi.fn((_key: string, value: unknown) => {
      // Map practice labels to option IDs (reverse of output)
      const map: Record<string, number> = { Varicent: 10, Xactly: 11 };
      return map[value as string] ?? value;
    }),
    getOutputKey: vi.fn((key: string) => key),
    resolveOutputValue: vi.fn((key: string, value: unknown) => {
      if (key === 'abc_bhg_practices') {
        const map: Record<number, string> = { 10: 'Varicent', 11: 'Xactly' };
        if (typeof value === 'number') return map[value] ?? value;
        if (Array.isArray(value)) return value.map(v => map[v] ?? v);
      }
      if (key === 'label') {
        const map: Record<number, string> = { 42: 'Commit', 43: 'Upside' };
        if (typeof value === 'number') return map[value] ?? value;
      }
      return value;
    }),
    getFieldDefinitions: vi.fn(() => []),
  };
}

function mockPipelineResolver() {
  return {
    resolveStageIdToName: vi.fn((id: number) => {
      const map: Record<number, string> = { 10: 'Qualified', 11: 'Proposal Sent' };
      return map[id] ?? `Stage ${id}`;
    }),
  };
}

describe('normalizeDeal', () => {
  let fieldRes: ReturnType<typeof mockFieldResolver>;
  let pipelineRes: ReturnType<typeof mockPipelineResolver>;

  beforeEach(() => {
    fieldRes = mockFieldResolver();
    pipelineRes = mockPipelineResolver();
  });

  it('normalizes a complete open deal', () => {
    const raw = {
      id: 1, title: 'Test Deal', value: 100000, status: 'open',
      won_time: null, expected_close_date: '2026-05-15',
      stage_id: 11, label_ids: [42], org_name: 'Acme Corp',
      custom_fields: { abc_bhg_practices: 10 },
    };
    const result = normalizeDeal(raw, fieldRes as any, pipelineRes as any, 'abc_bhg_practices');
    expect(result).toEqual({
      dealId: 1, title: 'Test Deal', value: 100000, status: 'open',
      wonTime: null, expectedCloseDate: '2026-05-15',
      stage: 'Proposal Sent', labels: ['Commit'], organization: 'Acme Corp',
      practiceValues: ['Varicent'],
    });
  });

  it('normalizes a won deal with wonTime', () => {
    const raw = {
      id: 2, title: 'Won Deal', value: 50000, status: 'won',
      won_time: '2026-04-10T14:00:00Z', expected_close_date: '2026-04-15',
      stage_id: 10, label_ids: [], org_name: null,
      custom_fields: { abc_bhg_practices: 11 },
    };
    const result = normalizeDeal(raw, fieldRes as any, pipelineRes as any, 'abc_bhg_practices');
    expect(result.status).toBe('won');
    expect(result.wonTime).toBe('2026-04-10T14:00:00Z');
    expect(result.practiceValues).toEqual(['Xactly']);
    expect(result.organization).toBeNull();
  });

  it('returns empty labels when label_ids is empty', () => {
    const raw = {
      id: 3, title: 'No Label', value: 30000, status: 'open',
      won_time: null, expected_close_date: '2026-06-01',
      stage_id: 10, label_ids: [], org_name: 'BigCorp',
      custom_fields: { abc_bhg_practices: 10 },
    };
    const result = normalizeDeal(raw, fieldRes as any, pipelineRes as any, 'abc_bhg_practices');
    expect(result.labels).toEqual([]);
  });

  it('returns empty practiceValues when custom field is missing', () => {
    const raw = {
      id: 4, title: 'No Practice', value: 20000, status: 'open',
      won_time: null, expected_close_date: '2026-06-01',
      stage_id: 10, label_ids: [], org_name: null,
      custom_fields: {},
    };
    const result = normalizeDeal(raw, fieldRes as any, pipelineRes as any, 'abc_bhg_practices');
    expect(result.practiceValues).toEqual([]);
  });

  it('handles missing org_name gracefully', () => {
    const raw = {
      id: 5, title: 'No Org', value: 10000, status: 'open',
      won_time: null, expected_close_date: null,
      stage_id: 10, label_ids: [], org_name: undefined,
      custom_fields: { abc_bhg_practices: 10 },
    };
    const result = normalizeDeal(raw, fieldRes as any, pipelineRes as any, 'abc_bhg_practices');
    expect(result.organization).toBeNull();
    expect(result.expectedCloseDate).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: FAIL — `normalizeDeal` not exported

- [ ] **Step 3: Implement normalizeDeal**

Add to `src/tools/practice-pipeline.ts`:

```typescript
import type { CanonicalDeal } from '../lib/pipeline-classifier.js';

/**
 * Transform a raw Pipedrive v2 deal into a CanonicalDeal.
 * All resolution uses cached reference data — zero per-deal API calls.
 */
export function normalizeDeal(
  raw: Record<string, unknown>,
  fieldResolver: { resolveOutputValue: (key: string, value: unknown) => unknown },
  pipelineResolver: { resolveStageIdToName: (id: number) => string },
  bhgPracticesKey: string,
  logger?: Logger
): CanonicalDeal {
  // Resolve practice values from custom_fields
  const customFields = (raw.custom_fields ?? {}) as Record<string, unknown>;
  const rawPractice = customFields[bhgPracticesKey];
  let practiceValues: string[] = [];
  if (rawPractice != null) {
    const resolved = fieldResolver.resolveOutputValue(bhgPracticesKey, rawPractice);
    if (Array.isArray(resolved)) {
      practiceValues = resolved.filter((v): v is string => typeof v === 'string');
    } else if (typeof resolved === 'string') {
      practiceValues = [resolved];
    }
    // Hard fail if field is populated but unresolvable
    if (practiceValues.length === 0) {
      throw new Error(
        'A deal has an unresolvable BHG Practices value. Field metadata may be inconsistent.'
      );
    }
  }

  // Resolve labels from label_ids
  const rawLabelIds = raw.label_ids;
  const labels: string[] = [];
  if (Array.isArray(rawLabelIds)) {
    for (const id of rawLabelIds) {
      if (id == null) continue;
      try {
        const resolved = fieldResolver.resolveOutputValue('label', id);
        if (typeof resolved === 'string') labels.push(resolved);
      } catch {
        logger?.warn({ labelId: id }, 'Unknown label option ID');
      }
    }
  }

  return {
    dealId: raw.id as number,
    title: (raw.title as string) ?? '',
    value: (raw.value as number) ?? 0,
    status: raw.status as 'open' | 'won',
    wonTime: raw.won_time ? String(raw.won_time) : null,
    expectedCloseDate: raw.expected_close_date ? String(raw.expected_close_date) : null,
    stage: raw.stage_id ? pipelineResolver.resolveStageIdToName(raw.stage_id as number) : '',
    labels,
    organization: (raw.org_name as string) ?? null,
    practiceValues,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/practice-pipeline.ts tests/tools/practice-pipeline.test.ts
git commit -m "feat: deal normalization — transforms raw API response to CanonicalDeal"
```

---

### Task 8: Response Rendering

**Files:**
- Modify: `src/tools/practice-pipeline.ts`
- Modify: `tests/tools/practice-pipeline.test.ts`

- [ ] **Step 1: Write failing tests for renderResponse**

Append to `tests/tools/practice-pipeline.test.ts`:

```typescript
import { renderResponse } from '../../src/tools/practice-pipeline.js';
import type { ClassificationResult } from '../../src/lib/pipeline-classifier.js';
import { createEmptyBucket, addToBucket } from '../../src/lib/pipeline-classifier.js';
import type { CanonicalDeal } from '../../src/lib/pipeline-classifier.js';

function makeDeal(overrides: Partial<CanonicalDeal> = {}): CanonicalDeal {
  return {
    dealId: 1, title: 'Test', value: 50000, status: 'open',
    wonTime: null, expectedCloseDate: '2026-05-15', stage: 'Qualified',
    labels: [], organization: 'Acme', practiceValues: ['Varicent'],
    ...overrides,
  };
}

describe('renderResponse', () => {
  it('renders empty classification result', () => {
    const result: ClassificationResult = {
      month: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      quarter: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      nextQuarter: { commit: createEmptyBucket(), upside: createEmptyBucket() },
      totalOpenPipeline: createEmptyBucket(),
      nextMonthPipeline: createEmptyBucket(),
      nextThreeMonthsPipeline: createEmptyBucket(),
    };
    const response = renderResponse(result, ['Varicent'], '2026-05-31', '2026-07-31');
    expect(response.practiceValues).toEqual(['Varicent']);
    expect(response.pipeline).toBe('BHG Pipeline');
    expect(response.month.won.totalValue).toBe(0);
    expect(response.month.won.deals).toEqual([]);
    expect(response.nextMonthPipeline.periodEnd).toBe('2026-05-31');
    expect(response.nextThreeMonthsPipeline.periodEnd).toBe('2026-07-31');
  });

  it('includes wonTime in won bucket deal details', () => {
    const result: ClassificationResult = {
      month: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      quarter: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      nextQuarter: { commit: createEmptyBucket(), upside: createEmptyBucket() },
      totalOpenPipeline: createEmptyBucket(),
      nextMonthPipeline: createEmptyBucket(),
      nextThreeMonthsPipeline: createEmptyBucket(),
    };
    addToBucket(result.month.won, makeDeal({ dealId: 1, status: 'won', wonTime: '2026-04-10T14:00:00Z' }));
    const response = renderResponse(result, ['Varicent'], '2026-05-31', '2026-07-31');
    expect(response.month.won.deals[0].wonTime).toBe('2026-04-10T14:00:00Z');
    expect(response.month.won.deals[0].expectedCloseDate).toBeUndefined();
  });

  it('includes expectedCloseDate in commit bucket deal details', () => {
    const result: ClassificationResult = {
      month: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      quarter: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      nextQuarter: { commit: createEmptyBucket(), upside: createEmptyBucket() },
      totalOpenPipeline: createEmptyBucket(),
      nextMonthPipeline: createEmptyBucket(),
      nextThreeMonthsPipeline: createEmptyBucket(),
    };
    addToBucket(result.month.commit, makeDeal({ dealId: 2, expectedCloseDate: '2026-04-20', labels: ['Commit'] }));
    const response = renderResponse(result, ['Varicent'], '2026-05-31', '2026-07-31');
    expect(response.month.commit.deals[0].expectedCloseDate).toBe('2026-04-20');
    expect(response.month.commit.deals[0].wonTime).toBeUndefined();
  });

  it('truncates at 50 deals with truncated flag', () => {
    const result: ClassificationResult = {
      month: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      quarter: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      nextQuarter: { commit: createEmptyBucket(), upside: createEmptyBucket() },
      totalOpenPipeline: createEmptyBucket(),
      nextMonthPipeline: createEmptyBucket(),
      nextThreeMonthsPipeline: createEmptyBucket(),
    };
    for (let i = 0; i < 55; i++) {
      addToBucket(result.totalOpenPipeline, makeDeal({ dealId: i, value: 1000, expectedCloseDate: '2026-05-01' }));
    }
    const response = renderResponse(result, ['Varicent'], '2026-05-31', '2026-07-31');
    expect(response.totalOpenPipeline.deals).toHaveLength(50);
    expect(response.totalOpenPipeline.truncated).toBe(true);
    expect(response.totalOpenPipeline.totalValue).toBe(55000);
    expect(response.totalOpenPipeline.dealCount).toBe(55);
  });

  it('omits truncated when exactly 50 deals', () => {
    const result: ClassificationResult = {
      month: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      quarter: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
      nextQuarter: { commit: createEmptyBucket(), upside: createEmptyBucket() },
      totalOpenPipeline: createEmptyBucket(),
      nextMonthPipeline: createEmptyBucket(),
      nextThreeMonthsPipeline: createEmptyBucket(),
    };
    for (let i = 0; i < 50; i++) {
      addToBucket(result.totalOpenPipeline, makeDeal({ dealId: i, value: 1000 }));
    }
    const response = renderResponse(result, ['Varicent'], '2026-05-31', '2026-07-31');
    expect(response.totalOpenPipeline.deals).toHaveLength(50);
    expect(response.totalOpenPipeline.truncated).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: FAIL — `renderResponse` not exported

- [ ] **Step 3: Implement renderResponse**

Add to `src/tools/practice-pipeline.ts`:

```typescript
import type { ClassificationResult, BucketAccumulator } from '../lib/pipeline-classifier.js';
import { sortWonDeals, sortByCloseDate } from '../lib/pipeline-classifier.js';

const MAX_DETAIL_DEALS = 50;

interface DealDetail {
  dealId: number;
  title: string;
  value: number;
  wonTime?: string;
  expectedCloseDate?: string;
  stage: string;
  labels: string[];
  organization: string | null;
}

interface BucketResult {
  totalValue: number;
  dealCount: number;
  deals: DealDetail[];
  truncated?: boolean;
}

interface PipelineHealthBucketResult extends BucketResult {
  periodEnd: string;
}

function renderBucket(
  bucket: BucketAccumulator,
  sortFn: (a: CanonicalDeal, b: CanonicalDeal) => number,
  dateField: 'wonTime' | 'expectedCloseDate'
): BucketResult {
  const sorted = [...bucket.deals].sort(sortFn);
  const truncated = sorted.length > MAX_DETAIL_DEALS;
  const deals: DealDetail[] = sorted.slice(0, MAX_DETAIL_DEALS).map(d => {
    const detail: DealDetail = {
      dealId: d.dealId,
      title: d.title,
      value: d.value,
      stage: d.stage,
      labels: d.labels,
      organization: d.organization,
    };
    if (dateField === 'wonTime') {
      detail.wonTime = d.wonTime ?? undefined;
    } else {
      detail.expectedCloseDate = d.expectedCloseDate ?? undefined;
    }
    return detail;
  });
  return {
    totalValue: bucket.totalValue,
    dealCount: bucket.dealCount,
    deals,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Transform ClassificationResult into the final API response shape.
 */
export function renderResponse(
  result: ClassificationResult,
  practiceValues: string[],
  nextMonthEnd: string,
  nextThreeMonthsEnd: string
): Record<string, unknown> {
  return {
    practiceValues,
    pipeline: 'BHG Pipeline',
    month: {
      won: renderBucket(result.month.won, sortWonDeals, 'wonTime'),
      commit: renderBucket(result.month.commit, sortByCloseDate, 'expectedCloseDate'),
      upside: renderBucket(result.month.upside, sortByCloseDate, 'expectedCloseDate'),
    },
    quarter: {
      won: renderBucket(result.quarter.won, sortWonDeals, 'wonTime'),
      commit: renderBucket(result.quarter.commit, sortByCloseDate, 'expectedCloseDate'),
      upside: renderBucket(result.quarter.upside, sortByCloseDate, 'expectedCloseDate'),
    },
    nextQuarter: {
      commit: renderBucket(result.nextQuarter.commit, sortByCloseDate, 'expectedCloseDate'),
      upside: renderBucket(result.nextQuarter.upside, sortByCloseDate, 'expectedCloseDate'),
    },
    totalOpenPipeline: renderBucket(result.totalOpenPipeline, sortByCloseDate, 'expectedCloseDate'),
    nextMonthPipeline: {
      ...renderBucket(result.nextMonthPipeline, sortByCloseDate, 'expectedCloseDate'),
      periodEnd: nextMonthEnd,
    },
    nextThreeMonthsPipeline: {
      ...renderBucket(result.nextThreeMonthsPipeline, sortByCloseDate, 'expectedCloseDate'),
      periodEnd: nextThreeMonthsEnd,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/practice-pipeline.ts tests/tools/practice-pipeline.test.ts
git commit -m "feat: response rendering with bucket-local sorting, truncation, and periodEnd"
```

---

### Task 9: Tool Handler — Fetch & Wiring

**Files:**
- Modify: `src/tools/practice-pipeline.ts`
- Modify: `tests/tools/practice-pipeline.test.ts`

- [ ] **Step 1: Write failing test for the full handler**

Append to `tests/tools/practice-pipeline.test.ts`:

```typescript
import { createPracticePipelineTools } from '../../src/tools/practice-pipeline.js';
import type { ToolDefinition } from '../../src/types.js';

function mockClient() {
  return { request: vi.fn() };
}

function mockResolverForHandler() {
  const fieldRes = {
    resolveInputField: vi.fn((label: string) => {
      if (label === 'BHG Practices') return 'abc_bhg_practices';
      throw new Error(`Unknown field '${label}'`);
    }),
    resolveInputValue: vi.fn((_key: string, value: unknown) => value),
    getOutputKey: vi.fn((key: string) => key),
    resolveOutputValue: vi.fn((key: string, value: unknown) => {
      if (key === 'abc_bhg_practices') {
        const map: Record<number, string> = { 10: 'Varicent', 11: 'Xactly' };
        if (typeof value === 'number') return map[value] ?? value;
        if (Array.isArray(value)) return value.map(v => map[v] ?? v);
      }
      if (key === 'label') {
        const map: Record<number, string> = { 42: 'Commit', 43: 'Upside' };
        if (typeof value === 'number') return map[value] ?? value;
      }
      return value;
    }),
    getFieldDefinitions: vi.fn(() => []),
  };
  const pipelineRes = {
    resolvePipelineNameToId: vi.fn((name: string) => {
      if (name === 'BHG Pipeline') return 1;
      throw new Error(`No pipeline found matching '${name}'`);
    }),
    resolvePipelineIdToName: vi.fn((id: number) => id === 1 ? 'BHG Pipeline' : `Pipeline ${id}`),
    resolveStageIdToName: vi.fn((id: number) => {
      const map: Record<number, string> = { 10: 'Qualified', 11: 'Proposal Sent', 12: 'Closed Won' };
      return map[id] ?? `Stage ${id}`;
    }),
    resolveStageNameToId: vi.fn(),
    resolveStageGlobally: vi.fn(),
    getPipelines: vi.fn(() => []),
    getStagesForPipeline: vi.fn(() => []),
  };
  return {
    instance: {
      getFieldResolver: vi.fn().mockResolvedValue(fieldRes),
      getUserResolver: vi.fn().mockResolvedValue({ resolveIdToName: vi.fn() }),
      getPipelineResolver: vi.fn().mockResolvedValue(pipelineRes),
    } as any,
    fieldResolver: fieldRes,
    pipelineResolver: pipelineRes,
  };
}

function apiResponse(data: unknown, additionalData?: Record<string, unknown>) {
  return {
    status: 200,
    data: { success: true, data, additional_data: additionalData },
    headers: new Headers(),
  };
}

describe('get-practice-pipeline handler', () => {
  let client: ReturnType<typeof mockClient>;
  let resolverMocks: ReturnType<typeof mockResolverForHandler>;
  let tools: ToolDefinition[];

  function findTool(name: string): ToolDefinition {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`Tool '${name}' not found`);
    return tool;
  }

  beforeEach(() => {
    client = mockClient();
    resolverMocks = mockResolverForHandler();
    tools = createPracticePipelineTools(client as any, resolverMocks.instance);
  });

  it('returns practice pipeline summary for a simple case', async () => {
    // Mock open deals response
    client.request.mockResolvedValueOnce(apiResponse([
      {
        id: 1, title: 'Deal A', value: 100000, status: 'open',
        won_time: null, expected_close_date: '2026-05-15',
        stage_id: 11, label_ids: [42], org_name: 'Acme',
        custom_fields: { abc_bhg_practices: 10 },
      },
    ]));
    // Mock won deals response
    client.request.mockResolvedValueOnce(apiResponse([
      {
        id: 2, title: 'Deal B', value: 50000, status: 'won',
        won_time: '2026-04-10T14:00:00Z', expected_close_date: '2026-04-15',
        stage_id: 12, label_ids: [], org_name: 'BigCorp',
        custom_fields: { abc_bhg_practices: 10 },
      },
    ]));

    const result = await findTool('get-practice-pipeline').handler({
      practiceValues: ['Varicent'],
      monthEnd: '2026-04-30',
      quarterEnd: '2026-06-30',
      nextQuarterStart: '2026-07-01',
      nextQuarterEnd: '2026-09-30',
      wonPeriodStart: '2026-04-01',
      wonPeriodEnd: '2026-04-17',
      wonQuarterStart: '2026-04-01',
      nextMonthEnd: '2026-05-31',
      nextThreeMonthsEnd: '2026-07-31',
    }) as any;

    expect(result.pipeline).toBe('BHG Pipeline');
    expect(result.practiceValues).toEqual(['Varicent']);
    // Won deal in month and quarter
    expect(result.month.won.totalValue).toBe(50000);
    expect(result.quarter.won.totalValue).toBe(50000);
    // Open Commit deal in month.commit, quarter.commit
    expect(result.month.commit.totalValue).toBe(100000);
    expect(result.quarter.commit.totalValue).toBe(100000);
    // Pipeline health
    expect(result.totalOpenPipeline.totalValue).toBe(100000);
    expect(result.nextMonthPipeline.totalValue).toBe(100000);
    expect(result.nextMonthPipeline.periodEnd).toBe('2026-05-31');
    // Verify API was called with correct params
    expect(client.request).toHaveBeenCalledTimes(2);
    const openCall = client.request.mock.calls[0];
    expect(openCall[0]).toBe('GET');
    expect(openCall[1]).toBe('v2');
    expect(openCall[2]).toBe('/deals');
    expect(openCall[4].pipeline_id).toBe('1');
    expect(openCall[4].status).toBe('open');
    expect(openCall[4].limit).toBe('500');
    expect(openCall[4].custom_fields).toContain('abc_bhg_practices');
  });

  it('returns zero-value buckets when no deals match practice', async () => {
    client.request.mockResolvedValueOnce(apiResponse([]));
    client.request.mockResolvedValueOnce(apiResponse([]));

    const result = await findTool('get-practice-pipeline').handler({
      practiceValues: ['Varicent'],
      monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
      nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
      wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
      wonQuarterStart: '2026-04-01',
      nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
    }) as any;

    expect(result.totalOpenPipeline.totalValue).toBe(0);
    expect(result.totalOpenPipeline.dealCount).toBe(0);
    expect(result.month.won.totalValue).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: FAIL — `createPracticePipelineTools` not yet implemented

- [ ] **Step 3: Implement createPracticePipelineTools factory and handler**

Add to `src/tools/practice-pipeline.ts`:

```typescript
import { classifyDeals } from '../lib/pipeline-classifier.js';
import type { CanonicalDeal } from '../lib/pipeline-classifier.js';

/**
 * Paginate through all deals for a given pipeline + status.
 * Continues until the API provides no next cursor.
 */
async function fetchAllDeals(
  client: PipedriveClient,
  pipelineId: number,
  status: string,
  customFieldKeys: string[],
  logger?: Logger
): Promise<Record<string, unknown>[]> {
  const allDeals: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  do {
    const queryParams: Record<string, string> = {
      pipeline_id: String(pipelineId),
      status,
      limit: '500',
    };
    if (customFieldKeys.length > 0) {
      queryParams.custom_fields = customFieldKeys.join(',');
    }
    if (cursor) {
      queryParams.cursor = cursor;
    }

    const response = await normalizeApiCall(
      async () => client.request('GET', 'v2', '/deals', undefined, queryParams),
      undefined, logger
    );

    const respData = (response as any).data;
    const items = Array.isArray(respData.data) ? respData.data : [];
    allDeals.push(...items);

    cursor = respData.additional_data?.next_cursor ?? undefined;
  } while (cursor);

  return allDeals;
}

export function createPracticePipelineTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  logger?: Logger
): ToolDefinition[] {
  return [
    {
      name: 'get-practice-pipeline',
      category: 'read' as const,
      description: 'Returns a practice-level pipeline summary for BHG Pipeline scorecard automation. Aggregates won, committed, upside, and pipeline health metrics by time period for the specified BHG Practices values. Not a general-purpose deal query tool.',
      inputSchema: {
        type: 'object',
        properties: {
          practiceValues: {
            type: 'array',
            items: { type: 'string', enum: [...CANONICAL_PRACTICES] },
            minItems: 1,
            description: 'BHG Practices values to include. Valid: Varicent, Xactly, CIQ/Emerging, Advisory, AI Product.',
          },
          monthEnd: { type: 'string', description: 'Ceiling for month commit/upside (YYYY-MM-DD)' },
          quarterEnd: { type: 'string', description: 'Ceiling for quarter commit/upside (YYYY-MM-DD)' },
          nextQuarterStart: { type: 'string', description: 'Floor for next-quarter commit/upside (YYYY-MM-DD)' },
          nextQuarterEnd: { type: 'string', description: 'Ceiling for next-quarter commit/upside (YYYY-MM-DD)' },
          wonPeriodStart: { type: 'string', description: 'Start of month won window (YYYY-MM-DD)' },
          wonPeriodEnd: { type: 'string', description: 'End of won windows — month and quarter (YYYY-MM-DD)' },
          wonQuarterStart: { type: 'string', description: 'Start of quarter won window (YYYY-MM-DD)' },
          nextMonthEnd: { type: 'string', description: 'Ceiling for next-month pipeline health (YYYY-MM-DD)' },
          nextThreeMonthsEnd: { type: 'string', description: 'Ceiling for next-three-months pipeline health (YYYY-MM-DD)' },
        },
        required: [
          'practiceValues', 'monthEnd', 'quarterEnd', 'nextQuarterStart', 'nextQuarterEnd',
          'wonPeriodStart', 'wonPeriodEnd', 'wonQuarterStart', 'nextMonthEnd', 'nextThreeMonthsEnd',
        ],
      },
      handler: async (params: Record<string, unknown>) => {
        // Phase 0: Validate
        const validated = validateParams(params);

        // Resolve field + pipeline metadata (cached, no API calls)
        const fieldResolver = await resolver.getFieldResolver('deal');
        const pipelineResolver = await resolver.getPipelineResolver();

        // Resolve BHG Practices field key
        let bhgPracticesKey: string;
        try {
          bhgPracticesKey = fieldResolver.resolveInputField(BHG_PRACTICES_FIELD_LABEL);
        } catch {
          throw new Error(
            `Custom field '${BHG_PRACTICES_FIELD_LABEL}' not found on deal fields. Check whether the Pipedrive field was renamed or removed.`
          );
        }

        // Verify requested practice option values exist in metadata
        for (const practice of validated.practiceValues) {
          try {
            fieldResolver.resolveInputValue(bhgPracticesKey, practice);
          } catch {
            throw new Error(
              `BHG Practices option '${practice}' not found in field metadata. Verify the field options still include the expected canonical values.`
            );
          }
        }

        // Resolve pipeline
        let pipelineId: number;
        try {
          pipelineId = pipelineResolver.resolvePipelineNameToId(BHG_PIPELINE_NAME);
        } catch {
          logger?.error({ pipeline: BHG_PIPELINE_NAME }, 'Pipeline not found');
          throw new Error(
            `Pipeline '${BHG_PIPELINE_NAME}' not found. Check whether the pipeline was renamed or removed.`
          );
        }

        // Phase 1: Fetch
        const [rawOpenDeals, rawWonDeals] = await Promise.all([
          fetchAllDeals(client, pipelineId, 'open', [bhgPracticesKey], logger),
          fetchAllDeals(client, pipelineId, 'won', [bhgPracticesKey], logger),
        ]);

        const totalFetched = rawOpenDeals.length + rawWonDeals.length;
        if (totalFetched === 0) {
          logger?.info('No deals found in BHG Pipeline with status open/won');
        }

        // Phase 2: Normalize
        const allDeals: CanonicalDeal[] = [];
        for (const raw of [...rawOpenDeals, ...rawWonDeals]) {
          allDeals.push(normalizeDeal(raw, fieldResolver, pipelineResolver, bhgPracticesKey, logger));
        }

        // Phase 3: Classify
        const classified = classifyDeals(allDeals, validated.practiceValues, validated, logger);

        if (totalFetched > 0 && classified.totalOpenPipeline.dealCount === 0 && classified.quarter.won.dealCount === 0) {
          logger?.info(
            { fetched: totalFetched, practices: validated.practiceValues },
            'Deals fetched from BHG Pipeline but none matched requested practice values'
          );
        }

        // Phase 4: Render
        return renderResponse(classified, validated.practiceValues, validated.nextMonthEnd, validated.nextThreeMonthsEnd);
      },
    },
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/practice-pipeline.ts tests/tools/practice-pipeline.test.ts
git commit -m "feat: get-practice-pipeline tool handler with fetch, normalize, classify, render pipeline"
```

---

### Task 10: Server Registration

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add import and registration**

In `src/server.ts`, add the import after line 19 (after the `createFieldTools` import):

```typescript
import { createPracticePipelineTools } from './tools/practice-pipeline.js';
```

In the `allTools` array (around line 35), add after the `createFieldTools` line:

```typescript
    ...createPracticePipelineTools(client, resolver, logger),
```

Note: This factory takes `(client, resolver, logger)` — no `entityResolver` needed.

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Verify access control isolation**

Check `src/config.ts` to determine whether `isToolEnabled` can isolate `get-practice-pipeline` from general `read`-category tools. If the current model only supports category-level filtering and cannot exclude this tool independently, add a code comment in `server.ts` at the registration line:

```typescript
// DEPLOYMENT RISK: get-practice-pipeline returns aggregated revenue pipeline data and should
// be restricted to trusted scorecard automation. The current access control model (category-level
// only) cannot isolate this tool from general read access. See spec Section 8.
```

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: register get-practice-pipeline tool in MCP server"
```

---

### Task 11: Pagination Tests

**Files:**
- Modify: `tests/tools/practice-pipeline.test.ts`

- [ ] **Step 1: Write pagination tests**

Append to the `get-practice-pipeline handler` describe block in `tests/tools/practice-pipeline.test.ts`:

```typescript
  it('paginates open deals across two pages', async () => {
    // Page 1 of open deals — has next_cursor
    client.request.mockResolvedValueOnce(apiResponse(
      [{ id: 1, title: 'A', value: 50000, status: 'open', won_time: null, expected_close_date: '2026-05-01',
         stage_id: 10, label_ids: [42], org_name: 'X', custom_fields: { abc_bhg_practices: 10 } }],
      { next_cursor: 'page2cursor' }
    ));
    // Page 2 of open deals — no next_cursor
    client.request.mockResolvedValueOnce(apiResponse(
      [{ id: 2, title: 'B', value: 75000, status: 'open', won_time: null, expected_close_date: '2026-05-15',
         stage_id: 11, label_ids: [42], org_name: 'Y', custom_fields: { abc_bhg_practices: 10 } }]
    ));
    // Won deals — single page
    client.request.mockResolvedValueOnce(apiResponse([]));

    const result = await findTool('get-practice-pipeline').handler({
      practiceValues: ['Varicent'],
      monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
      nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
      wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
      wonQuarterStart: '2026-04-01',
      nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
    }) as any;

    // Both open deals should be included
    expect(result.totalOpenPipeline.dealCount).toBe(2);
    expect(result.totalOpenPipeline.totalValue).toBe(125000);
    // Verify cursor was passed on second call
    expect(client.request).toHaveBeenCalledTimes(3); // 2 open pages + 1 won page
    expect(client.request.mock.calls[1][4].cursor).toBe('page2cursor');
  });

  it('paginates won deals across two pages', async () => {
    // Open deals — single page
    client.request.mockResolvedValueOnce(apiResponse([]));
    // Page 1 of won deals — has next_cursor
    client.request.mockResolvedValueOnce(apiResponse(
      [{ id: 1, title: 'Won A', value: 25000, status: 'won', won_time: '2026-04-05T10:00:00Z',
         expected_close_date: '2026-04-01', stage_id: 12, label_ids: [],
         org_name: 'X', custom_fields: { abc_bhg_practices: 10 } }],
      { next_cursor: 'wonpage2' }
    ));
    // Page 2 of won deals — no next_cursor
    client.request.mockResolvedValueOnce(apiResponse(
      [{ id: 2, title: 'Won B', value: 30000, status: 'won', won_time: '2026-04-12T10:00:00Z',
         expected_close_date: '2026-04-10', stage_id: 12, label_ids: [],
         org_name: 'Y', custom_fields: { abc_bhg_practices: 10 } }]
    ));

    const result = await findTool('get-practice-pipeline').handler({
      practiceValues: ['Varicent'],
      monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
      nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
      wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
      wonQuarterStart: '2026-04-01',
      nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
    }) as any;

    expect(result.quarter.won.dealCount).toBe(2);
    expect(result.quarter.won.totalValue).toBe(55000);
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: All tests PASS. If pagination mock ordering doesn't match the Promise.all call order in the handler, adjust mock order — open deals are fetched first.

- [ ] **Step 3: Commit**

```bash
git add tests/tools/practice-pipeline.test.ts
git commit -m "test: pagination tests for multi-page open and won deal fetching"
```

---

### Task 12: Metadata Drift & Edge Case Tests

**Files:**
- Modify: `tests/tools/practice-pipeline.test.ts`

- [ ] **Step 1: Write metadata drift tests**

Append to the `get-practice-pipeline handler` describe block:

```typescript
  describe('metadata drift failures', () => {
    it('fails when BHG Pipeline not found', async () => {
      resolverMocks.pipelineResolver.resolvePipelineNameToId.mockImplementation(() => {
        throw new Error("No pipeline found matching 'BHG Pipeline'");
      });

      await expect(findTool('get-practice-pipeline').handler({
        practiceValues: ['Varicent'],
        monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
        nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
        wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
        wonQuarterStart: '2026-04-01',
        nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
      })).rejects.toThrow("Pipeline 'BHG Pipeline' not found");
    });

    it('fails when BHG Practices field not found', async () => {
      resolverMocks.fieldResolver.resolveInputField.mockImplementation(() => {
        throw new Error('Unknown field');
      });

      await expect(findTool('get-practice-pipeline').handler({
        practiceValues: ['Varicent'],
        monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
        nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
        wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
        wonQuarterStart: '2026-04-01',
        nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
      })).rejects.toThrow("Custom field 'BHG Practices' not found");
    });

    it('fails when label field metadata is unavailable', async () => {
      resolverMocks.fieldResolver.resolveOutputValue.mockImplementation((key: string) => {
        if (key === 'label') throw new Error('Label field not found');
        return undefined;
      });

      client.request.mockResolvedValueOnce(apiResponse([
        {
          id: 1, title: 'Deal', value: 50000, status: 'open',
          won_time: null, expected_close_date: '2026-05-01',
          stage_id: 10, label_ids: [42], org_name: null,
          custom_fields: { abc_bhg_practices: 10 },
        },
      ]));
      client.request.mockResolvedValueOnce(apiResponse([]));

      // Label resolution failure during normalization should be a soft warning (label normalized to empty)
      // The deal still processes — it just has no labels and enters pipeline health buckets only
      const result = await findTool('get-practice-pipeline').handler({
        practiceValues: ['Varicent'],
        monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
        nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
        wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
        wonQuarterStart: '2026-04-01',
        nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
      }) as any;
      expect(result.totalOpenPipeline.dealCount).toBe(1);
      expect(result.month.commit.dealCount).toBe(0); // label unresolved, no commit classification
    });

    it('fails when practice option value missing from metadata', async () => {
      resolverMocks.fieldResolver.resolveInputValue.mockImplementation(() => {
        throw new Error('Option not found');
      });

      await expect(findTool('get-practice-pipeline').handler({
        practiceValues: ['Varicent'],
        monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
        nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
        wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
        wonQuarterStart: '2026-04-01',
        nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
      })).rejects.toThrow("BHG Practices option 'Varicent' not found in field metadata");
    });
  });
```

- [ ] **Step 2: Write edge case tests**

Append to the `get-practice-pipeline handler` describe block:

```typescript
  it('rejects invalid parameters before making API calls', async () => {
    await expect(findTool('get-practice-pipeline').handler({
      practiceValues: [],
      monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
      nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
      wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
      wonQuarterStart: '2026-04-01',
      nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
    })).rejects.toThrow('practiceValues must be a non-empty array');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('handles unresolvable BHG Practices option ID on a deal as hard failure', async () => {
    client.request.mockResolvedValueOnce(apiResponse([
      {
        id: 99, title: 'Bad Deal', value: 10000, status: 'open',
        won_time: null, expected_close_date: '2026-05-01',
        stage_id: 10, label_ids: [], org_name: null,
        custom_fields: { abc_bhg_practices: 999 }, // Unknown option ID
      },
    ]));
    client.request.mockResolvedValueOnce(apiResponse([]));

    // The field resolver returns the raw ID (non-string) for unknown options
    resolverMocks.fieldResolver.resolveOutputValue.mockImplementation((key: string, value: unknown) => {
      if (key === 'abc_bhg_practices' && value === 999) return 999; // non-string = unresolvable
      if (key === 'abc_bhg_practices') {
        const map: Record<number, string> = { 10: 'Varicent', 11: 'Xactly' };
        if (typeof value === 'number') return map[value] ?? value;
      }
      return value;
    });

    await expect(findTool('get-practice-pipeline').handler({
      practiceValues: ['Varicent'],
      monthEnd: '2026-04-30', quarterEnd: '2026-06-30',
      nextQuarterStart: '2026-07-01', nextQuarterEnd: '2026-09-30',
      wonPeriodStart: '2026-04-01', wonPeriodEnd: '2026-04-17',
      wonQuarterStart: '2026-04-01',
      nextMonthEnd: '2026-05-31', nextThreeMonthsEnd: '2026-07-31',
    })).rejects.toThrow('unresolvable BHG Practices value');
  });
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts`
Expected: All tests PASS. Note: the pagination tests depend on `Promise.all` call order in the handler — open deals are fetched first, so open-page mocks must come before won-page mocks. If tests fail due to mock ordering, adjust the handler to use sequential awaits or adjust mock ordering.

- [ ] **Step 4: Commit**

```bash
git add tests/tools/practice-pipeline.test.ts
git commit -m "test: metadata drift hard-failure tests and edge case validation tests"
```

---

### Task 13: Fixture Parity Tests (Tier 3)

**Files:**
- Modify: `tests/tools/practice-pipeline.test.ts`

- [ ] **Step 1: Build synthetic fixture data for Varicent Q2 2026**

This is the highest-value test. Build deterministic mock deals that produce the scorecard expected values for Week 16 ending April 17, 2026.

Append to `tests/tools/practice-pipeline.test.ts`:

```typescript
describe('fixture parity — Week 16 ending April 17, 2026', () => {
  const scorecardParams = {
    practiceValues: ['Varicent'],
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

  function buildVaricentFixture() {
    // Synthetic deals designed to produce exact scorecard values:
    // Quarter Committed = $202,000
    // Quarter Upside = $201,750
    // Next Month Pipeline = $1,301,600
    // Next 3 Months Pipeline = $2,881,750
    return [
      // Committed deals (quarter) — close by 06-30, label=Commit
      { id: 101, title: 'V-Commit-1', value: 120000, status: 'open',
        won_time: null, expected_close_date: '2026-05-15',
        stage_id: 11, label_ids: [42], org_name: 'Client A',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 102, title: 'V-Commit-2', value: 82000, status: 'open',
        won_time: null, expected_close_date: '2026-06-01',
        stage_id: 11, label_ids: [42], org_name: 'Client B',
        custom_fields: { abc_bhg_practices: 10 } },
      // Upside deals (quarter) — close by 06-30, label=Upside
      { id: 103, title: 'V-Upside-1', value: 150000, status: 'open',
        won_time: null, expected_close_date: '2026-05-20',
        stage_id: 10, label_ids: [43], org_name: 'Client C',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 104, title: 'V-Upside-2', value: 51750, status: 'open',
        won_time: null, expected_close_date: '2026-06-15',
        stage_id: 10, label_ids: [43], org_name: 'Client D',
        custom_fields: { abc_bhg_practices: 10 } },
      // Additional open deals for pipeline health (no commit/upside label, or close dates beyond quarter)
      { id: 105, title: 'V-Open-1', value: 500000, status: 'open',
        won_time: null, expected_close_date: '2026-05-10',
        stage_id: 10, label_ids: [], org_name: 'Client E',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 106, title: 'V-Open-2', value: 347850, status: 'open',
        won_time: null, expected_close_date: '2026-05-25',
        stage_id: 10, label_ids: [], org_name: 'Client F',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 107, title: 'V-Open-3', value: 700000, status: 'open',
        won_time: null, expected_close_date: '2026-07-15',
        stage_id: 10, label_ids: [], org_name: 'Client G',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 108, title: 'V-Open-4', value: 880150, status: 'open',
        won_time: null, expected_close_date: '2026-07-30',
        stage_id: 10, label_ids: [], org_name: 'Client H',
        custom_fields: { abc_bhg_practices: 10 } },
    ];
  }

  it('Varicent: Quarter Committed = $202,000', async () => {
    const fixture = buildVaricentFixture();
    client.request.mockResolvedValueOnce(apiResponse(fixture));
    client.request.mockResolvedValueOnce(apiResponse([]));

    const result = await findTool('get-practice-pipeline').handler(scorecardParams) as any;
    expect(result.quarter.commit.totalValue).toBe(202000);
  });

  it('Varicent: Quarter Upside = $201,750', async () => {
    const fixture = buildVaricentFixture();
    client.request.mockResolvedValueOnce(apiResponse(fixture));
    client.request.mockResolvedValueOnce(apiResponse([]));

    const result = await findTool('get-practice-pipeline').handler(scorecardParams) as any;
    expect(result.quarter.upside.totalValue).toBe(201750);
  });

  it('Varicent: Next Month Pipeline = $1,301,600', async () => {
    const fixture = buildVaricentFixture();
    client.request.mockResolvedValueOnce(apiResponse(fixture));
    client.request.mockResolvedValueOnce(apiResponse([]));

    const result = await findTool('get-practice-pipeline').handler(scorecardParams) as any;
    // nextMonthEnd = 2026-05-31 — includes all open deals with expectedCloseDate <= 05-31
    // Fixture values must be calibrated so these deals sum to exactly $1,301,600
    expect(result.nextMonthPipeline.totalValue).toBe(1301600);
  });

  it('Varicent: Next 3 Months Pipeline = $2,881,750', async () => {
    const fixture = buildVaricentFixture();
    client.request.mockResolvedValueOnce(apiResponse(fixture));
    client.request.mockResolvedValueOnce(apiResponse([]));

    const result = await findTool('get-practice-pipeline').handler(scorecardParams) as any;
    expect(result.nextThreeMonthsPipeline.totalValue).toBe(2881750);
  });
});
```

**Implementation note:** The fixture values above are illustrative. The implementer must calibrate the synthetic deal values so that when classified, they produce exactly the scorecard expected totals. This may require iterating: run the test, see the actual total, adjust deal values until the fixture is deterministic. A deal can appear in multiple buckets, so values must account for overlap. Build the fixture by working backwards from the expected totals.

- [ ] **Step 2: Calibrate fixture values to match expected totals**

Run: `npx vitest run tests/tools/practice-pipeline.test.ts -t "fixture parity"`

Adjust the `buildVaricentFixture()` deal values until all four assertions pass. This is iterative — the classification logic is already tested in Tier 1 and 2; this step confirms the fixture is correct.

- [ ] **Step 3: Add remaining practice parity tests**

Once the Varicent fixture pattern is established, add fixtures for Xactly, CaptivateIQ, and Advisory & AI using the same approach:

```typescript
  // --- Xactly fixtures ---
  // Build a separate fixture function for Xactly deals using practice option ID 11.
  // Won deals must sum to $25,600 with wonTime in [wonQuarterStart, wonPeriodEnd].
  // Committed deals must sum to $899,796 with expectedCloseDate <= quarterEnd and label=Commit.
  // Calibrate exact deal values through iterative test runs, same approach as Varicent.

  it('Xactly: Won Pipeline (Quarter) = $25,600', async () => {
    const fixture = [
      { id: 301, title: 'X-Won-1', value: 25600, status: 'won',
        won_time: '2026-04-08T10:00:00Z', expected_close_date: '2026-04-01',
        stage_id: 12, label_ids: [], org_name: 'XClient',
        custom_fields: { abc_bhg_practices: 11 } },
    ];
    client.request.mockResolvedValueOnce(apiResponse([])); // open
    client.request.mockResolvedValueOnce(apiResponse(fixture)); // won
    const result = await findTool('get-practice-pipeline').handler({
      ...scorecardParams, practiceValues: ['Xactly'],
    }) as any;
    expect(result.quarter.won.totalValue).toBe(25600);
  });

  it('Xactly: Committed Deals (Quarter) = $899,796', async () => {
    const fixture = [
      { id: 311, title: 'X-Commit-1', value: 500000, status: 'open',
        won_time: null, expected_close_date: '2026-05-15',
        stage_id: 11, label_ids: [42], org_name: 'XClient A',
        custom_fields: { abc_bhg_practices: 11 } },
      { id: 312, title: 'X-Commit-2', value: 399796, status: 'open',
        won_time: null, expected_close_date: '2026-06-20',
        stage_id: 11, label_ids: [42], org_name: 'XClient B',
        custom_fields: { abc_bhg_practices: 11 } },
    ];
    client.request.mockResolvedValueOnce(apiResponse(fixture)); // open
    client.request.mockResolvedValueOnce(apiResponse([])); // won
    const result = await findTool('get-practice-pipeline').handler({
      ...scorecardParams, practiceValues: ['Xactly'],
    }) as any;
    expect(result.quarter.commit.totalValue).toBe(899796);
  });

  // --- CaptivateIQ fixtures (practice value "CIQ/Emerging", needs its own option ID in mock) ---
  // Implementer: add CIQ/Emerging as option ID 12 in the field resolver mock, then build
  // fixtures for Won Pipeline (Quarter) = $232,536.50 and Next Month Pipeline = $58,000.

  // --- Advisory & AI fixtures (practice values ["Advisory", "AI Product"]) ---
  // Implementer: add Advisory as option ID 13 and AI Product as option ID 14 in the mock, then
  // build fixtures for Won Pipeline (Quarter) = $190,000 and Next Month Pipeline = $250,000.
```

- [ ] **Step 4: Commit**

```bash
git add tests/tools/practice-pipeline.test.ts
git commit -m "test: Tier 3 fixture parity tests against Week 16 scorecard expected values"
```

---

## Execution Notes

**Promise.all mock ordering:** The handler uses `Promise.all` to fetch open and won deals concurrently. `Promise.all` starts both promises immediately, and `vitest`'s `mockResolvedValueOnce` resolves mocks in call order. Since the open fetch is listed first in the `Promise.all` array, it calls `client.request` first. Set up mocks in open-first order. If tests fail due to nondeterministic ordering, switch the handler to sequential `await` (open then won) — correctness matters more than parallelism at ~150 deals.

**Label field key:** The handler resolves labels via `fieldResolver.resolveOutputValue('label', id)`. Verify that `'label'` is the correct field key in the Pipedrive deal fields metadata. If the v2 API uses a different key (e.g., `'label_ids'` mapped differently), adjust during implementation.

**org_name availability:** Verify during Task 9 that the v2 deals response includes `org_name`. If not, set `organization: null` and add a comment documenting the fallback.

**Access control deployment risk:** During Task 10, verify whether the current `isToolEnabled` + `ServerConfig` model can isolate this tool from general read access. If it cannot, add a comment in the registration code flagging this as a deployment risk per the spec.
