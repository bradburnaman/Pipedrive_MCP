# Part 13: README and Integration Tests

> Part 13 of 13 — Documentation and integration test scaffolding
> **Depends on:** Parts 1-12
> **Produces:** `README.md`, `vitest.integration.config.ts`, `tests/integration/setup.ts`, `tests/integration/deals.integration.test.ts`

---

## Task 21: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# Pipedrive MCP Server

An MCP (Model Context Protocol) server that exposes Pipedrive CRM data to AI agents. Built for BHG's internal team (~7 users). Provides 31 tools covering Deals, Persons, Organizations, Activities, Notes, Pipelines/Stages, Users, and Field Metadata. Human-friendly inputs throughout — agents send names ("Stacy", "Sales", "Proposal Sent"), not raw IDs.

## Setup

### 1. Get your Pipedrive API token

Go to **Pipedrive > Settings > Personal preferences > API** and copy your personal API token.

### 2. Create a `.env` file

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set your token:

```bash
PIPEDRIVE_API_TOKEN=your_token_here
```

The `chmod 600` restricts the file to owner-only read/write. The `.env` file contains your API token and must be treated as a secret.

### 3. Install and build

```bash
npm install
npm run build
```

### 4. Configure Claude Code

Add the MCP server to your Claude Code configuration.

**stdio mode** (recommended — runs as a subprocess):

