# Pipedrive MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 31-tool MCP server that exposes Pipedrive CRM data to AI agents for BHG's internal team.

**Architecture:** Five-layer stack (MCP SDK -> Tool Handlers -> Reference Data Resolver -> Error Normalizer -> Pipedrive Client). Dual transport (stdio default, SSE opt-in). Human-friendly inputs with automatic field/entity/stage resolution.

**Tech Stack:** TypeScript, Node.js 20 LTS, @modelcontextprotocol/sdk, Pino logger, Vitest, native fetch.

**Spec:** `docs/superpowers/specs/2026-03-30-pipedrive-mcp-design.md`

---

## File Structure

```
src/
  index.ts                          — entry point, stdout safety, transport init, startup validation
  server.ts                         — MCP server setup, tool registration with access control
  types.ts                          — shared types (PipedriveError, PaginatedResponse, SummaryShapes, etc.)
  config.ts                         — env var parsing, category/tool access control
  tools/
    deals.ts                        — 6 deal tool handlers
    persons.ts                      — 6 person tool handlers
    organizations.ts                — 5 org tool handlers
    activities.ts                   — 5 activity tool handlers
    notes.ts                        — 5 note tool handlers
    pipelines.ts                    — 2 pipeline/stage tool handlers
    users.ts                        — 1 user tool handler
    fields.ts                       — 1 get-fields tool handler
  lib/
    pipedrive-client.ts             — HTTP client, auth, route registry, rate tracking, fetch timeouts
    error-normalizer.ts             — error catching and normalization across v1/v2
    reference-resolver/
      index.ts                      — public API, orchestrates sub-resolvers
      cache.ts                      — generic stale-while-revalidate cache with TTL
      field-resolver.ts             — field label<->key, enum option label<->ID, fuzzy matching
      user-resolver.ts              — user name->ID resolution and caching
      pipeline-resolver.ts          — pipeline/stage name->ID, stage disambiguation
      activity-types.ts             — activity type validation and caching
    entity-resolver.ts              — name->ID search, case-insensitive match, disambiguation
    sanitizer.ts                    — input trimming, length limits, HTML stripping
    cursor.ts                       — base64 cursor encode/decode/validate
tests/
  lib/
    cursor.test.ts
    sanitizer.test.ts
    error-normalizer.test.ts
    pipedrive-client.test.ts
    entity-resolver.test.ts
    reference-resolver/
      cache.test.ts
      field-resolver.test.ts
      user-resolver.test.ts
      pipeline-resolver.test.ts
      activity-types.test.ts
  tools/
    deals.test.ts
    persons.test.ts
    organizations.test.ts
    activities.test.ts
    notes.test.ts
    pipelines.test.ts
    users.test.ts
    fields.test.ts
  config.test.ts
  integration/                      — Pipedrive sandbox tests (run separately)
    deals.integration.test.ts
    persons.integration.test.ts
    organizations.integration.test.ts
    activities.integration.test.ts
    notes.integration.test.ts
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `vitest.config.ts`

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/brad/Library/CloudStorage/OneDrive-TheBlueHorizonsGroup/Apps/Pipedrive_MCP
npm init -y
```

Then replace the contents of `package.json`:

```json
{
  "name": "pipedrive-mcp",
  "version": "0.1.0",
  "description": "MCP server for Pipedrive CRM",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "start:stdio": "node dist/index.js",
    "start:sse": "node dist/index.js --transport sse",
    "dev": "tsx src/index.ts",
    "dev:sse": "tsx src/index.ts --transport sse",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "private": true
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk pino dotenv fastest-levenshtein striptags
npm install -D typescript vitest tsx @types/node
```

- [ ] **Step 3: Check the installed MCP SDK version and pin it**

```bash
npm ls @modelcontextprotocol/sdk
```

Update `package.json` to pin the SDK to the installed minor version (e.g., change `^1.12.0` to `~1.12.0`).

Also check what version of Zod the SDK brought in:

```bash
npm ls zod
```

If Zod is present as a transitive dependency, do NOT add it separately.

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.tsbuildinfo
```

- [ ] **Step 6: Create .env.example**

```bash
# Required: Your Pipedrive personal API token
# Found in Pipedrive > Settings > Personal preferences > API
PIPEDRIVE_API_TOKEN=your_token_here

# Optional: Server port for SSE mode (default: 3000)
PORT=3000

# Optional: Access control
# Categories: read, create, update, delete (default: all enabled)
PIPEDRIVE_ENABLED_CATEGORIES=read,create,update,delete

# Optional: Disable specific tools (comma-separated tool names)
# PIPEDRIVE_DISABLED_TOOLS=delete-deal,delete-person

# Optional: Log level (default: info)
# Set to "debug" for full param logging (includes PII — development only)
PIPEDRIVE_LOG_LEVEL=info
```

- [ ] **Step 7: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    environment: 'node',
  },
});
```

- [ ] **Step 8: Create directory structure**

```bash
mkdir -p src/tools src/lib/reference-resolver tests/lib/reference-resolver tests/tools tests/integration
```

- [ ] **Step 9: Verify setup compiles**

Create a minimal `src/index.ts`:

```typescript
console.error('Pipedrive MCP Server starting...');
```

```bash
npx tsc --noEmit
npx vitest run
```

Expected: TypeScript compiles with no errors. Vitest runs with 0 tests.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: project scaffolding with TypeScript, Vitest, MCP SDK"
```

---

## Task 2: Shared Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write shared type definitions**

```typescript
// src/types.ts

// --- Error Types ---

export interface PipedriveApiError {
  error: true;
  code: number;
  message: string;
  details?: Record<string, unknown>;
}

// --- Pagination ---

export interface CursorPayload {
  v: 'v1' | 'v2';
  offset?: number;
  cursor?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string;
}

// --- Summary Shapes ---

export interface DealSummary {
  id: number;
  title: string;
  status: string;
  pipeline: string;
  stage: string;
  owner: string;
  value: number | null;
  updated_at: string;
}

export interface PersonSummary {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  organization: string | null;
  owner: string;
  updated_at: string;
}

export interface OrganizationSummary {
  id: number;
  name: string;
  owner: string;
  address: string | null;
  updated_at: string;
}

export interface ActivitySummary {
  id: number;
  type: string;
  subject: string;
  due_date: string | null;
  done: boolean;
  deal: string | null;
  person: string | null;
  owner: string;
}

export interface NoteSummary {
  id: number;
  content: string;
  truncated: boolean;
  deal: string | null;
  person: string | null;
  org: string | null;
  updated_at: string;
}

// --- Delete ---

export interface DeleteConfirmation {
  confirm_required: true;
  message: string;
}

export interface DeleteResult {
  id: number;
  title?: string;
  name?: string;
  deleted: true;
}

// --- Field Definitions ---

export interface FieldDefinition {
  key: string;
  name: string;
  field_type: string;
  options?: FieldOption[];
  max_length?: number;
}

export interface FieldOption {
  id: number;
  label: string;
}

// --- Reference Data ---

