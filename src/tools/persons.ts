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

    // Email — normalize to Pipedrive v2 array-of-objects format (plural key)
    if (params.email) {
      if (Array.isArray(params.email)) {
        resolved.emails = (params.email as string[]).map(e => ({
          value: e,
          primary: false,
          label: 'work',
        }));
      } else {
        resolved.emails = [{ value: params.email as string, primary: true, label: 'work' }];
      }
    }

    // Phone — normalize to Pipedrive v2 array-of-objects format (plural key)
    if (params.phone) {
      if (Array.isArray(params.phone)) {
        resolved.phones = (params.phone as string[]).map(p => ({
          value: p,
          primary: false,
          label: 'work',
        }));
      } else {
        resolved.phones = [{ value: params.phone as string, primary: true, label: 'work' }];
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

    // Custom fields — nest under custom_fields for v2 API
    if (params.fields && typeof params.fields === 'object') {
      const customFields: Record<string, unknown> = {};
      for (const [label, value] of Object.entries(params.fields as Record<string, unknown>)) {
        const key = fieldResolver.resolveInputField(label);
        customFields[key] = fieldResolver.resolveInputValue(key, value);
      }
      if (Object.keys(customFields).length > 0) {
        resolved.custom_fields = customFields;
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
    const SKIP = new Set(['user_id', 'org_id', 'creator_user_id', 'custom_fields']);

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

    // Unwrap custom_fields from v2 response format
    if (raw.custom_fields && typeof raw.custom_fields === 'object') {
      for (const [key, value] of Object.entries(raw.custom_fields as Record<string, unknown>)) {
        const outputKey = fieldResolver.getOutputKey(key);
        result[outputKey] = fieldResolver.resolveOutputValue(key, value);
      }
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

    // Extract primary email from Pipedrive's array-of-objects format (v2 uses 'emails', v1 uses 'email')
    const emailArr = (raw.emails ?? raw.email) as Array<{ value: string; primary: boolean }> | string | undefined;
    const primaryEmail = Array.isArray(emailArr)
      ? emailArr.find(e => e.primary)?.value ?? emailArr[0]?.value
      : emailArr;

    // Extract primary phone from Pipedrive's array-of-objects format (v2 uses 'phones', v1 uses 'phone')
    const phoneArr = (raw.phones ?? raw.phone) as Array<{ value: string; primary: boolean }> | string | undefined;
    const primaryPhone = Array.isArray(phoneArr)
      ? phoneArr.find(p => p.primary)?.value ?? phoneArr[0]?.value
      : phoneArr;

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

        // Search endpoint returns { result_score, item: { id, name, email, phone, organization: {name}, owner: {id}, ... } }
        // which differs from list endpoint shape — map directly to summary
        const userResolver = await resolver.getUserResolver();
        const summaries = items.map((wrapper: any) => {
          const p = wrapper.item ?? wrapper;

          // Search may return email/phone as arrays or strings
          let email: string | null = null;
          if (Array.isArray(p.email)) {
            email = (p.email.find((e: any) => e.primary)?.value ?? p.email[0]?.value) || null;
          } else if (typeof p.email === 'string') {
            email = p.email || null;
          }

          let phone: string | null = null;
          if (Array.isArray(p.phone)) {
            phone = (p.phone.find((ph: any) => ph.primary)?.value ?? p.phone[0]?.value) || null;
          } else if (typeof p.phone === 'string') {
            phone = p.phone || null;
          }

          return {
            id: p.id as number,
            name: (p.name as string) ?? '',
            email,
            phone,
            organization: p.organization?.name ?? (p.org_name as string) ?? null,
            owner: p.owner?.id ? userResolver.resolveIdToName(p.owner.id) : '',
            updated_at: (p.update_time as string) ?? '',
          };
        });

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
