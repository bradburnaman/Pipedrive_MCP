# Implementation Plan — Fixes and Completions

> **Context:** This document amends `2026-03-30-pipedrive-mcp-implementation.md`. Apply these fixes to the corresponding tasks. Where a task is listed here, this version supersedes the original.

---

## Fix 1: Error Normalizer — Add 429 Retry + Fix ApiResponse Type

**Replaces:** Task 7, Steps 1 and 3

The `ApiResponse` interface must include headers so the 429 handler can read rate limit reset info. The normalizer must retry on 429 (waiting for the reset period).

### Fixed error-normalizer.ts

```typescript
// src/lib/error-normalizer.ts
import type { PipedriveApiError } from '../types.js';
import type { Logger } from 'pino';

interface ApiResponse {
  status: number;
  data: unknown;
  headers?: Headers;
}

interface ErrorContext {
  entity?: string;
  id?: number;
}

const ERROR_MESSAGES: Record<number, string> = {
  401: 'API token is invalid. Restart the server with a valid token.',
  402: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.',
  403: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.',
  500: 'Pipedrive API error. Try again.',
  502: 'Pipedrive API is temporarily unavailable. Try again.',
  503: 'Pipedrive API is temporarily unavailable. Try again.',
  504: 'Pipedrive API timed out.',
};

// Retry config: status code -> delay in ms (before first retry)
const RETRY_CONFIG: Record<number, { delayMs: number; getDelay?: (response: ApiResponse) => number }> = {
  429: {
    delayMs: 2000, // fallback if no header
    getDelay: (response) => {
      const reset = response.headers?.get('x-ratelimit-reset');
      if (reset) {
        const resetTime = parseInt(reset, 10);
        const now = Math.floor(Date.now() / 1000);
        const waitSeconds = Math.max(resetTime - now, 1);
        return Math.min(waitSeconds * 1000, 30000); // cap at 30s
      }
      return 2000;
    },
  },
  502: { delayMs: 1000 },
  503: { delayMs: 2000 },
};

// NOT retryable
const NO_RETRY = new Set([500, 504]);

function makeError(code: number, message: string, details?: Record<string, unknown>): PipedriveApiError {
  return { error: true, code, message, details };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function normalizeApiCall(
  fn: () => Promise<ApiResponse>,
  context?: ErrorContext,
  logger?: Logger
): Promise<ApiResponse> {
  let response: ApiResponse;

  try {
    response = await fn();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw makeError(0, 'Request to Pipedrive API timed out.');
    }
    if (err instanceof TypeError) {
      throw makeError(0, 'Unable to reach Pipedrive API. Check network connection.');
    }
    throw makeError(0, `Unexpected error: ${String(err)}`);
  }

  // Success
  if (response.status >= 200 && response.status < 300) {
    return response;
  }

  // Check if retryable
  const retryConfig = RETRY_CONFIG[response.status];
  if (retryConfig && !NO_RETRY.has(response.status)) {
    const delayMs = retryConfig.getDelay?.(response) ?? retryConfig.delayMs;
    logger?.warn({ status: response.status, delayMs }, 'Retrying after error');
    await sleep(delayMs);

    try {
      const retryResponse = await fn();
      if (retryResponse.status >= 200 && retryResponse.status < 300) {
        return retryResponse;
      }
      // Retry also failed — fall through with retry response
      response = retryResponse;
    } catch {
      // Retry threw — fall through with original response
    }
  }

  // 429 — rate limited (after retry failed or no retry)
  if (response.status === 429) {
    const resetHeader = response.headers?.get('x-ratelimit-reset');
    const waitInfo = resetHeader
      ? `Try again after ${Math.max(parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000), 1)}s.`
      : 'Try again later.';
    throw makeError(429, `Rate limited by Pipedrive. ${waitInfo}`, {
      rate_limit_reset: resetHeader ? parseInt(resetHeader, 10) : null,
    });
  }

  // 404 — not found with entity context
  if (response.status === 404) {
    const message = context?.entity && context?.id
      ? `${context.entity} with ID ${context.id} not found.`
      : 'Resource not found.';
    throw makeError(404, message);
  }

  // Known error codes
  const knownMessage = ERROR_MESSAGES[response.status];
  if (knownMessage) {
    throw makeError(response.status, knownMessage);
  }

  throw makeError(response.status, `Pipedrive API returned status ${response.status}.`);
}
```

### Fixed error-normalizer tests — add 429 cases

Add these tests to the existing test file:

```typescript
it('retries 429 once using rate limit header', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) {
      return {
        status: 429,
        data: {},
        headers: new Headers({
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1),
        }),
      };
    }
    return { status: 200, data: { success: true, data: { id: 1 } } };
  };
  const result = await normalizeApiCall(fn);
  expect(calls).toBe(2);
  expect(result.status).toBe(200);
});

it('throws after 429 retry fails', async () => {
  const fn = async () => ({
    status: 429,
    data: {},
    headers: new Headers({
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1),
    }),
  });
  await expect(normalizeApiCall(fn)).rejects.toMatchObject({
    error: true,
    code: 429,
  });
});
```