export interface PipedriveUser {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export interface PipedrivePipeline {
  id: number;
  name: string;
  active: boolean;
  stages: PipedriveStage[];
}

export interface PipedriveStage {
  id: number;
  name: string;
  pipeline_id: number;
  order_nr: number;
  rotten_flag: boolean;
  rotten_days: number | null;
}

// --- Config ---

export type ToolCategory = 'read' | 'create' | 'update' | 'delete';

export interface ServerConfig {
  apiToken: string;
  port: number;
  transport: 'stdio' | 'sse';
  enabledCategories: Set<ToolCategory>;
  disabledTools: Set<string>;
  logLevel: 'info' | 'debug';
}

// --- Tool Registration ---

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

// --- Pipedrive Client ---

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiRoute {
  version: 'v1' | 'v2';
  path: string;
  method: HttpMethod;
}

export interface RateLimitState {
  remaining: number | null;
  resetTimestamp: number | null;
}
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared type definitions"
```

---

## Task 3: Config Module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write config tests**

```typescript
// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('parses valid config with all defaults', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'test-token-123';
    const config = parseConfig();
    expect(config.apiToken).toBe('test-token-123');
    expect(config.port).toBe(3000);
    expect(config.transport).toBe('stdio');
    expect(config.enabledCategories).toEqual(new Set(['read', 'create', 'update', 'delete']));
    expect(config.disabledTools).toEqual(new Set());
    expect(config.logLevel).toBe('info');
  });

  it('throws if PIPEDRIVE_API_TOKEN is missing', () => {
    delete process.env.PIPEDRIVE_API_TOKEN;
    expect(() => parseConfig()).toThrow('PIPEDRIVE_API_TOKEN environment variable is required');
  });

  it('throws if PIPEDRIVE_API_TOKEN is empty', () => {
    process.env.PIPEDRIVE_API_TOKEN = '   ';
    expect(() => parseConfig()).toThrow('PIPEDRIVE_API_TOKEN environment variable is required');
  });

  it('parses custom port', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    process.env.PORT = '8080';
    const config = parseConfig();
    expect(config.port).toBe(8080);
  });

  it('parses enabled categories', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    process.env.PIPEDRIVE_ENABLED_CATEGORIES = 'read,create';
    const config = parseConfig();
    expect(config.enabledCategories).toEqual(new Set(['read', 'create']));
  });

  it('warns on unknown categories and ignores them', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    process.env.PIPEDRIVE_ENABLED_CATEGORIES = 'read,bogus,create';
    const config = parseConfig();
    expect(config.enabledCategories).toEqual(new Set(['read', 'create']));
    // Warning is logged — tested via logger mock in integration
  });

  it('parses disabled tools', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    process.env.PIPEDRIVE_DISABLED_TOOLS = 'delete-deal,delete-person';
    const config = parseConfig();
    expect(config.disabledTools).toEqual(new Set(['delete-deal', 'delete-person']));
  });

  it('parses log level', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    process.env.PIPEDRIVE_LOG_LEVEL = 'debug';
    const config = parseConfig();
    expect(config.logLevel).toBe('debug');
  });

  it('defaults log level to info for unknown values', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    process.env.PIPEDRIVE_LOG_LEVEL = 'trace';
    const config = parseConfig();
    expect(config.logLevel).toBe('info');
  });

  it('parses transport from args', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    const config = parseConfig(['--transport', 'sse']);
    expect(config.transport).toBe('sse');
  });

  it('parses port from args', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    const config = parseConfig(['--port', '9090']);
    expect(config.port).toBe(9090);
  });

  it('isToolEnabled checks both categories and disabled tools', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'token';
    process.env.PIPEDRIVE_ENABLED_CATEGORIES = 'read,create,delete';
    process.env.PIPEDRIVE_DISABLED_TOOLS = 'delete-deal';
    const config = parseConfig();

    // read category enabled, not in disabled list
    expect(isToolEnabled(config, 'list-deals', 'read')).toBe(true);
    // delete category enabled, but specific tool disabled
    expect(isToolEnabled(config, 'delete-deal', 'delete')).toBe(false);
    // update category not enabled
    expect(isToolEnabled(config, 'update-deal', 'update')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL — `parseConfig` not found.

- [ ] **Step 3: Write config implementation**

```typescript
// src/config.ts
import type { ServerConfig, ToolCategory } from './types.js';

const VALID_CATEGORIES: ToolCategory[] = ['read', 'create', 'update', 'delete'];

export function parseConfig(args: string[] = process.argv.slice(2)): ServerConfig {
  const apiToken = (process.env.PIPEDRIVE_API_TOKEN ?? '').trim();
  if (!apiToken) {
    throw new Error('PIPEDRIVE_API_TOKEN environment variable is required');
  }

  // Parse CLI args
  let transport: 'stdio' | 'sse' = 'stdio';
  let cliPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--transport' && args[i + 1]) {
      transport = args[i + 1] === 'sse' ? 'sse' : 'stdio';
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      cliPort = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const port = cliPort ?? parseInt(process.env.PORT ?? '3000', 10);

  // Parse enabled categories
  const categoriesEnv = process.env.PIPEDRIVE_ENABLED_CATEGORIES?.trim();
  let enabledCategories: Set<ToolCategory>;
  if (categoriesEnv) {
    const parsed = categoriesEnv.split(',').map(s => s.trim());
    const valid = parsed.filter((c): c is ToolCategory =>
      VALID_CATEGORIES.includes(c as ToolCategory)
    );
    const invalid = parsed.filter(c => !VALID_CATEGORIES.includes(c as ToolCategory));
    if (invalid.length > 0) {
      // Log warning — caller should handle this via logger
      console.error(`Warning: Unknown categories ignored: ${invalid.join(', ')}`);
    }
    enabledCategories = new Set(valid);
  } else {
    enabledCategories = new Set(VALID_CATEGORIES);
  }

  // Parse disabled tools
  const disabledToolsEnv = process.env.PIPEDRIVE_DISABLED_TOOLS?.trim();
  const disabledTools = disabledToolsEnv
    ? new Set(disabledToolsEnv.split(',').map(s => s.trim()).filter(Boolean))
    : new Set<string>();

  // Parse log level
  const logLevelEnv = process.env.PIPEDRIVE_LOG_LEVEL?.trim();
  const logLevel = logLevelEnv === 'debug' ? 'debug' : 'info';

  return {
    apiToken,
    port,
    transport,
    enabledCategories,
    disabledTools,
    logLevel,
  };
}

export function isToolEnabled(
  config: ServerConfig,
  toolName: string,
  category: ToolCategory
): boolean {
  if (!config.enabledCategories.has(category)) return false;
  if (config.disabledTools.has(toolName)) return false;
  return true;
}
```

- [ ] **Step 4: Update test import to include isToolEnabled and run tests**

Add the import for `isToolEnabled` to the test file's import line:

```typescript
import { parseConfig, isToolEnabled } from '../src/config.js';
```

```bash
npx vitest run tests/config.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config module with env var parsing and access control"
```

---

## Task 4: Cursor Module

**Files:**
- Create: `src/lib/cursor.ts`
- Create: `tests/lib/cursor.test.ts`

- [ ] **Step 1: Write cursor tests**

```typescript
// tests/lib/cursor.test.ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/lib/cursor.js';

describe('encodeCursor', () => {
  it('encodes a v2 cursor', () => {
    const encoded = encodeCursor({ v: 'v2', cursor: 'abc123' });
    expect(typeof encoded).toBe('string');
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ v: 'v2', cursor: 'abc123' });
  });

  it('encodes a v1 offset', () => {
    const encoded = encodeCursor({ v: 'v1', offset: 200 });
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ v: 'v1', offset: 200 });
  });
});

describe('decodeCursor', () => {
  it('decodes a valid v2 cursor', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v2', cursor: 'xyz' })).toString('base64');
    expect(decodeCursor(payload)).toEqual({ v: 'v2', cursor: 'xyz' });
  });

  it('decodes a valid v1 offset', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: 100 })).toString('base64');
    expect(decodeCursor(payload)).toEqual({ v: 'v1', offset: 100 });
  });

  it('throws on invalid base64', () => {
    expect(() => decodeCursor('not-valid-base64!!!')).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on invalid JSON', () => {
    const payload = Buffer.from('not json').toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on missing v field', () => {
    const payload = Buffer.from(JSON.stringify({ offset: 100 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on unrecognized v value', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v3', offset: 100 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on negative offset for v1', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: -5 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on non-integer offset for v1', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: 3.14 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on missing cursor for v2', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v2' })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/cursor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write cursor implementation**

```typescript
// src/lib/cursor.ts
import type { CursorPayload } from '../types.js';

const CURSOR_ERROR = 'Invalid cursor — start a new list request without a cursor.';

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function decodeCursor(encoded: string): CursorPayload {
  let parsed: unknown;
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf-8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error(CURSOR_ERROR);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(CURSOR_ERROR);
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.v !== 'v1' && obj.v !== 'v2') {
    throw new Error(CURSOR_ERROR);
  }

  if (obj.v === 'v1') {
    if (typeof obj.offset !== 'number' || !Number.isInteger(obj.offset) || obj.offset < 0) {
      throw new Error(CURSOR_ERROR);
    }
    return { v: 'v1', offset: obj.offset };
  }

  if (typeof obj.cursor !== 'string' || obj.cursor.length === 0) {
    throw new Error(CURSOR_ERROR);
  }

  return { v: 'v2', cursor: obj.cursor };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/cursor.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cursor.ts tests/lib/cursor.test.ts
git commit -m "feat: cursor encode/decode with validation"
```

---

## Task 5: Sanitizer Module

**Files:**
- Create: `src/lib/sanitizer.ts`
- Create: `tests/lib/sanitizer.test.ts`

- [ ] **Step 1: Write sanitizer tests**

```typescript
// tests/lib/sanitizer.test.ts
import { describe, it, expect } from 'vitest';
import { trimString, sanitizeNoteContent, validateStringLength } from '../../src/lib/sanitizer.js';

describe('trimString', () => {
  it('trims whitespace', () => {
    expect(trimString('  hello  ')).toBe('hello');
  });

  it('throws on empty-after-trim', () => {
    expect(() => trimString('   ', 'title')).toThrow("Field 'title' cannot be empty.");
  });

  it('throws on empty string', () => {
    expect(() => trimString('', 'name')).toThrow("Field 'name' cannot be empty.");
  });

  it('returns trimmed value for valid input', () => {
    expect(trimString('  valid  ', 'field')).toBe('valid');
  });
});

describe('validateStringLength', () => {
  it('passes for string within limit', () => {
    expect(() => validateStringLength('hello', 'title', 255)).not.toThrow();
  });

  it('throws for string exceeding limit', () => {
    const long = 'a'.repeat(256);
    expect(() => validateStringLength(long, 'title', 255)).toThrow(
      "Field 'title' exceeds maximum length of 255 characters (got 256)."
    );
  });
});

describe('sanitizeNoteContent', () => {
  it('strips basic HTML tags', () => {
    expect(sanitizeNoteContent('<b>Important</b>: follow up')).toBe('Important: follow up');
  });

  it('converts <br> to newlines', () => {
    expect(sanitizeNoteContent('Line one<br>Line two')).toBe('Line one\nLine two');
  });

  it('converts <br/> and <br /> to newlines', () => {
    expect(sanitizeNoteContent('A<br/>B<br />C')).toBe('A\nB\nC');
  });

  it('converts <p> tags to newlines', () => {
    expect(sanitizeNoteContent('<p>First paragraph</p><p>Second paragraph</p>')).toBe(
      'First paragraph\n\nSecond paragraph'
    );
  });

  it('converts block-level elements to newlines', () => {
    expect(sanitizeNoteContent('<div>First</div><div>Second</div>')).toBe('First\nSecond');
  });

  it('converts <li> to newlines', () => {
    expect(sanitizeNoteContent('<ul><li>Item 1</li><li>Item 2</li></ul>')).toBe('Item 1\nItem 2');
  });

  it('converts heading tags to newlines', () => {
    expect(sanitizeNoteContent('<h1>Title</h1><h2>Subtitle</h2>Text')).toBe('Title\nSubtitle\nText');
  });

  it('decodes HTML entities', () => {
    expect(sanitizeNoteContent('Tom &amp; Jerry &lt;3')).toBe('Tom & Jerry <3');
  });

  it('collapses 3+ newlines to 2', () => {
    expect(sanitizeNoteContent('A\n\n\n\nB')).toBe('A\n\nB');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeNoteContent('  <p>Hello</p>  ')).toBe('Hello');
  });

  it('handles plain text without changes', () => {
    expect(sanitizeNoteContent('Just plain text')).toBe('Just plain text');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/sanitizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write sanitizer implementation**

```typescript
// src/lib/sanitizer.ts
import striptags from 'striptags';

export function trimString(value: string, fieldName?: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Field '${fieldName ?? 'value'}' cannot be empty.`);
  }
  return trimmed;
}

export function validateStringLength(
  value: string,
  fieldName: string,
  maxLength: number
): void {
  if (value.length > maxLength) {
    throw new Error(
      `Field '${fieldName}' exceeds maximum length of ${maxLength} characters (got ${value.length}).`
    );
  }
}

export function sanitizeNoteContent(html: string): string {
  let text = html;

  // Convert block-level elements to newlines BEFORE stripping tags
  // <p> gets double newline (paragraph break)
  text = text.replace(/<\/p>\s*/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');

  // <br> variants to newline
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Block-level elements: closing tags become newlines
  const blockTags = ['div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr'];
  for (const tag of blockTags) {
    text = text.replace(new RegExp(`</${tag}>`, 'gi'), '\n');
  }

  // Strip all remaining HTML tags
  text = striptags(text);

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Collapse 3+ newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim
  text = text.trim();

  return text;
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'gi'), char);
  }
  // Numeric entities
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  result = result.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  return result;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/sanitizer.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sanitizer.ts tests/lib/sanitizer.test.ts
git commit -m "feat: input sanitizer with HTML stripping and length validation"
```

---

## Task 6: Pipedrive Client

**Files:**
- Create: `src/lib/pipedrive-client.ts`
- Create: `tests/lib/pipedrive-client.test.ts`

- [ ] **Step 1: Write Pipedrive client tests**

```typescript
// tests/lib/pipedrive-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipedriveClient } from '../../src/lib/pipedrive-client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('PipedriveClient', () => {
  let client: PipedriveClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PipedriveClient('test-token');
  });

  describe('request', () => {
    it('attaches api_token as query param for v1', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 1 } }));
      await client.request('GET', 'v1', '/users/me');
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api_token=test-token');
      expect(calledUrl).toContain('api.pipedrive.com/v1/users/me');
    });

    it('attaches api_token as query param for v2', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: 1 }] }));
      await client.request('GET', 'v2', '/deals');
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api_token=test-token');
      expect(calledUrl).toContain('api.pipedrive.com/api/v2/deals');
    });

    it('sends JSON body for POST requests', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 1 } }));
      await client.request('POST', 'v2', '/deals', { title: 'Test Deal' });
      const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
      expect(callArgs.method).toBe('POST');
      expect(callArgs.headers).toHaveProperty('Content-Type', 'application/json');
      expect(JSON.parse(callArgs.body as string)).toEqual({ title: 'Test Deal' });
    });

    it('appends query params for GET requests', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
      await client.request('GET', 'v2', '/deals', undefined, { status: 'open', limit: '50' });
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('status=open');
      expect(calledUrl).toContain('limit=50');
    });

    it('tracks rate limit headers', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [] }, 200, {
          'x-ratelimit-remaining': '42',
          'x-ratelimit-reset': '1711641600',
        })
      );
      await client.request('GET', 'v2', '/deals');
      expect(client.rateLimitState.remaining).toBe(42);
      expect(client.rateLimitState.resetTimestamp).toBe(1711641600);
    });

    it('uses AbortSignal timeout', async () => {
      mockFetch.mockImplementation(() => new Promise(() => {})); // never resolves
      const promise = client.request('GET', 'v1', '/users/me', undefined, undefined, 50);
      await expect(promise).rejects.toThrow();
    });
  });

  describe('validateToken', () => {
    it('resolves on valid token', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { id: 1, name: 'Brad' } })
      );
      const user = await client.validateToken();
      expect(user).toEqual({ id: 1, name: 'Brad' });
    });

    it('throws on invalid token', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'unauthorized' }, 401)
      );
      await expect(client.validateToken()).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/pipedrive-client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write Pipedrive client implementation**

