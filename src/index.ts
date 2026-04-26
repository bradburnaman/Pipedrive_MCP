// src/index.ts

import { assertConfigDirSafe, assertCwdClean } from './lib/path-safety.js';
import {
  getToken, evaluateRotation, envOverrideAllowed, permissionRepairEvents,
} from './lib/secret-store.js';
import { probeClaudeDesktopConfig } from './lib/claude-desktop-probe.js';
import { VERSION_ID, versionString, POLICY_HASH } from './lib/version-id.js';
import { AuditLog } from './lib/audit-log.js';
import { loadPolicy, recomputeHash, PolicyHashMismatchError } from './lib/capability-policy.js';
import { KillSwitch } from './lib/kill-switch.js';
import { ReadBudget } from './lib/read-budget.js';
import type { SafeDegradedRef } from './lib/safe-degraded-decorator.js';
import { parseConfig } from './config.js';
import { PipedriveClient } from './lib/pipedrive-client.js';
import { ReferenceResolver } from './lib/reference-resolver/index.js';
import { EntityResolver } from './lib/entity-resolver.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';

async function main() {
  assertConfigDirSafe();
  assertCwdClean();
  const config = parseConfig();

  // Logger writes to stderr (fd 2) in all modes — stdout is reserved for
  // MCP JSON-RPC in stdio mode, and stderr is correct for SSE too.
  const logger = pino(
    {
      level: config.logLevel,
      redact: {
        paths: [
          'apiToken',
          'api_token',
          'token',
          'config.apiToken',
          'req.url',
          'url',
          'headers.authorization',
          'headers.Authorization',
          'req.headers.authorization',
          'err.config.url',
          '*.apiToken',
          '*.api_token',
        ],
        remove: true,
      },
    },
    pino.destination(2),
  );

  logger.info(
    { transport: config.transport, version: versionString(), dirty: VERSION_ID.dirty },
    'Pipedrive MCP Server starting',
  );

  // --- Token resolution (Keychain first; env override is restricted) ---
  let token: string;
  let issuedAt: string | null = null;
  let envOverrideReason: string | null = null;

  const ov = envOverrideAllowed();
  if (ov.allowed && process.env.PIPEDRIVE_API_TOKEN) {
    token = process.env.PIPEDRIVE_API_TOKEN.trim();
    envOverrideReason = ov.reason ?? null;
    if (envOverrideReason && envOverrideReason.startsWith('break_glass:')) {
      process.stderr.write(
        `WARNING: break-glass env override active. Reason: ${envOverrideReason.slice('break_glass:'.length)}\n`,
      );
      // sec-06 will also write a BREAK_GLASS_ENV_OVERRIDE audit row + exceptions.log entry.
    }
  } else {
    const entry = await getToken();
    if (!entry) {
      console.error('No token in Keychain. Run `npm run setup`.');
      process.exit(1);
    }
    token = entry.token;
    issuedAt = entry.issuedAt;
  }

  // --- Rotation gate (75/90/120 days per spec §7.5) ---
  if (issuedAt) {
    const r = evaluateRotation(issuedAt);
    const staleReason = (process.env.BHG_PIPEDRIVE_STALE_REASON ?? '').trim();
    if (r.status === 'refuse') {
      const allowStale = process.env.BHG_PIPEDRIVE_ALLOW_STALE === '1';
      if (!allowStale || staleReason.length === 0) {
        console.error(
          `Token is ${Math.floor(r.ageDays)} days old (hard-block >= 120d). ` +
          'Run `npm run setup -- --rotate`. Override requires both ' +
          'BHG_PIPEDRIVE_ALLOW_STALE=1 AND BHG_PIPEDRIVE_STALE_REASON="...".',
        );
        process.exit(1);
      }
      // sec-06 will write STALE_TOKEN_EXCEPTION audit row + exceptions.log entry.
    }
    if (r.status === 'due' || r.status === 'degraded') {
      process.stderr.write(
        `Token is ${Math.floor(r.ageDays)} days old. Rotate soon (\`npm run setup -- --rotate\`).\n`,
      );
    }
  }

  // --- Claude Desktop config probe (warn on hardcoded token) ---
  const probe = probeClaudeDesktopConfig();
  if (probe) {
    process.stderr.write(
      `WARNING: Claude Desktop config ${probe.path} has PIPEDRIVE_API_TOKEN in ` +
      `env block(s): ${probe.servers.join(', ')}. Remove the env block — this ` +
      'server reads the token from Keychain.\n',
    );
    // sec-06 will also write a CLAUDE_DESKTOP_TOKEN_IN_CONFIG audit row.
  }

  // sec-06 will replay permissionRepairEvents into PERMISSION_REPAIRED audit rows.
  if (permissionRepairEvents.length > 0) {
    logger.warn({ events: permissionRepairEvents }, 'Sensitive file permissions repaired at startup');
  }

  // Initialize client with logger
  const client = new PipedriveClient(token, logger);

  // Validate token against Pipedrive API
  try {
    const user = await client.validateToken();
    logger.info({ userId: user.id, userName: user.name }, 'Token validated');
  } catch (err) {
    logger.fatal({ err }, 'Token rejected by Pipedrive. Exiting.');
    process.exit(1);
  }

  // Initialize resolvers — lazy init, caches prime on first access
  const resolver = new ReferenceResolver(client, logger);
  const entityResolver = new EntityResolver(client, logger);

  // --- Capability policy load (sec-10) ---
  // Startup mismatch = exit 1 (operator intervention required before server starts).
  // We need the auditLog to record the failure event, so create a temporary instance.
  let policy;
  try {
    policy = loadPolicy();
  } catch (err) {
    if (err instanceof PolicyHashMismatchError) {
      const startupAuditLog = new AuditLog();
      startupAuditLog.insert({
        tool: '_startup', category: 'policy', entity_type: null, entity_id: null,
        status: 'failure', reason_code: 'POLICY_HASH_MISMATCH_STARTUP',
        request_hash: '',
        target_summary: `expected=${err.expected} got=${err.got}`,
        diff_summary: null, idempotency_key: null,
      });
      startupAuditLog.close();
      logger.fatal(
        { expected: err.expected, got: err.got },
        'POLICY_HASH_MISMATCH_STARTUP — refusing to start. Rebuild from clean source or investigate tampering.',
      );
      process.exit(1);
    }
    throw err;
  }

  const killSwitch = new KillSwitch();
  const readBudget = new ReadBudget(policy.read_budgets);

  // --- Audit log + safe-degraded gate (sec-06) ---
  const auditLog = new AuditLog();
  const safeDegraded: SafeDegradedRef = { value: false, reason: null };
  const initialVerify = auditLog.verifyChain();
  if (!initialVerify.ok) {
    safeDegraded.value = true;
    safeDegraded.reason = 'AUDIT_CHAIN_BROKEN';
    // Emit to stderr only — never write the failure event to the tampered DB.
    logger.error(
      { breakAtId: initialVerify.breakAtId },
      'AUDIT_CHAIN_BROKEN — entering safe-degraded mode. Writes disabled; reads carry _security_notice. Run `npm run audit-verify` for details.',
    );
  }

  const activity = { lastActivityMs: Date.now() };

  // 60s tail hot-check — cheap, catches in-flight tampering of recent rows.
  const hotCheck = setInterval(() => {
    if (safeDegraded.value) return;
    const r = auditLog.verifyTail(100);
    if (!r.ok) {
      safeDegraded.value = true;
      safeDegraded.reason = 'AUDIT_CHAIN_BROKEN_TAIL';
      logger.error({ breakAtId: r.breakAtId }, 'AUDIT_CHAIN_BROKEN — tail hot-check detected tampering');
    }
  }, 60_000);
  hotCheck.unref();

  // 60s policy hot-check — runtime mismatch flips safe-degraded; does NOT exit
  // (don't abruptly kill a running user session; startup already guards the entry point).
  const policyHotCheck = setInterval(() => {
    if (safeDegraded.value) return;
    try {
      const got = recomputeHash();
      if (got !== POLICY_HASH) {
        safeDegraded.value = true;
        safeDegraded.reason = 'POLICY_HASH_MISMATCH_RUNTIME';
        logger.error({ expected: POLICY_HASH, got }, 'POLICY_HASH_MISMATCH_RUNTIME — entering safe-degraded mode');
        auditLog.insert({
          tool: '_hot_check', category: 'policy', entity_type: null, entity_id: null,
          status: 'safe_degraded_rejected', reason_code: 'POLICY_HASH_MISMATCH_RUNTIME',
          request_hash: '',
          target_summary: `expected=${POLICY_HASH} got=${got}`,
          diff_summary: null, idempotency_key: null,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Policy hot-check failed');
    }
  }, 60_000);
  policyHotCheck.unref();

  // 15-minute idle re-verify — full walk catches modifications outside the
  // tail window. Only runs when the server has been quiet for 30s+.
  const idleReverify = setInterval(() => {
    if (safeDegraded.value) return;
    if (Date.now() - activity.lastActivityMs < 30_000) return;
    const r = auditLog.verifyChain();
    if (!r.ok) {
      safeDegraded.value = true;
      safeDegraded.reason = 'AUDIT_CHAIN_BROKEN_IDLE_VERIFY';
      logger.error({ breakAtId: r.breakAtId }, 'AUDIT_CHAIN_BROKEN — idle re-verify detected post-startup tampering');
    }
  }, 15 * 60_000);
  idleReverify.unref();

  // Create MCP server with all dependencies
  const server = createServer(config, client, resolver, entityResolver, logger, {
    auditLog,
    safeDegraded,
    killSwitch,
    readBudget,
    activity,
  });

  // Start transport
  if (config.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Server running on stdio');
  } else {
    logger.fatal(
      'SSE transport is not yet implemented. Use stdio mode (the default) or implement SSE support against the installed SDK version.',
    );
    process.exit(1);
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
      auditLog.close();
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
