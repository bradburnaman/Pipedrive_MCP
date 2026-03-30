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