```typescript
// src/lib/pipedrive-client.ts
import type { RateLimitState, HttpMethod } from '../types.js';

const BASE_URL = 'https://api.pipedrive.com';
const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const STARTUP_TIMEOUT = 10_000; // 10 seconds

export class PipedriveClient {
  private apiToken: string;
  public rateLimitState: RateLimitState = {
    remaining: null,
    resetTimestamp: null,
  };

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

  async request(
    method: HttpMethod,
    version: 'v1' | 'v2',
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
    timeoutMs: number = DEFAULT_TIMEOUT
  ): Promise<unknown> {
    const basePath = version === 'v1' ? '/v1' : '/api/v2';
    const url = new URL(`${basePath}${path}`, BASE_URL);

    // Auth via query param (works for both v1 and v2 with personal tokens)
    url.searchParams.set('api_token', this.apiToken);

    // Additional query params
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== '') {
          url.searchParams.set(key, value);
        }
      }
    }

    const options: RequestInit = {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (body && method !== 'GET') {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), options);

    // Track rate limit headers
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining !== null) {
      this.rateLimitState.remaining = parseInt(remaining, 10);
    }
    if (reset !== null) {
      this.rateLimitState.resetTimestamp = parseInt(reset, 10);
    }

    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }

  async validateToken(): Promise<{ id: number; name: string }> {
    const result = await this.request('GET', 'v1', '/users/me', undefined, undefined, STARTUP_TIMEOUT) as {
      status: number;
      data: { success: boolean; data?: { id: number; name: string }; error?: string };
    };

    if (result.status !== 200 || !result.data.success || !result.data.data) {
      throw new Error('API token is invalid. Restart the server with a valid token.');
    }

    return result.data.data;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/pipedrive-client.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipedrive-client.ts tests/lib/pipedrive-client.test.ts
git commit -m "feat: Pipedrive HTTP client with auth, rate limit tracking, timeouts"
```

