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
