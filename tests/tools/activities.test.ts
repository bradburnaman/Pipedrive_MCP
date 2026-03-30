// tests/tools/activities.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActivityTools } from '../../src/tools/activities.js';

// --- Mocks ---

function createMockClient() {
  return {
    request: vi.fn(),
  };
}

function createMockActivityTypeResolver() {
  return {
    isValidType: vi.fn((type: string) => {
      const valid = new Set(['call', 'meeting', 'task', 'email', 'deadline']);
      return valid.has(type.toLowerCase());
    }),
    normalizeType: vi.fn((type: string) => type.toLowerCase()),
    getTypes: vi.fn(() => [
      { key_string: 'call', name: 'Call', active_flag: true },
      { key_string: 'meeting', name: 'Meeting', active_flag: true },
      { key_string: 'task', name: 'Task', active_flag: true },
      { key_string: 'email', name: 'Email', active_flag: true },
      { key_string: 'deadline', name: 'Deadline', active_flag: true },
    ]),
  };
}

function createMockUserResolver() {
  return {
    resolveNameToId: vi.fn((name: string) => {
      const users: Record<string, number> = { stacy: 1, brad: 2 };
      const id = users[name.toLowerCase()];
      if (id) return id;
      throw new Error(`No user found matching '${name}'. Available users: Stacy, Brad`);
    }),
    resolveIdToName: vi.fn((id: number) => {
      const names: Record<number, string> = { 1: 'Stacy', 2: 'Brad' };
      return names[id] ?? `User ${id}`;
    }),
  };
}

function createMockResolver() {
  const activityTypeResolver = createMockActivityTypeResolver();
  const userResolver = createMockUserResolver();
  return {
    getActivityTypeResolver: vi.fn(async () => activityTypeResolver),
    getUserResolver: vi.fn(async () => userResolver),
    getFieldResolver: vi.fn(),
    getPipelineResolver: vi.fn(),
    _activityTypeResolver: activityTypeResolver,
    _userResolver: userResolver,
  };
}

function createMockEntityResolver() {
  return {
    resolve: vi.fn(),
  };
}