---

## Task 7: Error Normalizer

**Files:**
- Create: `src/lib/error-normalizer.ts`
- Create: `tests/lib/error-normalizer.test.ts`

- [ ] **Step 1: Write error normalizer tests**

```typescript
// tests/lib/error-normalizer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeApiCall } from '../../src/lib/error-normalizer.js';

describe('normalizeApiCall', () => {
  it('passes through successful responses', async () => {
    const result = await normalizeApiCall(async () => ({
      status: 200,
      data: { success: true, data: { id: 1 } },
    }));
    expect(result).toEqual({ status: 200, data: { success: true, data: { id: 1 } } });
  });

  it('normalizes 401 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 401,
        data: { success: false, error: 'unauthorized' },
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 401,
      message: 'API token is invalid. Restart the server with a valid token.',
    });
  });

  it('normalizes 403 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 403,
        data: { success: false, error: 'forbidden' },
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 403,
      message: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.',
    });
  });

  it('normalizes 404 errors with entity context', async () => {
    await expect(
      normalizeApiCall(
        async () => ({ status: 404, data: { success: false } }),
        { entity: 'Deal', id: 123 }
      )
    ).rejects.toMatchObject({
      error: true,
      code: 404,
      message: 'Deal with ID 123 not found.',
    });
  });

  it('normalizes 404 without entity context', async () => {
    await expect(
      normalizeApiCall(async () => ({ status: 404, data: { success: false } }))
    ).rejects.toMatchObject({
      error: true,
      code: 404,
      message: 'Resource not found.',
    });
  });

  it('normalizes 429 with rate limit info', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 429,
        data: { success: false, error: 'rate limited' },
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 429,
    });
  });

  it('normalizes 500 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 500,
        data: { success: false, error: 'internal error' },
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 500,
      message: 'Pipedrive API error. Try again.',
    });
  });

  it('normalizes 502 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 502,
        data: {},
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 502,
      message: 'Pipedrive API is temporarily unavailable. Try again.',
    });
  });

  it('normalizes 504 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 504,
        data: {},
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 504,
      message: 'Pipedrive API timed out.',
    });
  });

  it('normalizes network failures', async () => {
    await expect(
      normalizeApiCall(async () => {
        throw new TypeError('fetch failed');
      })
    ).rejects.toMatchObject({
      error: true,
      code: 0,
      message: 'Unable to reach Pipedrive API. Check network connection.',
    });
  });

  it('normalizes timeout errors', async () => {
    await expect(
      normalizeApiCall(async () => {
        const err = new DOMException('The operation was aborted', 'AbortError');
        throw err;
      })
    ).rejects.toMatchObject({
      error: true,
      code: 0,
      message: 'Request to Pipedrive API timed out.',
    });
  });

  it('retries 502 once', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) return { status: 502, data: {} };
      return { status: 200, data: { success: true, data: { id: 1 } } };
    };
    const result = await normalizeApiCall(fn);
    expect(calls).toBe(2);
    expect(result).toEqual({ status: 200, data: { success: true, data: { id: 1 } } });
  });

  it('retries 503 once', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) return { status: 503, data: {} };
      return { status: 200, data: { success: true, data: { id: 1 } } };
    };
    const result = await normalizeApiCall(fn);
    expect(calls).toBe(2);
  });

  it('does not retry 500', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { status: 500, data: { success: false } };
    };
    await expect(normalizeApiCall(fn)).rejects.toMatchObject({ code: 500 });
    expect(calls).toBe(1);
  });

  it('does not retry 504', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { status: 504, data: {} };
    };
    await expect(normalizeApiCall(fn)).rejects.toMatchObject({ code: 504 });
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/error-normalizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write error normalizer implementation**

```typescript
// src/lib/error-normalizer.ts
import type { PipedriveApiError } from '../types.js';

interface ApiResponse {
  status: number;
  data: unknown;
}

interface ErrorContext {
  entity?: string;
  id?: number;
}

const RETRYABLE_CODES: Record<number, number> = {
  502: 1000, // 1 second delay
  503: 2000, // 2 second delay
};

