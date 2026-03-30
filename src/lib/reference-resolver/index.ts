// src/lib/reference-resolver/index.ts
import { StaleWhileRevalidateCache } from './cache.js';
import { FieldResolver } from './field-resolver.js';
import { UserResolver } from './user-resolver.js';
import { PipelineResolver } from './pipeline-resolver.js';
import { ActivityTypeResolver } from './activity-types.js';
import type { ActivityType } from './activity-types.js';
import type { FieldDefinition, PipedriveUser, PipedrivePipeline, PipedriveStage } from '../../types.js';
import type { PipedriveClient } from '../pipedrive-client.js';
import { normalizeApiCall } from '../error-normalizer.js';
import type { Logger } from 'pino';

const FIELD_TTL = 5 * 60 * 1000;       // 5 minutes
const USER_TTL = 30 * 60 * 1000;       // 30 minutes
const PIPELINE_TTL = 30 * 60 * 1000;   // 30 minutes
const ACTIVITY_TYPE_TTL = 30 * 60 * 1000;

// System fields for each resource type — these cannot be overridden by custom field labels
const DEAL_SYSTEM_FIELDS = new Set([
  'id', 'title', 'value', 'currency', 'status', 'pipeline_id', 'stage_id',
  'user_id', 'person_id', 'org_id', 'expected_close_date', 'add_time', 'update_time',
  'won_time', 'lost_time', 'close_time', 'lost_reason', 'visible_to',
]);

const PERSON_SYSTEM_FIELDS = new Set([
  'id', 'name', 'email', 'phone', 'org_id', 'user_id', 'add_time', 'update_time', 'visible_to',
]);

const ORG_SYSTEM_FIELDS = new Set([
  'id', 'name', 'owner_id', 'address', 'add_time', 'update_time', 'visible_to',
]);

const SYSTEM_FIELDS_MAP: Record<string, Set<string>> = {
  deal: DEAL_SYSTEM_FIELDS,
  person: PERSON_SYSTEM_FIELDS,
  organization: ORG_SYSTEM_FIELDS,
  activity: new Set(['id', 'type', 'subject', 'due_date', 'due_time', 'duration',
    'deal_id', 'person_id', 'org_id', 'user_id', 'note', 'done', 'add_time', 'update_time']),
};

export type ResourceType = 'deal' | 'person' | 'organization' | 'activity';

export class ReferenceResolver {
  private client: PipedriveClient;
  private logger: Logger;

  // Field resolvers — track { resolver, data } pairs to detect cache refreshes
  private fieldCaches: Map<ResourceType, StaleWhileRevalidateCache<FieldDefinition[]>>;
  private fieldResolvers: Map<ResourceType, { resolver: FieldResolver; data: FieldDefinition[] }>;

  // User resolver
  private userCache: StaleWhileRevalidateCache<PipedriveUser[]>;
  private userState: { resolver: UserResolver; data: PipedriveUser[] } | null = null;

  // Pipeline resolver
  private pipelineCache: StaleWhileRevalidateCache<PipedrivePipeline[]>;
  private pipelineState: { resolver: PipelineResolver; data: PipedrivePipeline[] } | null = null;

  // Activity type resolver
  private activityTypeCache: StaleWhileRevalidateCache<ActivityType[]>;
  private activityTypeState: { resolver: ActivityTypeResolver; data: ActivityType[] } | null = null;

  constructor(client: PipedriveClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
    this.fieldCaches = new Map();
    this.fieldResolvers = new Map();

    // Initialize field caches per resource type — logger passed so background refresh failures are logged
    for (const type of ['deal', 'person', 'organization', 'activity'] as ResourceType[]) {
      this.fieldCaches.set(
        type,
        new StaleWhileRevalidateCache(() => this.fetchFields(type), FIELD_TTL, logger)
      );
    }

    this.userCache = new StaleWhileRevalidateCache(() => this.fetchUsers(), USER_TTL, logger);
    this.pipelineCache = new StaleWhileRevalidateCache(() => this.fetchPipelines(), PIPELINE_TTL, logger);
    this.activityTypeCache = new StaleWhileRevalidateCache(() => this.fetchActivityTypes(), ACTIVITY_TYPE_TTL, logger);
  }

  // Lazy initialization — no eager cache priming on startup.
  // Caches are populated on first access via StaleWhileRevalidateCache.get().
  // The startup validation call (GET /users/me) already confirms the token works.

