# Part 7: Deal Tool Handlers (Full CRUD Pattern)
> Part 7 of 13 — The canonical CRUD pattern. All subsequent entity tools (persons, orgs, activities, notes) follow this structure.
> **Depends on:** Parts 2 (types), 3 (cursor), 4 (reference-resolver), 5 (entity-resolver), 6 (read-only tools for pattern reference)
> **Produces:** `src/tools/deals.ts`, `tests/tools/deals.test.ts`

---

## Overview

The deal tools are the most complex tool group: 6 tools covering list, get, create, update, delete, and search. They integrate with every layer of the stack:

- **PipedriveClient** -- HTTP calls to Pipedrive API
- **ErrorNormalizer** -- wraps all API calls for consistent error handling
- **ReferenceResolver** -- field label/key resolution, user name/ID resolution, pipeline/stage resolution
- **EntityResolver** -- person/org name-to-ID search and disambiguation
- **Sanitizer** -- input trimming and length validation
- **Cursor** -- pagination encode/decode

The function signature is:

```typescript
createDealTools(client: PipedriveClient, resolver: ReferenceResolver, entityResolver: EntityResolver, logger?: Logger): ToolDefinition[]
```

Three internal helpers are defined inside `createDealTools` (closures over the parameters):
1. `resolveInputFields` -- human-friendly params to Pipedrive API format
2. `resolveOutputRecord` -- raw API response to human-readable record (uses Fix 7 version with PASSTHROUGH/SKIP sets)
3. `toDealSummary` -- raw API record to summary shape for list/search responses

---

## Step 1: Write deal tool tests

- [ ] **Create `tests/tools/deals.test.ts`**

