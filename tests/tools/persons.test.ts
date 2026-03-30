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
