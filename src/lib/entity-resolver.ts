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
