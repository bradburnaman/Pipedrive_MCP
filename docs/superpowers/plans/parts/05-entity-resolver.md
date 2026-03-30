# Part 5: Entity Resolver
> Part 5 of 13 — Name-to-ID search with case-insensitive matching and disambiguation
> **Depends on:** Parts 2, 3 (types, pipedrive client)
> **Produces:** `src/lib/entity-resolver.ts`, `tests/lib/entity-resolver.test.ts`

---

## Task 12: Entity Resolver

**Files:**
- Create: `src/lib/entity-resolver.ts`
- Create: `tests/lib/entity-resolver.test.ts`

**Applied fixes:**
- Fix 4: Constructor takes optional `Logger`. Logs warning via `logger.warn` when search returns a full page with no exact match (result may exist beyond the first page).

- [ ] **Step 1: Write entity resolver tests**

```typescript
// tests/lib/entity-resolver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EntityResolver } from '../../src/lib/entity-resolver.js';

function mockClient(searchResults: Array<{ id: number; name: string; [key: string]: unknown }>) {
  return {
    request: vi.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: { items: searchResults.map(r => ({ item: r, result_score: 1 })) },
      },
    }),
  } as any;
}

describe('EntityResolver', () => {
  it('resolves a number ID directly', async () => {
    const resolver = new EntityResolver(mockClient([]));
    const result = await resolver.resolve('person', 123);
    expect(result).toBe(123);
  });

  it('resolves a numeric string directly', async () => {
    const resolver = new EntityResolver(mockClient([]));
    const result = await resolver.resolve('person', '456');
    expect(result).toBe(456);
  });

  it('resolves exact match (case-insensitive)', async () => {
    const client = mockClient([
      { id: 1, name: 'John Smith', organization: { name: 'Acme' } },
    ]);
    const resolver = new EntityResolver(client);
    const result = await resolver.resolve('person', 'john smith');
    expect(result).toBe(1);
  });

  it('throws on multiple matches', async () => {
    const client = mockClient([
      { id: 1, name: 'John Smith', organization: { name: 'Acme Corp' } },
      { id: 2, name: 'John Smith', organization: { name: 'Globex' } },
    ]);
    const resolver = new EntityResolver(client);
    await expect(resolver.resolve('person', 'John Smith')).rejects.toThrow(
      /Multiple persons match 'John Smith'/
    );
  });

  it('throws on no matches', async () => {
    const client = mockClient([]);
    const resolver = new EntityResolver(client);
    await expect(resolver.resolve('person', 'Nobody')).rejects.toThrow(
      "No person found matching 'Nobody'. Create one first or use a person_id."
    );
  });

  it('throws on search API failure', async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error('network error')),
    } as any;
    const resolver = new EntityResolver(client);
    await expect(resolver.resolve('person', 'Test')).rejects.toThrow(
      'Unable to resolve person name. Use a person_id instead.'
    );
  });

  it('rejects partial name matches', async () => {
    const client = mockClient([
      { id: 1, name: 'Stacy Anderson' },
    ]);
    const resolver = new EntityResolver(client);
    await expect(resolver.resolve('person', 'Stac')).rejects.toThrow(
      "No person found matching 'Stac'"
    );
  });

  it('logs warning when search returns full page with no match', async () => {
    // 50 results but none match exactly
    const results = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `Person ${i + 1}`,
    }));
    const client = mockClient(results);
    const mockLogger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any;
    const resolver = new EntityResolver(client, mockLogger);
    // Should still throw no match, but logs a warning
    await expect(resolver.resolve('person', 'Someone Else')).rejects.toThrow(
      "No person found matching 'Someone Else'"
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'person',
        searchTerm: 'Someone Else',
        resultCount: 50,
      }),
      'Search returned full page with no exact match — result may exist beyond first page'
    );
  });

  it('does not log warning when search returns partial page with no match', async () => {
    const results = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      name: `Person ${i + 1}`,
    }));
    const client = mockClient(results);
    const mockLogger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any;
    const resolver = new EntityResolver(client, mockLogger);
    await expect(resolver.resolve('person', 'Someone Else')).rejects.toThrow(
      "No person found matching 'Someone Else'"
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/entity-resolver.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write entity resolver**

```typescript
// src/lib/entity-resolver.ts
import type { PipedriveClient } from './pipedrive-client.js';
import type { Logger } from 'pino';

type EntityType = 'person' | 'organization';

const ENTITY_LABELS: Record<EntityType, string> = {
  person: 'person',
  organization: 'organization',
};

const SEARCH_PAGE_SIZE = 50;

export class EntityResolver {
  private client: PipedriveClient;
  private logger?: Logger;

  constructor(client: PipedriveClient, logger?: Logger) {
    this.client = client;
    this.logger = logger;
  }

  async resolve(entityType: EntityType, value: string | number): Promise<number> {
    // If it's already a number, return directly
    if (typeof value === 'number') return value;

    // If it's a numeric string, parse and return
    const asNumber = Number(value);
    if (!isNaN(asNumber) && String(asNumber) === value.trim()) {
      return asNumber;
    }

    // It's a name — search for it
    const label = ENTITY_LABELS[entityType];
    let searchResults: Array<{ id: number; name: string; organization?: { name: string } }>;

    try {
      const response = await this.client.request(
        'GET', 'v2', `/${entityType}s/search`,
        undefined,
        { term: value, limit: String(SEARCH_PAGE_SIZE) }
      ) as any;

      const data = response.data;
      if (!data.success) {
        throw new Error('Search failed');
      }

      const items = data.data?.items ?? [];
      searchResults = items.map((item: any) => ({
        id: item.item?.id ?? item.id,
        name: item.item?.name ?? item.name ?? '',
        organization: item.item?.organization ?? item.organization,
      }));
    } catch {
      throw new Error(`Unable to resolve ${label} name. Use a ${label}_id instead.`);
    }

    // Exact case-insensitive match
    const exactMatches = searchResults.filter(
      r => r.name.toLowerCase() === value.toLowerCase()
    );

    if (exactMatches.length === 1) {
      return exactMatches[0].id;
    }

    if (exactMatches.length > 1) {
      const details = exactMatches
        .map(m => {
          const org = m.organization?.name ? ` (${m.organization.name}, ID ${m.id})` : ` (ID ${m.id})`;
          return `${m.name}${org}`;
        })
        .join(', ');
      throw new Error(
        `Multiple ${label}s match '${value}': ${details}. Use a ${label}_id to be specific.`
      );
    }

    // No exact match — warn if we got a full page (match might be beyond results)
    if (searchResults.length >= SEARCH_PAGE_SIZE) {
      this.logger?.warn(
        { entityType, searchTerm: value, resultCount: searchResults.length },
        'Search returned full page with no exact match — result may exist beyond first page'
      );
    }

    throw new Error(
      `No ${label} found matching '${value}'. Create one first or use a ${label}_id.`
    );
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/entity-resolver.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/entity-resolver.ts tests/lib/entity-resolver.test.ts
git commit -m "feat: entity resolver with name->ID search, disambiguation, and logger"
```
