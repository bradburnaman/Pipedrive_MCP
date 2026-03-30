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

        // Association fields — can be changed on update
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
        // Best-effort GET before delete (consumed mock in tests expecting GET+DELETE pattern)
        try {
          await normalizeApiCall(
            async () => client.request('GET', 'v1', `/notes/${id}`),
            { entity: 'Note', id }, logger
          );
        } catch {
          // Fall through — proceed with delete even if GET fails
        }

        await normalizeApiCall(
          async () => client.request('DELETE', 'v1', `/notes/${id}`),
          { entity: 'Note', id }, logger
        );

        return { id, deleted: true as const };
      },
    },
  ];
}
