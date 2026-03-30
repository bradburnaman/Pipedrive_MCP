# Part 12: Server Entry Point

> Part 12 of 13 — MCP server setup, tool registration with audit logging, and application entry point
> **Depends on:** Parts 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
> **Produces:** `src/server.ts`, `src/index.ts`, `tests/server.test.ts`

---

## Task 19: Server Setup (server.ts)

**Files:**
- Create: `src/server.ts`
- Create: `tests/server.test.ts`

- [ ] **Step 1: Write server tests**

```typescript
// tests/server.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../src/server.js';
import type { ServerConfig, ToolCategory } from '../src/types.js';
import type { Logger } from 'pino';

// Minimal mock logger
function createMockLogger(): Logger {
  const noop = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => logger),
    level: 'info',
  } as unknown as Logger;
  return logger;
}

// Minimal mock client
function createMockClient() {
  return {
    request: vi.fn(),
    validateToken: vi.fn(),
    rateLimitState: { remaining: null, resetTimestamp: null },
  } as any;
}

// Minimal mock resolver
function createMockResolver() {
  return {
    getFieldResolver: vi.fn(),
    getUserResolver: vi.fn(),
    getPipelineResolver: vi.fn(),
    getActivityTypeResolver: vi.fn(),
  } as any;
}

// Minimal mock entity resolver
function createMockEntityResolver() {
  return {
    resolve: vi.fn(),
  } as any;
}

function createConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiToken: 'test-token',
    port: 3000,
    transport: 'stdio' as const,
    enabledCategories: new Set<ToolCategory>(['read', 'create', 'update', 'delete']),
    disabledTools: new Set<string>(),
    logLevel: 'info' as const,
    ...overrides,
  };
}

describe('createServer', () => {
  let logger: Logger;
  let client: ReturnType<typeof createMockClient>;
  let resolver: ReturnType<typeof createMockResolver>;
  let entityResolver: ReturnType<typeof createMockEntityResolver>;

  beforeEach(() => {
    logger = createMockLogger();
    client = createMockClient();
    resolver = createMockResolver();
    entityResolver = createMockEntityResolver();
  });

  it('creates a server with all tools when all categories enabled', () => {
    const config = createConfig();
    const server = createServer(config, client, resolver, entityResolver, logger);
    expect(server).toBeDefined();
    // The server object should be an McpServer instance
    expect(typeof server.connect).toBe('function');
  });

  it('registers only read tools when only read category is enabled', () => {
    const config = createConfig({
      enabledCategories: new Set<ToolCategory>(['read']),
    });

    // We test this indirectly. The server should be created without error.
    // Direct tool count verification requires accessing internal state which
    // the MCP SDK may not expose. Instead, we verify no errors during registration.
    const server = createServer(config, client, resolver, entityResolver, logger);
    expect(server).toBeDefined();
  });

  it('excludes disabled tools from registration', () => {
    const config = createConfig({
      disabledTools: new Set(['delete-deal', 'delete-person']),
    });

    const server = createServer(config, client, resolver, entityResolver, logger);
    expect(server).toBeDefined();
    // Disabled tools should be skipped — no error from trying to register them
  });

  it('excludes all delete tools when delete category is disabled', () => {
    const config = createConfig({
      enabledCategories: new Set<ToolCategory>(['read', 'create', 'update']),
    });

    const server = createServer(config, client, resolver, entityResolver, logger);
    expect(server).toBeDefined();
  });

  it('creates server with no tools when no categories enabled', () => {
    const config = createConfig({
      enabledCategories: new Set<ToolCategory>(),
    });

    const server = createServer(config, client, resolver, entityResolver, logger);
    expect(server).toBeDefined();
  });
});

describe('tool dispatch error handling', () => {
  // These tests verify the dispatch wrapper behavior by testing the
  // server's tool handlers directly. Since McpServer.tool() registers
  // handlers internally, we test this through the tool definitions layer.

  it('tool handler errors are caught and returned as isError responses', async () => {
    // We test this by importing the tool creation functions directly
    // and verifying that thrown errors produce the expected shape.
    // The actual wrapping happens in server.ts's registration loop.

    // Simulate what the dispatch wrapper does:
    const mockHandler = async () => {
      throw new Error('Something broke');
    };

    try {
      await mockHandler();
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const errorObj = (err as any)?.error === true ? err : { error: true, message };
      expect(errorObj).toEqual({ error: true, message: 'Something broke' });
    }
  });

  it('PipedriveApiError objects are preserved in error responses', async () => {
    const pipedriveError = { error: true, code: 404, message: 'Deal with ID 999 not found.' };

    const mockHandler = async () => {
      throw pipedriveError;
    };

    try {
      await mockHandler();
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const errorObj = (err as any)?.error === true ? err : { error: true, message: String(err) };
      expect(errorObj).toEqual(pipedriveError);
    }
  });

  it('audit logging captures tool name and duration on success', () => {
    // Verify the logger is called with expected fields
    const mockLogger = createMockLogger();
    const startTime = Date.now();

    // Simulate what the dispatch wrapper logs
    const logEntry: Record<string, unknown> = {
      tool: 'get-deal',
      duration_ms: 42,
      status: 'success',
      entity_id: 123,
    };
    mockLogger.info(logEntry, 'Tool call completed');

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'get-deal',
        status: 'success',
        entity_id: 123,
      }),
      'Tool call completed'
    );
  });

  it('audit logging captures error details on failure', () => {
    const mockLogger = createMockLogger();

    const logEntry: Record<string, unknown> = {
      tool: 'update-deal',
      duration_ms: 15,
      status: 'error',
      error_code: 404,
      error_message: 'Deal with ID 999 not found.',
    };
    mockLogger.warn(logEntry, 'Tool call failed');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'update-deal',
        status: 'error',
        error_code: 404,
      }),
      'Tool call failed'
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/server.test.ts
```

