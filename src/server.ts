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
import type { AuditLog, AuditCategory, AuditStatus } from './lib/audit-log.js';
import { requestHash, extractEntityId } from './lib/audit-middleware.js';
import { decorateReadResponse, type SafeDegradedRef } from './lib/safe-degraded-decorator.js';
import { isToolEnabled } from './config.js';
import { createDealTools } from './tools/deals.js';
import { createPersonTools } from './tools/persons.js';
import { createOrganizationTools } from './tools/organizations.js';
import { createActivityTools } from './tools/activities.js';
import { createNoteTools } from './tools/notes.js';
import { createPipelineTools } from './tools/pipelines.js';
import { createUserTools } from './tools/users.js';
import { createFieldTools } from './tools/fields.js';
import { createPracticePipelineTools } from './tools/practice-pipeline.js';
import type { Logger } from 'pino';

export interface ServerDeps {
  auditLog: AuditLog;
  safeDegraded: SafeDegradedRef;
  // Bumped on every tool dispatch so the idle re-verify scheduler in index.ts
  // can decide whether the server is quiet enough to walk the full chain.
  activity: { lastActivityMs: number };
}

export function createServer(
  config: ServerConfig,
  client: PipedriveClient,
  resolver: ReferenceResolver,
  entityResolver: EntityResolver,
  logger: Logger,
  deps: ServerDeps,
): McpServer {
  const server = new McpServer({
    name: 'pipedrive-mcp',
    version: '0.1.0',
  });

  // Collect all tool definitions from all 9 tool files
  const allTools: ToolDefinition[] = [
    ...createDealTools(client, resolver, entityResolver, logger),
    ...createPersonTools(client, resolver, entityResolver, logger),
    ...createOrganizationTools(client, resolver, entityResolver, logger),
    ...createActivityTools(client, resolver, entityResolver, logger),
    ...createNoteTools(client, resolver, entityResolver, logger),
    ...createPipelineTools(resolver),
    ...createUserTools(resolver),
    ...createFieldTools(resolver),
    // DEPLOYMENT RISK: get-practice-pipeline returns aggregated revenue pipeline data and should
    // be restricted to trusted scorecard automation. Use PIPEDRIVE_DISABLED_TOOLS to exclude it
    // from general read access if needed. See spec Section 8.
    ...createPracticePipelineTools(client, resolver, logger),
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
    const params = (request.params.arguments ?? {}) as Record<string, unknown>;
    return dispatchToolCall(request.params.name, params, toolMap, deps, logger);
  });

  return server;
}

// Exported for direct testing without round-tripping through MCP transport.
// Index signature widens to match @modelcontextprotocol/sdk's loose result shape.
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export async function dispatchToolCall(
  toolName: string,
  params: Record<string, unknown>,
  toolMap: Map<string, ToolDefinition>,
  deps: ServerDeps,
  logger: Logger,
): Promise<ToolCallResult> {
  const tool = toolMap.get(toolName);
  deps.activity.lastActivityMs = Date.now();

  if (!tool) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: `Tool '${toolName}' not found` }) }],
      isError: true,
    };
  }
  return dispatchTool(tool, params, deps, logger);
}

async function dispatchTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  deps: ServerDeps,
  logger: Logger,
): Promise<ToolCallResult> {
  const toolName = tool.name;
    const startTime = Date.now();
    const isWrite = tool.category !== 'read';
    const reqHash = isWrite ? requestHash(toolName, params) : '';

    // --- Safe-degraded gate for writes ---
    if (isWrite && deps.safeDegraded.value) {
      // TODO(sec-10): populate target_summary / diff_summary when per-tool helpers land.
      deps.auditLog.insert({
        tool: toolName,
        category: tool.category as AuditCategory,
        entity_type: null,
        entity_id: extractEntityId(params, null),
        status: 'safe_degraded_rejected' satisfies AuditStatus,
        reason_code: deps.safeDegraded.reason ?? 'AUDIT_CHAIN_BROKEN',
        request_hash: reqHash,
        target_summary: null,
        diff_summary: null,
        idempotency_key: null,
      });
      const errorObj = {
        error: true,
        code: 503,
        message: `Audit chain integrity failure (${deps.safeDegraded.reason ?? 'unknown'}). Writes disabled. Contact owner.`,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorObj, null, 2) }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(params);
      const duration = Date.now() - startTime;

      // Pino structured log — PII-aware:
      // DO log: tool name, entity IDs, duration, outcome, deal titles, stage names
      // DO NOT log: person names, emails, phones, note content, activity descriptions
      const logEntry: Record<string, unknown> = {
        tool: toolName,
        duration_ms: duration,
        status: 'success',
      };
      if (params.id) logEntry.entity_id = params.id;
      if (isWrite && toolName.includes('deal') && params.title) logEntry.deal_title = params.title;
      if (params.stage) logEntry.stage = params.stage;
      if (params.pipeline) logEntry.pipeline = params.pipeline;
      logger.info(logEntry, 'Tool call completed');

      // Tool-result error envelope ({ error: true, ... }) is success-on-the-wire
      // but a logical failure — audit it as 'failure'.
      const isLogicalError =
        result && typeof result === 'object' && (result as { error?: boolean }).error === true;

      if (isWrite) {
        // TODO(sec-10): populate target_summary / diff_summary when per-tool helpers land.
        deps.auditLog.insert({
          tool: toolName,
          category: tool.category as AuditCategory,
          entity_type: null,
          entity_id: extractEntityId(params, result),
          status: (isLogicalError ? 'failure' : 'success') satisfies AuditStatus,
          reason_code: isLogicalError
            ? String((result as { code?: number | string }).code ?? 'API_ERROR')
            : null,
          request_hash: reqHash,
          target_summary: null,
          diff_summary: null,
          idempotency_key: null,
        });
      }

      // Decorate read results with the safe-degraded notice when the chain is
      // broken. (The gate above already blocks writes; reads remain open but
      // carry an in-band warning so callers see results may be untrustworthy.)
      const out = isWrite ? result : decorateReadResponse(result, deps.safeDegraded);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
      };
    } catch (err: unknown) {
      const duration = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      const errorObj = (err as Record<string, unknown>)?.error === true
        ? err
        : { error: true, message };

      logger.warn({
        tool: toolName,
        duration_ms: duration,
        status: 'error',
        error_code: (err as Record<string, unknown>)?.code,
        error_message: message,
      }, 'Tool call failed');

      if (isWrite) {
        deps.auditLog.insert({
          tool: toolName,
          category: tool.category as AuditCategory,
          entity_type: null,
          entity_id: extractEntityId(params, null),
          status: 'failure' satisfies AuditStatus,
          reason_code: 'EXCEPTION',
          request_hash: reqHash,
          target_summary: null,
          diff_summary: null,
          idempotency_key: null,
        });
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorObj, null, 2) }],
        isError: true,
      };
    }
}
