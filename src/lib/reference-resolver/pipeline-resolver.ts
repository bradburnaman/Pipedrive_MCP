// src/lib/reference-resolver/pipeline-resolver.ts
import type { PipedrivePipeline, PipedriveStage } from '../../types.js';

export class PipelineResolver {
  private pipelines: PipedrivePipeline[];
  private pipelineNameToId: Map<string, number>;
  private pipelineIdToName: Map<number, string>;
  private stageIdToName: Map<number, string>;
  private stagesByPipeline: Map<number, PipedriveStage[]>;

  constructor(pipelines: PipedrivePipeline[]) {
    this.pipelines = pipelines;
    this.pipelineNameToId = new Map();
    this.pipelineIdToName = new Map();
    this.stageIdToName = new Map();
    this.stagesByPipeline = new Map();

    for (const pipeline of pipelines) {
      this.pipelineNameToId.set(pipeline.name.toLowerCase(), pipeline.id);
      this.pipelineIdToName.set(pipeline.id, pipeline.name);
      this.stagesByPipeline.set(pipeline.id, pipeline.stages);
      for (const stage of pipeline.stages) {
        this.stageIdToName.set(stage.id, stage.name);
      }
    }
  }

  resolvePipelineNameToId(name: string): number {
    const id = this.pipelineNameToId.get(name.toLowerCase());
    if (id !== undefined) return id;

    const available = this.pipelines.map(p => p.name).join(', ');
    throw new Error(`No pipeline found matching '${name}'. Available pipelines: ${available}`);
  }

  resolvePipelineIdToName(id: number): string {
    return this.pipelineIdToName.get(id) ?? `Pipeline ${id}`;
  }

  resolveStageNameToId(stageName: string, pipelineId: number): number {
    const stages = this.stagesByPipeline.get(pipelineId) ?? [];
    const stage = stages.find(s => s.name.toLowerCase() === stageName.toLowerCase());
    if (stage) return stage.id;

    const pipelineName = this.resolvePipelineIdToName(pipelineId);
    const available = stages.map(s => s.name).join(', ');
    throw new Error(
      `No stage '${stageName}' found in pipeline '${pipelineName}'. Available stages: ${available}`
    );
  }

  resolveStageGlobally(stageName: string): { stageId: number; pipelineId: number; pipelineName: string } {
    const matches: { stageId: number; pipelineId: number; pipelineName: string }[] = [];

    for (const pipeline of this.pipelines) {
      for (const stage of pipeline.stages) {
        if (stage.name.toLowerCase() === stageName.toLowerCase()) {
          matches.push({
            stageId: stage.id,
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
          });
        }
      }
    }

    if (matches.length === 0) {
      throw new Error(`No stage found matching '${stageName}' in any pipeline.`);
    }

    if (matches.length === 1) {
      return matches[0];
    }

    const pipelineNames = matches.map(m => m.pipelineName).join(', ');
    throw new Error(
      `Stage '${stageName}' exists in multiple pipelines: ${pipelineNames}. Specify a pipeline to disambiguate.`
    );
  }

  resolveStageIdToName(id: number): string {
    return this.stageIdToName.get(id) ?? `Stage ${id}`;
  }

  getPipelines(): PipedrivePipeline[] {
    return this.pipelines;
  }

  getStagesForPipeline(pipelineId: number): PipedriveStage[] {
    return this.stagesByPipeline.get(pipelineId) ?? [];
  }
}
