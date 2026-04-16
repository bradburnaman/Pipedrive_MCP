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