### Fixed PipedriveClient.request return type

The `request` method must return headers in a way the normalizer can use:

```typescript
// In pipedrive-client.ts, change the return to:
return { status: response.status, data, headers: response.headers };
```

And update the return type:

```typescript
async request(
  method: HttpMethod,
  version: 'v1' | 'v2',
  path: string,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<{ status: number; data: unknown; headers: Headers }> {
```

---

## Fix 2: ReferenceResolver — Rebuild Sub-Resolvers on Cache Refresh

**Replaces:** Task 11, Step 1 (the orchestrator)

The bug: `getUserResolver()`, `getPipelineResolver()`, and `getActivityTypeResolver()` only create the resolver once and never rebuild it when the cache refreshes with new data.

Fix: track the last data reference and rebuild when it changes.

### Fixed reference-resolver/index.ts (key sections)

```typescript
// In the ReferenceResolver class, replace the single-check pattern with freshness tracking:

export class ReferenceResolver {
  private client: PipedriveClient;
  private logger: Logger;

  // Field resolvers
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

  // Lazy initialization — no eager cache priming on startup
  // Caches are populated on first access per the optimization feedback.

  async getFieldResolver(type: ResourceType): Promise<FieldResolver> {
    const cache = this.fieldCaches.get(type)!;
    const fields = await cache.get();
    const existing = this.fieldResolvers.get(type);
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
    if (!this.userState || this.userState.data !== users) {
      this.userState = { resolver: new UserResolver(users), data: users };
    }
    return this.userState.resolver;
  }

  async getPipelineResolver(): Promise<PipelineResolver> {
    const pipelines = await this.pipelineCache.get();
    if (!this.pipelineState || this.pipelineState.data !== pipelines) {
      this.pipelineState = { resolver: new PipelineResolver(pipelines), data: pipelines };
    }
    return this.pipelineState.resolver;
  }

  async getActivityTypeResolver(): Promise<ActivityTypeResolver> {
    const types = await this.activityTypeCache.get();
    if (!this.activityTypeState || this.activityTypeState.data !== types) {
      this.activityTypeState = { resolver: new ActivityTypeResolver(types), data: types };
    }
    return this.activityTypeState.resolver;
  }
}
```

---

## Fix 3: stdout Redirect Before All Imports

**Replaces:** Task 20, Step 1

The redirect must happen at the very top of `index.ts`, before any module imports that might have side effects.

### Fixed index.ts

```typescript
// src/index.ts

// FIRST: Load env vars (dotenv has no stdout side effects)
import 'dotenv/config';

// SECOND: Redirect stdout to stderr BEFORE any other imports.
// This prevents any module initialization code from corrupting
// the MCP JSON-RPC protocol stream in stdio mode.
const isStdio = !process.argv.includes('sse');
if (isStdio) {
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: any, ...args: any[]) => {
    return (stderrWrite as any)(chunk, ...args);
  };
}

// THIRD: Now safe to import everything else
import { parseConfig } from './config.js';
import { PipedriveClient } from './lib/pipedrive-client.js';
import { ReferenceResolver } from './lib/reference-resolver/index.js';
import { EntityResolver } from './lib/entity-resolver.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';

async function main() {
  const config = parseConfig();

  // Logger writes to stderr (fd 2) in all modes
  const logger = pino({
    level: config.logLevel,
  }, pino.destination(2));

  logger.info({ transport: config.transport }, 'Pipedrive MCP Server starting');

  // Initialize client with logger
  const client = new PipedriveClient(config.apiToken, logger);

  // Validate token
  try {
    const user = await client.validateToken();
    logger.info({ userId: user.id, userName: user.name }, 'Token validated');
  } catch (err) {
    logger.fatal('Invalid or missing PIPEDRIVE_API_TOKEN. Exiting.');
    process.exit(1);
  }

  // Initialize resolvers (lazy — caches prime on first use, not here)
  const resolver = new ReferenceResolver(client, logger);
  const entityResolver = new EntityResolver(client, logger);

  // Create MCP server with logger
  const server = createServer(config, client, resolver, entityResolver, logger);

  // Start transport
  if (config.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Server running on stdio');
  } else {
    // SSE mode
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const http = await import('node:http');

    const httpServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        await server.connect(transport);
      } else if (req.method === 'POST' && req.url === '/messages') {
        // The SSE transport handles POST messages
        // This depends on the SDK version — check SDK docs during implementation
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    httpServer.listen(config.port, () => {
      logger.info({ port: config.port }, 'Server running on SSE');
    });
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    const shutdownTimeout = setTimeout(() => {
      logger.warn('Shutdown timed out after 5s, forcing exit');
      process.exit(1);
    }, 5000);
    try {
      await server.close();
    } finally {
      clearTimeout(shutdownTimeout);
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

---

## Fix 4: Logger Injection Across All Modules

**Amends:** Tasks 6, 8, 11, 12

Every module that makes API calls, caches data, or handles errors needs a logger.

### PipedriveClient — add logger

```typescript
// Constructor signature change:
constructor(apiToken: string, logger?: Logger) {
  this.apiToken = apiToken;
  this.logger = logger;
}

