// src/tools/users.ts
import type { ToolDefinition } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';

export function createUserTools(resolver: ReferenceResolver): ToolDefinition[] {
  return [
    {
      name: 'list-users',
      category: 'read',
      description: "List all Pipedrive users. Enables resolving user names (e.g., 'Stacy') to IDs for owner assignment.",
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        const userResolver = await resolver.getUserResolver();
        return userResolver.getUsers().map(u => ({
          id: u.id,
          name: u.name,
          email: u.email,
          active: u.active,
        }));
      },
    },
  ];
}
