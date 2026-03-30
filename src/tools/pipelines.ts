// src/tools/pipelines.ts
import type { ToolDefinition } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';

export function createPipelineTools(resolver: ReferenceResolver): ToolDefinition[] {
  return [
    {
      name: 'list-pipelines',
      category: 'read',
      description: 'List all pipelines with their stages. Read-only — pipeline configuration changes should be made in Pipedrive UI.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        const pipelineResolver = await resolver.getPipelineResolver();
        const pipelines = pipelineResolver.getPipelines();
        return pipelines.map(p => ({
          id: p.id,
          name: p.name,
          active: p.active,
          stages: p.stages.map(s => ({
            id: s.id,
            name: s.name,
            order: s.order_nr,
            rotten_flag: s.rotten_flag,
            rotten_days: s.rotten_days,
          })),
        }));
      },
    },
    {
      name: 'list-stages',
      category: 'read',
      description: "List stages for a given pipeline by name or ID, including stage order and rotten-day settings. Example: pipeline 'Sales'.",
      inputSchema: {
        type: 'object',
        properties: {
          pipeline: {
            type: 'string',
            description: "Pipeline name or ID, e.g. 'Sales'",
          },
        },
        required: ['pipeline'],
      },
      handler: async (params: Record<string, unknown>) => {
        const pipeline = params.pipeline as string;
        const pipelineResolver = await resolver.getPipelineResolver();

        // Resolve pipeline name to ID
        let pipelineId: number;
        const asNum = Number(pipeline);
        if (!isNaN(asNum) && String(asNum) === String(pipeline).trim()) {
          pipelineId = asNum;
        } else {
          pipelineId = pipelineResolver.resolvePipelineNameToId(pipeline);
        }

        const stages = pipelineResolver.getStagesForPipeline(pipelineId);
        return stages.map(s => ({
          id: s.id,
          name: s.name,
          order: s.order_nr,
          rotten_flag: s.rotten_flag,
          rotten_days: s.rotten_days,
        }));
      },
    },
  ];
}