// In request(), after rate limit header tracking:
if (this.logger) {
  this.logger.debug({
    method, version, path,
    status: response.status,
    rateLimitRemaining: this.rateLimitState.remaining,
  }, 'Pipedrive API call');
}
```

### StaleWhileRevalidateCache — add logger

```typescript
// Constructor signature change:
constructor(fetcher: () => Promise<T>, ttlMs: number, logger?: Logger) {
  this.fetcher = fetcher;
  this.ttlMs = ttlMs;
  this.logger = logger;
}

// In the catch block of the background refresh:
.catch(err => {
  this.refreshInFlight = null;
  this.logger?.warn({ err }, 'Cache background refresh failed, serving stale data');
  return this.data as T;
});
```

### EntityResolver — add logger

```typescript
constructor(client: PipedriveClient, logger?: Logger) {
  this.client = client;
  this.logger = logger;
}

// In the full-page warning:
if (searchResults.length >= SEARCH_PAGE_SIZE) {
  this.logger?.warn(
    { entityType, searchTerm: value, resultCount: searchResults.length },
    'Search returned full page with no exact match — result may exist beyond first page'
  );
}
```

---

## Fix 5: N+1 Pipeline Fetch + Lazy Initialization

**Amends:** Task 11

### Fixed fetchPipelines — single stages call

```typescript
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

  // Fetch ALL stages in one call (no pipeline_id filter)
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
```

### Lazy initialization

Remove the `initialize()` method from `ReferenceResolver`. Caches prime on first access via `StaleWhileRevalidateCache.get()`. The startup validation call (`GET /users/me`) already confirms the token works. Remove the `await resolver.initialize()` call from `index.ts`.

---

## Fix 6: Audit Logging in Server Tool Dispatch

**Replaces:** Task 19, Step 1

### Fixed server.ts tool registration loop

```typescript
server.tool(tool.name, tool.description, tool.inputSchema, async (params) => {
  const startTime = Date.now();
  const toolParams = params as Record<string, unknown>;

  try {
    const result = await tool.handler(toolParams);
    const duration = Date.now() - startTime;

    // Audit log — PII-aware
    const logEntry: Record<string, unknown> = {
      tool: tool.name,
      duration_ms: duration,
      status: 'success',
    };
    // Only log entity IDs, deal titles, stage names — not person names, emails, note content
    if (toolParams.id) logEntry.entity_id = toolParams.id;
    if (tool.category !== 'read' && (tool.name.includes('deal'))) {
      if (toolParams.title) logEntry.deal_title = toolParams.title;
    }
    logger.info(logEntry, 'Tool call completed');

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    const errorObj = (err as any)?.error === true ? err : { error: true, message };

    logger.warn({
      tool: tool.name,
      duration_ms: duration,
      status: 'error',
      error_code: (err as any)?.code,
      error_message: message,
    }, 'Tool call failed');

    return {
      content: [{ type: 'text', text: JSON.stringify(errorObj, null, 2) }],
      isError: true,
    };
  }
});
```

---

## Fix 7: Minor Issues

### fetchFields endpoint name

Pipedrive uses `dealFields`, `personFields`, `organizationFields` — but activity fields are fetched differently. Fix:

```typescript
private async fetchFields(type: ResourceType): Promise<FieldDefinition[]> {
  // Activity types have their own endpoint
  if (type === 'activity') {
    // Activity "fields" come from the standard fields list
    // Activity TYPES are separate (handled by ActivityTypeResolver)
  }
  const endpoint = `/${type}Fields`;
  // ... rest unchanged
}
```

Verify the exact endpoint names against the Pipedrive API during build. The v1 endpoints are: `GET /v1/dealFields`, `GET /v1/personFields`, `GET /v1/organizationFields`.

### Entity resolver search — pin API version

Pipedrive v2 search wraps results differently than v1. Pin to v2 and parse accordingly:

```typescript
// In entity-resolver.ts resolve():
const response = await this.client.request(
  'GET', 'v2', `/${entityType}s/search`,
  undefined,
  { term: value, limit: String(SEARCH_PAGE_SIZE) }
);