describe('createActivityTools', () => {
  let client: ReturnType<typeof createMockClient>;
  let resolver: ReturnType<typeof createMockResolver>;
  let entityResolver: ReturnType<typeof createMockEntityResolver>;
  let tools: ReturnType<typeof createActivityTools>;

  beforeEach(() => {
    client = createMockClient();
    resolver = createMockResolver();
    entityResolver = createMockEntityResolver();
    tools = createActivityTools(client as any, resolver as any, entityResolver as any);
  });

  function findTool(name: string) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`Tool '${name}' not found`);
    return tool;
  }

  // --- list-activities ---

  describe('list-activities', () => {
    it('lists activities with type filter', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: [
            {
              id: 1,
              type: 'call',
              subject: 'Follow up call',
              due_date: '2026-04-01',
              done: false,
              deal_title: 'Acme Deal',
              person_name: 'John Smith',
              user_id: 1,
            },
          ],
          additional_data: { next_cursor: null },
        },
        headers: new Headers(),
      });

      const tool = findTool('list-activities');
      const result = await tool.handler({ type: 'call' }) as any;

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        id: 1,
        type: 'call',
        subject: 'Follow up call',
        due_date: '2026-04-01',
        done: false,
        deal: 'Acme Deal',
        person: 'John Smith',
        owner: 'Stacy',
      });
      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v1', '/activities',
        undefined,
        expect.objectContaining({ type: 'call' }),
      );
    });

    it('lists activities with date range filters', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: [],
          additional_data: { next_cursor: null },
        },
        headers: new Headers(),
      });

      const tool = findTool('list-activities');
      await tool.handler({
        start_date: '2026-03-01',
        end_date: '2026-03-31',
        done: true,
      });

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v1', '/activities',
        undefined,
        expect.objectContaining({
          start_date: '2026-03-01',
          end_date: '2026-03-31',
          done: '1',
        }),
      );
    });

    it('lists activities with updated_since filter', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: [],
          additional_data: { next_cursor: null },
        },
        headers: new Headers(),
      });

      const tool = findTool('list-activities');
      await tool.handler({ updated_since: '2026-03-15' });

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v1', '/activities',
        undefined,
        expect.objectContaining({ since: '2026-03-15' }),
      );
    });

    it('returns pagination cursor when has_more', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: [
            { id: 1, type: 'task', subject: 'Task 1', due_date: null, done: false, user_id: 1 },
          ],
          additional_data: { next_cursor: 'abc123' },
        },
        headers: new Headers(),
      });

      const tool = findTool('list-activities');
      const result = await tool.handler({}) as any;

      expect(result.has_more).toBe(true);
      expect(result.next_cursor).toBeDefined();
    });
  });

  // --- get-activity ---

  describe('get-activity', () => {
    it('returns full activity record', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 42,
            type: 'meeting',
            subject: 'Quarterly Review',
            due_date: '2026-04-15',
            due_time: '14:00',
            duration: '01:00',
            done: false,
            deal_id: 10,
            deal_title: 'Big Deal',
            person_id: 20,
            person_name: 'Jane Doe',
            org_id: 30,
            user_id: 2,
            note: 'Bring slides',
            add_time: '2026-03-28 10:00:00',
            update_time: '2026-03-29 11:00:00',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('get-activity');
      const result = await tool.handler({ id: 42 }) as any;

      expect(result.id).toBe(42);
      expect(result.type).toBe('meeting');
      expect(result.subject).toBe('Quarterly Review');
      expect(result.owner).toBe('Brad');
      expect(result.deal_title).toBe('Big Deal');
      expect(result.person_name).toBe('Jane Doe');
      expect(client.request).toHaveBeenCalledWith('GET', 'v1', '/activities/42');
    });
  });

  // --- create-activity ---

  describe('create-activity', () => {
    it('creates activity with valid type', async () => {
      // POST response
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { success: true, data: { id: 99 } },
        headers: new Headers(),
      });
      // GET after write
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 99,
            type: 'call',
            subject: 'Check in with client',
            due_date: '2026-04-01',
            done: false,
            user_id: 1,
            deal_id: 5,
            deal_title: 'Acme Deal',
            person_id: null,
            person_name: null,
            org_id: null,
            add_time: '2026-03-30 09:00:00',
            update_time: '2026-03-30 09:00:00',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('create-activity');
      const result = await tool.handler({
        type: 'call',
        subject: 'Check in with client',
        due_date: '2026-04-01',
        owner: 'Stacy',
        deal_id: 5,
      }) as any;

      expect(result.id).toBe(99);
      expect(result.type).toBe('call');
      expect(result.subject).toBe('Check in with client');
      expect(result.owner).toBe('Stacy');

      // Verify POST payload
      expect(client.request).toHaveBeenCalledWith(
        'POST', 'v1', '/activities',
        expect.objectContaining({
          type: 'call',
          subject: 'Check in with client',
          due_date: '2026-04-01',
          user_id: 1,
          deal_id: 5,
        }),
      );
    });

    it('validates type against ActivityTypeResolver', async () => {
      const tool = findTool('create-activity');

      // Valid type should not throw (handled above)
      // Invalid type should throw with helpful error
      await expect(
        tool.handler({ type: 'yoga', subject: 'Morning session' })
      ).rejects.toThrow(/Invalid activity type 'yoga'/);
    });

    it('rejects invalid type with list of valid types', async () => {
      const tool = findTool('create-activity');

      try {
        await tool.handler({ type: 'invalid_type', subject: 'Test' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('Invalid activity type');
        expect(err.message).toContain('call');
        expect(err.message).toContain('meeting');
        expect(err.message).toContain('task');
      }
    });

    it('normalizes type casing', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { success: true, data: { id: 100 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 100, type: 'meeting', subject: 'Standup',
            due_date: null, done: false, user_id: 1,
            deal_id: null, deal_title: null, person_id: null, person_name: null, org_id: null,
            add_time: '2026-03-30', update_time: '2026-03-30',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('create-activity');
      await tool.handler({ type: 'Meeting', subject: 'Standup' });

      expect(client.request).toHaveBeenCalledWith(
        'POST', 'v1', '/activities',
        expect.objectContaining({ type: 'meeting' }),
      );
    });

    it('resolves owner name to user_id', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { success: true, data: { id: 101 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 101, type: 'task', subject: 'Review doc', due_date: null, done: false,
            user_id: 2, deal_id: null, deal_title: null, person_id: null, person_name: null,
            org_id: null, add_time: '2026-03-30', update_time: '2026-03-30',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('create-activity');
      await tool.handler({ type: 'task', subject: 'Review doc', owner: 'Brad' });

      expect(client.request).toHaveBeenCalledWith(
        'POST', 'v1', '/activities',
        expect.objectContaining({ user_id: 2 }),
      );
    });
  });

  // --- update-activity ---

  describe('update-activity', () => {
    it('updates activity fields', async () => {
      // PUT response
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { id: 42 } },
        headers: new Headers(),
      });
      // GET after write
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 42, type: 'meeting', subject: 'Updated Subject',
            due_date: '2026-05-01', done: true, user_id: 1,
            deal_id: null, deal_title: null, person_id: null, person_name: null,
            org_id: null, add_time: '2026-03-28', update_time: '2026-03-30',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('update-activity');
      const result = await tool.handler({
        id: 42,
        subject: 'Updated Subject',
        done: true,
      }) as any;

      expect(result.id).toBe(42);
      expect(result.subject).toBe('Updated Subject');
      expect(client.request).toHaveBeenCalledWith(
        'PUT', 'v1', '/activities/42',
        expect.objectContaining({ subject: 'Updated Subject', done: true }),
      );
    });

    it('rejects update with no fields beyond id', async () => {
      const tool = findTool('update-activity');
      await expect(tool.handler({ id: 42 })).rejects.toThrow(
        'No fields provided. Include at least one field to update.'
      );
    });
  });

  // --- delete-activity ---

  describe('delete-activity', () => {
    it('returns confirmation prompt on first call', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: { id: 42, subject: 'Team Standup', type: 'meeting' },
        },
        headers: new Headers(),
      });

      const tool = findTool('delete-activity');
      const result = await tool.handler({ id: 42 }) as any;

      expect(result.confirm_required).toBe(true);
      expect(result.message).toContain('permanently delete');
      expect(result.message).toContain('Team Standup');
      expect(result.message).toContain('42');
      expect(result.message).toContain('confirm: true');
    });

    it('executes deletion when confirm is true', async () => {
      // GET for subject before delete
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { id: 42, subject: 'Team Standup' } },
        headers: new Headers(),
      });
      // DELETE
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: new Headers(),
      });

      const tool = findTool('delete-activity');
      const result = await tool.handler({ id: 42, confirm: true }) as any;

      expect(result.deleted).toBe(true);
      expect(result.id).toBe(42);
      expect(result.subject).toBe('Team Standup');
      expect(client.request).toHaveBeenCalledWith('DELETE', 'v1', '/activities/42');
    });

    it('deletes with ID-only response if GET fails', async () => {
      // GET fails
      client.request.mockResolvedValueOnce({
        status: 404,
        data: { success: false },
        headers: new Headers(),
      });
      // DELETE succeeds
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: new Headers(),
      });

      const tool = findTool('delete-activity');
      const result = await tool.handler({ id: 42, confirm: true }) as any;

      expect(result.deleted).toBe(true);
      expect(result.id).toBe(42);
      expect(result.subject).toBeUndefined();
    });
  });
});
