// tests/tools/notes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNoteTools } from '../../src/tools/notes.js';

// We need to mock the sanitizer module so we can verify it's called
vi.mock('../../src/lib/sanitizer.js', () => ({
  sanitizeNoteContent: vi.fn((content: string) => {
    // Simple mock: strip <b> tags for testing, pass through everything else
    return content.replace(/<[^>]+>/g, '').trim();
  }),
  trimString: vi.fn((value: string, fieldName?: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error(`Field '${fieldName ?? 'value'}' cannot be empty.`);
    return trimmed;
  }),
  validateStringLength: vi.fn((value: string, fieldName: string, maxLength: number) => {
    if (value.length > maxLength) {
      throw new Error(`Field '${fieldName}' exceeds maximum length of ${maxLength} characters (got ${value.length}).`);
    }
  }),
}));

import { sanitizeNoteContent } from '../../src/lib/sanitizer.js';

// --- Mocks ---

function createMockClient() {
  return {
    request: vi.fn(),
  };
}

function createMockUserResolver() {
  return {
    resolveNameToId: vi.fn((name: string) => {
      const users: Record<string, number> = { stacy: 1, brad: 2 };
      const id = users[name.toLowerCase()];
      if (id) return id;
      throw new Error(`No user found matching '${name}'.`);
    }),
    resolveIdToName: vi.fn((id: number) => {
      const names: Record<number, string> = { 1: 'Stacy', 2: 'Brad' };
      return names[id] ?? `User ${id}`;
    }),
  };
}

function createMockResolver() {
  const userResolver = createMockUserResolver();
  return {
    getUserResolver: vi.fn(async () => userResolver),
    getFieldResolver: vi.fn(),
    getPipelineResolver: vi.fn(),
    getActivityTypeResolver: vi.fn(),
    _userResolver: userResolver,
  };
}

function createMockEntityResolver() {
  return {
    resolve: vi.fn(),
  };
}

