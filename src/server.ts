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
import { KillSwitch } from './lib/kill-switch.js';
import { ReadBudget } from './lib/read-budget.js';
import type { CapabilityPolicy } from './lib/capability-policy.js';
import {
  isHighRiskDelete,
  resolveDeleteConfirmation,
  checkUserChatMessage,
  needsUpdateConfirmation,
  BulkDetector,
} from './lib/typed-confirmation.js';
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
  killSwitch: KillSwitch;
  readBudget: ReadBudget;
  policy: CapabilityPolicy;
  bulkDetector: BulkDetector;
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

    // --- Kill-switch gate for writes ---
    if (isWrite && !deps.killSwitch.writesEnabled) {
      deps.auditLog.insert({
        tool: toolName,
        category: tool.category as AuditCategory,
        entity_type: null,
        entity_id: extractEntityId(params, null),
        status: 'rejected' satisfies AuditStatus,
        reason_code: 'WRITES_DISABLED',
        request_hash: reqHash,
        target_summary: null,
        diff_summary: null,
        idempotency_key: null,
      });
      const errorObj = {
        error: true,
        code: 503,
        reason: 'WRITES_DISABLED',
        message: 'Writes are currently disabled. Re-enable via `npm run kill-switch -- --on`.',
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorObj, null, 2) }],
        isError: true,
      };
    }

    // --- Typed destructive confirmation gate ---
    if (isWrite) {
      const toolPolicy = deps.policy.tools[toolName];
      const entityId = (params as { id?: string | number }).id ?? '?';
      const confirm = typeof params.confirm === 'string' ? params.confirm : undefined;

      // 1. Delete confirmation (all deletes require typed confirm string)
      if (toolPolicy?.destructive && toolPolicy.confirmation_format) {
        const required = resolveDeleteConfirmation(toolPolicy, entityId);
        if (confirm !== required) {
          deps.auditLog.insert({
            tool: toolName, category: tool.category as AuditCategory,
            entity_type: null, entity_id: String(entityId),
            status: 'rejected', reason_code: 'CONFIRMATION_REQUIRED',
            request_hash: reqHash, target_summary: null, diff_summary: null, idempotency_key: null,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: true, code: 428, reason: 'CONFIRMATION_REQUIRED',
              required_confirmation: required,
              message: `Destructive action. Re-invoke with confirm: "${required}".` +
                (isHighRiskDelete(toolName)
                  ? ` Also include user_chat_message: the user's literal chat message that contains "${required}".`
                  : ''),
            }, null, 2) }],
            isError: true,
          };
        }

        // 1b. High-risk deletes also require user_chat_message containing the confirm string
        if (isHighRiskDelete(toolName)) {
          const ucm = (params as { user_chat_message?: string }).user_chat_message;
          const check = checkUserChatMessage(ucm, required);
          if (!check.ok) {
            deps.auditLog.insert({
              tool: toolName, category: tool.category as AuditCategory,
              entity_type: null, entity_id: String(entityId),
              status: 'rejected',
              reason_code: check.reason === 'MISSING'
                ? 'CONFIRMATION_USER_MESSAGE_MISSING'
                : 'CONFIRMATION_USER_MESSAGE_MISMATCH',
              request_hash: reqHash, target_summary: null, diff_summary: null, idempotency_key: null,
            });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                error: true, code: 428, reason: 'CONFIRMATION_USER_MESSAGE_REQUIRED',
                required_confirmation: required,
                message: `High-risk delete. Include user_chat_message (the user's literal chat message) containing "${required}".`,
              }, null, 2) }],
              isError: true,
            };
          }
          // Stash hash for success-path audit row
          (params as Record<string, unknown>)._userChatMessageHash = check.hash;
        }
      }

      // 2. Destructive-field update confirmation
      if (tool.category === 'update' && toolPolicy) {
        const hit = needsUpdateConfirmation(toolPolicy, params);
        if (hit && confirm !== hit.required) {
          deps.auditLog.insert({
            tool: toolName, category: 'update' as AuditCategory,
            entity_type: null, entity_id: String(entityId),
            status: 'rejected', reason_code: 'CONFIRMATION_REQUIRED',
            request_hash: reqHash,
            target_summary: `destructive_update_field=${hit.field}`,
            diff_summary: null, idempotency_key: null,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: true, code: 428, reason: 'CONFIRMATION_REQUIRED',
              required_confirmation: hit.required,
              message: `Update touches destructive field "${hit.field}". Re-invoke with confirm: "${hit.required}".`,
            }, null, 2) }],
            isError: true,
          };
        }
      }

      // 3. Bulk detector
      const bulkCheck = deps.bulkDetector.needsConfirmation(
        toolName, confirm, deps.policy.bulk_detector.confirmation_format,
      );
      if (!bulkCheck.ok) {
        deps.auditLog.insert({
          tool: toolName, category: tool.category as AuditCategory,
          entity_type: null, entity_id: null,
          status: 'rejected', reason_code: 'BULK_CONFIRMATION_REQUIRED',
          request_hash: reqHash, target_summary: null, diff_summary: null, idempotency_key: null,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 428, reason: 'BULK_CONFIRMATION_REQUIRED',
            required_confirmation: bulkCheck.required,
            message: `Bulk pattern detected. Re-invoke with confirm: "${bulkCheck.required}".`,
          }, null, 2) }],
          isError: true,
        };
      }
    }

    // --- Read-budget gate ---
    if (!isWrite) {
      const confirm = typeof params.confirm === 'string' ? params.confirm : undefined;
      const broad = deps.readBudget.needsBroadConfirmation(toolName, params, confirm);
      if (!broad.ok) {
        deps.auditLog.insert({
          tool: toolName, category: 'broad_query', entity_type: null, entity_id: null,
          status: 'rejected', reason_code: 'BROAD_READ_CONFIRMATION_REQUIRED',
          request_hash: '', target_summary: null, diff_summary: null, idempotency_key: null,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 428, reason: 'BROAD_READ_CONFIRMATION_REQUIRED',
            required_confirmation: broad.required,
            message: `Broad query detected. Re-invoke with confirm: "${broad.required}".`,
          }, null, 2) }],
          isError: true,
        };
      }
      const recCheck = deps.readBudget.checkRecords();
      if (!recCheck.ok) {
        deps.auditLog.insert({
          tool: toolName, category: 'read_budget', entity_type: null, entity_id: null,
          status: 'rejected', reason_code: recCheck.reason!,
          request_hash: '', target_summary: null, diff_summary: null, idempotency_key: null,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 429, reason: recCheck.reason,
            message: 'Session read record budget exceeded.',
          }, null, 2) }],
          isError: true,
        };
      }
      const bytCheck = deps.readBudget.checkBytes();
      if (!bytCheck.ok) {
        deps.auditLog.insert({
          tool: toolName, category: 'read_budget', entity_type: null, entity_id: null,
          status: 'rejected', reason_code: bytCheck.reason!,
          request_hash: '', target_summary: null, diff_summary: null, idempotency_key: null,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 429, reason: bytCheck.reason,
            message: 'Session read byte budget exceeded.',
          }, null, 2) }],
          isError: true,
        };
      }
      const pagCheck = deps.readBudget.checkPagination(toolName);
      if (!pagCheck.ok) {
        deps.auditLog.insert({
          tool: toolName, category: 'read_budget', entity_type: null, entity_id: null,
          status: 'rejected', reason_code: pagCheck.reason!,
          request_hash: '', target_summary: null, diff_summary: null, idempotency_key: null,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 429, reason: pagCheck.reason,
            message: 'Pagination depth budget exceeded for this tool.',
          }, null, 2) }],
          isError: true,
        };
      }
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
        const ucmHash = (params as Record<string, unknown>)._userChatMessageHash;
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
          diff_summary: typeof ucmHash === 'string' ? `user_chat_message_hash=${ucmHash}` : null,
          idempotency_key: null,
        });
      }

      // Post-call read accounting: records + bytes + pagination depth.
      if (!isWrite && result && typeof result === 'object') {
        const items = (result as { items?: unknown[] }).items;
        if (Array.isArray(items)) {
          const n = items.length;
          const b = Buffer.byteLength(JSON.stringify(items));
          const isPaginated = params.cursor !== undefined || params.start !== undefined;
          deps.readBudget.add(toolName, n, b, isPaginated);
        }
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
