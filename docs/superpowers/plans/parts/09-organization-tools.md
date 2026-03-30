# Part 9: Organization Tools
> Part 9 of 13 — Organization CRUD tool handlers (no delete) with field resolution and owner resolution
> **Depends on:** Parts 2, 4, 5, 6, 7 (types, sanitizer, cursor, error-normalizer, reference-resolver, deals pattern)
> **Produces:** `src/tools/organizations.ts`, `tests/tools/organizations.test.ts`

---

## Overview

Five organization tools following the deal pattern from Part 7. Key differences: no delete tool (intentional -- cascading destruction to linked persons and deals), no entity resolution needed on input (orgs don't link to other entities by name on create/update), no pipeline/stage resolution. The `entityResolver` parameter is accepted for signature consistency but is not used.

---

## Step 1: Write organization tool tests

Create `tests/tools/organizations.test.ts`:

```typescript
// tests/tools/organizations.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOrganizationTools } from '../../src/tools/organizations.js';
import type { ToolDefinition } from '../../src/types.js';

// --- Mock Factories ---

function createMockClient() {
  return {
    request: vi.fn(),
  };
}

function createMockResolver() {
  const fieldResolver = {
    resolveInputField: vi.fn((label: string) => `hash_${label.toLowerCase().replace(/\s/g, '_')}`),
    resolveInputValue: vi.fn((_key: string, value: unknown) => value),
    getOutputKey: vi.fn((key: string) => key.startsWith('hash_') ? key.replace('hash_', '').replace(/_/g, ' ') : key),
    resolveOutputValue: vi.fn((_key: string, value: unknown) => value),
  };

  const userResolver = {
    resolveNameToId: vi.fn((name: string) => {
      if (name.toLowerCase() === 'stacy') return 101;
      if (name.toLowerCase() === 'brad') return 102;
      throw new Error(`No user found matching '${name}'.`);
    }),
    resolveIdToName: vi.fn((id: number) => {
      if (id === 101) return 'Stacy';
      if (id === 102) return 'Brad';
      return `User ${id}`;
    }),
  };

  return {
    getFieldResolver: vi.fn(async () => fieldResolver),
    getUserResolver: vi.fn(async () => userResolver),
    getPipelineResolver: vi.fn(async () => ({})),
    getActivityTypeResolver: vi.fn(async () => ({})),
    _fieldResolver: fieldResolver,
    _userResolver: userResolver,
  };
}

function createMockEntityResolver() {
  return {
    resolve: vi.fn(),
  };
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

// --- Raw organization data from Pipedrive ---

function makePipedriveOrgRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    name: 'Acme Corp',
    user_id: 101,
    address: '123 Main St, Springfield, IL 62701',
    add_time: '2026-01-10T09:00:00Z',
    update_time: '2026-03-18T11:45:00Z',
    visible_to: 3,
    ...overrides,
  };
}

describe('createOrganizationTools', () => {
  let client: ReturnType<typeof createMockClient>;
  let resolver: ReturnType<typeof createMockResolver>;
  let entityResolver: ReturnType<typeof createMockEntityResolver>;
  let tools: ToolDefinition[];

  beforeEach(() => {
    client = createMockClient();
    resolver = createMockResolver();
    entityResolver = createMockEntityResolver();
    tools = createOrganizationTools(client as any, resolver as any, entityResolver as any);
  });

  // --- list-organizations ---

  describe('list-organizations', () => {
    it('lists organizations with default params', async () => {
      const raw = makePipedriveOrgRaw();
      client.request.mockResolvedValue({
        status: 200,
        data: { data: [raw], additional_data: { next_cursor: null } },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'list-organizations');
      const result = await tool.handler({});

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v2', '/organizations', undefined, expect.any(Object)
      );
      expect((result as any).items).toHaveLength(1);
      expect((result as any).items[0]).toEqual({
        id: 501,
        name: 'Acme Corp',
        owner: 'Stacy',
        address: '123 Main St, Springfield, IL 62701',
        updated_at: '2026-03-18T11:45:00Z',
      });
      expect((result as any).has_more).toBe(false);
    });

    it('filters by owner name', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: { data: [], additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'list-organizations');
      await tool.handler({ owner: 'Brad' });

      const callArgs = client.request.mock.calls[0];
      const queryParams = callArgs[4];
      expect(queryParams.user_id).toBe('102');
    });

    it('returns pagination cursor when has_more', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: {
          data: [makePipedriveOrgRaw()],
          additional_data: { next_cursor: 'xyz789' },
        },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'list-organizations');
      const result = await tool.handler({});

      expect((result as any).has_more).toBe(true);
      expect((result as any).next_cursor).toBeDefined();
    });

    it('passes updated_since filter', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: { data: [], additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'list-organizations');
      await tool.handler({ updated_since: '2026-03-01' });

      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.since).toBe('2026-03-01');
    });

    it('passes sort params', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: { data: [], additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'list-organizations');
      await tool.handler({ sort_by: 'name', sort_order: 'asc' });

      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.sort).toBe('name');
      expect(queryParams.sort_direction).toBe('asc');
    });
  });

  // --- get-organization ---

  describe('get-organization', () => {
    it('returns full resolved record', async () => {
      const raw = makePipedriveOrgRaw();
      client.request.mockResolvedValue({
        status: 200,
        data: { data: raw },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'get-organization');
      const result = await tool.handler({ id: 501 }) as Record<string, unknown>;

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v2', '/organizations/501'
      );
      expect(result.id).toBe(501);
      expect(result.name).toBe('Acme Corp');
      expect(result.owner).toBe('Stacy');
      expect(result.updated_at).toBe('2026-03-18T11:45:00Z');
    });
  });

  // --- create-organization ---

  describe('create-organization', () => {
    it('creates organization with name, owner, and address', async () => {
      const createdRaw = makePipedriveOrgRaw({ id: 600 });

      // POST response
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { data: { id: 600 } },
        headers: new Headers(),
      });
      // GET-after-write response
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: createdRaw },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'create-organization');
      const result = await tool.handler({
        name: 'Acme Corp',
        owner: 'Stacy',
        address: '123 Main St, Springfield, IL 62701',
      });

      // Verify POST was called with resolved fields
      const postCall = client.request.mock.calls[0];
      expect(postCall[0]).toBe('POST');
      expect(postCall[1]).toBe('v2');
      expect(postCall[2]).toBe('/organizations');
      const body = postCall[3] as Record<string, unknown>;
      expect(body.name).toBe('Acme Corp');
      expect(body.user_id).toBe(101);
      expect(body.address).toBe('123 Main St, Springfield, IL 62701');

      // Verify GET-after-write
      const getCall = client.request.mock.calls[1];
      expect(getCall[0]).toBe('GET');
      expect(getCall[2]).toBe('/organizations/600');

      expect((result as any).id).toBe(600);
    });

    it('creates organization with only required name', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { data: { id: 601 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedriveOrgRaw({ id: 601, name: 'NewCo' }) },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'create-organization');
      await tool.handler({ name: 'NewCo' });

      const body = client.request.mock.calls[0][3] as Record<string, unknown>;
      expect(body.name).toBe('NewCo');
      expect(body.user_id).toBeUndefined();
      expect(body.address).toBeUndefined();
    });

    it('creates organization with custom fields', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { data: { id: 602 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedriveOrgRaw({ id: 602 }) },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'create-organization');
      await tool.handler({
        name: 'Custom Corp',
        fields: { 'Industry': 'Technology' },
      });

      const body = client.request.mock.calls[0][3] as Record<string, unknown>;
      expect(body.hash_industry).toBe('Technology');
    });

    it('does not call entityResolver (orgs have no entity links on create)', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { data: { id: 603 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedriveOrgRaw({ id: 603 }) },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'create-organization');
      await tool.handler({ name: 'Test Corp' });

      expect(entityResolver.resolve).not.toHaveBeenCalled();
    });
  });

  // --- update-organization ---

  describe('update-organization', () => {
    it('updates organization fields', async () => {
      const updatedRaw = makePipedriveOrgRaw({ name: 'Acme Updated' });

      // PATCH response
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: { id: 501 } },
        headers: new Headers(),
      });
      // GET-after-write response
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: updatedRaw },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'update-organization');
      const result = await tool.handler({ id: 501, name: 'Acme Updated' });

      expect(client.request.mock.calls[0][0]).toBe('PATCH');
      expect(client.request.mock.calls[0][2]).toBe('/organizations/501');
      expect((result as any).name).toBe('Acme Updated');
    });

    it('rejects update with no fields', async () => {
      const tool = findTool(tools, 'update-organization');
      await expect(tool.handler({ id: 501 })).rejects.toThrow(
        'No fields provided. Include at least one field to update.'
      );
      expect(client.request).not.toHaveBeenCalled();
    });

    it('updates owner by name', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: { id: 501 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedriveOrgRaw({ user_id: 102 }) },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'update-organization');
      await tool.handler({ id: 501, owner: 'Brad' });

      const patchBody = client.request.mock.calls[0][3] as Record<string, unknown>;
      expect(patchBody.user_id).toBe(102);
    });

    it('updates address', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: { id: 501 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedriveOrgRaw({ address: '456 Oak Ave' }) },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'update-organization');
      await tool.handler({ id: 501, address: '456 Oak Ave' });

      const patchBody = client.request.mock.calls[0][3] as Record<string, unknown>;
      expect(patchBody.address).toBe('456 Oak Ave');
    });
  });

  // --- search-organizations ---

  describe('search-organizations', () => {
    it('returns summary shape results', async () => {
      const raw = makePipedriveOrgRaw();
      client.request.mockResolvedValue({
        status: 200,
        data: { data: { items: [raw] }, additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'search-organizations');
      const result = await tool.handler({ query: 'Acme' }) as any;

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v2', '/organizations/search', undefined,
        expect.objectContaining({ term: 'Acme' })
      );
      expect(result.items).toHaveLength(1);
      const summary = result.items[0];
      expect(summary.id).toBe(501);
      expect(summary.name).toBe('Acme Corp');
      expect(summary.owner).toBe('Stacy');
      expect(summary.address).toBe('123 Main St, Springfield, IL 62701');
      expect(summary.updated_at).toBeDefined();
    });

    it('passes limit and cursor params', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: { data: { items: [] }, additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'search-organizations');
      await tool.handler({ query: 'test', limit: 25 });

      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.term).toBe('test');
      expect(queryParams.limit).toBe('25');
    });

    it('returns empty results gracefully', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: { data: { items: [] }, additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'search-organizations');
      const result = await tool.handler({ query: 'nonexistent' }) as any;

      expect(result.items).toHaveLength(0);
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeUndefined();
    });
  });

  // --- Tool registration ---

  describe('tool registration', () => {
    it('creates exactly 5 tools (no delete)', () => {
      expect(tools).toHaveLength(5);
    });

    it('does not include a delete tool', () => {
      const deleteTools = tools.filter(t => t.category === 'delete');
      expect(deleteTools).toHaveLength(0);
    });

    it('assigns correct categories', () => {
      expect(findTool(tools, 'list-organizations').category).toBe('read');
      expect(findTool(tools, 'get-organization').category).toBe('read');
      expect(findTool(tools, 'create-organization').category).toBe('create');
      expect(findTool(tools, 'update-organization').category).toBe('update');
      expect(findTool(tools, 'search-organizations').category).toBe('read');
    });
  });
});
```

---

## Step 2: Run tests to verify they fail

```bash
npx vitest run tests/tools/organizations.test.ts
```

Expected: FAIL -- `createOrganizationTools` not found.

---

## Step 3: Write organization tool handlers

Create `src/tools/organizations.ts`:

```typescript
// src/tools/organizations.ts
import type { ToolDefinition, OrganizationSummary } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import type { EntityResolver } from '../lib/entity-resolver.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { trimString, validateStringLength } from '../lib/sanitizer.js';
import type { Logger } from 'pino';

export function createOrganizationTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver,
  logger?: Logger
): ToolDefinition[] {
  // entityResolver is accepted for signature consistency with other tool
  // factories but is not used — organizations don't link to other entities
  // by name on create/update.
  void entityResolver;

  // --- Helper: resolve org input fields from human-friendly to Pipedrive format ---

  async function resolveOrgInput(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fieldResolver = await resolver.getFieldResolver('organization');
    const userResolver = await resolver.getUserResolver();
    const resolved: Record<string, unknown> = {};

    // Name
    if (params.name) {
      resolved.name = trimString(params.name as string, 'name');
    }

    // Owner — resolve user name to ID
    if (params.owner) {
      resolved.user_id = userResolver.resolveNameToId(params.owner as string);
    }

    // Address — pass through as string
    if (params.address) {
      resolved.address = trimString(params.address as string, 'address');
    }

    // Custom fields — resolve labels to keys, option labels to IDs
    if (params.fields && typeof params.fields === 'object') {
      for (const [label, value] of Object.entries(params.fields as Record<string, unknown>)) {
        const key = fieldResolver.resolveInputField(label);
        resolved[key] = fieldResolver.resolveInputValue(key, value);
      }
    }

    return resolved;
  }

  // --- Helper: resolve Pipedrive raw output to human-friendly format ---

  async function resolveOrgOutput(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fieldResolver = await resolver.getFieldResolver('organization');
    const userResolver = await resolver.getUserResolver();
    const result: Record<string, unknown> = {};

    // System fields that pass through without field resolution
    const PASSTHROUGH = new Set(['id', 'add_time', 'update_time', 'visible_to']);

    // Internal ID fields that get resolved separately below
    const SKIP = new Set(['user_id', 'creator_user_id']);

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
    if (raw.user_id) {
      result.owner = userResolver.resolveIdToName(raw.user_id as number);
    }

    // Rename update_time to updated_at for consistency
    if (result.update_time) {
      result.updated_at = result.update_time;
      delete result.update_time;
    }

    return result;
  }

  // --- Helper: build organization summary for list/search responses ---

  async function toOrgSummary(raw: Record<string, unknown>): Promise<OrganizationSummary> {
    const userResolver = await resolver.getUserResolver();

    return {
      id: raw.id as number,
      name: (raw.name as string) ?? '',
      owner: raw.user_id ? userResolver.resolveIdToName(raw.user_id as number) : '',
      address: (raw.address as string) ?? null,
      updated_at: (raw.update_time as string) ?? '',
    };
  }

  // --- Tool Definitions ---

  return [
    // =====================================================================
    // list-organizations
    // =====================================================================
    {
      name: 'list-organizations',
      category: 'read' as const,
      description: "Browse organizations by structured filters (owner, updated_since). Returns summary shape.",
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: "User name, e.g. 'Stacy'",
          },
          updated_since: {
            type: 'string',
            description: 'ISO date (YYYY-MM-DD) — organizations updated on or after',
          },
          sort_by: {
            type: 'string',
            description: 'Field to sort on',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
          },
          limit: {
            type: 'number',
            description: 'Page size (default 100)',
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor from previous response',
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const userResolver = await resolver.getUserResolver();
        const query: Record<string, string> = {};

        if (params.owner) {
          query.user_id = String(userResolver.resolveNameToId(params.owner as string));
        }
        if (params.updated_since) {
          query.since = params.updated_since as string;
        }
        if (params.sort_by) {
          query.sort = params.sort_by as string;
        }
        if (params.sort_order) {
          query.sort_direction = params.sort_order as string;
        }
        if (params.limit) {
          query.limit = String(params.limit);
        }

        // Pagination
        if (params.cursor) {
          const decoded = decodeCursor(params.cursor as string);
          if (decoded.v === 'v2' && decoded.cursor) {
            query.cursor = decoded.cursor;
          }
          if (decoded.v === 'v1' && decoded.offset !== undefined) {
            query.start = String(decoded.offset);
          }
        }

        const response = await normalizeApiCall(
          async () => client.request('GET', 'v2', '/organizations', undefined, query),
          undefined,
          logger
        );

        const respData = (response as any).data;
        const items = respData.data ?? [];
        const summaries = await Promise.all(items.map((o: any) => toOrgSummary(o)));

        const nextCursor = respData.additional_data?.next_cursor;
        return {
          items: summaries,
          has_more: !!nextCursor,
          next_cursor: nextCursor
            ? encodeCursor({ v: 'v2', cursor: nextCursor })
            : undefined,
        };
      },
    },

    // =====================================================================
    // get-organization
    // =====================================================================
    {
      name: 'get-organization',
      category: 'read' as const,
      description: "Get a single organization by ID with all fields resolved to human-readable labels. Returns full record.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Organization ID' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const response = await normalizeApiCall(
          async () => client.request('GET', 'v2', `/organizations/${id}`),
          { entity: 'Organization', id },
          logger
        );
        const raw = (response as any).data.data;
        return resolveOrgOutput(raw);
      },
    },

    // =====================================================================
    // create-organization
    // =====================================================================
    {
      name: 'create-organization',
      category: 'create' as const,
      description: "Create a new organization.",
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Organization name',
          },
          owner: {
            type: 'string',
            description: "User name, e.g. 'Stacy'",
          },
          address: {
            type: 'string',
            description: 'Full address',
          },
          fields: {
            type: 'object',
            description: "Custom fields as { 'Label Name': value }",
          },
        },
        required: ['name'],
      },
      handler: async (params: Record<string, unknown>) => {
        const resolved = await resolveOrgInput(params);
        validateStringLength(resolved.name as string, 'name', 255);

        const response = await normalizeApiCall(
          async () => client.request('POST', 'v2', '/organizations', resolved),
          undefined,
          logger
        );

        const created = (response as any).data.data;

        // GET after write for confirmed persisted state
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v2', `/organizations/${created.id}`),
          { entity: 'Organization', id: created.id },
          logger
        );
        const full = (getResponse as any).data.data;
        return resolveOrgOutput(full);
      },
    },

    // =====================================================================
    // update-organization
    // =====================================================================
    {
      name: 'update-organization',
      category: 'update' as const,
      description: "Update an existing organization by ID. Same field format as create-organization.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Organization ID' },
          name: { type: 'string', description: 'Organization name' },
          owner: {
            type: 'string',
            description: "User name",
          },
          address: {
            type: 'string',
            description: 'Full address',
          },
          fields: {
            type: 'object',
            description: "Custom fields as { 'Label Name': value }",
          },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const { id: _, ...updateParams } = params;

        // Validate at least one field beyond id
        const hasFields = Object.keys(updateParams).some(k =>
          updateParams[k] !== undefined &&
          (k !== 'fields' || Object.keys(updateParams[k] as object).length > 0)
        );
        if (!hasFields) {
          throw new Error('No fields provided. Include at least one field to update.');
        }

        const resolved = await resolveOrgInput(updateParams);

        await normalizeApiCall(
          async () => client.request('PATCH', 'v2', `/organizations/${id}`, resolved),
          { entity: 'Organization', id },
          logger
        );

        // GET after write for confirmed persisted state
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v2', `/organizations/${id}`),
          { entity: 'Organization', id },
          logger
        );
        return resolveOrgOutput((getResponse as any).data.data);
      },
    },

    // =====================================================================
    // search-organizations
    // =====================================================================
    {
      name: 'search-organizations',
      category: 'read' as const,
      description: "Find organizations by keyword across name and custom fields. Use when you have a name or term but not exact filter values. Returns summary shape.",
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search keyword',
          },
          limit: {
            type: 'number',
            description: 'Max results',
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor',
          },
        },
        required: ['query'],
      },
      handler: async (params: Record<string, unknown>) => {
        const queryParams: Record<string, string> = {
          term: params.query as string,
        };
        if (params.limit) {
          queryParams.limit = String(params.limit);
        }
        if (params.cursor) {
          const decoded = decodeCursor(params.cursor as string);
          if (decoded.v === 'v2' && decoded.cursor) {
            queryParams.cursor = decoded.cursor;
          }
        }

        const response = await normalizeApiCall(
          async () => client.request('GET', 'v2', '/organizations/search', undefined, queryParams),
          undefined,
          logger
        );

        const respData = (response as any).data;
        const items = respData.data?.items ?? [];
        const summaries = await Promise.all(
          items.map((item: any) => toOrgSummary(item))
        );

        const nextCursor = respData.additional_data?.next_cursor;
        return {
          items: summaries,
          has_more: !!nextCursor,
          next_cursor: nextCursor
            ? encodeCursor({ v: 'v2', cursor: nextCursor })
            : undefined,
        };
      },
    },
  ];

  // NOTE: No delete-organization tool. Intentional — deleting an organization
  // in Pipedrive cascades to linked persons and deals. Too destructive for
  // agent-initiated action. Use the Pipedrive UI for org deletion.
}
```

---

## Step 4: Run tests

```bash
npx vitest run tests/tools/organizations.test.ts
```

Expected: All tests pass.

---

## Step 5: Typecheck

```bash
npx tsc --noEmit
```

Expected: No errors.

---

## Step 6: Commit

```bash
git add src/tools/organizations.ts tests/tools/organizations.test.ts
git commit -m "feat: organization tool handlers with CRUD (no delete — intentional cascading protection)"
```
