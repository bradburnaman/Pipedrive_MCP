# Part 1: Project Setup

> Part 1 of 13 — Project scaffolding, shared type definitions, and config module
> **Depends on:** Nothing
> **Produces:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `vitest.config.ts`, `src/types.ts`, `src/config.ts`, `tests/config.test.ts`

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
import { parseConfig, isToolEnabled } from '../src/config.js';

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

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/config.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config module with env var parsing and access control"
```
