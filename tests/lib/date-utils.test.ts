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
