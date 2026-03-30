// tests/tools/pipelines.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPipelineTools } from '../../src/tools/pipelines.js';

function mockResolver() {
  return {
    getPipelineResolver: vi.fn().mockResolvedValue({
      getPipelines: () => [
        {
          id: 1, name: 'Sales', active: true,
          stages: [
            { id: 10, name: 'Qualified', pipeline_id: 1, order_nr: 1, rotten_flag: false, rotten_days: null },
            { id: 11, name: 'Proposal Sent', pipeline_id: 1, order_nr: 2, rotten_flag: true, rotten_days: 14 },
          ],
        },
      ],
      resolvePipelineNameToId: (name: string) => {
        if (name.toLowerCase() === 'sales') return 1;
        throw new Error(`No pipeline found matching '${name}'`);
      },
      getStagesForPipeline: (id: number) => {
        if (id === 1) return [
          { id: 10, name: 'Qualified', pipeline_id: 1, order_nr: 1, rotten_flag: false, rotten_days: null },
          { id: 11, name: 'Proposal Sent', pipeline_id: 1, order_nr: 2, rotten_flag: true, rotten_days: 14 },
        ];
        return [];
      },
    }),
  } as any;
}

describe('pipeline tools', () => {
  it('list-pipelines returns all pipelines with stages', async () => {
    const tools = createPipelineTools(mockResolver());
    const listTool = tools.find(t => t.name === 'list-pipelines')!;
    const result = await listTool.handler({});
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Sales');
    expect(result[0].stages).toHaveLength(2);
  });

  it('list-stages returns stages for a pipeline', async () => {
    const tools = createPipelineTools(mockResolver());
    const stageTool = tools.find(t => t.name === 'list-stages')!;
    const result = await stageTool.handler({ pipeline: 'Sales' });
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Qualified');
  });

  it('list-stages throws on unknown pipeline', async () => {
    const tools = createPipelineTools(mockResolver());
    const stageTool = tools.find(t => t.name === 'list-stages')!;
    await expect(stageTool.handler({ pipeline: 'Unknown' })).rejects.toThrow(/No pipeline found/);
  });
});