describe('createNoteTools', () => {
  let client: ReturnType<typeof createMockClient>;
  let resolver: ReturnType<typeof createMockResolver>;
  let entityResolver: ReturnType<typeof createMockEntityResolver>;
  let tools: ReturnType<typeof createNoteTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
    resolver = createMockResolver();
    entityResolver = createMockEntityResolver();
    tools = createNoteTools(client as any, resolver as any, entityResolver as any);
  });

  function findTool(name: string) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`Tool '${name}' not found`);
    return tool;
  }

  // --- create-note ---

  describe('create-note', () => {
    it('creates note with HTML content — sanitizeNoteContent is called', async () => {
      // POST response
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { success: true, data: { id: 1 } },
        headers: new Headers(),
      });
      // GET after write
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 1,
            content: 'Important follow up needed',
            deal_id: 10,
            deal: { title: 'Acme Deal' },
            person_id: null,
            person: null,
            org_id: null,
            organization: null,
            update_time: '2026-03-30 10:00:00',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('create-note');
      const result = await tool.handler({
        content: '<b>Important</b> follow up needed',
        deal_id: 10,
      }) as any;

      // Verify sanitizeNoteContent was called with the raw HTML input
      expect(sanitizeNoteContent).toHaveBeenCalledWith('<b>Important</b> follow up needed');

      // Verify POST was made with sanitized content
      expect(client.request).toHaveBeenCalledWith(
        'POST', 'v1', '/notes',
        expect.objectContaining({
          content: 'Important follow up needed',
          deal_id: 10,
        }),
      );

      expect(result.id).toBe(1);
    });

    it('rejects create-note without any association', async () => {
      const tool = findTool('create-note');

      await expect(
        tool.handler({ content: 'Some note text' })
      ).rejects.toThrow(
        'At least one of deal_id, person_id, or org_id must be provided.'
      );
    });

    it('creates note with deal_id only', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { success: true, data: { id: 2 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 2, content: 'Deal note', deal_id: 5,
            deal: { title: 'Big Deal' },
            person_id: null, person: null,
            org_id: null, organization: null,
            update_time: '2026-03-30',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('create-note');
      const result = await tool.handler({ content: 'Deal note', deal_id: 5 }) as any;

      expect(result.id).toBe(2);
      expect(client.request).toHaveBeenCalledWith(
        'POST', 'v1', '/notes',
        expect.objectContaining({ content: 'Deal note', deal_id: 5 }),
      );
    });

    it('creates note with person_id only', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { success: true, data: { id: 3 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 3, content: 'Person note', deal_id: null, deal: null,
            person_id: 20, person: { name: 'Jane Doe' },
            org_id: null, organization: null,
            update_time: '2026-03-30',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('create-note');
      const result = await tool.handler({ content: 'Person note', person_id: 20 }) as any;

      expect(result.id).toBe(3);
      expect(client.request).toHaveBeenCalledWith(
        'POST', 'v1', '/notes',
        expect.objectContaining({ content: 'Person note', person_id: 20 }),
      );
    });

    it('creates note with org_id only', async () => {
      client.request.mockResolvedValueOnce({
        status: 201,
        data: { success: true, data: { id: 4 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 4, content: 'Org note', deal_id: null, deal: null,
            person_id: null, person: null,
            org_id: 30, organization: { name: 'Acme Corp' },
            update_time: '2026-03-30',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('create-note');
      const result = await tool.handler({ content: 'Org note', org_id: 30 }) as any;

      expect(result.id).toBe(4);
      expect(client.request).toHaveBeenCalledWith(
        'POST', 'v1', '/notes',
        expect.objectContaining({ content: 'Org note', org_id: 30 }),
      );
    });
  });

  // --- list-notes ---

  describe('list-notes', () => {
    it('returns truncated content with truncated: true flag', async () => {
      const longContent = 'A'.repeat(300);
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: [
            {
              id: 1,
              content: longContent,
              deal_id: 10,
              deal: { title: 'Acme Deal' },
              person_id: null,
              person: null,
              org_id: null,
              organization: null,
              update_time: '2026-03-30 10:00:00',
            },
          ],
          additional_data: { pagination: { more_items_in_collection: false } },
        },
        headers: new Headers(),
      });

      const tool = findTool('list-notes');
      const result = await tool.handler({ deal_id: 10 }) as any;

      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toHaveLength(200);
      expect(result.items[0].content).toBe('A'.repeat(200));
      expect(result.items[0].truncated).toBe(true);
      expect(result.items[0].deal).toBe('Acme Deal');
    });

    it('returns full content with truncated: false when short', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: [
            {
              id: 2,
              content: 'Short note',
              deal_id: null, deal: null,
              person_id: 20, person: { name: 'Jane Doe' },
              org_id: null, organization: null,
              update_time: '2026-03-30',
            },
          ],
          additional_data: { pagination: { more_items_in_collection: false } },
        },
        headers: new Headers(),
      });

      const tool = findTool('list-notes');
      const result = await tool.handler({ person_id: 20 }) as any;

      expect(result.items[0].content).toBe('Short note');
      expect(result.items[0].truncated).toBe(false);
      expect(result.items[0].person).toBe('Jane Doe');
    });

    it('passes filter params to API', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: [],
          additional_data: { pagination: { more_items_in_collection: false } },
        },
        headers: new Headers(),
      });

      const tool = findTool('list-notes');
      await tool.handler({ deal_id: 10, person_id: 20, org_id: 30, limit: 50 });

      expect(client.request).toHaveBeenCalledWith(
        'GET', 'v1', '/notes',
        undefined,
        expect.objectContaining({
          deal_id: '10',
          person_id: '20',
          org_id: '30',
          limit: '50',
        }),
      );
    });
  });

  // --- get-note ---

  describe('get-note', () => {
    it('returns full untruncated content', async () => {
      const fullContent = 'B'.repeat(500);
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 10,
            content: fullContent,
            deal_id: 5,
            deal: { title: 'Big Deal' },
            person_id: 20,
            person: { name: 'John Smith' },
            org_id: 30,
            organization: { name: 'Acme Corp' },
            update_time: '2026-03-30 11:00:00',
            add_time: '2026-03-28 09:00:00',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('get-note');
      const result = await tool.handler({ id: 10 }) as any;

      expect(result.id).toBe(10);
      expect(result.content).toBe(fullContent);
      expect(result.content).toHaveLength(500);
      // get-note returns FULL content, no truncation
      expect(result.deal).toBe('Big Deal');
      expect(result.person).toBe('John Smith');
      expect(result.org).toBe('Acme Corp');
    });
  });

  // --- update-note ---

  describe('update-note', () => {
    it('can change associations (deal_id, person_id, org_id)', async () => {
      // PUT response
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { id: 10 } },
        headers: new Headers(),
      });
      // GET after write
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 10,
            content: 'Updated note',
            deal_id: 99,
            deal: { title: 'New Deal' },
            person_id: 88,
            person: { name: 'New Person' },
            org_id: 77,
            organization: { name: 'New Org' },
            update_time: '2026-03-30 12:00:00',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('update-note');
      const result = await tool.handler({
        id: 10,
        content: 'Updated note',
        deal_id: 99,
        person_id: 88,
        org_id: 77,
      }) as any;

      expect(result.id).toBe(10);
      expect(result.deal).toBe('New Deal');
      expect(result.person).toBe('New Person');
      expect(result.org).toBe('New Org');

      // Verify PUT payload includes all associations
      expect(client.request).toHaveBeenCalledWith(
        'PUT', 'v1', '/notes/10',
        expect.objectContaining({
          content: expect.any(String),
          deal_id: 99,
          person_id: 88,
          org_id: 77,
        }),
      );
    });

    it('updates content only', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { id: 10 } },
        headers: new Headers(),
      });
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 10, content: 'New content',
            deal_id: 5, deal: { title: 'Existing Deal' },
            person_id: null, person: null,
            org_id: null, organization: null,
            update_time: '2026-03-30',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('update-note');
      await tool.handler({ id: 10, content: '<p>New content</p>' });

      // Verify sanitizeNoteContent was called on update content too
      expect(sanitizeNoteContent).toHaveBeenCalledWith('<p>New content</p>');
    });

    it('rejects update with empty params beyond id', async () => {
      const tool = findTool('update-note');

      await expect(
        tool.handler({ id: 10 })
      ).rejects.toThrow(
        'No fields provided. Include at least one field to update.'
      );
    });
  });

  // --- delete-note ---

  describe('delete-note', () => {
    it('returns confirmation prompt on first call', async () => {
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            id: 10,
            content: 'Important meeting notes from quarterly review that are very long',
          },
        },
        headers: new Headers(),
      });

      const tool = findTool('delete-note');
      const result = await tool.handler({ id: 10 }) as any;

      expect(result.confirm_required).toBe(true);
      expect(result.message).toContain('permanently delete');
      expect(result.message).toContain('10');
      expect(result.message).toContain('confirm: true');
    });

    it('executes deletion when confirm is true', async () => {
      // GET for content preview before delete
      client.request.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: { id: 10, content: 'Some note content' },
        },
        headers: new Headers(),
      });
      // DELETE
      client.request.mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: new Headers(),
      });

      const tool = findTool('delete-note');
      const result = await tool.handler({ id: 10, confirm: true }) as any;

      expect(result.deleted).toBe(true);
      expect(result.id).toBe(10);
      expect(client.request).toHaveBeenCalledWith('DELETE', 'v1', '/notes/10');
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

      const tool = findTool('delete-note');
      const result = await tool.handler({ id: 10, confirm: true }) as any;

      expect(result.deleted).toBe(true);
      expect(result.id).toBe(10);
    });
  });
});