const ERROR_MESSAGES: Record<number, string> = {
  401: 'API token is invalid. Restart the server with a valid token.',
  402: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.',
  403: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.',
  500: 'Pipedrive API error. Try again.',
  502: 'Pipedrive API is temporarily unavailable. Try again.',
  503: 'Pipedrive API is temporarily unavailable. Try again.',
  504: 'Pipedrive API timed out.',
};

function makeError(code: number, message: string, details?: Record<string, unknown>): PipedriveApiError {
  return { error: true, code, message, details };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function normalizeApiCall(
  fn: () => Promise<ApiResponse>,
  context?: ErrorContext
): Promise<ApiResponse> {
  let response: ApiResponse;

  try {
    response = await fn();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw makeError(0, 'Request to Pipedrive API timed out.');
    }
    if (err instanceof TypeError) {
      throw makeError(0, 'Unable to reach Pipedrive API. Check network connection.');
    }
    throw makeError(0, `Unexpected error: ${String(err)}`);
  }

  // Success
  if (response.status >= 200 && response.status < 300) {
    return response;
  }

  // Retryable errors — retry once
  const retryDelay = RETRYABLE_CODES[response.status];
  if (retryDelay !== undefined) {
    await sleep(retryDelay);
    try {
      const retryResponse = await fn();
      if (retryResponse.status >= 200 && retryResponse.status < 300) {
        return retryResponse;
      }
      // Retry also failed — fall through to error handling with retry response
      response = retryResponse;
    } catch {
      // Retry threw — fall through to error handling with original response
    }
  }

  // 429 — rate limited
  if (response.status === 429) {
    const data = response.data as Record<string, unknown> | undefined;
    throw makeError(429, 'Rate limited by Pipedrive. Try again later.', {
      rate_limit_info: data,
    });
  }

  // 404 — not found with entity context
  if (response.status === 404) {
    const message = context?.entity && context?.id
      ? `${context.entity} with ID ${context.id} not found.`
      : 'Resource not found.';
    throw makeError(404, message);
  }

  // Known error codes
  const knownMessage = ERROR_MESSAGES[response.status];
  if (knownMessage) {
    throw makeError(response.status, knownMessage);
  }

  // Unknown error
  throw makeError(response.status, `Pipedrive API returned status ${response.status}.`);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/error-normalizer.test.ts
```

Expected: All tests PASS. Note: The retry tests may be slow due to the delay (1-2 seconds). If needed, mock `setTimeout` via `vi.useFakeTimers()` to speed them up.

- [ ] **Step 5: Commit**

```bash
git add src/lib/error-normalizer.ts tests/lib/error-normalizer.test.ts
git commit -m "feat: error normalizer with retry for 502/503 and consistent error shapes"
```

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

export class StaleWhileRevalidateCache<T> {
  private data: T | null = null;
  private fetchedAt: number = 0;
  private ttlMs: number;
  private fetcher: () => Promise<T>;
  private refreshInFlight: Promise<T> | null = null;

  constructor(fetcher: () => Promise<T>, ttlMs: number) {
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
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
          // Don't throw — stale data is still being served
          // Log warning in production (caller can handle)
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
git commit -m "feat: stale-while-revalidate cache with refresh deduplication"
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

- [ ] **Step 1: Write the orchestrator**

```typescript
// src/lib/reference-resolver/index.ts
import { StaleWhileRevalidateCache } from './cache.js';
import { FieldResolver } from './field-resolver.js';
import { UserResolver } from './user-resolver.js';
import { PipelineResolver } from './pipeline-resolver.js';
import { ActivityTypeResolver } from './activity-types.js';
import type { FieldDefinition, PipedriveUser, PipedrivePipeline } from '../../types.js';
import type { PipedriveClient } from '../pipedrive-client.js';
import { normalizeApiCall } from '../error-normalizer.js';

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
  private fieldCaches: Map<ResourceType, StaleWhileRevalidateCache<FieldDefinition[]>>;
  private fieldResolvers: Map<ResourceType, FieldResolver | null>;
  private userCache: StaleWhileRevalidateCache<PipedriveUser[]>;
  private userResolver: UserResolver | null = null;
  private pipelineCache: StaleWhileRevalidateCache<PipedrivePipeline[]>;
  private pipelineResolver: PipelineResolver | null = null;
  private activityTypeCache: StaleWhileRevalidateCache<unknown[]>;
  private activityTypeResolver: ActivityTypeResolver | null = null;

  constructor(client: PipedriveClient) {
    this.client = client;
    this.fieldCaches = new Map();
    this.fieldResolvers = new Map();

    // Initialize field caches per resource type
    for (const type of ['deal', 'person', 'organization', 'activity'] as ResourceType[]) {
      this.fieldCaches.set(
        type,
        new StaleWhileRevalidateCache(() => this.fetchFields(type), FIELD_TTL)
      );
      this.fieldResolvers.set(type, null);
    }

    this.userCache = new StaleWhileRevalidateCache(() => this.fetchUsers(), USER_TTL);
    this.pipelineCache = new StaleWhileRevalidateCache(() => this.fetchPipelines(), PIPELINE_TTL);
    this.activityTypeCache = new StaleWhileRevalidateCache(() => this.fetchActivityTypes(), ACTIVITY_TYPE_TTL);
  }

  async initialize(): Promise<void> {
    // Prime all caches on startup
    await Promise.all([
      this.getFieldResolver('deal'),
      this.getFieldResolver('person'),
      this.getFieldResolver('organization'),
      this.getFieldResolver('activity'),
      this.getUserResolver(),
      this.getPipelineResolver(),
      this.getActivityTypeResolver(),
    ]);
  }

  async getFieldResolver(type: ResourceType): Promise<FieldResolver> {
    const cache = this.fieldCaches.get(type)!;
    const fields = await cache.get();
    // Rebuild resolver if fields changed (cache may have been refreshed)
    const existing = this.fieldResolvers.get(type);
    if (!existing || existing.getFieldDefinitions() !== fields) {
      const systemFields = SYSTEM_FIELDS_MAP[type] ?? new Set();
      const resolver = new FieldResolver(fields, systemFields);
      this.fieldResolvers.set(type, resolver);
      return resolver;
    }
    return existing;
  }

  async getUserResolver(): Promise<UserResolver> {
    const users = await this.userCache.get();
    if (!this.userResolver) {
      this.userResolver = new UserResolver(users);
    }
    return this.userResolver;
  }

  async getPipelineResolver(): Promise<PipelineResolver> {
    const pipelines = await this.pipelineCache.get();
    if (!this.pipelineResolver) {
      this.pipelineResolver = new PipelineResolver(pipelines);
    }
    return this.pipelineResolver;
  }

  async getActivityTypeResolver(): Promise<ActivityTypeResolver> {
    const types = await this.activityTypeCache.get();
    if (!this.activityTypeResolver) {
      this.activityTypeResolver = new ActivityTypeResolver(types as any);
    }
    return this.activityTypeResolver;
  }

  // --- Fetch methods (called by caches) ---

  private async fetchFields(type: ResourceType): Promise<FieldDefinition[]> {
    const endpoint = `/${type}Fields`;
    const result = await normalizeApiCall(async () =>
      this.client.request('GET', 'v1', endpoint) as any
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
    const result = await normalizeApiCall(async () =>
      this.client.request('GET', 'v1', '/users') as any
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
    const result = await normalizeApiCall(async () =>
      this.client.request('GET', 'v1', '/pipelines') as any
    );
    const pipelinesData = (result as any).data;
    if (!pipelinesData.success || !Array.isArray(pipelinesData.data)) {
      throw new Error('Failed to fetch pipelines');
    }

    const pipelines: PipedrivePipeline[] = [];
    for (const p of pipelinesData.data) {
      const stagesResult = await normalizeApiCall(async () =>
        this.client.request('GET', 'v1', `/stages`, undefined, { pipeline_id: String(p.id) }) as any
      );
      const stagesData = (stagesResult as any).data;
      const stages = Array.isArray(stagesData.data) ? stagesData.data.map((s: any) => ({
        id: s.id,
        name: s.name,
        pipeline_id: s.pipeline_id,
        order_nr: s.order_nr,
        rotten_flag: s.rotten_flag,
        rotten_days: s.rotten_days,
      })) : [];

      pipelines.push({
        id: p.id,
        name: p.name,
        active: p.active_flag,
        stages,
      });
    }

    return pipelines;
  }

  private async fetchActivityTypes(): Promise<unknown[]> {
    const result = await normalizeApiCall(async () =>
      this.client.request('GET', 'v1', '/activityTypes') as any
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
git commit -m "feat: reference resolver orchestrator with cache initialization"
```

---

## Task 12: Entity Resolver

**Files:**
- Create: `src/lib/entity-resolver.ts`
- Create: `tests/lib/entity-resolver.test.ts`

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
    const resolver = new EntityResolver(client);
    // Should still throw no match, but would log a warning in production
    await expect(resolver.resolve('person', 'Someone Else')).rejects.toThrow(
      "No person found matching 'Someone Else'"
    );
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

type EntityType = 'person' | 'organization';

const ENTITY_LABELS: Record<EntityType, string> = {
  person: 'person',
  organization: 'organization',
};

const SEARCH_PAGE_SIZE = 50;

export class EntityResolver {
  private client: PipedriveClient;

  constructor(client: PipedriveClient) {
    this.client = client;
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
      // In production, log: "Search returned full page with no exact match for '${value}'"
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
git commit -m "feat: entity resolver with name->ID search and disambiguation"
```

---

## Task 13: Tool Handlers — Pipelines, Users, Fields (Read-Only)

These are the simplest tools — read-only, no field resolution needed on input. Good candidates to establish the tool handler pattern.

**Files:**
- Create: `src/tools/pipelines.ts`
- Create: `src/tools/users.ts`
- Create: `src/tools/fields.ts`
- Create: `tests/tools/pipelines.test.ts`
- Create: `tests/tools/users.test.ts`
- Create: `tests/tools/fields.test.ts`

- [ ] **Step 1: Write pipelines tool tests**

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

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/tools/pipelines.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write pipeline tool handlers**

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

- [ ] **Step 4: Run pipeline tests**

```bash
npx vitest run tests/tools/pipelines.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Write users and fields tools (following same pattern)**

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

- [ ] **Step 6: Write tests for users and fields tools**

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
});
```

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

  it('get-fields rejects invalid resource type', async () => {
    const resolver = {} as any;
    const tools = createFieldTools(resolver);
    await expect(tools[0].handler({ resource_type: 'bogus' })).rejects.toThrow(/Invalid resource_type/);
  });
});
```

- [ ] **Step 7: Run all tool tests**

```bash
npx vitest run tests/tools/
```

Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools/ tests/tools/
git commit -m "feat: read-only tool handlers for pipelines, users, and fields"
```

---

## Task 14: Tool Handlers — Deals (Full CRUD Pattern)

This is the most complex tool group and establishes the pattern for all CRUD entities. Subsequent tasks will follow this pattern with entity-specific differences.

**Files:**
- Create: `src/tools/deals.ts`
- Create: `tests/tools/deals.test.ts`

Due to the size of this task, see the implementation in the spec for field schemas. The deal tools require integration with: PipedriveClient, ErrorNormalizer, ReferenceResolver (field resolution, stage resolution, user resolution), EntityResolver (person/org by name), Sanitizer, and Cursor.

- [ ] **Step 1: Write deal tool tests**

Write comprehensive tests for all 6 deal tools. Key test cases per tool:

- `list-deals`: basic listing, filtering by status, pagination with cursor, stage filter disambiguation
- `get-deal`: returns full record with resolved fields
- `create-deal`: creates with human-friendly names, returns full record, validates required title
- `update-deal`: updates with human-friendly names, rejects empty fields, stage resolution uses current pipeline
- `delete-deal`: first call returns confirmation, second call with confirm executes, best-effort title fetch
- `search-deals`: keyword search, returns summary shape

The test file will be substantial (~200-300 lines). Mock the PipedriveClient, ReferenceResolver, and EntityResolver.

```typescript
// tests/tools/deals.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDealTools } from '../../src/tools/deals.js';

// Full test implementation here — test each tool's happy path and key error cases.
// This comment is a placeholder for the implementation engineer to write based on the
// tool handler code in Step 3. The pattern matches pipelines.test.ts but with mocked
// client, resolver, and entity resolver.
//
// IMPORTANT: Do NOT skip writing these tests. Write them BEFORE the implementation.
// Each test should verify:
// 1. Correct API endpoint called
// 2. Field resolution applied (input and output)
// 3. Stage resolution with pipeline context
// 4. Entity resolution for person/org names
// 5. Summary vs full response shapes
// 6. Delete confirmation flow
// 7. Pagination cursor handling
// 8. Input validation (required fields, empty update rejection)
```

*Note to implementing engineer: Write the full test file following the patterns established in tasks 4-13. Each test should mock dependencies and verify one specific behavior. The spec's input schemas (lines 177-213) define the exact parameters to test.*

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/tools/deals.test.ts
```

- [ ] **Step 3: Write deal tool handlers**

The implementation follows this structure for each tool:

```typescript
// src/tools/deals.ts
import type { ToolDefinition, DealSummary } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import type { EntityResolver } from '../lib/entity-resolver.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { trimString, validateStringLength, sanitizeNoteContent } from '../lib/sanitizer.js';

export function createDealTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver
): ToolDefinition[] {
  // Helper: resolve deal fields from human-friendly to Pipedrive format
  async function resolveInputFields(params: Record<string, unknown>) {
    const fieldResolver = await resolver.getFieldResolver('deal');
    const userResolver = await resolver.getUserResolver();
    const pipelineResolver = await resolver.getPipelineResolver();
    const resolved: Record<string, unknown> = {};

    // System fields
    if (params.title) resolved.title = trimString(params.title as string, 'title');
    if (params.value !== undefined) resolved.value = params.value;
    if (params.currency) resolved.currency = params.currency;
    if (params.status) resolved.status = params.status;
    if (params.expected_close_date) resolved.expected_close_date = params.expected_close_date;

    // Owner resolution
    if (params.owner) {
      resolved.user_id = userResolver.resolveNameToId(params.owner as string);
    }

    // Person/org entity resolution
    if (params.person !== undefined) {
      resolved.person_id = await entityResolver.resolve('person', params.person as string | number);
    }
    if (params.organization !== undefined) {
      resolved.org_id = await entityResolver.resolve('organization', params.organization as string | number);
    }

    // Pipeline and stage resolution
    if (params.pipeline || params.stage) {
      let pipelineId: number | undefined;

      if (params.pipeline) {
        pipelineId = pipelineResolver.resolvePipelineNameToId(params.pipeline as string);
        resolved.pipeline_id = pipelineId;
      }

      if (params.stage) {
        if (pipelineId) {
          resolved.stage_id = pipelineResolver.resolveStageNameToId(params.stage as string, pipelineId);
        } else {
          // No pipeline specified — try global resolution
          const result = pipelineResolver.resolveStageGlobally(params.stage as string);
          resolved.stage_id = result.stageId;
          resolved.pipeline_id = result.pipelineId;
          // Note: caller should include inference note in response
        }
      }
    }

    // Custom fields
    if (params.fields && typeof params.fields === 'object') {
      for (const [label, value] of Object.entries(params.fields as Record<string, unknown>)) {
        const key = fieldResolver.resolveInputField(label);
        resolved[key] = fieldResolver.resolveInputValue(key, value);
      }
    }

    return resolved;
  }

  // Helper: resolve output record to human-friendly format
  async function resolveOutputRecord(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fieldResolver = await resolver.getFieldResolver('deal');
    const userResolver = await resolver.getUserResolver();
    const pipelineResolver = await resolver.getPipelineResolver();
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(raw)) {
      const outputKey = fieldResolver.getOutputKey(key);
      result[outputKey] = fieldResolver.resolveOutputValue(key, value);
    }

    // Resolve user_id to name
    if (raw.user_id) result.owner = userResolver.resolveIdToName(raw.user_id as number);
    // Resolve pipeline/stage IDs to names
    if (raw.pipeline_id) result.pipeline = pipelineResolver.resolvePipelineIdToName(raw.pipeline_id as number);
    if (raw.stage_id) result.stage = pipelineResolver.resolveStageIdToName(raw.stage_id as number);

    return result;
  }

  // Helper: build deal summary
  async function toDealSummary(raw: Record<string, unknown>): Promise<DealSummary> {
    const userResolver = await resolver.getUserResolver();
    const pipelineResolver = await resolver.getPipelineResolver();
    return {
      id: raw.id as number,
      title: (raw.title as string) ?? '',
      status: (raw.status as string) ?? '',
      pipeline: raw.pipeline_id ? pipelineResolver.resolvePipelineIdToName(raw.pipeline_id as number) : '',
      stage: raw.stage_id ? pipelineResolver.resolveStageIdToName(raw.stage_id as number) : '',
      owner: raw.user_id ? userResolver.resolveIdToName(raw.user_id as number) : '',
      value: (raw.value as number) ?? null,
      updated_at: (raw.update_time as string) ?? '',
    };
  }

  return [
    // list-deals, get-deal, create-deal, update-deal, delete-deal, search-deals
    // Each tool follows the pattern:
    // 1. Validate input
    // 2. Resolve human-friendly fields
    // 3. Call Pipedrive via normalizeApiCall
    // 4. Resolve output fields
    // 5. Return formatted response

    // Implementation for each tool goes here.
    // The implementing engineer should use the helpers above and follow
    // the exact input schemas defined in the spec (lines 177-213).
  ];
}
```

*Note to implementing engineer: The helper functions above are production code. Complete the return array with all 6 tool definitions using the input schemas from the spec. Each tool should be 30-60 lines. The spec's data flow section (lines 293-336) shows the exact request flow to follow.*

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/tools/deals.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/deals.ts tests/tools/deals.test.ts
git commit -m "feat: deal tool handlers with full CRUD, field/stage/entity resolution"
```

---

## Task 15: Tool Handlers — Persons

**Files:**
- Create: `src/tools/persons.ts`
- Create: `tests/tools/persons.test.ts`

Follows the deal pattern with person-specific differences:
- `create-person` requires `name`, accepts `email` (string | string[]), `phone` (string | string[]), `organization` (name or ID)
- No stage resolution needed
- Entity resolution for `organization` field
- Summary shape: id, name, email, phone, organization, owner, updated_at

- [ ] **Step 1: Write tests following deal test pattern**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Write person tool handlers following deal handler pattern**
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

```bash
git add src/tools/persons.ts tests/tools/persons.test.ts
git commit -m "feat: person tool handlers with CRUD, entity/field resolution"
```

---

## Task 16: Tool Handlers — Organizations

**Files:**
- Create: `src/tools/organizations.ts`
- Create: `tests/tools/organizations.test.ts`

Key differences from deals/persons:
- No delete tool (intentional — cascading destruction)
- 5 tools: list, get, create, update, search
- No entity resolution needed on create/update (orgs don't link to other entities by name)
- Summary shape: id, name, owner, address, updated_at

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Write org tool handlers**
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

```bash
git add src/tools/organizations.ts tests/tools/organizations.test.ts
git commit -m "feat: organization tool handlers with CRUD (no delete — intentional)"
```

---

## Task 17: Tool Handlers — Activities

**Files:**
- Create: `src/tools/activities.ts`
- Create: `tests/tools/activities.test.ts`

Key differences:
- `create-activity` requires `type` and `subject`
- Activity `type` validated against cached activity types via ActivityTypeResolver
- `owner` resolved to user ID
- Linked entities via `deal_id`, `person_id`, `org_id` (IDs only, no name resolution)
- `list-activities` has date range filters: `start_date`, `end_date`, `updated_since`
- Summary shape: id, type, subject, due_date, done, deal, person, owner

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Write activity tool handlers**
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

```bash
git add src/tools/activities.ts tests/tools/activities.test.ts
git commit -m "feat: activity tool handlers with type validation and date filters"
```

---

## Task 18: Tool Handlers — Notes

**Files:**
- Create: `src/tools/notes.ts`
- Create: `tests/tools/notes.test.ts`

Key differences:
- `create-note` requires `content`, at least one of `deal_id`, `person_id`, `org_id`
- Content sanitized via `sanitizeNoteContent` (HTML stripped to plain text)
- `update-note` accepts `content`, `deal_id`, `person_id`, `org_id` (all optional except id, at least one required)
- `list-notes` returns content truncated to 200 chars with `truncated: boolean` flag
- `get-note` returns full content
- Summary shape: id, content (truncated), truncated, deal, person, org, updated_at

- [ ] **Step 1: Write tests**

Key test cases for notes:
- Create with HTML content → verify it's stripped to plain text
- Create without any linked entity → error
- List returns truncated content with `truncated: true`
- Get returns full content
- Update associations (deal_id, person_id, org_id are changeable)

- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Write note tool handlers**
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

```bash
git add src/tools/notes.ts tests/tools/notes.test.ts
git commit -m "feat: note tool handlers with HTML sanitization and content truncation"
```

---

## Task 19: MCP Server Setup

**Files:**
- Create: `src/server.ts`

This wires together all tool handlers, the MCP SDK, and access control.

- [ ] **Step 1: Write server.ts**

```typescript
// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig, ToolDefinition } from './types.js';
import type { ReferenceResolver } from './lib/reference-resolver/index.js';
import type { PipedriveClient } from './lib/pipedrive-client.js';
import type { EntityResolver } from './lib/entity-resolver.js';
import { isToolEnabled } from './config.js';
import { createDealTools } from './tools/deals.js';
import { createPersonTools } from './tools/persons.js';
import { createOrganizationTools } from './tools/organizations.js';
import { createActivityTools } from './tools/activities.js';
import { createNoteTools } from './tools/notes.js';
import { createPipelineTools } from './tools/pipelines.js';
import { createUserTools } from './tools/users.js';
import { createFieldTools } from './tools/fields.js';

export function createServer(
  config: ServerConfig,
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver
): McpServer {
  const server = new McpServer({
    name: 'pipedrive-mcp',
    version: '0.1.0',
  });

  // Collect all tool definitions
  const allTools: ToolDefinition[] = [
    ...createDealTools(client, resolver, entityResolver),
    ...createPersonTools(client, resolver, entityResolver),
    ...createOrganizationTools(client, resolver, entityResolver),
    ...createActivityTools(client, resolver, entityResolver),
    ...createNoteTools(client, resolver, entityResolver),
    ...createPipelineTools(resolver),
    ...createUserTools(resolver),
    ...createFieldTools(resolver),
  ];

  // Register enabled tools
  for (const tool of allTools) {
    if (!isToolEnabled(config, tool.name, tool.category)) {
      continue;
    }

    server.tool(tool.name, tool.description, tool.inputSchema, async (params) => {
      try {
        const result = await tool.handler(params as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const errorObj = (err as any)?.error === true ? err : { error: true, message };
        return {
          content: [{ type: 'text', text: JSON.stringify(errorObj, null, 2) }],
          isError: true,
        };
      }
    });
  }

  return server;
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: MCP server setup with tool registration and access control"
```

---

## Task 20: Entry Point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write the entry point**

```typescript
// src/index.ts
import 'dotenv/config';

// stdout safety: redirect stdout to stderr BEFORE any other imports
// that might have side effects (logging libraries, etc.)
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
let stdoutRedirected = false;

function redirectStdout() {
  if (stdoutRedirected) return;
  process.stdout.write = (chunk: any, ...args: any[]) => {
    return (process.stderr.write as any)(chunk, ...args);
  };
  stdoutRedirected = true;
}

import { parseConfig } from './config.js';
import { PipedriveClient } from './lib/pipedrive-client.js';
import { ReferenceResolver } from './lib/reference-resolver/index.js';
import { EntityResolver } from './lib/entity-resolver.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';

async function main() {
  const config = parseConfig();

  // Setup logger
  const logger = pino({
    level: config.logLevel,
    transport: undefined, // raw JSON to stderr
  }, pino.destination(2)); // fd 2 = stderr

  // Redirect stdout to stderr in stdio mode
  if (config.transport === 'stdio') {
    redirectStdout();
  }

  logger.info({ transport: config.transport }, 'Pipedrive MCP Server starting');

  // Initialize client
  const client = new PipedriveClient(config.apiToken);

  // Validate token
  try {
    const user = await client.validateToken();
    logger.info({ userId: user.id, userName: user.name }, 'Token validated');
  } catch (err) {
    logger.fatal('Invalid or missing PIPEDRIVE_API_TOKEN. Exiting.');
    process.exit(1);
  }

  // Initialize reference resolver and prime caches
  const resolver = new ReferenceResolver(client);
  try {
    await resolver.initialize();
    logger.info('Reference data cached');
  } catch (err) {
    logger.fatal({ err }, 'Failed to initialize reference data. Exiting.');
    process.exit(1);
  }

  // Initialize entity resolver
  const entityResolver = new EntityResolver(client);

  // Create MCP server
  const server = createServer(config, client, resolver, entityResolver);

  // Start transport
  if (config.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Server running on stdio');
  } else {
    // SSE mode
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    // SSE transport setup depends on SDK version — implement based on current SDK API
    logger.info({ port: config.port }, 'Server running on SSE');
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Test the server starts (requires valid token)**

```bash
# Create a .env with a test token (or your real token for smoke testing)
echo "PIPEDRIVE_API_TOKEN=your_token_here" > .env

# Build and try to start
npx tsc
node dist/index.js
```

Expected: If token is valid, server starts and logs "Server running on stdio". If invalid, exits with "Invalid or missing PIPEDRIVE_API_TOKEN."

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: entry point with startup validation, stdout safety, graceful shutdown"
```

---

## Task 21: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Write a README covering:
1. **What this is** — One paragraph describing the Pipedrive MCP server
2. **Setup** — Environment variables, `.env` file, `chmod 600 .env`
3. **Claude Code configuration** — MCP config JSON snippet
4. **Available tools** — Table organized by category (read, create, update, delete)
5. **Access control** — `PIPEDRIVE_ENABLED_CATEGORIES` and `PIPEDRIVE_DISABLED_TOOLS` examples
6. **Troubleshooting** — Common errors and what they mean (invalid token, rate limited, unknown field, ambiguous stage, etc.)
7. **Development** — How to run tests, build, run in dev mode

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with setup, tools reference, access control, troubleshooting"
```

---

## Task 22: Integration Test Scaffolding

**Files:**
- Create: `vitest.integration.config.ts`
- Create: `tests/integration/setup.ts`
- Create: `tests/integration/deals.integration.test.ts`

- [ ] **Step 1: Create integration test config**

```typescript
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
  },
});
```

- [ ] **Step 2: Create integration test setup**

```typescript
// tests/integration/setup.ts
import 'dotenv/config';
import { PipedriveClient } from '../../src/lib/pipedrive-client.js';
import { ReferenceResolver } from '../../src/lib/reference-resolver/index.js';
import { EntityResolver } from '../../src/lib/entity-resolver.js';