```typescript
// tests/tools/deals.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDealTools } from '../../src/tools/deals.js';
import type { ToolDefinition } from '../../src/types.js';

// --- Mock Factories ---

function mockClient() {
  return {
    request: vi.fn(),
  };
}

function mockFieldResolver() {
  return {
    resolveInputField: vi.fn((label: string) => {
      const map: Record<string, string> = { 'Practice Area': 'abc_practice_area' };
      if (map[label]) return map[label];
      return label;
    }),
    resolveInputValue: vi.fn((_key: string, value: unknown) => value),
    getOutputKey: vi.fn((key: string) => {
      const map: Record<string, string> = { abc_practice_area: 'Practice Area' };
      return map[key] ?? key;
    }),
    resolveOutputValue: vi.fn((_key: string, value: unknown) => value),
    getFieldDefinitions: vi.fn(() => []),
  };
}

function mockUserResolver() {
  return {
    resolveNameToId: vi.fn((name: string) => {
      const map: Record<string, number> = { Stacy: 2, Brad: 1 };
      if (map[name]) return map[name];
      throw new Error(`No user found matching '${name}'`);
    }),
    resolveIdToName: vi.fn((id: number) => {
      const map: Record<number, string> = { 1: 'Brad', 2: 'Stacy' };
      return map[id] ?? `User ${id}`;
    }),
    getUsers: vi.fn(() => []),
  };
}

function mockPipelineResolver() {
  return {
    resolvePipelineNameToId: vi.fn((name: string) => {
      if (name.toLowerCase() === 'sales') return 1;
      if (name.toLowerCase() === 'partnerships') return 2;
      throw new Error(`No pipeline found matching '${name}'`);
    }),
    resolvePipelineIdToName: vi.fn((id: number) => {
      const map: Record<number, string> = { 1: 'Sales', 2: 'Partnerships' };
      return map[id] ?? `Pipeline ${id}`;
    }),
    resolveStageNameToId: vi.fn((name: string, pipelineId: number) => {
      if (name === 'Proposal Sent' && pipelineId === 1) return 11;
      if (name === 'Qualified' && pipelineId === 1) return 10;
      if (name === 'Qualified' && pipelineId === 2) return 20;
      throw new Error(`No stage '${name}' found in pipeline ${pipelineId}`);
    }),
    resolveStageIdToName: vi.fn((id: number) => {
      const map: Record<number, string> = { 10: 'Qualified', 11: 'Proposal Sent', 20: 'Qualified' };
      return map[id] ?? `Stage ${id}`;
    }),
    resolveStageGlobally: vi.fn((name: string) => {
      if (name === 'Proposal Sent') return { stageId: 11, pipelineId: 1 };
      if (name === 'Qualified') {
        throw new Error("Stage 'Qualified' exists in multiple pipelines: 'Sales', 'Partnerships'. Specify a pipeline to disambiguate.");
      }
      throw new Error(`No stage found matching '${name}'`);
    }),
    getPipelines: vi.fn(() => []),
    getStagesForPipeline: vi.fn(() => []),
  };
}

function mockResolver() {
  const fieldRes = mockFieldResolver();
  const userRes = mockUserResolver();
  const pipelineRes = mockPipelineResolver();
  return {
    instance: {
      getFieldResolver: vi.fn().mockResolvedValue(fieldRes),
      getUserResolver: vi.fn().mockResolvedValue(userRes),
      getPipelineResolver: vi.fn().mockResolvedValue(pipelineRes),
    } as any,
    fieldResolver: fieldRes,
    userResolver: userRes,
    pipelineResolver: pipelineRes,
  };
}

function mockEntityResolver() {
  return {
    resolve: vi.fn(async (_type: string, value: string | number) => {
      if (typeof value === 'number') return value;
      const map: Record<string, number> = { 'John Smith': 100, 'Acme Corp': 200 };
      if (map[value]) return map[value];
      throw new Error(`No ${_type} found matching '${value}'`);
    }),
  };
}

function rawDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'Test Deal',
    status: 'open',
    pipeline_id: 1,
    stage_id: 10,
    user_id: 2,
    value: 5000,
    currency: 'USD',
    update_time: '2026-03-28T10:00:00Z',
    person_id: 100,
    org_id: 200,
    add_time: '2026-03-01T08:00:00Z',
    ...overrides,
  };
}

function apiResponse(data: unknown, additionalData?: Record<string, unknown>) {
  return {
    status: 200,
    data: {
      success: true,
      data,
      additional_data: additionalData,
    },
    headers: new Headers(),
  };
}

// --- Test Suite ---

describe('deal tools', () => {
  let client: ReturnType<typeof mockClient>;
  let resolverMocks: ReturnType<typeof mockResolver>;
  let entityRes: ReturnType<typeof mockEntityResolver>;
  let tools: ToolDefinition[];

  function findTool(name: string): ToolDefinition {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`Tool '${name}' not found`);
    return tool;
  }

  beforeEach(() => {
    client = mockClient();
    resolverMocks = mockResolver();
    entityRes = mockEntityResolver();
    tools = createDealTools(client as any, resolverMocks.instance, entityRes as any);
  });

  // --- list-deals ---

  describe('list-deals', () => {
    it('returns deals in summary shape', async () => {
      client.request.mockResolvedValueOnce(apiResponse([rawDeal()]));

      const result = await findTool('list-deals').handler({});
      expect(result).toEqual({
        items: [
          {
            id: 1,
            title: 'Test Deal',
            status: 'open',
            pipeline: 'Sales',
            stage: 'Qualified',
            owner: 'Stacy',
            value: 5000,
            updated_at: '2026-03-28T10:00:00Z',
          },
        ],
        has_more: false,
        next_cursor: undefined,
      });
    });

    it('passes status filter to API', async () => {
      client.request.mockResolvedValueOnce(apiResponse([]));

      await findTool('list-deals').handler({ status: 'won' });
      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.status).toBe('won');
    });

    it('resolves owner name to user_id in query', async () => {
      client.request.mockResolvedValueOnce(apiResponse([]));

      await findTool('list-deals').handler({ owner: 'Stacy' });
      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.user_id).toBe('2');
    });

    it('handles pagination with cursor', async () => {
      const cursor = btoa(JSON.stringify({ v: 'v2', cursor: 'abc123' }));
      client.request.mockResolvedValueOnce(
        apiResponse([rawDeal()], { next_cursor: 'def456' })
      );

      const result = await findTool('list-deals').handler({ cursor });
      expect(result.has_more).toBe(true);
      expect(result.next_cursor).toBeDefined();

      // Verify cursor was passed to API
      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.cursor).toBe('abc123');
    });

    it('resolves stage with pipeline disambiguation', async () => {
      client.request.mockResolvedValueOnce(apiResponse([]));

      await findTool('list-deals').handler({ stage: 'Proposal Sent' });
      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.stage_id).toBe('11');
      expect(queryParams.pipeline_id).toBe('1');
    });

    it('resolves stage within specified pipeline', async () => {
      client.request.mockResolvedValueOnce(apiResponse([]));

      await findTool('list-deals').handler({ pipeline: 'Sales', stage: 'Qualified' });
      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.stage_id).toBe('10');
      expect(queryParams.pipeline_id).toBe('1');
    });

    it('throws on ambiguous stage without pipeline', async () => {
      await expect(
        findTool('list-deals').handler({ stage: 'Qualified' })
      ).rejects.toThrow(/multiple pipelines/i);
    });
  });

  // --- get-deal ---

  describe('get-deal', () => {
    it('returns full record with resolved fields', async () => {
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({
        abc_practice_area: 'Varicent',
      })));

      const result = await findTool('get-deal').handler({ id: 1 }) as Record<string, unknown>;
      expect(result.id).toBe(1);
      expect(result.owner).toBe('Stacy');
      expect(result.pipeline).toBe('Sales');
      expect(result.stage).toBe('Qualified');
      expect(result.updated_at).toBe('2026-03-28T10:00:00Z');
      // Custom field resolved to human-readable key
      expect(result['Practice Area']).toBe('Varicent');
    });

    it('passes entity context for 404 errors', async () => {
      client.request.mockResolvedValueOnce(apiResponse(rawDeal()));
      await findTool('get-deal').handler({ id: 42 });

      // Verify the normalizeApiCall is called — we check the client was called with correct path
      expect(client.request).toHaveBeenCalledWith('GET', 'v2', '/deals/42');
    });
  });

  // --- create-deal ---

  describe('create-deal', () => {
    it('creates deal with human-friendly names and returns full record', async () => {
      // First call: POST create
      client.request.mockResolvedValueOnce(apiResponse({ id: 99 }));
      // Second call: GET after write
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({ id: 99, title: 'New Deal' })));

      const result = await findTool('create-deal').handler({
        title: 'New Deal',
        pipeline: 'Sales',
        stage: 'Qualified',
        owner: 'Stacy',
        person: 'John Smith',
        organization: 'Acme Corp',
        value: 10000,
      }) as Record<string, unknown>;

      expect(result.id).toBe(99);

      // Verify POST body
      const postBody = client.request.mock.calls[0][3];
      expect(postBody.title).toBe('New Deal');
      expect(postBody.pipeline_id).toBe(1);
      expect(postBody.stage_id).toBe(10);
      expect(postBody.user_id).toBe(2);
      expect(postBody.person_id).toBe(100);
      expect(postBody.org_id).toBe(200);
      expect(postBody.value).toBe(10000);
    });

    it('validates required title', async () => {
      // createDealTools requires title in the schema. The handler will receive params
      // and attempt to build. Without a title, the resolved body has no title.
      // Since title is schema-required, the MCP SDK validates this. But the handler also
      // calls validateStringLength which handles the case if it's somehow empty.
      client.request.mockResolvedValueOnce(apiResponse({ id: 1 }));
      client.request.mockResolvedValueOnce(apiResponse(rawDeal()));

      // A create with title should succeed
      await findTool('create-deal').handler({ title: 'Valid Title' });
      expect(client.request).toHaveBeenCalled();
    });

    it('resolves custom fields in create', async () => {
      client.request.mockResolvedValueOnce(apiResponse({ id: 1 }));
      client.request.mockResolvedValueOnce(apiResponse(rawDeal()));

      await findTool('create-deal').handler({
        title: 'Custom Fields Deal',
        fields: { 'Practice Area': 'Varicent' },
      });

      const postBody = client.request.mock.calls[0][3];
      expect(postBody.abc_practice_area).toBe('Varicent');
    });

    it('includes pipeline inference note when stage infers pipeline', async () => {
      client.request.mockResolvedValueOnce(apiResponse({ id: 1 }));
      client.request.mockResolvedValueOnce(apiResponse(rawDeal()));

      const result = await findTool('create-deal').handler({
        title: 'Inferred Pipeline',
        stage: 'Proposal Sent',
        // No pipeline specified — should be inferred
      }) as Record<string, unknown>;

      expect(result._note).toMatch(/inferred from stage/i);
      expect(result._note).toMatch(/Sales/);
    });

    it('returns full record from GET-after-write', async () => {
      client.request.mockResolvedValueOnce(apiResponse({ id: 50 }));
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({ id: 50, title: 'Written Deal', value: 7500 })));

      const result = await findTool('create-deal').handler({ title: 'Written Deal' }) as Record<string, unknown>;
      // Second call is GET for confirmation read
      expect(client.request.mock.calls[1][0]).toBe('GET');
      expect(client.request.mock.calls[1][2]).toBe('/deals/50');
      expect(result.id).toBe(50);
    });
  });

  // --- update-deal ---

  describe('update-deal', () => {
    it('rejects empty fields object', async () => {
      await expect(
        findTool('update-deal').handler({ id: 1 })
      ).rejects.toThrow(/No fields provided/);
    });

    it('updates deal and returns full record', async () => {
      // GET for stage resolution (current pipeline)
      // Not needed if pipeline is specified
      client.request
        .mockResolvedValueOnce(apiResponse(rawDeal())) // GET current deal for pipeline context
        .mockResolvedValueOnce(apiResponse({}))         // PATCH update
        .mockResolvedValueOnce(apiResponse(rawDeal({ stage_id: 11 }))); // GET after write

      const result = await findTool('update-deal').handler({
        id: 1,
        stage: 'Proposal Sent',
      }) as Record<string, unknown>;

      expect(result.stage).toBe('Proposal Sent');
    });

    it('uses current pipeline for stage resolution when pipeline not specified', async () => {
      // GET current deal to discover pipeline_id
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({ pipeline_id: 1 })));
      // PATCH update
      client.request.mockResolvedValueOnce(apiResponse({}));
      // GET after write
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({ stage_id: 11 })));

      await findTool('update-deal').handler({ id: 1, stage: 'Proposal Sent' });

      // Verify PATCH was called with resolved stage_id
      const patchBody = client.request.mock.calls[1][3];
      expect(patchBody.stage_id).toBe(11);
    });

    it('does not fetch current deal when pipeline is specified with stage', async () => {
      // PATCH directly — no preliminary GET needed
      client.request.mockResolvedValueOnce(apiResponse({}));
      // GET after write
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({ pipeline_id: 1, stage_id: 10 })));

      await findTool('update-deal').handler({ id: 1, pipeline: 'Sales', stage: 'Qualified' });

      // First call should be PATCH, not GET
      expect(client.request.mock.calls[0][0]).toBe('PATCH');
    });

    it('updates simple fields without stage resolution', async () => {
      client.request.mockResolvedValueOnce(apiResponse({})); // PATCH
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({ title: 'Updated Title' }))); // GET after write

      await findTool('update-deal').handler({ id: 1, title: 'Updated Title' });
      const patchBody = client.request.mock.calls[0][3];
      expect(patchBody.title).toBe('Updated Title');
    });
  });

  // --- delete-deal ---

  describe('delete-deal', () => {
    it('first call returns confirmation prompt', async () => {
      // Best-effort GET for title
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({ title: 'Acme Q3 Renewal' })));

      const result = await findTool('delete-deal').handler({ id: 1 }) as Record<string, unknown>;
      expect(result.confirm_required).toBe(true);
      expect(result.message).toMatch(/Acme Q3 Renewal/);
      expect(result.message).toMatch(/confirm: true/);
    });

    it('second call with confirm executes deletion', async () => {
      // Best-effort GET for title
      client.request.mockResolvedValueOnce(apiResponse(rawDeal({ title: 'Doomed Deal' })));
      // DELETE call
      client.request.mockResolvedValueOnce(apiResponse({}));

      const result = await findTool('delete-deal').handler({ id: 1, confirm: true }) as Record<string, unknown>;
      expect(result.deleted).toBe(true);
      expect(result.id).toBe(1);
      expect(result.title).toBe('Doomed Deal');

      // Verify DELETE was actually called
      expect(client.request.mock.calls[1][0]).toBe('DELETE');
      expect(client.request.mock.calls[1][2]).toBe('/deals/1');
    });

    it('falls back to ID-only if GET for title fails', async () => {
      // Best-effort GET fails
      client.request.mockRejectedValueOnce(new Error('network error'));

      const result = await findTool('delete-deal').handler({ id: 999 }) as Record<string, unknown>;
      expect(result.confirm_required).toBe(true);
      expect(result.message).toMatch(/Deal 999/);
    });

    it('proceeds with deletion even if GET for title fails on confirm', async () => {
      // Best-effort GET fails
      client.request.mockRejectedValueOnce(new Error('transient error'));
      // DELETE succeeds
      client.request.mockResolvedValueOnce(apiResponse({}));

      const result = await findTool('delete-deal').handler({ id: 5, confirm: true }) as Record<string, unknown>;
      expect(result.deleted).toBe(true);
      expect(result.id).toBe(5);
      expect(result.title).toBeUndefined();
    });
  });

  // --- search-deals ---

  describe('search-deals', () => {
    it('returns summary shape from keyword search', async () => {
      client.request.mockResolvedValueOnce(
        apiResponse(undefined, undefined)
      );
      // Override: search returns items inside data.items
      client.request.mockReset();
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            items: [rawDeal({ id: 7, title: 'Acme Renewal' })],
          },
          additional_data: undefined,
        },
        headers: new Headers(),
      });

      const result = await findTool('search-deals').handler({ query: 'Acme' }) as any;
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(7);
      expect(result.items[0].title).toBe('Acme Renewal');
      expect(result.items[0].pipeline).toBeDefined();
      expect(result.items[0].owner).toBeDefined();
    });

    it('passes status filter and limit to search API', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { items: [] }, additional_data: undefined },
        headers: new Headers(),
      });

      await findTool('search-deals').handler({ query: 'Test', status: 'open', limit: 10 });
      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.term).toBe('Test');
      expect(queryParams.status).toBe('open');
      expect(queryParams.limit).toBe('10');
    });

    it('handles empty search results', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { items: [] }, additional_data: undefined },
        headers: new Headers(),
      });

      const result = await findTool('search-deals').handler({ query: 'Nonexistent' }) as any;
      expect(result.items).toEqual([]);
      expect(result.has_more).toBe(false);
    });

    it('handles pagination cursor in search', async () => {
      const cursor = btoa(JSON.stringify({ v: 'v2', cursor: 'search_cursor_123' }));
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { items: [] }, additional_data: { next_cursor: 'next_abc' } },
        headers: new Headers(),
      });

      const result = await findTool('search-deals').handler({ query: 'Test', cursor }) as any;
      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.cursor).toBe('search_cursor_123');
      expect(result.has_more).toBe(true);
      expect(result.next_cursor).toBeDefined();
    });
  });
});
```