  async getFieldResolver(type: ResourceType): Promise<FieldResolver> {
    const cache = this.fieldCaches.get(type)!;
    const fields = await cache.get();
    const existing = this.fieldResolvers.get(type);
    // Rebuild resolver if data reference changed (cache was refreshed in background)
    if (!existing || existing.data !== fields) {
      const systemFields = SYSTEM_FIELDS_MAP[type] ?? new Set();
      const resolver = new FieldResolver(fields, systemFields);
      this.fieldResolvers.set(type, { resolver, data: fields });
      return resolver;
    }
    return existing.resolver;
  }

  async getUserResolver(): Promise<UserResolver> {
    const users = await this.userCache.get();
    // Rebuild resolver if data reference changed (cache was refreshed in background)
    if (!this.userState || this.userState.data !== users) {
      this.userState = { resolver: new UserResolver(users), data: users };
    }
    return this.userState.resolver;
  }

  async getPipelineResolver(): Promise<PipelineResolver> {
    const pipelines = await this.pipelineCache.get();
    // Rebuild resolver if data reference changed (cache was refreshed in background)
    if (!this.pipelineState || this.pipelineState.data !== pipelines) {
      this.pipelineState = { resolver: new PipelineResolver(pipelines), data: pipelines };
    }
    return this.pipelineState.resolver;
  }

  async getActivityTypeResolver(): Promise<ActivityTypeResolver> {
    const types = await this.activityTypeCache.get();
    // Rebuild resolver if data reference changed (cache was refreshed in background)
    if (!this.activityTypeState || this.activityTypeState.data !== types) {
      this.activityTypeState = { resolver: new ActivityTypeResolver(types), data: types };
    }
    return this.activityTypeState.resolver;
  }

  // --- Fetch methods (called by caches) ---

  private async fetchFields(type: ResourceType): Promise<FieldDefinition[]> {
    const endpoint = `/${type}Fields`;
    const result = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', endpoint) as any,
      undefined, this.logger
    );
    const data = (result as any).data;
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error(`Failed to fetch ${type} fields`);
    }
    return data.data.map((f: any) => ({
      key: f.key,
      name: f.name,
      field_type: f.field_type,
      options: f.options ?? undefined,
      max_length: f.max_length ?? undefined,
    }));
  }

  private async fetchUsers(): Promise<PipedriveUser[]> {
    const result = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', '/users') as any,
      undefined, this.logger
    );
    const data = (result as any).data;
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error('Failed to fetch users');
    }
    return data.data.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      active: u.active_flag,
    }));
  }

  private async fetchPipelines(): Promise<PipedrivePipeline[]> {
    // Fetch all pipelines
    const pipelinesResult = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', '/pipelines') as any,
      undefined, this.logger
    );
    const pipelinesData = (pipelinesResult as any).data;
    if (!pipelinesData.success || !Array.isArray(pipelinesData.data)) {
      throw new Error('Failed to fetch pipelines');
    }

    // Fetch ALL stages in one call (no pipeline_id filter) — avoids N+1
    const stagesResult = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', '/stages') as any,
      undefined, this.logger
    );
    const stagesData = (stagesResult as any).data;
    const allStages: PipedriveStage[] = Array.isArray(stagesData.data)
      ? stagesData.data.map((s: any) => ({
          id: s.id,
          name: s.name,
          pipeline_id: s.pipeline_id,
          order_nr: s.order_nr,
          rotten_flag: s.rotten_flag,
          rotten_days: s.rotten_days,
        }))
      : [];

    // Group stages by pipeline
    const stagesByPipeline = new Map<number, PipedriveStage[]>();
    for (const stage of allStages) {
      const list = stagesByPipeline.get(stage.pipeline_id) ?? [];
      list.push(stage);
      stagesByPipeline.set(stage.pipeline_id, list);
    }

    return pipelinesData.data.map((p: any) => ({
      id: p.id,
      name: p.name,
      active: p.active_flag,
      stages: stagesByPipeline.get(p.id) ?? [],
    }));
  }

  private async fetchActivityTypes(): Promise<ActivityType[]> {
    const result = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', '/activityTypes') as any,
      undefined, this.logger
    );
    const data = (result as any).data;
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error('Failed to fetch activity types');
    }
    return data.data;
  }
}
