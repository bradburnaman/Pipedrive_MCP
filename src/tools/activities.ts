// src/tools/activities.ts
import type { ToolDefinition, ActivitySummary } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import type { EntityResolver } from '../lib/entity-resolver.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { trimString } from '../lib/sanitizer.js';
import type { Logger } from 'pino';

export function createActivityTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver,
  logger?: Logger
): ToolDefinition[] {

  /**
   * Resolve activity input params from human-friendly to Pipedrive API format.
   * Validates activity type against ActivityTypeResolver.
   * Resolves owner name to user_id.
   * Passes through deal_id, person_id, org_id as-is (IDs only, no name resolution).
   */
  async function resolveActivityInput(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const activityTypeResolver = await resolver.getActivityTypeResolver();
    const userResolver = await resolver.getUserResolver();
    const resolved: Record<string, unknown> = {};

    // Type validation and normalization
    if (params.type !== undefined) {
      const typeStr = params.type as string;
      if (!activityTypeResolver.isValidType(typeStr)) {
        const validTypes = activityTypeResolver.getTypes().map(t => t.key_string).join(', ');
        throw new Error(
          `Invalid activity type '${typeStr}'. Valid types: ${validTypes}`
        );
      }
      resolved.type = activityTypeResolver.normalizeType(typeStr);
    }

    // Subject
    if (params.subject !== undefined) {
      resolved.subject = trimString(params.subject as string, 'subject');
    }

    // Date/time fields
    if (params.due_date !== undefined) resolved.due_date = params.due_date;
    if (params.due_time !== undefined) resolved.due_time = params.due_time;
    if (params.duration !== undefined) resolved.duration = params.duration;

    // Linked entity IDs (no name resolution for activities)
    if (params.deal_id !== undefined) resolved.deal_id = params.deal_id;
    if (params.person_id !== undefined) resolved.person_id = params.person_id;
    if (params.org_id !== undefined) resolved.org_id = params.org_id;

    // Owner resolution
    if (params.owner !== undefined) {
      resolved.user_id = userResolver.resolveNameToId(params.owner as string);
    }

    // Note/description
    if (params.note !== undefined) resolved.note = params.note;

    // Done flag
    if (params.done !== undefined) resolved.done = params.done;

    return resolved;
  }

  /**
   * Resolve raw Pipedrive activity response to human-friendly output.
   * Resolves user_id to owner name. Passes through all other fields.
   * No custom field resolution needed for activities.
   */
  async function resolveActivityOutput(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userResolver = await resolver.getUserResolver();
    const SKIP = new Set(['user_id', 'creator_user_id']);
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(raw)) {
      if (SKIP.has(key)) continue;
      result[key] = value;
    }

    // Resolve user_id to owner name
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

  /**
   * Build activity summary shape for list responses.
   * deal and person fields show names from Pipedrive's deal_title/person_name
   * if available in the raw response, otherwise show ID or null.
   */
  async function toActivitySummary(raw: Record<string, unknown>): Promise<ActivitySummary> {
    const userResolver = await resolver.getUserResolver();

    // Pipedrive often includes deal_title and person_name in activity list responses
    let dealDisplay: string | null = null;
    if (raw.deal_title) {
      dealDisplay = raw.deal_title as string;
    } else if (raw.deal_id) {
      dealDisplay = `Deal ${raw.deal_id}`;
    }

    let personDisplay: string | null = null;
    if (raw.person_name) {
      personDisplay = raw.person_name as string;
    } else if (raw.person_id) {
      personDisplay = `Person ${raw.person_id}`;
    }

    return {
      id: raw.id as number,
      type: (raw.type as string) ?? '',
      subject: (raw.subject as string) ?? '',
      due_date: (raw.due_date as string) ?? null,
      done: raw.done === true || raw.done === 1,
      deal: dealDisplay,
      person: personDisplay,
      owner: raw.user_id ? userResolver.resolveIdToName(raw.user_id as number) : '',
    };
  }

  return [
    // --- list-activities ---
    {
      name: 'list-activities',
      category: 'read' as const,
      description: "List activities filtered by type, deal, person, org, owner, date range, done status. Returns summary shape.",
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: "Activity type filter, e.g. 'call', 'meeting', 'task'" },
          deal_id: { type: 'number', description: 'Filter by linked deal ID' },
          person_id: { type: 'number', description: 'Filter by linked person ID' },
          org_id: { type: 'number', description: 'Filter by linked organization ID' },
          owner: { type: 'string', description: "User name, e.g. 'Stacy'" },
          done: { type: 'boolean', description: 'Filter by completion status' },
          start_date: { type: 'string', description: 'Start of date range (YYYY-MM-DD)' },
          end_date: { type: 'string', description: 'End of date range (YYYY-MM-DD)' },
          updated_since: { type: 'string', description: 'ISO date (YYYY-MM-DD) — activities updated on or after' },
          limit: { type: 'number', description: 'Page size (default 100)' },
          cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const userResolver = await resolver.getUserResolver();
        const query: Record<string, string> = {};

        if (params.type) query.type = params.type as string;
        if (params.deal_id) query.deal_id = String(params.deal_id);
        if (params.person_id) query.person_id = String(params.person_id);
        if (params.org_id) query.org_id = String(params.org_id);
        if (params.owner) query.user_id = String(userResolver.resolveNameToId(params.owner as string));
        if (params.done !== undefined) query.done = params.done ? '1' : '0';
        if (params.start_date) query.start_date = params.start_date as string;
        if (params.end_date) query.end_date = params.end_date as string;
        if (params.updated_since) query.since = params.updated_since as string;
        if (params.limit) query.limit = String(params.limit);

        // Pagination
        if (params.cursor) {
          const decoded = decodeCursor(params.cursor as string);
          if (decoded.v === 'v1' && decoded.offset !== undefined) query.start = String(decoded.offset);
          if (decoded.v === 'v2' && decoded.cursor) query.cursor = decoded.cursor;
        }

        const response = await normalizeApiCall(
          async () => client.request('GET', 'v1', '/activities', undefined, query),
          undefined, logger
        );

        const respData = (response as any).data;
        const items = respData.data ?? [];
        const summaries = await Promise.all(items.map((a: any) => toActivitySummary(a)));

        const nextCursor = respData.additional_data?.next_cursor
          ?? (respData.additional_data?.pagination?.next_start != null
            ? respData.additional_data.pagination.next_start
            : null);
        const hasMore = respData.additional_data?.pagination?.more_items_in_collection
          ?? !!respData.additional_data?.next_cursor;

        return {
          items: summaries,
          has_more: hasMore,
          next_cursor: nextCursor != null
            ? encodeCursor(
                typeof nextCursor === 'number'
                  ? { v: 'v1', offset: nextCursor }
                  : { v: 'v2', cursor: String(nextCursor) }
              )
            : undefined,
        };
      },
    },

    // --- get-activity ---
    {
      name: 'get-activity',
      category: 'read' as const,
      description: "Get a single activity by ID. Returns full record.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Activity ID' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const response = await normalizeApiCall(
          async () => client.request('GET', 'v1', `/activities/${id}`),
          { entity: 'Activity', id }, logger
        );
        const raw = (response as any).data.data;
        return resolveActivityOutput(raw);
      },
    },

    // --- create-activity ---
    {
      name: 'create-activity',
      category: 'create' as const,
      description: "Create an activity (call, meeting, task, email, etc.). Common types: call, meeting, task, email, deadline. Use get-fields with resource_type 'activity' to see all configured types.",
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: "Activity type. Common types: call, meeting, task, email, deadline." },
          subject: { type: 'string', description: 'Activity subject line' },
          due_date: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
          due_time: { type: 'string', description: 'HH:MM format' },
          duration: { type: 'string', description: 'HH:MM format' },
          deal_id: { type: 'number', description: 'Link to deal' },
          person_id: { type: 'number', description: 'Link to person' },
          org_id: { type: 'number', description: 'Link to organization' },
          owner: { type: 'string', description: "User name, e.g. 'Stacy'" },
          note: { type: 'string', description: 'Activity description/body' },
          done: { type: 'boolean', description: 'Mark as completed' },
        },
        required: ['type', 'subject'],
      },
      handler: async (params: Record<string, unknown>) => {
        const resolved = await resolveActivityInput(params);

        const response = await normalizeApiCall(
          async () => client.request('POST', 'v1', '/activities', resolved),
          undefined, logger
        );

        const created = (response as any).data.data;

        // GET after write for confirmed state
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v1', `/activities/${created.id}`),
          { entity: 'Activity', id: created.id }, logger
        );
        const full = (getResponse as any).data.data;
        return resolveActivityOutput(full);
      },
    },

    // --- update-activity ---
    {
      name: 'update-activity',
      category: 'update' as const,
      description: "Update an activity by ID.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Activity ID' },
          type: { type: 'string', description: 'Activity type' },
          subject: { type: 'string', description: 'Activity subject line' },
          due_date: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
          due_time: { type: 'string', description: 'HH:MM format' },
          duration: { type: 'string', description: 'HH:MM format' },
          deal_id: { type: 'number', description: 'Link to deal' },
          person_id: { type: 'number', description: 'Link to person' },
          org_id: { type: 'number', description: 'Link to organization' },
          owner: { type: 'string', description: "User name, e.g. 'Stacy'" },
          note: { type: 'string', description: 'Activity description/body' },
          done: { type: 'boolean', description: 'Mark as completed' },
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

        const resolved = await resolveActivityInput(updateParams);

        await normalizeApiCall(
          async () => client.request('PUT', 'v1', `/activities/${id}`, resolved),
          { entity: 'Activity', id }, logger
        );

        // GET after write for confirmed state
        const getResponse = await normalizeApiCall(
          async () => client.request('GET', 'v1', `/activities/${id}`),
          { entity: 'Activity', id }, logger
        );
        return resolveActivityOutput((getResponse as any).data.data);
      },
    },

    // --- delete-activity ---
    {
      name: 'delete-activity',
      category: 'delete' as const,
      description: "Delete an activity by ID. Requires two-step confirmation.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Activity ID' },
          confirm: { type: 'boolean', description: 'Set to true to confirm deletion' },
        },
        required: ['id'],
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.id as number;
        const confirm = params.confirm === true;

        // Step 1: Return confirmation prompt (unless confirm=true)
        if (!confirm) {
          // Best-effort GET for subject
          let subject = `Activity ${id}`;
          try {
            const getResponse = await normalizeApiCall(
              async () => client.request('GET', 'v1', `/activities/${id}`),
              { entity: 'Activity', id }, logger
            );
            subject = (getResponse as any).data.data?.subject ?? subject;
          } catch {
            // Fall back to ID-only
          }
          return {
            confirm_required: true,
            message: `This will permanently delete activity '${subject}' (ID ${id}). Call delete-activity again with confirm: true to proceed.`,
          };
        }

        // Step 2: Execute deletion
        // Best-effort GET for subject before delete
        let subject: string | undefined;
        try {
          const getResponse = await normalizeApiCall(
            async () => client.request('GET', 'v1', `/activities/${id}`),
            { entity: 'Activity', id }, logger
          );
          subject = (getResponse as any).data.data?.subject;
        } catch {
          // Proceed without subject
        }

        await normalizeApiCall(
          async () => client.request('DELETE', 'v1', `/activities/${id}`),
          { entity: 'Activity', id }, logger
        );

        return { id, subject, deleted: true as const };
      },
    },
  ];
}
