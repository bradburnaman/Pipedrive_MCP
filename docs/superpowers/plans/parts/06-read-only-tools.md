# Part 6: Read-Only Tool Handlers (Pipelines, Users, Fields)
> Part 6 of 13 — Simplest tools: read-only, no field resolution on input. Establishes the tool handler pattern.
> **Depends on:** Parts 2 (types), 4 (reference-resolver)
> **Produces:** `src/tools/pipelines.ts`, `src/tools/users.ts`, `src/tools/fields.ts`, `tests/tools/pipelines.test.ts`, `tests/tools/users.test.ts`, `tests/tools/fields.test.ts`

---

## Overview

These four tools are read-only and don't need field resolution on input. They pull data directly from the ReferenceResolver's cached sub-resolvers. This makes them the right place to establish the tool handler pattern before tackling CRUD tools.

All tool creation functions take `(resolver: ReferenceResolver)` as their parameter and return `ToolDefinition[]`.

---

## Step 1: Write pipeline tool tests

- [ ] **Create `tests/tools/pipelines.test.ts`**

```typescript
// tests/tools/pipelines.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPipelineTools } from '../../src/tools/pipelines.js';

function mockResolver() {
  return {
    getPipelineResolver: vi.fn().mockResolvedValue({
      getPipelines: () => [
        {
          id: 1, name: 'Sales', active: true,
          stages: [
            { id: 10, name: 'Qualified', pipeline_id: 1, order_nr: 1, rotten_flag: false, rotten_days: null },
            { id: 11, name: 'Proposal Sent', pipeline_id: 1, order_nr: 2, rotten_flag: true, rotten_days: 14 },
          ],
        },
      ],
      resolvePipelineNameToId: (name: string) => {
        if (name.toLowerCase() === 'sales') return 1;
        throw new Error(`No pipeline found matching '${name}'`);
      },
      getStagesForPipeline: (id: number) => {
        if (id === 1) return [
          { id: 10, name: 'Qualified', pipeline_id: 1, order_nr: 1, rotten_flag: false, rotten_days: null },
          { id: 11, name: 'Proposal Sent', pipeline_id: 1, order_nr: 2, rotten_flag: true, rotten_days: 14 },
        ];
        return [];
      },
    }),
  } as any;
}

describe('pipeline tools', () => {
  it('list-pipelines returns all pipelines with stages', async () => {
    const tools = createPipelineTools(mockResolver());
    const listTool = tools.find(t => t.name === 'list-pipelines')!;
    const result = await listTool.handler({});
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Sales');
    expect(result[0].stages).toHaveLength(2);
  });

  it('list-stages returns stages for a pipeline', async () => {
    const tools = createPipelineTools(mockResolver());
    const stageTool = tools.find(t => t.name === 'list-stages')!;
    const result = await stageTool.handler({ pipeline: 'Sales' });
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Qualified');
  });

  it('list-stages throws on unknown pipeline', async () => {
    const tools = createPipelineTools(mockResolver());
    const stageTool = tools.find(t => t.name === 'list-stages')!;
    await expect(stageTool.handler({ pipeline: 'Unknown' })).rejects.toThrow(/No pipeline found/);
  });
});
```

---

## Step 2: Run pipeline tests (expect failure)

- [ ] **Verify tests fail before implementation**

```bash
npx vitest run tests/tools/pipelines.test.ts
```

Expected: FAIL (module not found).

---

## Step 3: Write pipeline tool handlers

- [ ] **Create `src/tools/pipelines.ts`**

```typescript
// src/tools/pipelines.ts
import type { ToolDefinition } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';

export function createPipelineTools(resolver: ReferenceResolver): ToolDefinition[] {
  return [
    {
      name: 'list-pipelines',
      category: 'read',
      description: 'List all pipelines with their stages. Read-only — pipeline configuration changes should be made in Pipedrive UI.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        const pipelineResolver = await resolver.getPipelineResolver();
        const pipelines = pipelineResolver.getPipelines();
        return pipelines.map(p => ({
          id: p.id,
          name: p.name,
          active: p.active,
          stages: p.stages.map(s => ({
            id: s.id,
            name: s.name,
            order: s.order_nr,
            rotten_flag: s.rotten_flag,
            rotten_days: s.rotten_days,
          })),
        }));
      },
    },
    {
      name: 'list-stages',
      category: 'read',
      description: "List stages for a given pipeline by name or ID, including stage order and rotten-day settings. Example: pipeline 'Sales'.",
      inputSchema: {
        type: 'object',
        properties: {
          pipeline: {
            type: 'string',
            description: "Pipeline name or ID, e.g. 'Sales'",
          },
        },
        required: ['pipeline'],
      },
      handler: async (params: Record<string, unknown>) => {
        const pipeline = params.pipeline as string;
        const pipelineResolver = await resolver.getPipelineResolver();

        // Resolve pipeline name to ID
        let pipelineId: number;
        const asNum = Number(pipeline);
        if (!isNaN(asNum) && String(asNum) === String(pipeline).trim()) {
          pipelineId = asNum;
        } else {
          pipelineId = pipelineResolver.resolvePipelineNameToId(pipeline);
        }

        const stages = pipelineResolver.getStagesForPipeline(pipelineId);
        return stages.map(s => ({
          id: s.id,
          name: s.name,
          order: s.order_nr,
          rotten_flag: s.rotten_flag,
          rotten_days: s.rotten_days,
        }));
      },
    },
  ];
}
```