// v2 search response shape:
// { success: true, data: { items: [{ id, name, ... }] } }
const respData = (response as any).data;
const items = respData.data?.items ?? [];
searchResults = items.map((item: any) => ({
  id: item.id,
  name: item.name ?? '',
  organization: item.organization,
}));
```

### resolveOutputRecord — skip system fields

```typescript
async function resolveOutputRecord(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const fieldResolver = await resolver.getFieldResolver('deal');
  const userResolver = await resolver.getUserResolver();
  const pipelineResolver = await resolver.getPipelineResolver();
  const result: Record<string, unknown> = {};

  // Pass through system fields that shouldn't go through field resolver
  const PASSTHROUGH = new Set(['id', 'add_time', 'update_time', 'close_time',
    'won_time', 'lost_time', 'visible_to', 'deleted']);

  for (const [key, value] of Object.entries(raw)) {
    if (PASSTHROUGH.has(key)) {
      result[key] = value;
      continue;
    }
    // Skip internal IDs that get resolved below
    if (['user_id', 'pipeline_id', 'stage_id', 'person_id', 'org_id', 'creator_user_id'].includes(key)) {
      continue;
    }
    const outputKey = fieldResolver.getOutputKey(key);
    result[outputKey] = fieldResolver.resolveOutputValue(key, value);
  }

  // Resolve IDs to human-readable names
  if (raw.user_id) result.owner = userResolver.resolveIdToName(raw.user_id as number);
  if (raw.pipeline_id) result.pipeline = pipelineResolver.resolvePipelineIdToName(raw.pipeline_id as number);
  if (raw.stage_id) result.stage = pipelineResolver.resolveStageIdToName(raw.stage_id as number);
  if (raw.person_id) result.person_id = raw.person_id; // Keep ID, agent can look up if needed
  if (raw.org_id) result.org_id = raw.org_id;

  // Rename update_time to updated_at for consistency
  if (result.update_time) {
    result.updated_at = result.update_time;
    delete result.update_time;
  }

  return result;
}
```

---

## Fix 8: Complete Deal Tool Implementations

**Replaces:** Task 14, Step 3

The `resolveInputFields`, `resolveOutputRecord`, and `toDealSummary` helpers from the original plan are correct (with the Fix 7 amendment to resolveOutputRecord). Here are the 6 tool definitions that go in the return array:

```typescript
// src/tools/deals.ts — the return array inside createDealTools()