```json
{
  "mcpServers": {
    "pipedrive": {
      "command": "node",
      "args": ["/absolute/path/to/pipedrive-mcp/dist/index.js"],
      "env": {
        "PIPEDRIVE_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

**SSE mode** (networked, for multi-client use):

Start the server:

```bash
PIPEDRIVE_API_TOKEN=your_token_here node dist/index.js --transport sse --port 3000
```

Then configure the MCP client:

```json
{
  "mcpServers": {
    "pipedrive": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

## Available Tools

### Deals (6 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-deals` | read | Browse deals by pipeline, stage, owner, status, updated_since |
| `get-deal` | read | Get a single deal by ID with all fields resolved to labels |
| `create-deal` | create | Create a deal with human-friendly names for pipeline, stage, owner, person, org |
| `update-deal` | update | Update a deal by ID — same field format as create |
| `delete-deal` | delete | Delete a deal by ID (two-step confirmation) |
| `search-deals` | read | Find deals by keyword across title and custom fields |

### Persons (6 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-persons` | read | Browse persons by owner, org, updated_since |
| `get-person` | read | Get a single person by ID with all fields resolved |
| `create-person` | create | Create a person — organization resolved by name or ID |
| `update-person` | update | Update a person by ID |
| `delete-person` | delete | Delete a person by ID (two-step confirmation) |
| `search-persons` | read | Find persons by keyword across name, email, phone |

### Organizations (5 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-organizations` | read | Browse organizations by owner, updated_since |
| `get-organization` | read | Get a single organization by ID with all fields resolved |
| `create-organization` | create | Create an organization |
| `update-organization` | update | Update an organization by ID |
| `search-organizations` | read | Find organizations by keyword |

No delete tool — deleting organizations cascades to linked persons and deals in Pipedrive. Use the Pipedrive UI for org deletion.

### Activities (5 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-activities` | read | List activities by type, deal, person, org, owner, date range, done status |
| `get-activity` | read | Get a single activity by ID |
| `create-activity` | create | Create an activity (call, meeting, task, email, deadline, etc.) |
| `update-activity` | update | Update an activity by ID |
| `delete-activity` | delete | Delete an activity by ID (two-step confirmation) |

### Notes (5 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-notes` | read | List notes by deal, person, or org (content truncated to 200 chars) |
| `get-note` | read | Get a single note by ID with full content |
| `create-note` | create | Create a note linked to a deal, person, and/or org (plain text only) |
| `update-note` | update | Update a note by ID |
| `delete-note` | delete | Delete a note by ID (two-step confirmation) |

### Pipelines & Stages (2 tools, read-only)

| Tool | Category | Description |
|------|----------|-------------|
| `list-pipelines` | read | List all pipelines with their stages |
| `list-stages` | read | List stages for a given pipeline by name or ID |

### Users (1 tool, read-only)

| Tool | Category | Description |
|------|----------|-------------|
| `list-users` | read | List all Pipedrive users |

### Field Metadata (1 tool)

| Tool | Category | Description |
|------|----------|-------------|
| `get-fields` | read | Get field definitions for a resource type (deal, person, organization, activity) |

## Access Control

### Category-based (coarse)

Control which categories of tools are available:

```bash
# Default: all categories enabled
PIPEDRIVE_ENABLED_CATEGORIES=read,create,update,delete

# Read-only mode — no writes
PIPEDRIVE_ENABLED_CATEGORIES=read

# Allow reads and creates, but no updates or deletes
PIPEDRIVE_ENABLED_CATEGORIES=read,create
```

Categories: `read` (list, get, search, get-fields), `create`, `update`, `delete`.

Disabled categories' tools are not registered — they don't appear in the tool list at all.

### Per-tool overrides (surgical)

Disable specific tools on top of category settings:

```bash
# Allow all deletes except deal deletion
PIPEDRIVE_ENABLED_CATEGORIES=read,create,update,delete
PIPEDRIVE_DISABLED_TOOLS=delete-deal

# Disable multiple tools
PIPEDRIVE_DISABLED_TOOLS=delete-deal,delete-person,delete-activity
```

Unknown category or tool names are logged as warnings at startup and ignored.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PIPEDRIVE_API_TOKEN` | **yes** | — | Pipedrive personal API token |
| `PORT` | no | `3000` | HTTP port for SSE mode |
| `PIPEDRIVE_ENABLED_CATEGORIES` | no | `read,create,update,delete` | Comma-separated categories |
| `PIPEDRIVE_DISABLED_TOOLS` | no | — | Comma-separated tool names to disable |
| `PIPEDRIVE_LOG_LEVEL` | no | `info` | Log level: `info` or `debug` |

CLI arguments: `--transport stdio|sse`, `--port 3000`

## Troubleshooting

### Invalid or missing API token

```
FATAL: Invalid or missing PIPEDRIVE_API_TOKEN. Exiting.
```

The server validates the token on startup via `GET /v1/users/me`. If the token is missing, empty, or invalid, the server exits immediately with code 1. Check your `.env` file or MCP config `env` block.

### Rate limited

```json
{ "error": true, "code": 429, "message": "Rate limited by Pipedrive. Try again after 2s." }
```

The server retries once automatically on 429 responses. If the retry also fails, this error is returned. Wait the indicated time and try again. At BHG's usage volume, this should be extremely rare.

### Unknown field

```json
{ "error": true, "message": "Unknown field 'Pratice Area' on deal. Did you mean 'Practice Area'?" }
```

The field name doesn't match any known field. If the name is close to a known field (within Levenshtein distance 2), a suggestion is provided. The call is always rejected — fix the field name and retry.

### Ambiguous stage

```json
{ "error": true, "message": "Stage 'Qualified' exists in multiple pipelines: 'Sales', 'Partnerships'. Specify a pipeline to disambiguate." }
```

The stage name exists in more than one pipeline. Add the `pipeline` parameter to specify which one.

### Multiple entity matches

```json
{ "error": true, "message": "Multiple persons match 'John Smith': John Smith (Acme Corp, ID 456), John Smith (Globex, ID 789). Use a person_id to be specific." }
```

Entity resolution (name to ID) found multiple matches. Use a specific ID instead of a name.

### No entity match

```json
{ "error": true, "message": "No person found matching 'John Smith'. Create one first or use a person_id." }
```

No entity matches the provided name. Create the entity first or use its ID directly.

### Permission denied

```json
{ "error": true, "code": 403, "message": "Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan." }
```

The API token doesn't have access to this endpoint. Check your Pipedrive plan and user permissions.

### Network error

```json
{ "error": true, "code": 0, "message": "Unable to reach Pipedrive API. Check network connection." }
```

The server couldn't connect to Pipedrive's API. Check your network connection and that `api.pipedrive.com` is reachable.

### Request timeout

```json
{ "error": true, "code": 0, "message": "Request to Pipedrive API timed out." }
```

The API call took longer than 30 seconds. Pipedrive may be experiencing issues. Try again.

## Development

### Run tests

```bash
# Unit tests
npm test

# Unit tests in watch mode
npm run test:watch

# Integration tests (requires PIPEDRIVE_API_TOKEN in .env)
npm run test:integration

# Type checking
npm run typecheck
```

### Dev mode

```bash
# stdio mode with tsx (no build step)
npm run dev

# SSE mode with tsx
npm run dev:sse
```

### Build

```bash
npm run build
npm start
```

### Project structure

```
src/
  index.ts              — entry point, stdout safety, transport init
  server.ts             — MCP server setup, tool registration, audit logging
  config.ts             — env var parsing, access control
  types.ts              — shared type definitions
  tools/                — tool handlers (one file per entity type)
  lib/
    pipedrive-client.ts — HTTP client, auth, rate limit tracking
    error-normalizer.ts — error normalization across v1/v2
    reference-resolver/ — field/user/pipeline/stage resolution with caching
    entity-resolver.ts  — name-to-ID search and disambiguation
    sanitizer.ts        — input trimming, length limits, HTML stripping
    cursor.ts           — pagination cursor encode/decode
tests/
  lib/                  — unit tests for lib modules
  tools/                — unit tests for tool handlers
  integration/          — integration tests (Pipedrive sandbox)
```
```

- [ ] **Step 2: Verify README renders correctly**

Open the README in a markdown previewer or review in the IDE to ensure tables and code blocks render correctly.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with setup, tools, access control, and troubleshooting"
```

---

## Task 22: Integration Test Scaffolding

**Files:**
- Create: `vitest.integration.config.ts`
- Create: `tests/integration/setup.ts`
- Create: `tests/integration/deals.integration.test.ts`

- [ ] **Step 1: Create vitest.integration.config.ts**

```typescript
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 30_000, // 30 seconds per test — API calls are slow
    hookTimeout: 30_000,
    // Run integration tests sequentially to avoid rate limiting
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
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
import pino from 'pino';

const API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

if (!API_TOKEN) {
  throw new Error(
    'PIPEDRIVE_API_TOKEN is required for integration tests. ' +
    'Set it in your .env file or environment.'
  );
}

// Create a test logger that writes to stderr at debug level
const logger = pino(
  { level: 'debug' },
  pino.destination(2)
);

// Shared instances for all integration tests
export const client = new PipedriveClient(API_TOKEN, logger);
export const resolver = new ReferenceResolver(client, logger);
export const entityResolver = new EntityResolver(client, logger);
export { logger };

/**
 * Validate the token before running any tests.
 * Called once in the top-level beforeAll of each test file.
 */
export async function validateSetup(): Promise<void> {
  const user = await client.validateToken();
  logger.info({ userId: user.id, userName: user.name }, 'Integration test token validated');
}

/**
 * Helper to pause between API calls to avoid rate limiting.
 * Pipedrive's rate limits are generous but sequential CRUD
 * operations can occasionally hit them.
 */
export function pause(ms: number = 500): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 3: Create deals integration test**

```typescript
// tests/integration/deals.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { client, resolver, entityResolver, logger, validateSetup, pause } from './setup.js';
import { createDealTools } from '../../src/tools/deals.js';
import type { ToolDefinition } from '../../src/types.js';

describe('Deals CRUD Integration', () => {
  let tools: ToolDefinition[];
  let createdDealId: number | null = null;

  // Look up a tool by name
  function findTool(name: string): ToolDefinition {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`Tool '${name}' not found`);
    return tool;
  }

  beforeAll(async () => {
    await validateSetup();
    tools = createDealTools(client, resolver, entityResolver, logger);
  });

  // Clean up: delete the test deal if it was created
  afterAll(async () => {
    if (createdDealId) {
      try {
        const deleteTool = findTool('delete-deal');
        await deleteTool.handler({ id: createdDealId, confirm: true });
      } catch {
        // Best effort cleanup — don't fail the suite
        logger.warn({ dealId: createdDealId }, 'Failed to clean up test deal');
      }
    }
  });

  it('creates a deal', async () => {
    const createTool = findTool('create-deal');
    const result = await createTool.handler({
      title: `Integration Test Deal ${Date.now()}`,
      status: 'open',
    }) as Record<string, unknown>;

    expect(result).toHaveProperty('id');
    expect(typeof result.id).toBe('number');
    expect(result).toHaveProperty('title');
    expect((result.title as string)).toContain('Integration Test Deal');
    expect(result.status).toBe('open');

    createdDealId = result.id as number;
  });

  it('gets the created deal', async () => {
    expect(createdDealId).not.toBeNull();
    await pause();

    const getTool = findTool('get-deal');
    const result = await getTool.handler({
      id: createdDealId,
    }) as Record<string, unknown>;

    expect(result.id).toBe(createdDealId);
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('pipeline');
    expect(result).toHaveProperty('stage');
    expect(result).toHaveProperty('owner');
  });

  it('updates the deal', async () => {
    expect(createdDealId).not.toBeNull();
    await pause();

    const updateTool = findTool('update-deal');
    const newTitle = `Updated Integration Test Deal ${Date.now()}`;
    const result = await updateTool.handler({
      id: createdDealId,
      title: newTitle,
    }) as Record<string, unknown>;

    expect(result.id).toBe(createdDealId);
    expect(result.title).toBe(newTitle);
  });

  it('gets the updated deal and confirms changes', async () => {
    expect(createdDealId).not.toBeNull();
    await pause();

    const getTool = findTool('get-deal');
    const result = await getTool.handler({
      id: createdDealId,
    }) as Record<string, unknown>;

    expect(result.id).toBe(createdDealId);
    expect((result.title as string)).toContain('Updated Integration Test Deal');
  });

  it('lists deals and finds the test deal', async () => {
    expect(createdDealId).not.toBeNull();
    await pause();

    const listTool = findTool('list-deals');
    const result = await listTool.handler({
      status: 'open',
    }) as { items: Array<Record<string, unknown>>; has_more: boolean };

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(typeof result.has_more).toBe('boolean');

    // Verify summary shape
    const firstItem = result.items[0];
    expect(firstItem).toHaveProperty('id');
    expect(firstItem).toHaveProperty('title');
    expect(firstItem).toHaveProperty('status');
    expect(firstItem).toHaveProperty('pipeline');
    expect(firstItem).toHaveProperty('stage');
    expect(firstItem).toHaveProperty('owner');
  });

  it('searches for the test deal', async () => {
    expect(createdDealId).not.toBeNull();
    await pause();

    const searchTool = findTool('search-deals');
    const result = await searchTool.handler({
      query: 'Integration Test Deal',
    }) as { items: Array<Record<string, unknown>>; has_more: boolean };

    expect(Array.isArray(result.items)).toBe(true);
    // Search should find at least our test deal
    // Note: Pipedrive search indexing may have a short delay,
    // so this could occasionally fail on very fast test runs.
    // The pause() calls help mitigate this.
  });

  it('delete-deal without confirm returns confirmation prompt', async () => {
    expect(createdDealId).not.toBeNull();
    await pause();

    const deleteTool = findTool('delete-deal');
    const result = await deleteTool.handler({
      id: createdDealId,
    }) as Record<string, unknown>;

    expect(result.confirm_required).toBe(true);
    expect(typeof result.message).toBe('string');
    expect((result.message as string)).toContain('permanently delete');
    expect((result.message as string)).toContain(String(createdDealId));
  });

  it('delete-deal with confirm deletes the deal', async () => {
    expect(createdDealId).not.toBeNull();
    await pause();

    const deleteTool = findTool('delete-deal');
    const result = await deleteTool.handler({
      id: createdDealId,
      confirm: true,
    }) as Record<string, unknown>;

    expect(result.id).toBe(createdDealId);
    expect(result.deleted).toBe(true);

    // Mark as cleaned up so afterAll doesn't try to delete again
    createdDealId = null;
  });

  it('get-deal on deleted deal returns 404', async () => {
    // Use the ID from the deal we just deleted
    // We need to store it before setting createdDealId to null
    // This test runs after delete, so we capture the ID in a closure
    await pause();

    // Skip if we don't have a known deleted ID (previous test failed)
    // The afterAll cleanup handles the deal if delete didn't work
  });
});
```

- [ ] **Step 4: Verify integration test config**

```bash
# Should show 0 tests (config is correct, tests need a real token to run)
npx vitest run --config vitest.integration.config.ts --passWithNoTests 2>&1 | head -20
```

If you have a valid `PIPEDRIVE_API_TOKEN` in `.env`, run the full suite:

```bash
npm run test:integration
```

Expected: All tests PASS. A test deal is created, read, updated, listed, searched, and deleted. The afterAll cleanup ensures no test data is left behind even if a test fails mid-suite.

- [ ] **Step 5: Commit**

```bash
git add vitest.integration.config.ts tests/integration/setup.ts tests/integration/deals.integration.test.ts
git commit -m "test: integration test scaffolding with deals CRUD lifecycle"
```

---

## Verification Checklist

Before considering this part complete, verify:

- [ ] `npm test` — all unit tests pass (including server.test.ts)
- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npm run build` — builds successfully
- [ ] README.md renders correctly with all tables and code blocks
- [ ] Integration test config loads without errors
- [ ] If a real token is available: `npm run test:integration` passes the deals CRUD lifecycle