---

## Step 4: Run pipeline tests

- [ ] **Verify pipeline tests pass**

```bash
npx vitest run tests/tools/pipelines.test.ts
```

Expected: All PASS.

---

## Step 5: Write users tool

- [ ] **Create `src/tools/users.ts`**

```typescript
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
```

---

## Step 6: Write fields tool

- [ ] **Create `src/tools/fields.ts`**

```typescript
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
```

---

## Step 7: Write users and fields tests

- [ ] **Create `tests/tools/users.test.ts`**

```typescript
// tests/tools/users.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createUserTools } from '../../src/tools/users.js';

describe('user tools', () => {
  it('list-users returns all users', async () => {
    const resolver = {
      getUserResolver: vi.fn().mockResolvedValue({
        getUsers: () => [
          { id: 1, name: 'Brad', email: 'brad@bhg.com', active: true },
          { id: 2, name: 'Stacy', email: 'stacy@bhg.com', active: true },
        ],
      }),
    } as any;
    const tools = createUserTools(resolver);
    const result = await tools[0].handler({});
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Brad');
  });

  it('list-users returns user shape with id, name, email, active', async () => {
    const resolver = {
      getUserResolver: vi.fn().mockResolvedValue({
        getUsers: () => [
          { id: 5, name: 'Alice', email: 'alice@bhg.com', active: false },
        ],
      }),
    } as any;
    const tools = createUserTools(resolver);
    const result = await tools[0].handler({});
    expect(result[0]).toEqual({
      id: 5,
      name: 'Alice',
      email: 'alice@bhg.com',
      active: false,
    });
  });

  it('list-users returns empty array when no users', async () => {
    const resolver = {
      getUserResolver: vi.fn().mockResolvedValue({
        getUsers: () => [],
      }),
    } as any;
    const tools = createUserTools(resolver);
    const result = await tools[0].handler({});
    expect(result).toEqual([]);
  });
});
```

- [ ] **Create `tests/tools/fields.test.ts`**

```typescript
// tests/tools/fields.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createFieldTools } from '../../src/tools/fields.js';

describe('field tools', () => {
  it('get-fields returns field definitions with options', async () => {
    const resolver = {
      getFieldResolver: vi.fn().mockResolvedValue({
        getFieldDefinitions: () => [
          { key: 'title', name: 'Title', field_type: 'varchar', options: undefined },
          { key: 'abc_area', name: 'Practice Area', field_type: 'enum', options: [
            { id: 1, label: 'Varicent' }, { id: 2, label: 'Xactly' },
          ]},
        ],
      }),
    } as any;
    const tools = createFieldTools(resolver);
    const result = await tools[0].handler({ resource_type: 'deal' });
    expect(result).toHaveLength(2);
    expect(result[1].options).toEqual(['Varicent', 'Xactly']);
  });

  it('get-fields returns null for options when field has no options', async () => {
    const resolver = {
      getFieldResolver: vi.fn().mockResolvedValue({
        getFieldDefinitions: () => [
          { key: 'title', name: 'Title', field_type: 'varchar', options: undefined },
        ],
      }),
    } as any;
    const tools = createFieldTools(resolver);
    const result = await tools[0].handler({ resource_type: 'person' });
    expect(result[0].options).toBeNull();
  });

  it('get-fields rejects invalid resource type', async () => {
    const resolver = {} as any;
    const tools = createFieldTools(resolver);
    await expect(tools[0].handler({ resource_type: 'bogus' })).rejects.toThrow(/Invalid resource_type/);
  });

  it('get-fields returns correct shape per field', async () => {
    const resolver = {
      getFieldResolver: vi.fn().mockResolvedValue({
        getFieldDefinitions: () => [
          { key: 'abc_custom', name: 'My Custom', field_type: 'text', options: undefined, max_length: 500 },
        ],
      }),
    } as any;
    const tools = createFieldTools(resolver);
    const result = await tools[0].handler({ resource_type: 'organization' });
    expect(result[0]).toEqual({
      key: 'abc_custom',
      name: 'My Custom',
      type: 'text',
      options: null,
    });
  });

  it('get-fields passes correct resource type to resolver', async () => {
    const getFieldResolver = vi.fn().mockResolvedValue({
      getFieldDefinitions: () => [],
    });
    const resolver = { getFieldResolver } as any;
    const tools = createFieldTools(resolver);
    await tools[0].handler({ resource_type: 'activity' });
    expect(getFieldResolver).toHaveBeenCalledWith('activity');
  });
});
```

---

## Step 8: Run all tool tests

- [ ] **Verify all read-only tool tests pass**

```bash
npx vitest run tests/tools/
```

Expected: All PASS.

---

## Step 9: Commit

- [ ] **Commit all read-only tool handlers and tests**

```bash
git add src/tools/pipelines.ts src/tools/users.ts src/tools/fields.ts \
       tests/tools/pipelines.test.ts tests/tools/users.test.ts tests/tools/fields.test.ts
git commit -m "feat: read-only tool handlers for pipelines, users, and fields"
```