return [
  {
    name: 'list-deals',
    category: 'read' as const,
    description: "Browse deals by structured filters (pipeline, stage, owner, status, updated_since). Use when you know what field values to filter on. Returns summary shape.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'won', 'lost', 'all_not_deleted'], description: 'Deal status filter' },
        pipeline: { type: 'string', description: "Pipeline name, e.g. 'Sales'" },
        stage: { type: 'string', description: "Stage name. If ambiguous across pipelines, specify pipeline too." },
        owner: { type: 'string', description: "User name, e.g. 'Stacy'" },
        person_id: { type: 'number', description: 'Filter by linked person ID' },
        org_id: { type: 'number', description: 'Filter by linked organization ID' },
        updated_since: { type: 'string', description: 'ISO date (YYYY-MM-DD) — deals updated on or after' },
        sort_by: { type: 'string', description: 'Field to sort on' },
        sort_order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number', description: 'Page size (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor from previous response' },
      },
    },
    handler: async (params: Record<string, unknown>) => {
      const pipelineResolver = await resolver.getPipelineResolver();
      const userResolver = await resolver.getUserResolver();
      const query: Record<string, string> = {};

      if (params.status) query.status = params.status as string;
      if (params.owner) query.user_id = String(userResolver.resolveNameToId(params.owner as string));
      if (params.person_id) query.person_id = String(params.person_id);
      if (params.org_id) query.org_id = String(params.org_id);
      if (params.updated_since) query.since = params.updated_since as string;
      if (params.sort_by) query.sort = params.sort_by as string;
      if (params.sort_order) query.sort_direction = params.sort_order as string;
      if (params.limit) query.limit = String(params.limit);

      // Stage filter with disambiguation
      if (params.stage) {
        let pipelineId: number | undefined;
        if (params.pipeline) {
          pipelineId = pipelineResolver.resolvePipelineNameToId(params.pipeline as string);
          query.pipeline_id = String(pipelineId);
        }
        if (pipelineId) {
          query.stage_id = String(pipelineResolver.resolveStageNameToId(params.stage as string, pipelineId));
        } else {
          const result = pipelineResolver.resolveStageGlobally(params.stage as string);
          query.stage_id = String(result.stageId);
          query.pipeline_id = String(result.pipelineId);
        }
      } else if (params.pipeline) {
        query.pipeline_id = String(pipelineResolver.resolvePipelineNameToId(params.pipeline as string));
      }

      // Pagination
      if (params.cursor) {
        const decoded = decodeCursor(params.cursor as string);
        if (decoded.v === 'v2' && decoded.cursor) query.cursor = decoded.cursor;
        if (decoded.v === 'v1' && decoded.offset !== undefined) query.start = String(decoded.offset);
      }

      const response = await normalizeApiCall(
        async () => client.request('GET', 'v2', '/deals', undefined, query),
        undefined, logger
      );

      const respData = (response as any).data;
      const items = respData.data ?? [];
      const summaries = await Promise.all(items.map((d: any) => toDealSummary(d)));

      const nextCursor = respData.additional_data?.next_cursor;
      return {
        items: summaries,
        has_more: !!nextCursor,
        next_cursor: nextCursor ? encodeCursor({ v: 'v2', cursor: nextCursor }) : undefined,
      };
    },
  },

  {
    name: 'get-deal',
    category: 'read' as const,
    description: "Get a single deal by ID with all fields resolved to human-readable labels. Returns full record.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Deal ID' },
      },
      required: ['id'],
    },
    handler: async (params: Record<string, unknown>) => {
      const id = params.id as number;
      const response = await normalizeApiCall(
        async () => client.request('GET', 'v2', `/deals/${id}`),
        { entity: 'Deal', id }, logger
      );
      const raw = (response as any).data.data;
      return resolveOutputRecord(raw);
    },
  },

  {
    name: 'create-deal',
    category: 'create' as const,
    description: "Create a new deal. Accepts human-friendly names for pipeline, stage, owner, person, and organization — resolved to IDs automatically.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Deal title' },
        pipeline: { type: 'string', description: "Pipeline name, e.g. 'Sales'" },
        stage: { type: 'string', description: "Stage name, e.g. 'Proposal Sent'" },
        owner: { type: 'string', description: "User name, e.g. 'Stacy'" },
        person: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Person name or ID' },
        organization: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Organization name or ID' },
        value: { type: 'number', description: 'Deal monetary value' },
        currency: { type: 'string', description: "3-letter currency code, e.g. 'USD'" },
        status: { type: 'string', enum: ['open', 'won', 'lost'] },
        expected_close_date: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
        fields: { type: 'object', description: "Custom fields as { 'Label Name': value }" },
      },
      required: ['title'],
    },
    handler: async (params: Record<string, unknown>) => {
      const resolved = await resolveInputFields(params);
      validateStringLength(resolved.title as string, 'title', 255);

      const response = await normalizeApiCall(
        async () => client.request('POST', 'v2', '/deals', resolved),
        undefined, logger
      );

      const created = (response as any).data.data;

      // GET after write for confirmed state
      const getResponse = await normalizeApiCall(
        async () => client.request('GET', 'v2', `/deals/${created.id}`),
        { entity: 'Deal', id: created.id }, logger
      );
      const full = (getResponse as any).data.data;
      const result = await resolveOutputRecord(full);

      // Note pipeline inference if stage was provided without pipeline
      if (params.stage && !params.pipeline && resolved.pipeline_id) {
        const pipelineResolver = await resolver.getPipelineResolver();
        const pipelineName = pipelineResolver.resolvePipelineIdToName(resolved.pipeline_id as number);
        (result as any)._note = `Deal created in pipeline '${pipelineName}' (inferred from stage '${params.stage}').`;
      }

      return result;
    },
  },

  {
    name: 'update-deal',
    category: 'update' as const,
    description: "Update an existing deal by ID. Same field format as create-deal.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Deal ID' },
        title: { type: 'string' },
        pipeline: { type: 'string' },
        stage: { type: 'string' },
        owner: { type: 'string' },
        person: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        organization: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        value: { type: 'number' },
        currency: { type: 'string' },
        status: { type: 'string', enum: ['open', 'won', 'lost'] },
        expected_close_date: { type: 'string' },
        fields: { type: 'object' },
      },
      required: ['id'],
    },
    handler: async (params: Record<string, unknown>) => {
      const id = params.id as number;
      const { id: _, ...updateParams } = params;

      // Validate at least one field beyond id
      const hasFields = Object.keys(updateParams).some(k =>
        updateParams[k] !== undefined && (k !== 'fields' || Object.keys(updateParams[k] as object).length > 0)
      );
      if (!hasFields) {
        throw new Error('No fields provided. Include at least one field to update.');
      }

      // For stage resolution without explicit pipeline, fetch current deal's pipeline
      if (updateParams.stage && !updateParams.pipeline) {
        const currentDeal = await normalizeApiCall(
          async () => client.request('GET', 'v2', `/deals/${id}`),
          { entity: 'Deal', id }, logger
        );
        const currentPipelineId = (currentDeal as any).data.data.pipeline_id;
        if (currentPipelineId) {
          const pipelineResolver = await resolver.getPipelineResolver();
          // Use current pipeline for stage resolution
          const stageId = pipelineResolver.resolveStageNameToId(updateParams.stage as string, currentPipelineId);
          updateParams._resolved_stage_id = stageId;
          updateParams._resolved_pipeline_id = currentPipelineId;
        }
      }

      const resolved = await resolveInputFields(updateParams);

      // Apply pre-resolved stage if we did pipeline-aware resolution above
      if ((updateParams as any)._resolved_stage_id) {
        resolved.stage_id = (updateParams as any)._resolved_stage_id;
        if (!resolved.pipeline_id) {
          resolved.pipeline_id = (updateParams as any)._resolved_pipeline_id;
        }
      }

      const response = await normalizeApiCall(
        async () => client.request('PATCH', 'v2', `/deals/${id}`, resolved),
        { entity: 'Deal', id }, logger
      );

      // GET after write
      const getResponse = await normalizeApiCall(
        async () => client.request('GET', 'v2', `/deals/${id}`),
        { entity: 'Deal', id }, logger
      );
      return resolveOutputRecord((getResponse as any).data.data);
    },
  },

  {
    name: 'delete-deal',
    category: 'delete' as const,
    description: "Delete a deal by ID. Requires two-step confirmation.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Deal ID' },
        confirm: { type: 'boolean', description: 'Set to true to confirm deletion' },
      },
      required: ['id'],
    },
    handler: async (params: Record<string, unknown>) => {
      const id = params.id as number;
      const confirm = params.confirm === true;

      // Step 1: Return confirmation prompt (unless confirm=true)
      if (!confirm) {
        // Best-effort GET for title
        let title = `Deal ${id}`;
        try {
          const getResponse = await normalizeApiCall(
            async () => client.request('GET', 'v2', `/deals/${id}`),
            { entity: 'Deal', id }, logger
          );
          title = (getResponse as any).data.data?.title ?? title;
        } catch {
          // Fall back to ID-only
        }
        return {
          confirm_required: true,
          message: `This will permanently delete deal '${title}' (ID ${id}). Call delete-deal again with confirm: true to proceed.`,
        };
      }

      // Step 2: Execute deletion
      // Best-effort GET for title before delete
      let title: string | undefined;
      try {
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v2', `/deals/${id}`),
          { entity: 'Deal', id }, logger
        );
        title = (getResponse as any).data.data?.title;
      } catch {
        // Proceed without title
      }

      await normalizeApiCall(
        async () => client.request('DELETE', 'v2', `/deals/${id}`),
        { entity: 'Deal', id }, logger
      );

      return { id, title, deleted: true as const };
    },
  },

  {
    name: 'search-deals',
    category: 'read' as const,
    description: "Find deals by keyword across title and custom fields. Use when you have a name or term but not exact filter values. Returns summary shape.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword' },
        status: { type: 'string', enum: ['open', 'won', 'lost'] },
        limit: { type: 'number', description: 'Max results' },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
      required: ['query'],
    },
    handler: async (params: Record<string, unknown>) => {
      const queryParams: Record<string, string> = {
        term: params.query as string,
      };
      if (params.status) queryParams.status = params.status as string;
      if (params.limit) queryParams.limit = String(params.limit);
      if (params.cursor) {
        const decoded = decodeCursor(params.cursor as string);
        if (decoded.v === 'v2' && decoded.cursor) queryParams.cursor = decoded.cursor;
      }

      const response = await normalizeApiCall(
        async () => client.request('GET', 'v2', '/deals/search', undefined, queryParams),
        undefined, logger
      );

      const respData = (response as any).data;
      const items = respData.data?.items ?? [];
      const summaries = await Promise.all(items.map((item: any) => toDealSummary(item)));

      const nextCursor = respData.additional_data?.next_cursor;
      return {
        items: summaries,
        has_more: !!nextCursor,
        next_cursor: nextCursor ? encodeCursor({ v: 'v2', cursor: nextCursor }) : undefined,
      };
    },
  },
];
```

---

## Fix 9: Complete Person, Organization, Activity, Note Tool Implementations

**Replaces:** Tasks 15-18

Each tool group follows the deal pattern. Below is the complete code for each.

### Persons (src/tools/persons.ts)

```typescript
import type { ToolDefinition, PersonSummary } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import type { EntityResolver } from '../lib/entity-resolver.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { trimString, validateStringLength } from '../lib/sanitizer.js';
import type { Logger } from 'pino';

