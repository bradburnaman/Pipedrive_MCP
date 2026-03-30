// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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

  // Filter to only enabled tools
  const enabledTools: ToolDefinition[] = [];
  let skippedCount = 0;

  for (const tool of allTools) {
    if (!isToolEnabled(config, tool.name, tool.category)) {
      skippedCount++;
      logger.debug({ tool: tool.name, category: tool.category }, 'Tool skipped (disabled)');
    } else {
      enabledTools.push(tool);
    }
  }

  logger.info(
    { registered: enabledTools.length, skipped: skippedCount, total: allTools.length },
    'Tool registration complete'
  );

  // Build a lookup map for dispatch
  const toolMap = new Map<string, ToolDefinition>(
    enabledTools.map(t => [t.name, t])
  );

  // Use the underlying Server to register tools/list and tools/call handlers.
  // We bypass McpServer.tool() because our inputSchema is plain JSON Schema,
  // not Zod schemas. The underlying Server.setRequestHandler() accepts any schema
  // shape and gives us full control over the protocol-level tool registration.
  const underlyingServer = server.server;

  underlyingServer.registerCapabilities({
    tools: { listChanged: true },
  });

  underlyingServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: enabledTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
    })),
  }));

  underlyingServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = toolMap.get(toolName);

    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: `Tool '${toolName}' not found` }) }],
        isError: true,
      };
    }

    const params = (request.params.arguments ?? {}) as Record<string, unknown>;
    const startTime = Date.now();

    try {
      const result = await tool.handler(params);
      const duration = Date.now() - startTime;

      // Audit log — PII-aware:
      // DO log: tool name, entity IDs, duration, outcome, deal titles, stage names
      // DO NOT log: person names, emails, phones, note content, activity descriptions
      const logEntry: Record<string, unknown> = {
        tool: toolName,
        duration_ms: duration,
        status: 'success',
      };
      if (params.id) logEntry.entity_id = params.id;
      // Log deal titles (not PII) but not person names or note content
      if (tool.category !== 'read' && toolName.includes('deal')) {
        if (params.title) logEntry.deal_title = params.title;
      }
      if (params.stage) logEntry.stage = params.stage;
      if (params.pipeline) logEntry.pipeline = params.pipeline;
      logger.info(logEntry, 'Tool call completed');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: unknown) {
      const duration = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      const errorObj = (err as Record<string, unknown>)?.error === true
        ? err
        : { error: true, message };

      // Audit log — error case
      logger.warn({
        tool: toolName,
        duration_ms: duration,
        status: 'error',
        error_code: (err as Record<string, unknown>)?.code,
        error_message: message,
      }, 'Tool call failed');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorObj, null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}
