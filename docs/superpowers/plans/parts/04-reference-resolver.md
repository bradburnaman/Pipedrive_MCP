# Part 4: Reference Resolver
> Part 4 of 13 — Cache utility, field resolver, user/pipeline/activity-type resolvers, and orchestrator index
> **Depends on:** Parts 2, 3 (types, error normalizer, pipedrive client)
> **Produces:** `src/lib/reference-resolver/cache.ts`, `src/lib/reference-resolver/field-resolver.ts`, `src/lib/reference-resolver/user-resolver.ts`, `src/lib/reference-resolver/pipeline-resolver.ts`, `src/lib/reference-resolver/activity-types.ts`, `src/lib/reference-resolver/index.ts`, `tests/lib/reference-resolver/cache.test.ts`, `tests/lib/reference-resolver/field-resolver.test.ts`, `tests/lib/reference-resolver/user-resolver.test.ts`, `tests/lib/reference-resolver/pipeline-resolver.test.ts`, `tests/lib/reference-resolver/activity-types.test.ts`

---

## Task 8: Reference Resolver — Cache Utility

**Files:**
- Create: `src/lib/reference-resolver/cache.ts`
- Create: `tests/lib/reference-resolver/cache.test.ts`

- [ ] **Step 1: Write cache tests**

```typescript
// tests/lib/reference-resolver/cache.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaleWhileRevalidateCache } from '../../../src/lib/reference-resolver/cache.js';

describe('StaleWhileRevalidateCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches data on first access', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a', 'b', 'c']);
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);
    const result = await cache.get();
    expect(result).toEqual(['a', 'b', 'c']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns cached data within TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a', 'b', 'c']);
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);
    await cache.get();
    vi.advanceTimersByTime(3000); // within TTL
    const result = await cache.get();
    expect(result).toEqual(['a', 'b', 'c']);
    expect(fetcher).toHaveBeenCalledTimes(1); // no refetch
  });

  it('serves stale data and triggers background refresh after TTL', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? ['old'] : ['new'];
    });
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);

    await cache.get(); // initial fetch
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // past TTL

    const staleResult = await cache.get(); // should return stale immediately
    expect(staleResult).toEqual(['old']); // stale data served

    // Let the background refresh complete
    await vi.runAllTimersAsync();

    const freshResult = await cache.get(); // should have new data now
    expect(freshResult).toEqual(['new']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refresh calls', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      return [`data-${callCount}`];
    });
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);

    await cache.get(); // initial fetch
    vi.advanceTimersByTime(6000); // expire

    // Two concurrent calls while cache is stale
    const [r1, r2] = await Promise.all([cache.get(), cache.get()]);

    // Both get stale data
    expect(r1).toEqual(['data-1']);
    expect(r2).toEqual(['data-1']);

    // Only one refresh triggered
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(2); // initial + 1 refresh (not 2)
  });

  it('clears refreshInFlight on rejection', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('API error');
      return [`data-${callCount}`];
    });
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);

    await cache.get(); // initial fetch succeeds
    vi.advanceTimersByTime(6000); // expire

    await cache.get(); // triggers refresh that will fail
    await vi.runAllTimersAsync(); // let the failed refresh complete

    vi.advanceTimersByTime(6000); // expire again

    // Should be able to trigger another refresh (not stuck on rejected promise)
    fetcher.mockResolvedValueOnce(['recovered']);
    await cache.get();
    await vi.runAllTimersAsync();

    const result = await cache.get();
    expect(result).toEqual(['recovered']);
  });

  it('throws on first access if fetcher fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('API down'));
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);
    await expect(cache.get()).rejects.toThrow('API down');
  });

  it('allows manual cache priming', async () => {
    const fetcher = vi.fn().mockResolvedValue(['fetched']);
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);
    cache.prime(['primed']);
    const result = await cache.get();
    expect(result).toEqual(['primed']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('logs warning on background refresh failure', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('API error');
      return [`data-${callCount}`];
    });
    const mockLogger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any;
    const cache = new StaleWhileRevalidateCache(fetcher, 5000, mockLogger);

    await cache.get(); // initial fetch succeeds
    vi.advanceTimersByTime(6000); // expire

    await cache.get(); // triggers refresh that will fail
    await vi.runAllTimersAsync(); // let the failed refresh complete

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Cache background refresh failed, serving stale data'
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/reference-resolver/cache.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write cache implementation**

```typescript
// src/lib/reference-resolver/cache.ts
import type { Logger } from 'pino';

export class StaleWhileRevalidateCache<T> {
  private data: T | null = null;
  private fetchedAt: number = 0;
  private ttlMs: number;
  private fetcher: () => Promise<T>;
  private refreshInFlight: Promise<T> | null = null;
  private logger?: Logger;

  constructor(fetcher: () => Promise<T>, ttlMs: number, logger?: Logger) {
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
    this.logger = logger;
  }