export function createPersonTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver,
  logger?: Logger
): ToolDefinition[] {

  async function resolvePersonInput(params: Record<string, unknown>) {
    const fieldResolver = await resolver.getFieldResolver('person');
    const userResolver = await resolver.getUserResolver();
    const resolved: Record<string, unknown> = {};

    if (params.name) resolved.name = trimString(params.name as string, 'name');
    if (params.email) {
      resolved.email = Array.isArray(params.email)
        ? params.email.map(e => ({ value: e, primary: false, label: 'work' }))
        : [{ value: params.email, primary: true, label: 'work' }];
    }
    if (params.phone) {
      resolved.phone = Array.isArray(params.phone)
        ? params.phone.map(p => ({ value: p, primary: false, label: 'work' }))
        : [{ value: params.phone, primary: true, label: 'work' }];
    }
    if (params.owner) resolved.user_id = userResolver.resolveNameToId(params.owner as string);
    if (params.organization !== undefined) {
      resolved.org_id = await entityResolver.resolve('organization', params.organization as string | number);
    }
    if (params.fields && typeof params.fields === 'object') {
      for (const [label, value] of Object.entries(params.fields as Record<string, unknown>)) {
        const key = fieldResolver.resolveInputField(label);
        resolved[key] = fieldResolver.resolveInputValue(key, value);
      }
    }
    return resolved;
  }

  async function resolvePersonOutput(raw: Record<string, unknown>) {
    const fieldResolver = await resolver.getFieldResolver('person');
    const userResolver = await resolver.getUserResolver();
    const PASSTHROUGH = new Set(['id', 'add_time', 'update_time', 'visible_to']);
    const SKIP = new Set(['user_id', 'org_id', 'creator_user_id']);
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(raw)) {
      if (PASSTHROUGH.has(key)) { result[key] = value; continue; }
      if (SKIP.has(key)) continue;
      const outputKey = fieldResolver.getOutputKey(key);
      result[outputKey] = fieldResolver.resolveOutputValue(key, value);
    }

    if (raw.user_id) result.owner = userResolver.resolveIdToName(raw.user_id as number);
    if (raw.org_id) result.org_id = raw.org_id;
    if (result.update_time) { result.updated_at = result.update_time; delete result.update_time; }
    return result;
  }

  async function toPersonSummary(raw: Record<string, unknown>): Promise<PersonSummary> {
    const userResolver = await resolver.getUserResolver();
    const primaryEmail = Array.isArray(raw.email) ? raw.email.find((e: any) => e.primary)?.value ?? raw.email[0]?.value : raw.email;
    const primaryPhone = Array.isArray(raw.phone) ? raw.phone.find((p: any) => p.primary)?.value ?? raw.phone[0]?.value : raw.phone;
    return {
      id: raw.id as number,
      name: (raw.name as string) ?? '',
      email: (primaryEmail as string) ?? null,
      phone: (primaryPhone as string) ?? null,
      organization: raw.org_name as string ?? null,
      owner: raw.user_id ? userResolver.resolveIdToName(raw.user_id as number) : '',
      updated_at: (raw.update_time as string) ?? '',
    };
  }

  return [
    {
      name: 'list-persons',
      category: 'read' as const,
      description: "Browse persons by structured filters (owner, org_id, updated_since). Returns summary shape.",
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "User name, e.g. 'Stacy'" },
          org_id: { type: 'number', description: 'Filter by organization ID' },
          updated_since: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
          sort_by: { type: 'string' }, sort_order: { type: 'string', enum: ['asc', 'desc'] },
          limit: { type: 'number' }, cursor: { type: 'string' },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const userResolver = await resolver.getUserResolver();
        const query: Record<string, string> = {};
        if (params.owner) query.user_id = String(userResolver.resolveNameToId(params.owner as string));
        if (params.org_id) query.org_id = String(params.org_id);
        if (params.updated_since) query.since = params.updated_since as string;
        if (params.sort_by) query.sort = params.sort_by as string;
        if (params.sort_order) query.sort_direction = params.sort_order as string;
        if (params.limit) query.limit = String(params.limit);
        if (params.cursor) { const d = decodeCursor(params.cursor as string); if (d.v === 'v2' && d.cursor) query.cursor = d.cursor; }

        const response = await normalizeApiCall(async () => client.request('GET', 'v2', '/persons', undefined, query), undefined, logger);
        const respData = (response as any).data;
        const items = respData.data ?? [];
        const summaries = await Promise.all(items.map((p: any) => toPersonSummary(p)));
        const nextCursor = respData.additional_data?.next_cursor;
        return { items: summaries, has_more: !!nextCursor, next_cursor: nextCursor ? encodeCursor({ v: 'v2', cursor: nextCursor }) : undefined };
      },
    },
    {
      name: 'get-person',
      category: 'read' as const,
      description: "Get a single person by ID with all fields resolved. Returns full record.",
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const response = await normalizeApiCall(async () => client.request('GET', 'v2', `/persons/${id}`), { entity: 'Person', id }, logger);
        return resolvePersonOutput((response as any).data.data);
      },
    },
    {
      name: 'create-person',
      category: 'create' as const,
      description: "Create a new person. Accepts organization by name or ID.",
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Person's full name" },
          email: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          phone: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          organization: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Org name or ID' },
          owner: { type: 'string' },
          fields: { type: 'object' },
        },
        required: ['name'],
      },
      handler: async (params: Record<string, unknown>) => {
        const resolved = await resolvePersonInput(params);
        validateStringLength(resolved.name as string, 'name', 255);
        const response = await normalizeApiCall(async () => client.request('POST', 'v2', '/persons', resolved), undefined, logger);
        const created = (response as any).data.data;
        const getResp = await normalizeApiCall(async () => client.request('GET', 'v2', `/persons/${created.id}`), { entity: 'Person', id: created.id }, logger);
        return resolvePersonOutput((getResp as any).data.data);
      },
    },
    {
      name: 'update-person',
      category: 'update' as const,
      description: "Update an existing person by ID. Same field format as create-person.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' },
          email: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          phone: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          organization: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          owner: { type: 'string' }, fields: { type: 'object' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const { id: _, ...updateParams } = params;
        if (!Object.values(updateParams).some(v => v !== undefined)) throw new Error('No fields provided. Include at least one field to update.');
        const resolved = await resolvePersonInput(updateParams);
        await normalizeApiCall(async () => client.request('PATCH', 'v2', `/persons/${id}`, resolved), { entity: 'Person', id }, logger);
        const getResp = await normalizeApiCall(async () => client.request('GET', 'v2', `/persons/${id}`), { entity: 'Person', id }, logger);
        return resolvePersonOutput((getResp as any).data.data);
      },
    },
    {
      name: 'delete-person',
      category: 'delete' as const,
      description: "Delete a person by ID. Requires two-step confirmation.",
      inputSchema: { type: 'object', properties: { id: { type: 'number' }, confirm: { type: 'boolean' } }, required: ['id'] },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        if (params.confirm !== true) {
          let name = `Person ${id}`;
          try { const r = await normalizeApiCall(async () => client.request('GET', 'v2', `/persons/${id}`), { entity: 'Person', id }, logger); name = (r as any).data.data?.name ?? name; } catch {}
          return { confirm_required: true, message: `This will permanently delete person '${name}' (ID ${id}). Call delete-person again with confirm: true to proceed.` };
        }
        let name: string | undefined;
        try { const r = await normalizeApiCall(async () => client.request('GET', 'v2', `/persons/${id}`), { entity: 'Person', id }, logger); name = (r as any).data.data?.name; } catch {}
        await normalizeApiCall(async () => client.request('DELETE', 'v2', `/persons/${id}`), { entity: 'Person', id }, logger);
        return { id, name, deleted: true as const };
      },
    },
    {
      name: 'search-persons',
      category: 'read' as const,
      description: "Find persons by keyword across name, email, phone, and custom fields. Returns summary shape.",
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['query'] },
      handler: async (params: Record<string, unknown>) => {
        const q: Record<string, string> = { term: params.query as string };
        if (params.limit) q.limit = String(params.limit);
        if (params.cursor) { const d = decodeCursor(params.cursor as string); if (d.v === 'v2' && d.cursor) q.cursor = d.cursor; }
        const response = await normalizeApiCall(async () => client.request('GET', 'v2', '/persons/search', undefined, q), undefined, logger);
        const respData = (response as any).data;
        const items = respData.data?.items ?? [];
        const summaries = await Promise.all(items.map((i: any) => toPersonSummary(i)));
        const nextCursor = respData.additional_data?.next_cursor;
        return { items: summaries, has_more: !!nextCursor, next_cursor: nextCursor ? encodeCursor({ v: 'v2', cursor: nextCursor }) : undefined };
      },
    },
  ];
}
```

### Organizations, Activities, Notes

These follow the same structural pattern as Persons above. Key differences per entity:

**Organizations** (`src/tools/organizations.ts`):
- 5 tools (no delete)
- `create-organization` requires `name`, accepts `owner`, `address`, `fields`
- No entity resolution on input
- Summary: `id, name, owner, address, updated_at`

**Activities** (`src/tools/activities.ts`):
- 5 tools including delete
- `create-activity` requires `type` and `subject`
- `type` validated via `ActivityTypeResolver` before sending to API
- `owner` resolved to `user_id`
- `list-activities` has `start_date`, `end_date`, `updated_since`, `done` filters
- No custom field resolution (activities use standard fields)
- Summary: `id, type, subject, due_date, done, deal, person, owner`

**Notes** (`src/tools/notes.ts`):
- 5 tools including delete
- `create-note` requires `content` + at least one of `deal_id, person_id, org_id`
- Content goes through `sanitizeNoteContent()` before API call
- `list-notes` truncates content to 200 chars with `truncated: boolean`
- `update-note` accepts `content, deal_id, person_id, org_id` (all changeable per verified API)
- `get-note` returns full untruncated content
- No custom field resolution needed

The implementing agent should:
1. Copy the person tools pattern
2. Adapt the input/output helpers for each entity's fields
3. Apply entity-specific validation (activity type check, note content sanitization, note association constraint)
4. Write tests following the pattern from tasks 4-13

Each entity tool file should be ~200-250 lines.

---

## Summary of All Fixes

| # | Fix | Impact |
|---|-----|--------|
| 1 | 429 retry in error normalizer | Spec compliance — was missing entirely |
| 2 | ApiResponse type includes headers | Enables 429 retry to read reset header |
| 3 | Sub-resolver rebuild on cache refresh | Bug — stale resolvers after background refresh |
| 4 | stdout redirect before imports | Bug — timing gap corrupts stdio protocol |
| 5 | Logger injection across all modules | Missing operational visibility |
| 6 | Audit logging in server dispatch | Spec requirement — no trace of agent actions |
| 7 | N+1 pipeline fetch → single call | Optimization — 2 API calls instead of N+1 |
| 8 | Lazy initialization | Optimization — fewer startup API calls |
| 9 | System field passthrough in output | Bug — system fields incorrectly resolved |
| 10 | Complete deal tool implementations | Critical gap — core business logic was a stub |
| 11 | Complete person tool implementations | Critical gap — full code provided |
| 12 | Pattern spec for org/activity/note tools | Sufficient detail for implementation |
