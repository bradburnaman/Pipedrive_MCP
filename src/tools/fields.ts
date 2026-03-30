// src/tools/fields.ts
import type { ToolDefinition } from '../types.js';
import type { ReferenceResolver, ResourceType } from '../lib/reference-resolver/index.js';

const VALID_RESOURCE_TYPES: ResourceType[] = ['deal', 'person', 'organization', 'activity'];

export function createFieldTools(resolver: ReferenceResolver): ToolDefinition[] {
  return [
    {
      name: 'get-fields',
      category: 'read',
      description: "Get field definitions for a resource type (deal, person, organization, activity), including custom fields and option sets for enum fields. Useful for discovering what fields exist and what values are valid. The agent doesn't need to call this before creates/updates — field resolution happens automatically.",
      inputSchema: {
        type: 'object',
        properties: {
          resource_type: {
            type: 'string',
            enum: VALID_RESOURCE_TYPES,
            description: "Resource type: 'deal', 'person', 'organization', or 'activity'",
          },
        },
        required: ['resource_type'],
      },
      handler: async (params: Record<string, unknown>) => {
        const resourceType = params.resource_type as ResourceType;
        if (!VALID_RESOURCE_TYPES.includes(resourceType)) {
          throw new Error(`Invalid resource_type '${resourceType}'. Must be one of: ${VALID_RESOURCE_TYPES.join(', ')}`);
        }
        const fieldResolver = await resolver.getFieldResolver(resourceType);
        return fieldResolver.getFieldDefinitions().map(f => ({
          key: f.key,
          name: f.name,
          type: f.field_type,
          options: f.options?.map(o => o.label) ?? null,
        }));
      },
    },
  ];
}
