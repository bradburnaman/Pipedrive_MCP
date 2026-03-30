# Part 11: Note Tools
> Part 11 of 13 — Complete note tool handlers with HTML sanitization, content truncation, association validation, and delete confirmation
> **Depends on:** Parts 2 (types), 3 (config), 5 (sanitizer), 6 (client), 7 (error-normalizer), 8 (cursor), 9 (entity-resolver), 11-ref (orchestrator)
> **Produces:** `src/tools/notes.ts`, `tests/tools/notes.test.ts`

---

## Step 1: Write note tool tests

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/tools/notes.test.ts
```

Expected: FAIL -- module `../../src/tools/notes.js` not found.

---

## Step 3: Write note tool handlers

```typescript
// src/tools/notes.ts
import type { ToolDefinition, NoteSummary } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import type { EntityResolver } from '../lib/entity-resolver.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { sanitizeNoteContent, validateStringLength } from '../lib/sanitizer.js';
import type { Logger } from 'pino';

export function createNoteTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver,
  logger?: Logger
): ToolDefinition[] {

  /**
   * Build note summary shape for list responses.
   * Content is truncated to 200 characters with a `truncated` boolean flag.
   * Deal, person, and org fields show names if available in the response.
   */
  function toNoteSummary(raw: Record<string, unknown>): NoteSummary {
    const content = (raw.content as string) ?? '';
    const truncated = content.length > 200;
    const displayContent = truncated ? content.substring(0, 200) : content;

    // Pipedrive note responses nest linked entities as objects with title/name
    // e.g. { deal: { title: "Acme Deal" }, person: { name: "John" }, organization: { name: "Corp" } }
    let dealName: string | null = null;
    if (raw.deal && typeof raw.deal === 'object' && (raw.deal as any).title) {
      dealName = (raw.deal as any).title;
    } else if (raw.deal_id) {
      dealName = `Deal ${raw.deal_id}`;
    }

    let personName: string | null = null;
    if (raw.person && typeof raw.person === 'object' && (raw.person as any).name) {
      personName = (raw.person as any).name;
    } else if (raw.person_id) {
      personName = `Person ${raw.person_id}`;
    }

    let orgName: string | null = null;
    if (raw.organization && typeof raw.organization === 'object' && (raw.organization as any).name) {
      orgName = (raw.organization as any).name;
    } else if (raw.org_id) {
      orgName = `Org ${raw.org_id}`;
    }

    return {
      id: raw.id as number,
      content: displayContent,
      truncated,
      deal: dealName,
      person: personName,
      org: orgName,
      updated_at: (raw.update_time as string) ?? '',
    };
  }

  /**
   * Resolve raw Pipedrive note response to human-friendly output for get/create/update.
   * Returns full content (not truncated). Resolves linked entity names.
   */
  function resolveNoteOutput(raw: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    result.id = raw.id;
    result.content = raw.content ?? '';

    // Linked entities
    let dealName: string | null = null;
    if (raw.deal && typeof raw.deal === 'object' && (raw.deal as any).title) {
      dealName = (raw.deal as any).title;
    }
    result.deal = dealName;
    result.deal_id = raw.deal_id ?? null;

    let personName: string | null = null;
    if (raw.person && typeof raw.person === 'object' && (raw.person as any).name) {
      personName = (raw.person as any).name;
    }
    result.person = personName;
    result.person_id = raw.person_id ?? null;

    let orgName: string | null = null;
    if (raw.organization && typeof raw.organization === 'object' && (raw.organization as any).name) {
      orgName = (raw.organization as any).name;
    }
    result.org = orgName;
    result.org_id = raw.org_id ?? null;

    // Timestamps
    if (raw.update_time) result.updated_at = raw.update_time;
    if (raw.add_time) result.created_at = raw.add_time;

    return result;
  }

  return [
    // --- list-notes ---
    {
      name: 'list-notes',
      category: 'read' as const,
      description: "List notes filtered by deal, person, or org. Returns summary shape with content truncated to 200 chars. Includes `truncated: true` flag when content is cut.",
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'number', description: 'Filter by linked deal ID' },
          person_id: { type: 'number', description: 'Filter by linked person ID' },
          org_id: { type: 'number', description: 'Filter by linked organization ID' },
          limit: { type: 'number', description: 'Page size (default 100)' },
          cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const query: Record<string, string> = {};

        if (params.deal_id) query.deal_id = String(params.deal_id);
        if (params.person_id) query.person_id = String(params.person_id);
        if (params.org_id) query.org_id = String(params.org_id);
        if (params.limit) query.limit = String(params.limit);

        // Pagination — notes use v1 offset-based pagination
        if (params.cursor) {
          const decoded = decodeCursor(params.cursor as string);
          if (decoded.v === 'v1' && decoded.offset !== undefined) query.start = String(decoded.offset);
          if (decoded.v === 'v2' && decoded.cursor) query.cursor = decoded.cursor;
        }

        const response = await normalizeApiCall(
          async () => client.request('GET', 'v1', '/notes', undefined, query),
          undefined, logger
        );

        const respData = (response as any).data;
        const items = respData.data ?? [];
        const summaries = items.map((n: any) => toNoteSummary(n));

        // v1 pagination: check additional_data.pagination
        const pagination = respData.additional_data?.pagination;
        const hasMore = pagination?.more_items_in_collection ?? false;
        const nextStart = pagination?.next_start;

        return {
          items: summaries,
          has_more: hasMore,
          next_cursor: nextStart != null
            ? encodeCursor({ v: 'v1', offset: nextStart })
            : undefined,
        };
      },
    },

    // --- get-note ---
    {
      name: 'get-note',
      category: 'read' as const,
      description: "Get a single note by ID with full content.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Note ID' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const response = await normalizeApiCall(
          async () => client.request('GET', 'v1', `/notes/${id}`),
          { entity: 'Note', id }, logger
        );
        const raw = (response as any).data.data;
        return resolveNoteOutput(raw);
      },
    },

    // --- create-note ---
    {
      name: 'create-note',
      category: 'create' as const,
      description: "Create a note linked to a deal, person, and/or org. At least one of deal_id, person_id, or org_id must be provided. Content is plain text only (HTML is stripped).",
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Note body (plain text only — HTML is stripped)' },
          deal_id: { type: 'number', description: 'Link to deal' },
          person_id: { type: 'number', description: 'Link to person' },
          org_id: { type: 'number', description: 'Link to organization' },
        },
        required: ['content'],
      },
      handler: async (params: Record<string, unknown>) => {
        // Validate at least one association
        const hasDeal = params.deal_id !== undefined;
        const hasPerson = params.person_id !== undefined;
        const hasOrg = params.org_id !== undefined;

        if (!hasDeal && !hasPerson && !hasOrg) {
          throw new Error(
            'At least one of deal_id, person_id, or org_id must be provided.'
          );
        }

        // Sanitize content (strip HTML to plain text)
        const sanitizedContent = sanitizeNoteContent(params.content as string);
        validateStringLength(sanitizedContent, 'content', 50000);

        const body: Record<string, unknown> = {
          content: sanitizedContent,
        };
        if (hasDeal) body.deal_id = params.deal_id;
        if (hasPerson) body.person_id = params.person_id;
        if (hasOrg) body.org_id = params.org_id;

        const response = await normalizeApiCall(
          async () => client.request('POST', 'v1', '/notes', body),
          undefined, logger
        );

        const created = (response as any).data.data;

        // GET after write for confirmed state
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v1', `/notes/${created.id}`),
          { entity: 'Note', id: created.id }, logger
        );
        const full = (getResponse as any).data.data;
        return resolveNoteOutput(full);
      },
    },

    // --- update-note ---
    {
      name: 'update-note',
      category: 'update' as const,
      description: "Update a note by ID.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Note ID' },
          content: { type: 'string', description: 'Note body (HTML is stripped)' },
          deal_id: { type: 'number', description: 'Link to deal (can change association)' },
          person_id: { type: 'number', description: 'Link to person (can change association)' },
          org_id: { type: 'number', description: 'Link to organization (can change association)' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const { id: _, ...updateParams } = params;

        // Validate at least one field beyond id
        const hasFields = Object.keys(updateParams).some(k => updateParams[k] !== undefined);
        if (!hasFields) {
          throw new Error('No fields provided. Include at least one field to update.');
        }

        const body: Record<string, unknown> = {};

        // Sanitize content if provided
        if (updateParams.content !== undefined) {
          const sanitizedContent = sanitizeNoteContent(updateParams.content as string);
          validateStringLength(sanitizedContent, 'content', 50000);
          body.content = sanitizedContent;
        }

        // Association fields — can be changed on update (verified against Pipedrive API)
        if (updateParams.deal_id !== undefined) body.deal_id = updateParams.deal_id;
        if (updateParams.person_id !== undefined) body.person_id = updateParams.person_id;
        if (updateParams.org_id !== undefined) body.org_id = updateParams.org_id;

        await normalizeApiCall(
          async () => client.request('PUT', 'v1', `/notes/${id}`, body),
          { entity: 'Note', id }, logger
        );

        // GET after write for confirmed state
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v1', `/notes/${id}`),
          { entity: 'Note', id }, logger
        );
        return resolveNoteOutput((getResponse as any).data.data);
      },
    },

    // --- delete-note ---
    {
      name: 'delete-note',
      category: 'delete' as const,
      description: "Delete a note by ID. Requires two-step confirmation.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Note ID' },
          confirm: { type: 'boolean', description: 'Set to true to confirm deletion' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const confirm = params.confirm === true;

        // Step 1: Return confirmation prompt (unless confirm=true)
        if (!confirm) {
          // Best-effort GET for content preview
          let preview = `Note ${id}`;
          try {
            const getResponse = await normalizeApiCall(
              async () => client.request('GET', 'v1', `/notes/${id}`),
              { entity: 'Note', id }, logger
            );
            const content = (getResponse as any).data.data?.content;
            if (content) {
              // Show first 100 chars of content in confirmation message
              preview = content.length > 100
                ? content.substring(0, 100) + '...'
                : content;
            }
          } catch {
            // Fall back to ID-only
          }
          return {
            confirm_required: true,
            message: `This will permanently delete note (ID ${id}): "${preview}". Call delete-note again with confirm: true to proceed.`,
          };
        }

        // Step 2: Execute deletion
        await normalizeApiCall(
          async () => client.request('DELETE', 'v1', `/notes/${id}`),
          { entity: 'Note', id }, logger
        );

        return { id, deleted: true as const };
      },
    },
  ];
}
```

---

## Step 4: Run tests

```bash
npx vitest run tests/tools/notes.test.ts
```

Expected: All tests PASS.

---

## Step 5: Commit

```bash
git add src/tools/notes.ts tests/tools/notes.test.ts
git commit -m "feat: note tool handlers with HTML sanitization and content truncation"
```
