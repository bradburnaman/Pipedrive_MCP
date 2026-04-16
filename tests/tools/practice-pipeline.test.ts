import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateParams, normalizeDeal, renderResponse } from '../../src/tools/practice-pipeline.js';
import { createPracticePipelineTools } from '../../src/tools/practice-pipeline.js';
import type { ToolDefinition } from '../../src/types.js';
import type { ClassificationResult, CanonicalDeal } from '../../src/lib/pipeline-classifier.js';
import { createEmptyBucket, addToBucket } from '../../src/lib/pipeline-classifier.js';

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

// ──────────────────────────────────────────────────────────────────────
// Handler integration tests
// ──────────────────────────────────────────────────────────────────────

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
    // Open Commit deal: expected_close_date 2026-05-15 > monthEnd 2026-04-30, so NOT in month.commit
    expect(result.month.commit.totalValue).toBe(0);
    // But within quarterEnd 2026-06-30, so in quarter.commit
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
      resolverMocks.fieldResolver.resolveOutputValue.mockImplementation((key: string, value: unknown) => {
        if (key === 'label') throw new Error('Label field not found');
        if (key === 'abc_bhg_practices') {
          const map: Record<number, string> = { 10: 'Varicent', 11: 'Xactly' };
          if (typeof value === 'number') return map[value] ?? value;
          if (Array.isArray(value)) return value.map((v: number) => map[v] ?? v);
        }
        return value;
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
    })).rejects.toThrow('Pipeline data configuration error');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Fixture parity tests — deterministic mock deals producing exact totals
// ──────────────────────────────────────────────────────────────────────