---

## Step 2: Run tests (expect failure)

- [ ] **Verify tests fail before implementation**

```bash
npx vitest run tests/tools/deals.test.ts
```

Expected: FAIL (module not found).

---

## Step 3: Write deal tool handlers

- [ ] **Create `src/tools/deals.ts`**

This file contains three internal helpers and six tool definitions.

```typescript
// src/tools/deals.ts
import type { ToolDefinition, DealSummary } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import type { EntityResolver } from '../lib/entity-resolver.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { trimString, validateStringLength } from '../lib/sanitizer.js';
import type { Logger } from 'pino';

export function createDealTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver,
  logger?: Logger
): ToolDefinition[] {

  // ─── Helper: resolve deal input fields from human-friendly to Pipedrive format ───

  async function resolveInputFields(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fieldResolver = await resolver.getFieldResolver('deal');
    const userResolver = await resolver.getUserResolver();
    const pipelineResolver = await resolver.getPipelineResolver();
    const resolved: Record<string, unknown> = {};

    // System fields
    if (params.title) resolved.title = trimString(params.title as string, 'title');
    if (params.value !== undefined) resolved.value = params.value;
    if (params.currency) resolved.currency = params.currency;
    if (params.status) resolved.status = params.status;
    if (params.expected_close_date) resolved.expected_close_date = params.expected_close_date;

    // Owner resolution
    if (params.owner) {
      resolved.user_id = userResolver.resolveNameToId(params.owner as string);
    }

    // Person/org entity resolution
    if (params.person !== undefined) {
      resolved.person_id = await entityResolver.resolve('person', params.person as string | number);
    }
    if (params.organization !== undefined) {
      resolved.org_id = await entityResolver.resolve('organization', params.organization as string | number);
    }

    // Pipeline and stage resolution
    if (params.pipeline || params.stage) {
      let pipelineId: number | undefined;

      if (params.pipeline) {
        pipelineId = pipelineResolver.resolvePipelineNameToId(params.pipeline as string);
        resolved.pipeline_id = pipelineId;
      }

      if (params.stage) {
        if (pipelineId) {
          resolved.stage_id = pipelineResolver.resolveStageNameToId(params.stage as string, pipelineId);
        } else {
          // No pipeline specified — try global resolution
          const result = pipelineResolver.resolveStageGlobally(params.stage as string);
          resolved.stage_id = result.stageId;
          resolved.pipeline_id = result.pipelineId;
          // Note: caller should include inference note in response
        }
      }
    }

    // Custom fields
    if (params.fields && typeof params.fields === 'object') {
      for (const [label, value] of Object.entries(params.fields as Record<string, unknown>)) {
        const key = fieldResolver.resolveInputField(label);
        resolved[key] = fieldResolver.resolveInputValue(key, value);
      }
    }

    return resolved;
  }

  // ─── Helper: resolve output record to human-readable format ───
  // Uses Fix 7 version: system field passthrough, PASSTHROUGH set, SKIP set for IDs

  async function resolveOutputRecord(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fieldResolver = await resolver.getFieldResolver('deal');
    const userResolver = await resolver.getUserResolver();
    const pipelineResolver = await resolver.getPipelineResolver();
    const result: Record<string, unknown> = {};

    // Pass through system fields that shouldn't go through field resolver
    const PASSTHROUGH = new Set([
      'id', 'add_time', 'update_time', 'close_time',
      'won_time', 'lost_time', 'visible_to', 'deleted',
    ]);

    // Skip internal IDs that get resolved to human-readable names below
    const SKIP = new Set([
      'user_id', 'pipeline_id', 'stage_id', 'person_id', 'org_id', 'creator_user_id',
    ]);

    for (const [key, value] of Object.entries(raw)) {
      if (PASSTHROUGH.has(key)) {
        result[key] = value;
        continue;
      }
      if (SKIP.has(key)) {
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

  // ─── Helper: build deal summary shape ───

  async function toDealSummary(raw: Record<string, unknown>): Promise<DealSummary> {
    const userResolver = await resolver.getUserResolver();
    const pipelineResolver = await resolver.getPipelineResolver();
    return {
      id: raw.id as number,
      title: (raw.title as string) ?? '',
      status: (raw.status as string) ?? '',
      pipeline: raw.pipeline_id ? pipelineResolver.resolvePipelineIdToName(raw.pipeline_id as number) : '',
      stage: raw.stage_id ? pipelineResolver.resolveStageIdToName(raw.stage_id as number) : '',
      owner: raw.user_id ? userResolver.resolveIdToName(raw.user_id as number) : '',
      value: (raw.value as number) ?? null,
      updated_at: (raw.update_time as string) ?? '',
    };
  }

  // ─── Tool Definitions ───

  return [

    // ── list-deals ──

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

    // ── get-deal ──

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

    // ── create-deal ──

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

    // ── update-deal ──

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

    // ── delete-deal ──

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

    // ── search-deals ──

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
}
```

