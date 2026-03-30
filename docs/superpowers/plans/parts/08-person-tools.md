# Part 8: Person Tools
> Part 8 of 13 — Person CRUD tool handlers with entity resolution for organizations, email/phone array normalization, and field resolution
> **Depends on:** Parts 2, 4, 5, 6, 7, 8 (types, sanitizer, cursor, error-normalizer, reference-resolver, entity-resolver, deals pattern)
> **Produces:** `src/tools/persons.ts`, `tests/tools/persons.test.ts`

---

## Overview

Six person tools following the deal pattern from Part 7. Key differences: email/phone are arrays of objects in Pipedrive, organization is resolved via EntityResolver (name -> ID), no pipeline/stage resolution.

---

## Step 1: Write person tool tests

Create `tests/tools/persons.test.ts`:

```typescript
// tests/tools/persons.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPersonTools } from '../../src/tools/persons.js';
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
    resolve: vi.fn(async (type: string, value: string | number) => {
      if (typeof value === 'number') return value;
      if (type === 'organization') {
        if (value.toLowerCase() === 'acme corp') return 501;
        if (value.toLowerCase() === 'globex') return 502;
        throw new Error(`No organization found matching '${value}'.`);
      }
      throw new Error(`No ${type} found matching '${value}'.`);
    }),
  };
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

// --- Raw person data from Pipedrive ---

function makePipedrivePersonRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'John Smith',
    email: [{ value: 'john@example.com', primary: true, label: 'work' }],
    phone: [{ value: '+1234567890', primary: true, label: 'work' }],
    org_id: 501,
    org_name: 'Acme Corp',
    user_id: 101,
    add_time: '2026-01-15T10:00:00Z',
    update_time: '2026-03-20T14:30:00Z',
    visible_to: 3,
    ...overrides,
  };
}

describe('createPersonTools', () => {
  let client: ReturnType<typeof createMockClient>;
  let resolver: ReturnType<typeof createMockResolver>;
  let entityResolver: ReturnType<typeof createMockEntityResolver>;
  let tools: ToolDefinition[];

  beforeEach(() => {
    client = createMockClient();
    resolver = createMockResolver();
    entityResolver = createMockEntityResolver();
    tools = createPersonTools(client as any, resolver as any, entityResolver as any);
  });

  // --- list-persons ---

  describe('list-persons', () => {
    it('lists persons with default params', async () => {
      const raw = makePipedrivePersonRaw();
      client.request.mockResolvedValue({
        status: 200,
        data: { data: [raw], additional_data: { next_cursor: null } },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'list-persons');
      const result = await tool.handler({});

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v2', '/persons', undefined, expect.any(Object)
      );
      expect((result as any).items).toHaveLength(1);
      expect((result as any).items[0]).toEqual({
        id: 1,
        name: 'John Smith',
        email: 'john@example.com',
        phone: '+1234567890',
        organization: 'Acme Corp',
        owner: 'Stacy',
        updated_at: '2026-03-20T14:30:00Z',
      });
      expect((result as any).has_more).toBe(false);
    });

    it('filters by owner name', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: { data: [], additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'list-persons');
      await tool.handler({ owner: 'Stacy' });

      const callArgs = client.request.mock.calls[0];
      const queryParams = callArgs[4];
      expect(queryParams.user_id).toBe('101');
    });

    it('returns pagination cursor when has_more', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: {
          data: [makePipedrivePersonRaw()],
          additional_data: { next_cursor: 'abc123' },
        },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'list-persons');
      const result = await tool.handler({});

      expect((result as any).has_more).toBe(true);
      expect((result as any).next_cursor).toBeDefined();
    });
  });

  // --- get-person ---

  describe('get-person', () => {
    it('returns full resolved record', async () => {
      const raw = makePipedrivePersonRaw();
      client.request.mockResolvedValue({
        status: 200,
        data: { data: raw },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'get-person');
      const result = await tool.handler({ id: 1 }) as Record<string, unknown>;

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v2', '/persons/1'
      );
      expect(result.id).toBe(1);
      expect(result.name).toBe('John Smith');
      expect(result.owner).toBe('Stacy');
      expect(result.updated_at).toBe('2026-03-20T14:30:00Z');
    });
  });

  // --- create-person ---

  describe('create-person', () => {
    it('creates person with organization resolved by name', async () => {
      const createdRaw = makePipedrivePersonRaw({ id: 99 });

      // POST response
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { data: { id: 99 } },
        headers: new Headers(),
      });
      // GET-after-write response
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: createdRaw },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'create-person');
      const result = await tool.handler({
        name: 'John Smith',
        email: 'john@example.com',
        phone: '+1234567890',
        organization: 'Acme Corp',
        owner: 'Stacy',
      });

      // Verify entity resolution was called for organization
      expect(entityResolver.resolve).toHaveBeenCalledWith('organization', 'Acme Corp');

      // Verify POST was called with resolved IDs
      const postCall = client.request.mock.calls[0];
      expect(postCall[0]).toBe('POST');
      expect(postCall[1]).toBe('v2');
      expect(postCall[2]).toBe('/persons');
      const body = postCall[3] as Record<string, unknown>;
      expect(body.name).toBe('John Smith');
      expect(body.org_id).toBe(501);
      expect(body.user_id).toBe(101);
      // Email should be array of objects
      expect(body.email).toEqual([{ value: 'john@example.com', primary: true, label: 'work' }]);
      expect(body.phone).toEqual([{ value: '+1234567890', primary: true, label: 'work' }]);

      // Verify GET-after-write
      const getCall = client.request.mock.calls[1];
      expect(getCall[0]).toBe('GET');
      expect(getCall[2]).toBe('/persons/99');

      expect((result as any).id).toBe(99);
    });

    it('creates person with multiple emails', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { data: { id: 100 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedrivePersonRaw({ id: 100 }) },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'create-person');
      await tool.handler({
        name: 'Jane Doe',
        email: ['jane@work.com', 'jane@personal.com'],
      });

      const postBody = client.request.mock.calls[0][3] as Record<string, unknown>;
      expect(postBody.email).toEqual([
        { value: 'jane@work.com', primary: false, label: 'work' },
        { value: 'jane@personal.com', primary: false, label: 'work' },
      ]);
    });

    it('creates person with multiple phone numbers', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { data: { id: 100 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedrivePersonRaw({ id: 100 }) },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'create-person');
      await tool.handler({
        name: 'Jane Doe',
        phone: ['+1111111111', '+2222222222'],
      });

      const postBody = client.request.mock.calls[0][3] as Record<string, unknown>;
      expect(postBody.phone).toEqual([
        { value: '+1111111111', primary: false, label: 'work' },
        { value: '+2222222222', primary: false, label: 'work' },
      ]);
    });

    it('creates person with organization by numeric ID', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { data: { id: 100 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedrivePersonRaw({ id: 100 }) },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'create-person');
      await tool.handler({
        name: 'Jane Doe',
        organization: 501,
      });

      // EntityResolver returns the number directly
      expect(entityResolver.resolve).toHaveBeenCalledWith('organization', 501);
      const postBody = client.request.mock.calls[0][3] as Record<string, unknown>;
      expect(postBody.org_id).toBe(501);
    });
  });

  // --- update-person ---

  describe('update-person', () => {
    it('updates person fields', async () => {
      const updatedRaw = makePipedrivePersonRaw({ name: 'John Updated' });

      // PATCH response
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: { id: 1 } },
        headers: new Headers(),
      });
      // GET-after-write response
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: updatedRaw },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'update-person');
      const result = await tool.handler({ id: 1, name: 'John Updated' });

      expect(client.request.mock.calls[0][0]).toBe('PATCH');
      expect(client.request.mock.calls[0][2]).toBe('/persons/1');
      expect((result as any).name).toBe('John Updated');
    });

    it('rejects update with no fields', async () => {
      const tool = findTool(tools, 'update-person');
      await expect(tool.handler({ id: 1 })).rejects.toThrow(
        'No fields provided. Include at least one field to update.'
      );
      expect(client.request).not.toHaveBeenCalled();
    });

    it('updates organization by name', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: { id: 1 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: makePipedrivePersonRaw() },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'update-person');
      await tool.handler({ id: 1, organization: 'Globex' });

      expect(entityResolver.resolve).toHaveBeenCalledWith('organization', 'Globex');
      const patchBody = client.request.mock.calls[0][3] as Record<string, unknown>;
      expect(patchBody.org_id).toBe(502);
    });
  });

  // --- delete-person ---

  describe('delete-person', () => {
    it('returns confirmation prompt without confirm flag', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: { name: 'John Smith' } },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'delete-person');
      const result = await tool.handler({ id: 1 }) as any;

      expect(result.confirm_required).toBe(true);
      expect(result.message).toContain('John Smith');
      expect(result.message).toContain('ID 1');
      // Should NOT have called DELETE
      expect(client.request).toHaveBeenCalledTimes(1);
      expect(client.request.mock.calls[0][0]).toBe('GET');
    });

    it('executes deletion with confirm: true', async () => {
      // Best-effort GET for name
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { data: { name: 'John Smith' } },
        headers: new Headers(),
      });
      // DELETE
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'delete-person');
      const result = await tool.handler({ id: 1, confirm: true }) as any;

      expect(result.deleted).toBe(true);
      expect(result.id).toBe(1);
      expect(result.name).toBe('John Smith');
      expect(client.request.mock.calls[1][0]).toBe('DELETE');
      expect(client.request.mock.calls[1][2]).toBe('/persons/1');
    });

    it('proceeds with deletion even if name lookup fails', async () => {
      // GET fails
      client.request.mockRejectedValueOnce(new Error('Not found'));
      // DELETE succeeds
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'delete-person');
      const result = await tool.handler({ id: 999, confirm: true }) as any;

      expect(result.deleted).toBe(true);
      expect(result.id).toBe(999);
      expect(result.name).toBeUndefined();
    });
  });

  // --- search-persons ---

  describe('search-persons', () => {
    it('returns summary shape results', async () => {
      const raw = makePipedrivePersonRaw();
      client.request.mockResolvedValue({
        status: 200,
        data: { data: { items: [raw] }, additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'search-persons');
      const result = await tool.handler({ query: 'John' }) as any;

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v2', '/persons/search', undefined,
        expect.objectContaining({ term: 'John' })
      );
      expect(result.items).toHaveLength(1);
      const summary = result.items[0];
      expect(summary.id).toBe(1);
      expect(summary.name).toBe('John Smith');
      expect(summary.email).toBe('john@example.com');
      expect(summary.phone).toBe('+1234567890');
      expect(summary.organization).toBe('Acme Corp');
      expect(summary.owner).toBe('Stacy');
      expect(summary.updated_at).toBeDefined();
    });

    it('passes limit and cursor params', async () => {
      client.request.mockResolvedValue({
        status: 200,
        data: { data: { items: [] }, additional_data: {} },
        headers: new Headers(),
      });

      const tool = findTool(tools, 'search-persons');
      await tool.handler({ query: 'test', limit: 10 });

      const queryParams = client.request.mock.calls[0][4];
      expect(queryParams.term).toBe('test');
      expect(queryParams.limit).toBe('10');
    });
  });

  // --- Tool registration ---

  describe('tool registration', () => {
    it('creates exactly 6 tools', () => {
      expect(tools).toHaveLength(6);
    });

    it('assigns correct categories', () => {
      expect(findTool(tools, 'list-persons').category).toBe('read');
      expect(findTool(tools, 'get-person').category).toBe('read');
      expect(findTool(tools, 'create-person').category).toBe('create');
      expect(findTool(tools, 'update-person').category).toBe('update');
      expect(findTool(tools, 'delete-person').category).toBe('delete');
      expect(findTool(tools, 'search-persons').category).toBe('read');
    });
  });
});
```