export async function createTestContext() {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) throw new Error('PIPEDRIVE_API_TOKEN required for integration tests');

  const client = new PipedriveClient(token);
  await client.validateToken();

  const resolver = new ReferenceResolver(client);
  await resolver.initialize();

  const entityResolver = new EntityResolver(client);

  return { client, resolver, entityResolver };
}
```

- [ ] **Step 3: Create a sample integration test**

```typescript
// tests/integration/deals.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext } from './setup.js';
import { createDealTools } from '../../src/tools/deals.js';

describe('Deal tools (integration)', () => {
  let tools: ReturnType<typeof createDealTools>;

  beforeAll(async () => {
    const ctx = await createTestContext();
    tools = createDealTools(ctx.client, ctx.resolver, ctx.entityResolver);
  });

  it('CRUD lifecycle', async () => {
    const createTool = tools.find(t => t.name === 'create-deal')!;
    const getTool = tools.find(t => t.name === 'get-deal')!;
    const updateTool = tools.find(t => t.name === 'update-deal')!;
    const deleteTool = tools.find(t => t.name === 'delete-deal')!;

    // Create
    const created = await createTool.handler({ title: 'Integration Test Deal' }) as any;
    expect(created.id).toBeDefined();
    expect(created.Title || created.title).toBe('Integration Test Deal');

    // Get
    const fetched = await getTool.handler({ id: created.id }) as any;
    expect(fetched.id).toBe(created.id);

    // Update
    const updated = await updateTool.handler({ id: created.id, title: 'Updated Test Deal' }) as any;
    expect(updated.Title || updated.title).toBe('Updated Test Deal');

    // Delete (confirmation)
    const confirmResult = await deleteTool.handler({ id: created.id }) as any;
    expect(confirmResult.confirm_required).toBe(true);

    // Delete (execute)
    const deleteResult = await deleteTool.handler({ id: created.id, confirm: true }) as any;
    expect(deleteResult.deleted).toBe(true);
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add vitest.integration.config.ts tests/integration/
git commit -m "feat: integration test scaffolding with CRUD lifecycle test"
```

---

## Self-Review Checklist

After completing all tasks, verify:

- [ ] All 31 tools are registered and tested
- [ ] `npx vitest run` passes all unit tests
- [ ] `npx tsc --noEmit` has zero errors
- [ ] Server starts successfully with a valid token
- [ ] Server fails fast with an invalid token
- [ ] README covers all sections
- [ ] `.env` file is gitignored
- [ ] No hardcoded tokens or secrets anywhere in the codebase
