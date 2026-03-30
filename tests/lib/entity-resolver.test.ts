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
