import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateParams, normalizeDeal } from '../../src/tools/practice-pipeline.js';

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

function mockFieldResolver() {
  return {
    resolveInputField: vi.fn((label: string) => {
      if (label === 'BHG Practices') return 'abc_bhg_practices';
      return label;
    }),
    resolveInputValue: vi.fn((_key: string, value: unknown) => {
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

  it('renders truncated bucket (already finalized by classifier)', () => {
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
    result.totalOpenPipeline.deals.length = 50;
    result.totalOpenPipeline.truncated = true;
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
