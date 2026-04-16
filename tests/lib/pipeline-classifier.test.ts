import { describe, it, expect } from 'vitest';
import { classifyLabel, practiceMatches } from '../../src/lib/pipeline-classifier.js';
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
