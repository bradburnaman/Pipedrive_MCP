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

  it('rejects non-string entries in practiceValues', () => {
    expect(() => validateParams({ ...validParams, practiceValues: [123] }))
      .toThrow('practiceValues must contain only strings');
    expect(() => validateParams({ ...validParams, practiceValues: [null] }))
      .toThrow('practiceValues must contain only strings');
    expect(() => validateParams({ ...validParams, practiceValues: ['Varicent', 42] }))
      .toThrow('practiceValues must contain only strings');
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