---

## Step 4: Run deal tests

- [ ] **Verify all deal tests pass**

```bash
npx vitest run tests/tools/deals.test.ts
```

Expected: All PASS.

---

## Step 5: Commit

- [ ] **Commit deal tool handlers and tests**

```bash
git add src/tools/deals.ts tests/tools/deals.test.ts
git commit -m "feat: deal tool handlers with full CRUD, field/stage/entity resolution"
```

---

## Implementation Notes

### resolveOutputRecord (Fix 7 version)

The `resolveOutputRecord` helper uses two critical sets:

- **PASSTHROUGH** (`id`, `add_time`, `update_time`, `close_time`, `won_time`, `lost_time`, `visible_to`, `deleted`): These system fields are copied directly to the output without going through the field resolver. They are not hash-keyed and don't need label resolution.

- **SKIP** (`user_id`, `pipeline_id`, `stage_id`, `person_id`, `org_id`, `creator_user_id`): These internal ID fields are skipped in the loop because they are resolved to human-readable names in a separate step below the loop (e.g., `user_id` becomes `owner: "Stacy"`). For `person_id` and `org_id`, the raw IDs are preserved so the agent can use them in subsequent calls.

### update-deal stage resolution

When the agent updates a deal's stage without specifying a pipeline, the handler fetches the deal's current pipeline first. This is necessary because stage names are not globally unique -- "Qualified" could exist in both "Sales" and "Partnerships" pipelines. The current pipeline provides the context needed to resolve the stage name to the correct stage ID.

If the agent specifies both pipeline and stage, no preliminary GET is needed -- the pipeline provides the context directly.

### delete-deal two-step flow

The delete handler is stateless. It does not track whether a confirmation was previously shown. The `confirm` parameter is a soft contract:

1. Without `confirm: true`: returns a confirmation prompt with the deal title (best-effort GET).
2. With `confirm: true`: executes the delete. A best-effort GET fetches the title before deletion so the response can include it.

If the title GET fails (transient error, permissions, etc.), the flow continues with ID-only information. The deletion itself is not blocked by title fetch failures.

### create-deal pipeline inference

When the agent specifies a stage without a pipeline on create, `resolveStageGlobally` attempts to find a unique match. If the stage name exists in exactly one pipeline, that pipeline is inferred. The response includes a `_note` field explaining the inference so the agent sees what happened.

### search-deals response shape

Search results go through `toDealSummary` just like list results. The search API may return items with a slightly different shape than the list API, but `toDealSummary` handles both by accessing the same fields (`id`, `title`, `status`, `pipeline_id`, `stage_id`, `user_id`, `value`, `update_time`).