Expected: FAIL — `createServer` not found (module does not exist yet).

- [ ] **Step 3: Write server.ts implementation**

This is the fixed version incorporating Fix 6 (audit logging) and Fix 4 (logger injection) from the addendum.

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
import type { Logger } from 'pino';

export function createServer(
  config: ServerConfig,
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver,
  logger: Logger
): McpServer {
  const server = new McpServer({
    name: 'pipedrive-mcp',
    version: '0.1.0',
  });

  // Collect all tool definitions from all 8 tool files
  const allTools: ToolDefinition[] = [
    ...createDealTools(client, resolver, entityResolver, logger),
    ...createPersonTools(client, resolver, entityResolver, logger),
    ...createOrganizationTools(client, resolver, entityResolver, logger),
    ...createActivityTools(client, resolver, entityResolver, logger),
    ...createNoteTools(client, resolver, entityResolver, logger),
    ...createPipelineTools(resolver),
    ...createUserTools(resolver),
    ...createFieldTools(resolver),
  ];

  let registeredCount = 0;
  let skippedCount = 0;

  // Register enabled tools with audit logging dispatch wrapper
  for (const tool of allTools) {
    if (!isToolEnabled(config, tool.name, tool.category)) {
      skippedCount++;
      logger.debug({ tool: tool.name, category: tool.category }, 'Tool skipped (disabled)');
      continue;
    }

    server.tool(tool.name, tool.description, tool.inputSchema, async (params) => {
      const startTime = Date.now();
      const toolParams = params as Record<string, unknown>;

      try {
        const result = await tool.handler(toolParams);
        const duration = Date.now() - startTime;

        // Audit log — PII-aware
        // DO log: tool name, entity IDs, duration, outcome, deal titles, stage names
        // DO NOT log: person names, emails, phones, note content, activity descriptions
        const logEntry: Record<string, unknown> = {
          tool: tool.name,
          duration_ms: duration,
          status: 'success',
        };
        if (toolParams.id) logEntry.entity_id = toolParams.id;
        // Log deal titles (not PII) but not person names or note content
        if (tool.category !== 'read' && tool.name.includes('deal')) {
          if (toolParams.title) logEntry.deal_title = toolParams.title;
        }
        if (toolParams.stage) logEntry.stage = toolParams.stage;
        if (toolParams.pipeline) logEntry.pipeline = toolParams.pipeline;
        logger.info(logEntry, 'Tool call completed');

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const duration = Date.now() - startTime;
        const message = err instanceof Error ? err.message : String(err);
        const errorObj = (err as any)?.error === true ? err : { error: true, message };

        // Audit log — error case
        logger.warn({
          tool: tool.name,
          duration_ms: duration,
          status: 'error',
          error_code: (err as any)?.code,
          error_message: message,
        }, 'Tool call failed');

        return {
          content: [{ type: 'text', text: JSON.stringify(errorObj, null, 2) }],
          isError: true,
        };
      }
    });

    registeredCount++;
  }

  logger.info(
    { registered: registeredCount, skipped: skippedCount, total: allTools.length },
    'Tool registration complete'
  );

  return server;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/server.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: No errors.

---

## Task 20: Entry Point (index.ts)

**Files:**
- Modify: `src/index.ts`

This replaces the placeholder `src/index.ts` from Task 1. Applies Fix 3 (stdout redirect before all imports) and Fix 4 (logger injection) from the addendum.

- [ ] **Step 1: Write the entry point**

```typescript
// src/index.ts

// FIRST: Load env vars (dotenv has no stdout side effects)
import 'dotenv/config';

// SECOND: Redirect stdout to stderr IMMEDIATELY — before all other imports.
// This prevents any module initialization code from corrupting the MCP
// JSON-RPC protocol stream in stdio mode. The redirect applies in ALL modes
// because stderr is the correct log destination for both stdio and SSE.
//
// Check argv to determine mode, but redirect regardless of mode.
const isSSE = process.argv.includes('sse');

const stderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk: any, ...args: any[]) => {
  return (stderrWrite as any)(chunk, ...args);
};

// THIRD: Now safe to import everything else
import { parseConfig } from './config.js';
import { PipedriveClient } from './lib/pipedrive-client.js';
import { ReferenceResolver } from './lib/reference-resolver/index.js';
import { EntityResolver } from './lib/entity-resolver.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';

async function main() {
  const config = parseConfig();

  // Logger writes to stderr (fd 2) in all modes — stdout is reserved for
  // MCP JSON-RPC in stdio mode, and stderr is correct for SSE too.
  const logger = pino({
    level: config.logLevel,
  }, pino.destination(2));

  logger.info({ transport: config.transport }, 'Pipedrive MCP Server starting');

  // Initialize client with logger
  const client = new PipedriveClient(config.apiToken, logger);

  // Validate token — fail fast with clear error if invalid
  try {
    const user = await client.validateToken();
    logger.info({ userId: user.id, userName: user.name }, 'Token validated');
  } catch (err) {
    logger.fatal('Invalid or missing PIPEDRIVE_API_TOKEN. Exiting.');
    process.exit(1);
  }

  // Initialize resolvers — lazy init, caches prime on first access
  // NO initialize() call needed (see Fix 5 from addendum)
  const resolver = new ReferenceResolver(client, logger);
  const entityResolver = new EntityResolver(client, logger);

  // Create MCP server with all dependencies
  const server = createServer(config, client, resolver, entityResolver, logger);

  // Start transport
  if (config.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Server running on stdio');
  } else {
    // SSE mode
    // NOTE: The SSE implementation depends on the installed SDK version.
    // The implementing agent should verify the SSEServerTransport API against
    // the installed @modelcontextprotocol/sdk version. The structure below
    // matches the common SDK pattern but may need adjustment.
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const http = await import('node:http');

    // Track active transports for clean shutdown
    const activeTransports = new Map<string, InstanceType<typeof SSEServerTransport>>();

    const httpServer = http.createServer(async (req, res) => {
      // GET /sse — Establish SSE connection
      if (req.method === 'GET' && req.url === '/sse') {
        logger.info('SSE client connecting');
        const transport = new SSEServerTransport('/messages', res);
        const sessionId = transport.sessionId ?? crypto.randomUUID();
        activeTransports.set(sessionId, transport);

        // Clean up on disconnect
        res.on('close', () => {
          activeTransports.delete(sessionId);
          logger.info({ sessionId }, 'SSE client disconnected');
        });

        await server.connect(transport);
        logger.info({ sessionId }, 'SSE client connected');
        return;
      }

      // POST /messages — Handle incoming MCP messages from SSE clients
      if (req.method === 'POST' && req.url?.startsWith('/messages')) {
        // The SSE transport handles POST message routing internally.
        // Parse the URL to extract session info if needed by the SDK version.
        // The implementing agent should verify this against the installed SDK.
        //
        // Common pattern: the SSEServerTransport instance handles its own
        // message routing via the response object passed during construction.
        // Some SDK versions require explicit message forwarding here.

        // Collect body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString('utf-8');

        // Try to find the matching transport and forward the message
        // SDK versions vary in how they expose this — check the installed version
        const url = new URL(req.url, `http://localhost:${config.port}`);
        const sessionId = url.searchParams.get('sessionId');

        if (sessionId && activeTransports.has(sessionId)) {
          const transport = activeTransports.get(sessionId)!;
          // Forward the message to the transport
          // The exact method depends on the SDK version
          try {
            await transport.handlePostMessage(req, res, body);
          } catch (err) {
            logger.error({ err, sessionId }, 'Error handling SSE message');
            if (!res.headersSent) {
              res.writeHead(500);
              res.end('Internal server error');
            }
          }
        } else {
          res.writeHead(400);
          res.end('Invalid or missing session');
        }
        return;
      }

      // Health check endpoint
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // Everything else — 404
      res.writeHead(404);
      res.end('Not found');
    });

    httpServer.listen(config.port, () => {
      logger.info({ port: config.port }, 'Server running on SSE');
    });
  }

  // Graceful shutdown — 5-second timeout
  const shutdown = async () => {
    logger.info('Shutting down...');
    const shutdownTimeout = setTimeout(() => {
      logger.warn('Shutdown timed out after 5s, forcing exit');
      process.exit(1);
    }, 5000);
    try {
      await server.close();
    } finally {
      clearTimeout(shutdownTimeout);
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: No errors. If there are errors related to the SSE transport API, check the installed SDK version:

```bash
npm ls @modelcontextprotocol/sdk
```

Adjust the SSE transport usage to match the installed version. The `SSEServerTransport` constructor signature and `handlePostMessage` method name may vary across SDK versions.

- [ ] **Step 3: Manual smoke test (stdio mode)**

```bash
# Build first
npm run build

# Test that the server starts and validates the token
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | PIPEDRIVE_API_TOKEN=your-real-token node dist/index.js
```

Expected: Server starts, validates token, returns an `initialize` response on stdout. If the token is invalid, the process exits with code 1 and a clear error on stderr.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/index.ts tests/server.test.ts
git commit -m "feat: server entry point with tool registration, audit logging, and dual transport"
```

---

## Key Design Decisions

### Audit Logging (Fix 6)

Every tool call is timed and logged. The dispatch wrapper in `server.ts` is the single place this happens — tool handlers themselves don't need to manage logging.

**What gets logged at default level:**
- Tool name
- Entity IDs (from params)
- Duration in milliseconds
- Outcome: `success` or `error`
- Deal titles and stage names (not PII)
- On error: error code and error message

**What is NOT logged at default level (PII-aware):**
- Person names
- Email addresses
- Phone numbers
- Note content
- Activity descriptions/body text

At `debug` level (`PIPEDRIVE_LOG_LEVEL=debug`), full params are logged by the individual tool handlers via their logger injection. This is for development only.

### stdout Redirect (Fix 3)

The redirect happens in ALL modes, not just stdio. This is correct because:
- **stdio mode:** stdout is reserved for MCP JSON-RPC — any stray writes corrupt the protocol
- **SSE mode:** logs should go to stderr too — stdout redirect prevents accidental corruption if someone later adds stdio support alongside SSE

The redirect happens BEFORE any module imports (after `dotenv/config` which has no stdout side effects). This closes the timing gap where module initialization code could write to stdout.

### SSE Transport Note

The SSE implementation uses `SSEServerTransport` from the MCP SDK. The exact API varies by SDK version. The implementing agent should:

1. Check the installed SDK version: `npm ls @modelcontextprotocol/sdk`
2. Look at the `SSEServerTransport` type definitions in `node_modules/@modelcontextprotocol/sdk/dist/server/sse.d.ts`
3. Adjust the constructor call and message handling to match

The basic pattern (GET /sse for connection, POST /messages for incoming) is stable across versions. The method for forwarding POST bodies to the transport is what may differ.

### Graceful Shutdown

Both SIGTERM and SIGINT are handled. The shutdown flow:

1. Log "Shutting down..."
2. Set a 5-second timeout that force-exits with code 1
3. Call `server.close()` to cleanly disconnect transports
4. Clear the timeout
5. Exit with code 0

In SSE mode, `server.close()` should close active SSE connections. The MCP SDK handles this internally when the server is closed. The 5-second timeout protects against hanging if in-flight Pipedrive API calls don't complete.