  async get(): Promise<T> {
    // No cached data — must fetch synchronously
    if (this.data === null) {
      this.data = await this.fetcher();
      this.fetchedAt = Date.now();
      return this.data;
    }

    // Cache is fresh
    if (Date.now() - this.fetchedAt < this.ttlMs) {
      return this.data;
    }

    // Cache is stale — serve stale, trigger background refresh
    if (this.refreshInFlight === null) {
      this.refreshInFlight = this.fetcher()
        .then(freshData => {
          this.data = freshData;
          this.fetchedAt = Date.now();
          this.refreshInFlight = null;
          return freshData;
        })
        .catch(err => {
          this.refreshInFlight = null; // Clear so next call can retry
          this.logger?.warn({ err }, 'Cache background refresh failed, serving stale data');
          return this.data as T;
        });
    }

    return this.data;
  }

  prime(data: T): void {
    this.data = data;
    this.fetchedAt = Date.now();
  }

  invalidate(): void {
    this.fetchedAt = 0;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/reference-resolver/cache.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reference-resolver/cache.ts tests/lib/reference-resolver/cache.test.ts
git commit -m "feat: stale-while-revalidate cache with refresh deduplication and logger"
```

---

## Task 9: Reference Resolver — Field Resolver

**Files:**
- Create: `src/lib/reference-resolver/field-resolver.ts`
- Create: `tests/lib/reference-resolver/field-resolver.test.ts`

- [ ] **Step 1: Write field resolver tests**

```typescript
// tests/lib/reference-resolver/field-resolver.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldResolver } from '../../../src/lib/reference-resolver/field-resolver.js';
import type { FieldDefinition } from '../../../src/types.js';

const MOCK_FIELDS: FieldDefinition[] = [
  { key: 'title', name: 'Title', field_type: 'varchar' },
  { key: 'status', name: 'Status', field_type: 'enum', options: [
    { id: 1, label: 'open' },
    { id: 2, label: 'won' },
    { id: 3, label: 'lost' },
  ]},
  { key: 'abc123_practice_area', name: 'Practice Area', field_type: 'enum', options: [
    { id: 10, label: 'Varicent' },
    { id: 11, label: 'Xactly' },
    { id: 12, label: 'CaptivateIQ' },
  ]},
  { key: 'def456_partner', name: 'Partner Assigned', field_type: 'varchar' },
];

// System fields that should not be overridden by custom field labels
const SYSTEM_FIELDS = new Set(['title', 'status', 'value', 'pipeline_id', 'stage_id', 'user_id']);

describe('FieldResolver', () => {
  let resolver: FieldResolver;

  beforeEach(() => {
    resolver = new FieldResolver(MOCK_FIELDS, SYSTEM_FIELDS);
  });

  describe('resolveInputField', () => {
    it('resolves a custom field label to its key', () => {
      expect(resolver.resolveInputField('Practice Area')).toBe('abc123_practice_area');
    });

    it('resolves a system field name to its key', () => {
      expect(resolver.resolveInputField('Title')).toBe('title');
    });

    it('passes through a known raw key', () => {
      expect(resolver.resolveInputField('abc123_practice_area')).toBe('abc123_practice_area');
    });

    it('throws on unknown field with fuzzy suggestion', () => {
      expect(() => resolver.resolveInputField('Pratice Area')).toThrow(
        "Unknown field 'Pratice Area' on this resource. Did you mean 'Practice Area'?"
      );
    });

    it('throws on unknown field with no close match', () => {
      expect(() => resolver.resolveInputField('xyzzy_nonsense')).toThrow(
        "Unknown field 'xyzzy_nonsense' on this resource."
      );
    });

    it('does not auto-correct — always throws', () => {
      expect(() => resolver.resolveInputField('Pratice Area')).toThrow();
    });
  });

  describe('resolveInputValue', () => {
    it('resolves enum label to ID', () => {
      expect(resolver.resolveInputValue('abc123_practice_area', 'Varicent')).toBe(10);
    });

    it('passes through non-enum values unchanged', () => {
      expect(resolver.resolveInputValue('def456_partner', 'Brad')).toBe('Brad');
    });

    it('throws on unknown enum option', () => {
      expect(() => resolver.resolveInputValue('abc123_practice_area', 'Unknown')).toThrow(
        "Invalid value 'Unknown' for field 'Practice Area'. Valid options: Varicent, Xactly, CaptivateIQ"
      );
    });
  });

  describe('resolveOutputField', () => {
    it('resolves a hash key to its label', () => {
      expect(resolver.resolveOutputField('abc123_practice_area')).toBe('Practice Area');
    });

    it('keeps system field names as-is', () => {
      expect(resolver.resolveOutputField('title')).toBe('Title');
    });
  });

  describe('resolveOutputValue', () => {
    it('resolves enum ID to label', () => {
      expect(resolver.resolveOutputValue('abc123_practice_area', 10)).toBe('Varicent');
    });

    it('passes through non-enum values', () => {
      expect(resolver.resolveOutputValue('def456_partner', 'Brad')).toBe('Brad');
    });

    it('passes through unknown enum IDs as-is', () => {
      expect(resolver.resolveOutputValue('abc123_practice_area', 999)).toBe(999);
    });
  });

  describe('collision handling', () => {
    it('namespaces colliding custom field on output', () => {
      const fields: FieldDefinition[] = [
        { key: 'status', name: 'Status', field_type: 'varchar' },
        { key: 'abc_status', name: 'status', field_type: 'varchar' }, // custom field named "status"
      ];
      const r = new FieldResolver(fields, SYSTEM_FIELDS);
      expect(r.getOutputKey('abc_status')).toBe('custom:status');
    });

    it('resolves custom: prefix on input', () => {
      const fields: FieldDefinition[] = [
        { key: 'status', name: 'Status', field_type: 'varchar' },
        { key: 'abc_status', name: 'status', field_type: 'varchar' },
      ];
      const r = new FieldResolver(fields, SYSTEM_FIELDS);
      expect(r.resolveInputField('custom:status')).toBe('abc_status');
    });
  });

  describe('getFieldDefinitions', () => {
    it('returns all field definitions', () => {
      expect(resolver.getFieldDefinitions()).toHaveLength(4);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/reference-resolver/field-resolver.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write field resolver implementation**

```typescript
// src/lib/reference-resolver/field-resolver.ts
import { closest } from 'fastest-levenshtein';
import { distance } from 'fastest-levenshtein';
import type { FieldDefinition, FieldOption } from '../../types.js';

const MAX_FUZZY_DISTANCE = 2;

export class FieldResolver {
  private fields: FieldDefinition[];
  private systemFields: Set<string>;
  private labelToKey: Map<string, string>;           // "Practice Area" -> "abc123_practice_area"
  private keyToLabel: Map<string, string>;            // "abc123_practice_area" -> "Practice Area"
  private keyToOptions: Map<string, FieldOption[]>;   // "abc123_practice_area" -> [{ id, label }]
  private optionLabelToId: Map<string, Map<string, number>>; // key -> (label -> id)
  private optionIdToLabel: Map<string, Map<number, string>>; // key -> (id -> label)
  private collidingLabels: Set<string>;               // custom field labels that collide with system keys
  private customPrefixMap: Map<string, string>;       // "custom:status" -> "abc_status"

  constructor(fields: FieldDefinition[], systemFields: Set<string>) {
    this.fields = fields;
    this.systemFields = systemFields;
    this.labelToKey = new Map();
    this.keyToLabel = new Map();
    this.keyToOptions = new Map();
    this.optionLabelToId = new Map();
    this.optionIdToLabel = new Map();
    this.collidingLabels = new Set();
    this.customPrefixMap = new Map();

    for (const field of fields) {
      // Map key -> label
      this.keyToLabel.set(field.key, field.name);

      // Check for collision: custom field whose label matches a system field key
      const labelLower = field.name.toLowerCase();
      if (systemFields.has(labelLower) && !systemFields.has(field.key)) {
        this.collidingLabels.add(field.name);
        this.customPrefixMap.set(`custom:${field.name}`, field.key);
      } else {
        // Map label -> key (no collision)
        this.labelToKey.set(field.name, field.key);
      }

      // Option maps for enum/set fields
      if (field.options && field.options.length > 0) {
        this.keyToOptions.set(field.key, field.options);
        const labelMap = new Map<string, number>();
        const idMap = new Map<number, string>();
        for (const opt of field.options) {
          labelMap.set(opt.label.toLowerCase(), opt.id);
          idMap.set(opt.id, opt.label);
        }
        this.optionLabelToId.set(field.key, labelMap);
        this.optionIdToLabel.set(field.key, idMap);
      }
    }
  }

  resolveInputField(name: string): string {
    // Check custom: prefix first
    const customKey = this.customPrefixMap.get(name);
    if (customKey) return customKey;

    // Check label map
    const keyFromLabel = this.labelToKey.get(name);
    if (keyFromLabel) return keyFromLabel;

    // Check if it's a known raw key
    if (this.keyToLabel.has(name)) return name;

    // Unknown — try fuzzy match
    const allLabels = [...this.labelToKey.keys()];
    for (const label of allLabels) {
      if (distance(name, label) <= MAX_FUZZY_DISTANCE) {
        throw new Error(
          `Unknown field '${name}' on this resource. Did you mean '${label}'?`
        );
      }
    }

    throw new Error(`Unknown field '${name}' on this resource.`);
  }

  resolveInputValue(key: string, value: unknown): unknown {
    const labelMap = this.optionLabelToId.get(key);
    if (!labelMap || typeof value !== 'string') return value;

    const id = labelMap.get(value.toLowerCase());
    if (id !== undefined) return id;

    // Unknown option
    const options = this.keyToOptions.get(key) ?? [];
    const validLabels = options.map(o => o.label).join(', ');
    const fieldName = this.keyToLabel.get(key) ?? key;
    throw new Error(
      `Invalid value '${value}' for field '${fieldName}'. Valid options: ${validLabels}`
    );
  }

  resolveOutputField(key: string): string {
    return this.keyToLabel.get(key) ?? key;
  }

  getOutputKey(key: string): string {
    const label = this.keyToLabel.get(key) ?? key;
    if (this.collidingLabels.has(label)) {
      return `custom:${label}`;
    }
    return label;
  }

  resolveOutputValue(key: string, value: unknown): unknown {
    const idMap = this.optionIdToLabel.get(key);
    if (!idMap || typeof value !== 'number') return value;
    return idMap.get(value) ?? value;
  }

  getFieldDefinitions(): FieldDefinition[] {
    return this.fields;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/reference-resolver/field-resolver.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reference-resolver/field-resolver.ts tests/lib/reference-resolver/field-resolver.test.ts
git commit -m "feat: field resolver with bidirectional label/key mapping and fuzzy matching"
```

---

## Task 10: Reference Resolver — User, Pipeline, Activity Type Resolvers

**Files:**
- Create: `src/lib/reference-resolver/user-resolver.ts`
- Create: `src/lib/reference-resolver/pipeline-resolver.ts`
- Create: `src/lib/reference-resolver/activity-types.ts`
- Create: `tests/lib/reference-resolver/user-resolver.test.ts`
- Create: `tests/lib/reference-resolver/pipeline-resolver.test.ts`
- Create: `tests/lib/reference-resolver/activity-types.test.ts`

- [ ] **Step 1: Write user resolver tests**

```typescript
// tests/lib/reference-resolver/user-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { UserResolver } from '../../../src/lib/reference-resolver/user-resolver.js';
import type { PipedriveUser } from '../../../src/types.js';

const MOCK_USERS: PipedriveUser[] = [
  { id: 1, name: 'Brad', email: 'brad@bhg.com', active: true },
  { id: 2, name: 'Stacy', email: 'stacy@bhg.com', active: true },
  { id: 3, name: 'Inactive User', email: 'gone@bhg.com', active: false },
];

describe('UserResolver', () => {
  const resolver = new UserResolver(MOCK_USERS);

  it('resolves user name to ID (case-insensitive)', () => {
    expect(resolver.resolveNameToId('brad')).toBe(1);
    expect(resolver.resolveNameToId('Stacy')).toBe(2);
    expect(resolver.resolveNameToId('BRAD')).toBe(1);
  });

  it('throws on unknown user', () => {
    expect(() => resolver.resolveNameToId('Nobody')).toThrow(
      "No user found matching 'Nobody'. Available users: Brad, Stacy, Inactive User"
    );
  });

  it('resolves user ID to name', () => {
    expect(resolver.resolveIdToName(1)).toBe('Brad');
    expect(resolver.resolveIdToName(2)).toBe('Stacy');
  });

  it('returns ID as string for unknown user IDs', () => {
    expect(resolver.resolveIdToName(999)).toBe('User 999');
  });

  it('returns all users', () => {
    expect(resolver.getUsers()).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Write pipeline resolver tests**

```typescript
// tests/lib/reference-resolver/pipeline-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { PipelineResolver } from '../../../src/lib/reference-resolver/pipeline-resolver.js';
import type { PipedrivePipeline } from '../../../src/types.js';

const MOCK_PIPELINES: PipedrivePipeline[] = [
  {
    id: 1, name: 'Sales', active: true,
    stages: [
      { id: 10, name: 'Qualified', pipeline_id: 1, order_nr: 1, rotten_flag: false, rotten_days: null },
      { id: 11, name: 'Proposal Sent', pipeline_id: 1, order_nr: 2, rotten_flag: true, rotten_days: 14 },
    ],
  },
  {
    id: 2, name: 'Partnerships', active: true,
    stages: [
      { id: 20, name: 'Qualified', pipeline_id: 2, order_nr: 1, rotten_flag: false, rotten_days: null },
      { id: 21, name: 'Negotiation', pipeline_id: 2, order_nr: 2, rotten_flag: false, rotten_days: null },
    ],
  },
];

describe('PipelineResolver', () => {
  const resolver = new PipelineResolver(MOCK_PIPELINES);

  describe('resolvePipelineNameToId', () => {
    it('resolves pipeline name (case-insensitive)', () => {
      expect(resolver.resolvePipelineNameToId('sales')).toBe(1);
      expect(resolver.resolvePipelineNameToId('Partnerships')).toBe(2);
    });

    it('throws on unknown pipeline', () => {
      expect(() => resolver.resolvePipelineNameToId('Unknown')).toThrow(
        "No pipeline found matching 'Unknown'. Available pipelines: Sales, Partnerships"
      );
    });
  });

  describe('resolveStageNameToId', () => {
    it('resolves stage within specified pipeline', () => {
      expect(resolver.resolveStageNameToId('Qualified', 1)).toBe(10);
      expect(resolver.resolveStageNameToId('Qualified', 2)).toBe(20);
    });

    it('throws on unknown stage within pipeline', () => {
      expect(() => resolver.resolveStageNameToId('Nonexistent', 1)).toThrow(
        "No stage 'Nonexistent' found in pipeline 'Sales'. Available stages: Qualified, Proposal Sent"
      );
    });
  });

  describe('resolveStageGlobally', () => {
    it('resolves globally unique stage without pipeline', () => {
      const result = resolver.resolveStageGlobally('Proposal Sent');
      expect(result).toEqual({ stageId: 11, pipelineId: 1, pipelineName: 'Sales' });
    });

    it('throws on ambiguous stage', () => {
      expect(() => resolver.resolveStageGlobally('Qualified')).toThrow(
        "Stage 'Qualified' exists in multiple pipelines: Sales, Partnerships. Specify a pipeline to disambiguate."
      );
    });

    it('throws on unknown stage', () => {
      expect(() => resolver.resolveStageGlobally('Nonexistent')).toThrow(
        "No stage found matching 'Nonexistent' in any pipeline."
      );
    });
  });

  describe('resolveStageIdToName', () => {
    it('resolves stage ID to name', () => {
      expect(resolver.resolveStageIdToName(10)).toBe('Qualified');
      expect(resolver.resolveStageIdToName(11)).toBe('Proposal Sent');
    });

    it('returns ID as string for unknown stage', () => {
      expect(resolver.resolveStageIdToName(999)).toBe('Stage 999');
    });
  });

  describe('resolvePipelineIdToName', () => {
    it('resolves pipeline ID to name', () => {
      expect(resolver.resolvePipelineIdToName(1)).toBe('Sales');
    });

    it('returns ID as string for unknown pipeline', () => {
      expect(resolver.resolvePipelineIdToName(999)).toBe('Pipeline 999');
    });
  });

  it('returns all pipelines', () => {
    expect(resolver.getPipelines()).toHaveLength(2);
  });

  it('returns stages for a pipeline', () => {
    expect(resolver.getStagesForPipeline(1)).toHaveLength(2);
    expect(resolver.getStagesForPipeline(999)).toEqual([]);
  });
});
```

- [ ] **Step 3: Write activity types tests**

```typescript
// tests/lib/reference-resolver/activity-types.test.ts
import { describe, it, expect } from 'vitest';
import { ActivityTypeResolver } from '../../../src/lib/reference-resolver/activity-types.js';

const MOCK_TYPES = [
  { key_string: 'call', name: 'Call', active_flag: true },
  { key_string: 'meeting', name: 'Meeting', active_flag: true },
  { key_string: 'task', name: 'Task', active_flag: true },
  { key_string: 'email', name: 'Email', active_flag: true },
  { key_string: 'deadline', name: 'Deadline', active_flag: true },
  { key_string: 'lunch', name: 'Lunch', active_flag: false },
];

describe('ActivityTypeResolver', () => {
  const resolver = new ActivityTypeResolver(MOCK_TYPES);

  it('validates a known active type', () => {
    expect(resolver.isValidType('call')).toBe(true);
    expect(resolver.isValidType('meeting')).toBe(true);
  });

  it('validates case-insensitively', () => {
    expect(resolver.isValidType('Call')).toBe(true);
    expect(resolver.isValidType('MEETING')).toBe(true);
  });

  it('normalizes type to key_string', () => {
    expect(resolver.normalizeType('Call')).toBe('call');
    expect(resolver.normalizeType('MEETING')).toBe('meeting');
  });

  it('includes inactive types as valid', () => {
    expect(resolver.isValidType('lunch')).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(resolver.isValidType('yoga')).toBe(false);
  });

  it('returns all types', () => {
    expect(resolver.getTypes()).toHaveLength(6);
  });
});
```

- [ ] **Step 4: Run all three test files to verify they fail**

```bash
npx vitest run tests/lib/reference-resolver/user-resolver.test.ts tests/lib/reference-resolver/pipeline-resolver.test.ts tests/lib/reference-resolver/activity-types.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 5: Write user resolver**

```typescript
// src/lib/reference-resolver/user-resolver.ts
import type { PipedriveUser } from '../../types.js';

export class UserResolver {
  private users: PipedriveUser[];
  private nameToId: Map<string, number>; // lowercase name -> id
  private idToName: Map<number, string>;

  constructor(users: PipedriveUser[]) {
    this.users = users;
    this.nameToId = new Map();
    this.idToName = new Map();

    for (const user of users) {
      this.nameToId.set(user.name.toLowerCase(), user.id);
      this.idToName.set(user.id, user.name);
    }
  }

  resolveNameToId(name: string): number {
    const id = this.nameToId.get(name.toLowerCase());
    if (id !== undefined) return id;

    const available = this.users.map(u => u.name).join(', ');
    throw new Error(`No user found matching '${name}'. Available users: ${available}`);
  }

  resolveIdToName(id: number): string {
    return this.idToName.get(id) ?? `User ${id}`;
  }

  getUsers(): PipedriveUser[] {
    return this.users;
  }
}
```

- [ ] **Step 6: Write pipeline resolver**

```typescript
// src/lib/reference-resolver/pipeline-resolver.ts
import type { PipedrivePipeline, PipedriveStage } from '../../types.js';

export class PipelineResolver {
  private pipelines: PipedrivePipeline[];
  private pipelineNameToId: Map<string, number>;
  private pipelineIdToName: Map<number, string>;
  private stageIdToName: Map<number, string>;
  private stagesByPipeline: Map<number, PipedriveStage[]>;

  constructor(pipelines: PipedrivePipeline[]) {
    this.pipelines = pipelines;
    this.pipelineNameToId = new Map();
    this.pipelineIdToName = new Map();
    this.stageIdToName = new Map();
    this.stagesByPipeline = new Map();

    for (const pipeline of pipelines) {
      this.pipelineNameToId.set(pipeline.name.toLowerCase(), pipeline.id);
      this.pipelineIdToName.set(pipeline.id, pipeline.name);
      this.stagesByPipeline.set(pipeline.id, pipeline.stages);
      for (const stage of pipeline.stages) {
        this.stageIdToName.set(stage.id, stage.name);
      }
    }
  }

  resolvePipelineNameToId(name: string): number {
    const id = this.pipelineNameToId.get(name.toLowerCase());
    if (id !== undefined) return id;

    const available = this.pipelines.map(p => p.name).join(', ');
    throw new Error(`No pipeline found matching '${name}'. Available pipelines: ${available}`);
  }

  resolvePipelineIdToName(id: number): string {
    return this.pipelineIdToName.get(id) ?? `Pipeline ${id}`;
  }

  resolveStageNameToId(stageName: string, pipelineId: number): number {
    const stages = this.stagesByPipeline.get(pipelineId) ?? [];
    const stage = stages.find(s => s.name.toLowerCase() === stageName.toLowerCase());
    if (stage) return stage.id;

    const pipelineName = this.resolvePipelineIdToName(pipelineId);
    const available = stages.map(s => s.name).join(', ');
    throw new Error(
      `No stage '${stageName}' found in pipeline '${pipelineName}'. Available stages: ${available}`
    );
  }

  resolveStageGlobally(stageName: string): { stageId: number; pipelineId: number; pipelineName: string } {
    const matches: { stageId: number; pipelineId: number; pipelineName: string }[] = [];

    for (const pipeline of this.pipelines) {
      for (const stage of pipeline.stages) {
        if (stage.name.toLowerCase() === stageName.toLowerCase()) {
          matches.push({
            stageId: stage.id,
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
          });
        }
      }
    }

    if (matches.length === 0) {
      throw new Error(`No stage found matching '${stageName}' in any pipeline.`);
    }

    if (matches.length === 1) {
      return matches[0];
    }

    const pipelineNames = matches.map(m => m.pipelineName).join(', ');
    throw new Error(
      `Stage '${stageName}' exists in multiple pipelines: ${pipelineNames}. Specify a pipeline to disambiguate.`
    );
  }

  resolveStageIdToName(id: number): string {
    return this.stageIdToName.get(id) ?? `Stage ${id}`;
  }

  getPipelines(): PipedrivePipeline[] {
    return this.pipelines;
  }

  getStagesForPipeline(pipelineId: number): PipedriveStage[] {
    return this.stagesByPipeline.get(pipelineId) ?? [];
  }
}
```

- [ ] **Step 7: Write activity types resolver**

```typescript
// src/lib/reference-resolver/activity-types.ts

export interface ActivityType {
  key_string: string;
  name: string;
  active_flag: boolean;
}

export class ActivityTypeResolver {
  private types: ActivityType[];
  private keySet: Map<string, string>; // lowercase key -> actual key

  constructor(types: ActivityType[]) {
    this.types = types;
    this.keySet = new Map();
    for (const t of types) {
      this.keySet.set(t.key_string.toLowerCase(), t.key_string);
    }
  }

  isValidType(type: string): boolean {
    return this.keySet.has(type.toLowerCase());
  }

  normalizeType(type: string): string {
    return this.keySet.get(type.toLowerCase()) ?? type;
  }

  getTypes(): ActivityType[] {
    return this.types;
  }
}
```

- [ ] **Step 8: Run tests**

```bash
npx vitest run tests/lib/reference-resolver/user-resolver.test.ts tests/lib/reference-resolver/pipeline-resolver.test.ts tests/lib/reference-resolver/activity-types.test.ts
```

Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/reference-resolver/user-resolver.ts src/lib/reference-resolver/pipeline-resolver.ts src/lib/reference-resolver/activity-types.ts tests/lib/reference-resolver/
git commit -m "feat: user, pipeline/stage, and activity type resolvers"
```

---

## Task 11: Reference Resolver — Index (Orchestrator)

**Files:**
- Create: `src/lib/reference-resolver/index.ts`

This module wires together the cache, sub-resolvers, and the Pipedrive client. It exposes the public API that tool handlers use.

**Applied fixes:**
- Fix 2: Track `{ resolver, data }` pairs. Rebuild sub-resolvers when cache data changes by checking `data !== freshData` before reusing.
- Fix 4: Constructor takes `Logger` param, passes to all caches so background refresh failures are logged.
- Fix 5: N+1 pipeline fetch eliminated — fetches all stages in one `GET /stages` call, groups by `pipeline_id`.
- Fix 5: Lazy initialization — no `initialize()` method. Caches prime on first access.

- [ ] **Step 1: Write the orchestrator**

```typescript
// src/lib/reference-resolver/index.ts
import { StaleWhileRevalidateCache } from './cache.js';
import { FieldResolver } from './field-resolver.js';
import { UserResolver } from './user-resolver.js';
import { PipelineResolver } from './pipeline-resolver.js';
import { ActivityTypeResolver } from './activity-types.js';
import type { ActivityType } from './activity-types.js';
import type { FieldDefinition, PipedriveUser, PipedrivePipeline, PipedriveStage } from '../../types.js';
import type { PipedriveClient } from '../pipedrive-client.js';
import { normalizeApiCall } from '../error-normalizer.js';
import type { Logger } from 'pino';

const FIELD_TTL = 5 * 60 * 1000;       // 5 minutes
const USER_TTL = 30 * 60 * 1000;       // 30 minutes
const PIPELINE_TTL = 30 * 60 * 1000;   // 30 minutes
const ACTIVITY_TYPE_TTL = 30 * 60 * 1000;

// System fields for each resource type — these cannot be overridden by custom field labels
const DEAL_SYSTEM_FIELDS = new Set([
  'id', 'title', 'value', 'currency', 'status', 'pipeline_id', 'stage_id',
  'user_id', 'person_id', 'org_id', 'expected_close_date', 'add_time', 'update_time',
  'won_time', 'lost_time', 'close_time', 'lost_reason', 'visible_to',
]);

const PERSON_SYSTEM_FIELDS = new Set([
  'id', 'name', 'email', 'phone', 'org_id', 'user_id', 'add_time', 'update_time', 'visible_to',
]);

const ORG_SYSTEM_FIELDS = new Set([
  'id', 'name', 'owner_id', 'address', 'add_time', 'update_time', 'visible_to',
]);

const SYSTEM_FIELDS_MAP: Record<string, Set<string>> = {
  deal: DEAL_SYSTEM_FIELDS,
  person: PERSON_SYSTEM_FIELDS,
  organization: ORG_SYSTEM_FIELDS,
  activity: new Set(['id', 'type', 'subject', 'due_date', 'due_time', 'duration',
    'deal_id', 'person_id', 'org_id', 'user_id', 'note', 'done', 'add_time', 'update_time']),
};

export type ResourceType = 'deal' | 'person' | 'organization' | 'activity';

export class ReferenceResolver {
  private client: PipedriveClient;
  private logger: Logger;

  // Field resolvers — track { resolver, data } pairs to detect cache refreshes
  private fieldCaches: Map<ResourceType, StaleWhileRevalidateCache<FieldDefinition[]>>;
  private fieldResolvers: Map<ResourceType, { resolver: FieldResolver; data: FieldDefinition[] }>;

  // User resolver
  private userCache: StaleWhileRevalidateCache<PipedriveUser[]>;
  private userState: { resolver: UserResolver; data: PipedriveUser[] } | null = null;

  // Pipeline resolver
  private pipelineCache: StaleWhileRevalidateCache<PipedrivePipeline[]>;
  private pipelineState: { resolver: PipelineResolver; data: PipedrivePipeline[] } | null = null;

  // Activity type resolver
  private activityTypeCache: StaleWhileRevalidateCache<ActivityType[]>;
  private activityTypeState: { resolver: ActivityTypeResolver; data: ActivityType[] } | null = null;

  constructor(client: PipedriveClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
    this.fieldCaches = new Map();
    this.fieldResolvers = new Map();

    // Initialize field caches per resource type — logger passed so background refresh failures are logged
    for (const type of ['deal', 'person', 'organization', 'activity'] as ResourceType[]) {
      this.fieldCaches.set(
        type,
        new StaleWhileRevalidateCache(() => this.fetchFields(type), FIELD_TTL, logger)
      );
    }

    this.userCache = new StaleWhileRevalidateCache(() => this.fetchUsers(), USER_TTL, logger);
    this.pipelineCache = new StaleWhileRevalidateCache(() => this.fetchPipelines(), PIPELINE_TTL, logger);
    this.activityTypeCache = new StaleWhileRevalidateCache(() => this.fetchActivityTypes(), ACTIVITY_TYPE_TTL, logger);
  }

  // Lazy initialization — no eager cache priming on startup.
  // Caches are populated on first access via StaleWhileRevalidateCache.get().
  // The startup validation call (GET /users/me) already confirms the token works.

  async getFieldResolver(type: ResourceType): Promise<FieldResolver> {
    const cache = this.fieldCaches.get(type)!;
    const fields = await cache.get();
    const existing = this.fieldResolvers.get(type);
    // Rebuild resolver if data reference changed (cache was refreshed in background)
    if (!existing || existing.data !== fields) {
      const systemFields = SYSTEM_FIELDS_MAP[type] ?? new Set();
      const resolver = new FieldResolver(fields, systemFields);
      this.fieldResolvers.set(type, { resolver, data: fields });
      return resolver;
    }
    return existing.resolver;
  }

  async getUserResolver(): Promise<UserResolver> {
    const users = await this.userCache.get();
    // Rebuild resolver if data reference changed (cache was refreshed in background)
    if (!this.userState || this.userState.data !== users) {
      this.userState = { resolver: new UserResolver(users), data: users };
    }
    return this.userState.resolver;
  }

  async getPipelineResolver(): Promise<PipelineResolver> {
    const pipelines = await this.pipelineCache.get();
    // Rebuild resolver if data reference changed (cache was refreshed in background)
    if (!this.pipelineState || this.pipelineState.data !== pipelines) {
      this.pipelineState = { resolver: new PipelineResolver(pipelines), data: pipelines };
    }
    return this.pipelineState.resolver;
  }

  async getActivityTypeResolver(): Promise<ActivityTypeResolver> {
    const types = await this.activityTypeCache.get();
    // Rebuild resolver if data reference changed (cache was refreshed in background)
    if (!this.activityTypeState || this.activityTypeState.data !== types) {
      this.activityTypeState = { resolver: new ActivityTypeResolver(types), data: types };
    }
    return this.activityTypeState.resolver;
  }

  // --- Fetch methods (called by caches) ---

  private async fetchFields(type: ResourceType): Promise<FieldDefinition[]> {
    const endpoint = `/${type}Fields`;
    const result = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', endpoint) as any,
      undefined, this.logger
    );
    const data = (result as any).data;
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error(`Failed to fetch ${type} fields`);
    }
    return data.data.map((f: any) => ({
      key: f.key,
      name: f.name,
      field_type: f.field_type,
      options: f.options ?? undefined,
      max_length: f.max_length ?? undefined,
    }));
  }

  private async fetchUsers(): Promise<PipedriveUser[]> {
    const result = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', '/users') as any,
      undefined, this.logger
    );
    const data = (result as any).data;
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error('Failed to fetch users');
    }
    return data.data.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      active: u.active_flag,
    }));
  }

  private async fetchPipelines(): Promise<PipedrivePipeline[]> {
    // Fetch all pipelines
    const pipelinesResult = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', '/pipelines') as any,
      undefined, this.logger
    );
    const pipelinesData = (pipelinesResult as any).data;
    if (!pipelinesData.success || !Array.isArray(pipelinesData.data)) {
      throw new Error('Failed to fetch pipelines');
    }

    // Fetch ALL stages in one call (no pipeline_id filter) — avoids N+1
    const stagesResult = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', '/stages') as any,
      undefined, this.logger
    );
    const stagesData = (stagesResult as any).data;
    const allStages: PipedriveStage[] = Array.isArray(stagesData.data)
      ? stagesData.data.map((s: any) => ({
          id: s.id,
          name: s.name,
          pipeline_id: s.pipeline_id,
          order_nr: s.order_nr,
          rotten_flag: s.rotten_flag,
          rotten_days: s.rotten_days,
        }))
      : [];

    // Group stages by pipeline
    const stagesByPipeline = new Map<number, PipedriveStage[]>();
    for (const stage of allStages) {
      const list = stagesByPipeline.get(stage.pipeline_id) ?? [];
      list.push(stage);
      stagesByPipeline.set(stage.pipeline_id, list);
    }

    return pipelinesData.data.map((p: any) => ({
      id: p.id,
      name: p.name,
      active: p.active_flag,
      stages: stagesByPipeline.get(p.id) ?? [],
    }));
  }

  private async fetchActivityTypes(): Promise<ActivityType[]> {
    const result = await normalizeApiCall(
      async () => this.client.request('GET', 'v1', '/activityTypes') as any,
      undefined, this.logger
    );
    const data = (result as any).data;
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error('Failed to fetch activity types');
    }
    return data.data;
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/reference-resolver/index.ts
git commit -m "feat: reference resolver orchestrator with lazy init and resolver rebuild on cache refresh"
```