---

## Step 2: Run tests to verify they fail

```bash
npx vitest run tests/tools/persons.test.ts
```

Expected: FAIL — `createPersonTools` not found.

---

## Step 3: Write person tool handlers

Create `src/tools/persons.ts`:

```typescript
// src/tools/persons.ts
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

  // --- Helper: resolve person input fields from human-friendly to Pipedrive format ---

  async function resolvePersonInput(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fieldResolver = await resolver.getFieldResolver('person');
    const userResolver = await resolver.getUserResolver();
    const resolved: Record<string, unknown> = {};

    // Name
    if (params.name) {
      resolved.name = trimString(params.name as string, 'name');
    }

    // Email — normalize to Pipedrive array-of-objects format
    if (params.email) {
      if (Array.isArray(params.email)) {
        resolved.email = (params.email as string[]).map(e => ({
          value: e,
          primary: false,
          label: 'work',
        }));
      } else {
        resolved.email = [{ value: params.email as string, primary: true, label: 'work' }];
      }
    }

    // Phone — normalize to Pipedrive array-of-objects format
    if (params.phone) {
      if (Array.isArray(params.phone)) {
        resolved.phone = (params.phone as string[]).map(p => ({
          value: p,
          primary: false,
          label: 'work',
        }));
      } else {
        resolved.phone = [{ value: params.phone as string, primary: true, label: 'work' }];
      }
    }

    // Owner — resolve user name to ID
    if (params.owner) {
      resolved.user_id = userResolver.resolveNameToId(params.owner as string);
    }

    // Organization — resolve name or pass through ID via EntityResolver
    if (params.organization !== undefined) {
      resolved.org_id = await entityResolver.resolve(
        'organization',
        params.organization as string | number
      );
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

  async function resolvePersonOutput(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fieldResolver = await resolver.getFieldResolver('person');
    const userResolver = await resolver.getUserResolver();
    const result: Record<string, unknown> = {};

    // System fields that pass through without field resolution
    const PASSTHROUGH = new Set(['id', 'add_time', 'update_time', 'visible_to']);

    // Internal ID fields that get resolved separately below
    const SKIP = new Set(['user_id', 'org_id', 'creator_user_id']);

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
    if (raw.org_id) {
      result.org_id = raw.org_id;
    }

    // Rename update_time to updated_at for consistency
    if (result.update_time) {
      result.updated_at = result.update_time;
      delete result.update_time;
    }

    return result;
  }

  // --- Helper: build person summary for list/search responses ---

  async function toPersonSummary(raw: Record<string, unknown>): Promise<PersonSummary> {
    const userResolver = await resolver.getUserResolver();

    // Extract primary email from Pipedrive's array-of-objects format
    const primaryEmail = Array.isArray(raw.email)
      ? (raw.email as Array<{ value: string; primary: boolean }>).find(e => e.primary)?.value
        ?? (raw.email as Array<{ value: string }>)[0]?.value
      : raw.email;

    // Extract primary phone from Pipedrive's array-of-objects format
    const primaryPhone = Array.isArray(raw.phone)
      ? (raw.phone as Array<{ value: string; primary: boolean }>).find(p => p.primary)?.value
        ?? (raw.phone as Array<{ value: string }>)[0]?.value
      : raw.phone;

    return {
      id: raw.id as number,
      name: (raw.name as string) ?? '',
      email: (primaryEmail as string) ?? null,
      phone: (primaryPhone as string) ?? null,
      organization: (raw.org_name as string) ?? null,
      owner: raw.user_id ? userResolver.resolveIdToName(raw.user_id as number) : '',
      updated_at: (raw.update_time as string) ?? '',
    };
  }

  // --- Tool Definitions ---

  return [
    // =====================================================================
    // list-persons
    // =====================================================================
    {
      name: 'list-persons',
      category: 'read' as const,
      description: "Browse persons by structured filters (owner, org_id, updated_since). Returns summary shape.",
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: "User name, e.g. 'Stacy'",
          },
          org_id: {
            type: 'number',
            description: 'Filter by organization ID',
          },
          updated_since: {
            type: 'string',
            description: 'ISO date (YYYY-MM-DD) — persons updated on or after',
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
        if (params.org_id) {
          query.org_id = String(params.org_id);
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
          async () => client.request('GET', 'v2', '/persons', undefined, query),
          undefined,
          logger
        );

        const respData = (response as any).data;
        const items = respData.data ?? [];
        const summaries = await Promise.all(items.map((p: any) => toPersonSummary(p)));

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
    // get-person
    // =====================================================================
    {
      name: 'get-person',
      category: 'read' as const,
      description: "Get a single person by ID with all fields resolved to human-readable labels. Returns full record.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Person ID' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const response = await normalizeApiCall(
          async () => client.request('GET', 'v2', `/persons/${id}`),
          { entity: 'Person', id },
          logger
        );
        const raw = (response as any).data.data;
        return resolvePersonOutput(raw);
      },
    },

    // =====================================================================
    // create-person
    // =====================================================================
    {
      name: 'create-person',
      category: 'create' as const,
      description: "Create a new person. Accepts organization by name or ID. Email and phone accept a single string or an array of strings.",
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "Person's full name",
          },
          email: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: "Email address(es)",
          },
          phone: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: "Phone number(s)",
          },
          organization: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
            description: "Organization name or ID",
          },
          owner: {
            type: 'string',
            description: "User name, e.g. 'Stacy'",
          },
          fields: {
            type: 'object',
            description: "Custom fields as { 'Label Name': value }",
          },
        },
        required: ['name'],
      },
      handler: async (params: Record<string, unknown>) => {
        const resolved = await resolvePersonInput(params);
        validateStringLength(resolved.name as string, 'name', 255);

        const response = await normalizeApiCall(
          async () => client.request('POST', 'v2', '/persons', resolved),
          undefined,
          logger
        );

        const created = (response as any).data.data;

        // GET after write for confirmed persisted state
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v2', `/persons/${created.id}`),
          { entity: 'Person', id: created.id },
          logger
        );
        const full = (getResponse as any).data.data;
        return resolvePersonOutput(full);
      },
    },

    // =====================================================================
    // update-person
    // =====================================================================
    {
      name: 'update-person',
      category: 'update' as const,
      description: "Update an existing person by ID. Same field format as create-person.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Person ID' },
          name: { type: 'string', description: "Person's full name" },
          email: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: "Email address(es)",
          },
          phone: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: "Phone number(s)",
          },
          organization: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
            description: "Organization name or ID",
          },
          owner: {
            type: 'string',
            description: "User name",
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

        const resolved = await resolvePersonInput(updateParams);

        await normalizeApiCall(
          async () => client.request('PATCH', 'v2', `/persons/${id}`, resolved),
          { entity: 'Person', id },
          logger
        );

        // GET after write for confirmed persisted state
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v2', `/persons/${id}`),
          { entity: 'Person', id },
          logger
        );
        return resolvePersonOutput((getResponse as any).data.data);
      },
    },

    // =====================================================================
    // delete-person
    // =====================================================================
    {
      name: 'delete-person',
      category: 'delete' as const,
      description: "Delete a person by ID. Requires two-step confirmation.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Person ID' },
          confirm: { type: 'boolean', description: 'Set to true to confirm deletion' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const confirm = params.confirm === true;

        // Step 1: Return confirmation prompt (unless confirm=true)
        if (!confirm) {
          // Best-effort GET for name
          let name = `Person ${id}`;
          try {
            const getResponse = await normalizeApiCall(
              async () => client.request('GET', 'v2', `/persons/${id}`),
              { entity: 'Person', id },
              logger
            );
            name = (getResponse as any).data.data?.name ?? name;
          } catch {
            // Fall back to ID-only
          }
          return {
            confirm_required: true,
            message: `This will permanently delete person '${name}' (ID ${id}). Call delete-person again with confirm: true to proceed.`,
          };
        }

        // Step 2: Execute deletion
        // Best-effort GET for name before delete
        let name: string | undefined;
        try {
          const getResponse = await normalizeApiCall(
            async () => client.request('GET', 'v2', `/persons/${id}`),
            { entity: 'Person', id },
            logger
          );
          name = (getResponse as any).data.data?.name;
        } catch {
          // Proceed without name
        }

        await normalizeApiCall(
          async () => client.request('DELETE', 'v2', `/persons/${id}`),
          { entity: 'Person', id },
          logger
        );

        return { id, name, deleted: true as const };
      },
    },

    // =====================================================================
    // search-persons
    // =====================================================================
    {
      name: 'search-persons',
      category: 'read' as const,
      description: "Find persons by keyword across name, email, phone, and custom fields. Use when you have a name or term but not exact filter values. Returns summary shape.",
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
          async () => client.request('GET', 'v2', '/persons/search', undefined, queryParams),
          undefined,
          logger
        );

        const respData = (response as any).data;
        const items = respData.data?.items ?? [];
        const summaries = await Promise.all(
          items.map((item: any) => toPersonSummary(item))
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
}
```

---

## Step 4: Run tests

```bash
npx vitest run tests/tools/persons.test.ts
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
git add src/tools/persons.ts tests/tools/persons.test.ts
git commit -m "feat: person tool handlers with CRUD, entity/field resolution, email/phone normalization"
```
