// tests/lib/reference-resolver/pipeline-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { PipelineResolver } from '../../../src/lib/reference-resolver/pipeline-resolver.js';
import type { PipedrivePipeline } from '../../../src/types.js';

const MOCK_PIPELINES: PipedrivePipeline[] = [
  {
    id: 1, name: 'Sales', active: true,
    stages: [
      { id: 10, name: 'Qualified', pipeline_id: 1, order_nr: 1, rotten_flag: false, rotten_days: null },
      { id: 11, name: 'Proposal Sent', pipeline_id: 1, order_nr: 2, rotten_flag: true, rotten_days: 14 },
    ],
  },
  {
    id: 2, name: 'Partnerships', active: true,
    stages: [
      { id: 20, name: 'Qualified', pipeline_id: 2, order_nr: 1, rotten_flag: false, rotten_days: null },
      { id: 21, name: 'Negotiation', pipeline_id: 2, order_nr: 2, rotten_flag: false, rotten_days: null },
    ],
  },
];

describe('PipelineResolver', () => {
  const resolver = new PipelineResolver(MOCK_PIPELINES);

  describe('resolvePipelineNameToId', () => {
    it('resolves pipeline name (case-insensitive)', () => {
      expect(resolver.resolvePipelineNameToId('sales')).toBe(1);
      expect(resolver.resolvePipelineNameToId('Partnerships')).toBe(2);
    });

    it('throws on unknown pipeline', () => {
      expect(() => resolver.resolvePipelineNameToId('Unknown')).toThrow(
        "No pipeline found matching 'Unknown'. Available pipelines: Sales, Partnerships"
      );
    });
  });

  describe('resolveStageNameToId', () => {
    it('resolves stage within specified pipeline', () => {
      expect(resolver.resolveStageNameToId('Qualified', 1)).toBe(10);
      expect(resolver.resolveStageNameToId('Qualified', 2)).toBe(20);
    });

    it('throws on unknown stage within pipeline', () => {
      expect(() => resolver.resolveStageNameToId('Nonexistent', 1)).toThrow(
        "No stage 'Nonexistent' found in pipeline 'Sales'. Available stages: Qualified, Proposal Sent"
      );
    });
  });

  describe('resolveStageGlobally', () => {
    it('resolves globally unique stage without pipeline', () => {
      const result = resolver.resolveStageGlobally('Proposal Sent');
      expect(result).toEqual({ stageId: 11, pipelineId: 1, pipelineName: 'Sales' });
    });

    it('throws on ambiguous stage', () => {
      expect(() => resolver.resolveStageGlobally('Qualified')).toThrow(
        "Stage 'Qualified' exists in multiple pipelines: Sales, Partnerships. Specify a pipeline to disambiguate."
      );
    });

    it('throws on unknown stage', () => {
      expect(() => resolver.resolveStageGlobally('Nonexistent')).toThrow(
        "No stage found matching 'Nonexistent' in any pipeline."
      );
    });
  });

  describe('resolveStageIdToName', () => {
    it('resolves stage ID to name', () => {
      expect(resolver.resolveStageIdToName(10)).toBe('Qualified');
      expect(resolver.resolveStageIdToName(11)).toBe('Proposal Sent');
    });

    it('returns ID as string for unknown stage', () => {
      expect(resolver.resolveStageIdToName(999)).toBe('Stage 999');
    });
  });

  describe('resolvePipelineIdToName', () => {
    it('resolves pipeline ID to name', () => {
      expect(resolver.resolvePipelineIdToName(1)).toBe('Sales');
    });

    it('returns ID as string for unknown pipeline', () => {
      expect(resolver.resolvePipelineIdToName(999)).toBe('Pipeline 999');
    });
  });

  it('returns all pipelines', () => {
    expect(resolver.getPipelines()).toHaveLength(2);
  });

  it('returns stages for a pipeline', () => {
    expect(resolver.getStagesForPipeline(1)).toHaveLength(2);
    expect(resolver.getStagesForPipeline(999)).toEqual([]);
  });
});