describe('fixture parity — Week 16 ending April 17, 2026', () => {
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

  // ── Varicent fixture ───────────────────────────────────────────────
  // Calibrated deal values:
  //   Quarter Committed: 120000 + 82000 = 202000
  //   Quarter Upside:    150000 + 51750 = 201750
  //   nextMonth (<=05-31): 120000+150000+500000+531600 = 1301600
  //   nextThree (<=07-31): 120000+82000+150000+51750+500000+531600+700000+746400 = 2881750

  function buildVaricentFixture() {
    return [
      { id: 101, title: 'V-Commit-1', value: 120000, status: 'open',
        won_time: null, expected_close_date: '2026-05-15',
        stage_id: 11, label_ids: [42], org_name: 'Varicent Client A',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 102, title: 'V-Commit-2', value: 82000, status: 'open',
        won_time: null, expected_close_date: '2026-06-01',
        stage_id: 11, label_ids: [42], org_name: 'Varicent Client B',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 103, title: 'V-Upside-1', value: 150000, status: 'open',
        won_time: null, expected_close_date: '2026-05-20',
        stage_id: 10, label_ids: [43], org_name: 'Varicent Client C',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 104, title: 'V-Upside-2', value: 51750, status: 'open',
        won_time: null, expected_close_date: '2026-06-15',
        stage_id: 10, label_ids: [43], org_name: 'Varicent Client D',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 105, title: 'V-Open-1', value: 500000, status: 'open',
        won_time: null, expected_close_date: '2026-05-10',
        stage_id: 10, label_ids: [], org_name: 'Varicent Client E',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 106, title: 'V-Open-2', value: 531600, status: 'open',
        won_time: null, expected_close_date: '2026-05-25',
        stage_id: 10, label_ids: [], org_name: 'Varicent Client F',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 107, title: 'V-Open-3', value: 700000, status: 'open',
        won_time: null, expected_close_date: '2026-07-15',
        stage_id: 10, label_ids: [], org_name: 'Varicent Client G',
        custom_fields: { abc_bhg_practices: 10 } },
      { id: 108, title: 'V-Open-4', value: 746400, status: 'open',
        won_time: null, expected_close_date: '2026-07-30',
        stage_id: 10, label_ids: [], org_name: 'Varicent Client H',
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
    expect(result.nextMonthPipeline.totalValue).toBe(1301600);
  });

  it('Varicent: Next 3 Months Pipeline = $2,881,750', async () => {
    const fixture = buildVaricentFixture();
    client.request.mockResolvedValueOnce(apiResponse(fixture));
    client.request.mockResolvedValueOnce(apiResponse([]));
    const result = await findTool('get-practice-pipeline').handler(scorecardParams) as any;
    expect(result.nextThreeMonthsPipeline.totalValue).toBe(2881750);
  });

  // ── Xactly fixtures ───────────────────────────────────────────────

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

  // ── CIQ/Emerging fixtures ─────────────────────────────────────────

  /** Override resolveOutputValue to handle CIQ option ID 12 */
  function overrideResolverForCIQ() {
    resolverMocks.fieldResolver.resolveOutputValue.mockImplementation((key: string, value: unknown) => {
      if (key === 'abc_bhg_practices') {
        const map: Record<number, string> = { 10: 'Varicent', 11: 'Xactly', 12: 'CIQ/Emerging' };
        if (typeof value === 'number') return map[value] ?? value;
        if (Array.isArray(value)) return value.map((v: number) => map[v] ?? v);
      }
      if (key === 'label') {
        const map: Record<number, string> = { 42: 'Commit', 43: 'Upside' };
        if (typeof value === 'number') return map[value] ?? value;
      }
      return value;
    });
  }

  it('CIQ/Emerging: Won Pipeline (Quarter) = $232,536.50', async () => {
    overrideResolverForCIQ();

    const wonFixture = [
      { id: 401, title: 'CIQ-Won-1', value: 150000, status: 'won',
        won_time: '2026-04-03T10:00:00Z', expected_close_date: '2026-04-01',
        stage_id: 12, label_ids: [], org_name: 'CIQClient A',
        custom_fields: { abc_bhg_practices: 12 } },
      { id: 402, title: 'CIQ-Won-2', value: 82536.50, status: 'won',
        won_time: '2026-04-15T10:00:00Z', expected_close_date: '2026-04-10',
        stage_id: 12, label_ids: [], org_name: 'CIQClient B',
        custom_fields: { abc_bhg_practices: 12 } },
    ];
    client.request.mockResolvedValueOnce(apiResponse([])); // open
    client.request.mockResolvedValueOnce(apiResponse(wonFixture)); // won
    const result = await findTool('get-practice-pipeline').handler({
      ...scorecardParams, practiceValues: ['CIQ/Emerging'],
    }) as any;
    expect(result.quarter.won.totalValue).toBe(232536.50);
  });

  it('CIQ/Emerging: Next Month Pipeline = $58,000', async () => {
    overrideResolverForCIQ();

    const openFixture = [
      { id: 411, title: 'CIQ-Open-1', value: 35000, status: 'open',
        won_time: null, expected_close_date: '2026-05-01',
        stage_id: 10, label_ids: [], org_name: 'CIQClient C',
        custom_fields: { abc_bhg_practices: 12 } },
      { id: 412, title: 'CIQ-Open-2', value: 23000, status: 'open',
        won_time: null, expected_close_date: '2026-05-20',
        stage_id: 10, label_ids: [], org_name: 'CIQClient D',
        custom_fields: { abc_bhg_practices: 12 } },
    ];
    client.request.mockResolvedValueOnce(apiResponse(openFixture)); // open
    client.request.mockResolvedValueOnce(apiResponse([])); // won
    const result = await findTool('get-practice-pipeline').handler({
      ...scorecardParams, practiceValues: ['CIQ/Emerging'],
    }) as any;
    expect(result.nextMonthPipeline.totalValue).toBe(58000);
  });

  // ── Advisory & AI Product fixtures ─────────────────────────────────

  /** Override resolveOutputValue to handle Advisory (13) and AI Product (14) */
  function overrideResolverForAdvisoryAI() {
    resolverMocks.fieldResolver.resolveOutputValue.mockImplementation((key: string, value: unknown) => {
      if (key === 'abc_bhg_practices') {
        const map: Record<number, string> = { 10: 'Varicent', 11: 'Xactly', 13: 'Advisory', 14: 'AI Product' };
        if (typeof value === 'number') return map[value] ?? value;
        if (Array.isArray(value)) return value.map((v: number) => map[v] ?? v);
      }
      if (key === 'label') {
        const map: Record<number, string> = { 42: 'Commit', 43: 'Upside' };
        if (typeof value === 'number') return map[value] ?? value;
      }
      return value;
    });
  }

  it('Advisory & AI Product: Won Pipeline (Quarter) = $190,000', async () => {
    overrideResolverForAdvisoryAI();

    const wonFixture = [
      { id: 501, title: 'Adv-Won-1', value: 120000, status: 'won',
        won_time: '2026-04-07T10:00:00Z', expected_close_date: '2026-04-01',
        stage_id: 12, label_ids: [], org_name: 'AdvClient',
        custom_fields: { abc_bhg_practices: 13 } },
      { id: 502, title: 'AI-Won-1', value: 70000, status: 'won',
        won_time: '2026-04-14T10:00:00Z', expected_close_date: '2026-04-10',
        stage_id: 12, label_ids: [], org_name: 'AIClient',
        custom_fields: { abc_bhg_practices: 14 } },
    ];
    client.request.mockResolvedValueOnce(apiResponse([])); // open
    client.request.mockResolvedValueOnce(apiResponse(wonFixture)); // won
    const result = await findTool('get-practice-pipeline').handler({
      ...scorecardParams, practiceValues: ['Advisory', 'AI Product'],
    }) as any;
    expect(result.quarter.won.totalValue).toBe(190000);
  });

  it('Advisory & AI Product: Next Month Pipeline = $250,000', async () => {
    overrideResolverForAdvisoryAI();

    const openFixture = [
      { id: 511, title: 'Adv-Open-1', value: 150000, status: 'open',
        won_time: null, expected_close_date: '2026-05-15',
        stage_id: 10, label_ids: [], org_name: 'AdvClient B',
        custom_fields: { abc_bhg_practices: 13 } },
      { id: 512, title: 'AI-Open-1', value: 100000, status: 'open',
        won_time: null, expected_close_date: '2026-05-28',
        stage_id: 10, label_ids: [], org_name: 'AIClient B',
        custom_fields: { abc_bhg_practices: 14 } },
    ];
    client.request.mockResolvedValueOnce(apiResponse(openFixture)); // open
    client.request.mockResolvedValueOnce(apiResponse([])); // won
    const result = await findTool('get-practice-pipeline').handler({
      ...scorecardParams, practiceValues: ['Advisory', 'AI Product'],
    }) as any;
    expect(result.nextMonthPipeline.totalValue).toBe(250000);
  });
});
