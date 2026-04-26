// src/index.ts

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertConfigDirSafe, assertCwdClean, configDir } from './lib/path-safety.js';
import {
  getToken, evaluateRotation, envOverrideAllowed, permissionRepairEvents,
} from './lib/secret-store.js';
import { probeClaudeDesktopConfig } from './lib/claude-desktop-probe.js';
import { VERSION_ID, versionString, POLICY_HASH } from './lib/version-id.js';
import { AuditLog, type InsertInput } from './lib/audit-log.js';
import { loadPolicy, recomputeHash, PolicyHashMismatchError } from './lib/capability-policy.js';
import { KillSwitch } from './lib/kill-switch.js';
import { ReadBudget } from './lib/read-budget.js';
import { BulkDetector } from './lib/typed-confirmation.js';
import type { SafeDegradedRef } from './lib/safe-degraded-decorator.js';
import { parseConfig } from './config.js';
import { PipedriveClient } from './lib/pipedrive-client.js';
import { ReferenceResolver } from './lib/reference-resolver/index.js';
import { EntityResolver } from './lib/entity-resolver.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';

function writeExceptionsLog(entry: string): void {
  try {
    const path = join(configDir(), 'exceptions.log');
    appendFileSync(path, `${new Date().toISOString()} ${entry}\n`, { mode: 0o600 });
  } catch {
    // Best effort — don't let a logging failure crash the server.
  }
}

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

  // --- Capability policy load (sec-10) — moved before token loading so a tampered
  // policy file causes exit 1 before any network call is made.
  // BHG_CAPABILITIES_PATH overrides the path for integration testing.
  const capabilitiesPath = process.env.BHG_CAPABILITIES_PATH;
  let policy;
  try {
    policy = loadPolicy(capabilitiesPath);
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

  // --- Token resolution (Keychain first; env override is restricted) ---
  // Deferred audit events — written to the audit log once it is initialized below.
  const deferredAudit: InsertInput[] = [];

  let token: string;
  let issuedAt: string | null = null;

  const ov = envOverrideAllowed();
  if (ov.allowed && process.env.PIPEDRIVE_API_TOKEN) {
    token = process.env.PIPEDRIVE_API_TOKEN.trim();
    const reason = ov.reason ?? null;
    if (reason?.startsWith('break_glass:')) {
      const bgReason = reason.slice('break_glass:'.length);
      process.stderr.write(`WARNING: break-glass env override active. Reason: ${bgReason}\n`);
      writeExceptionsLog(`BREAK_GLASS_ENV_OVERRIDE reason="${bgReason}"`);
      deferredAudit.push({
        tool: '_startup', category: 'break_glass', entity_type: null, entity_id: null,
        status: 'success', reason_code: 'BREAK_GLASS_ENV_OVERRIDE',
        request_hash: '', target_summary: null,
        diff_summary: `reason=${bgReason}`, idempotency_key: null,
      });
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
      writeExceptionsLog(`STALE_TOKEN_EXCEPTION ageDays=${Math.floor(r.ageDays)} reason="${staleReason}"`);
      deferredAudit.push({
        tool: '_startup', category: 'break_glass', entity_type: null, entity_id: null,
        status: 'success', reason_code: 'STALE_TOKEN_EXCEPTION',
        request_hash: '', target_summary: `age_days=${Math.floor(r.ageDays)}`,
        diff_summary: `reason=${staleReason}`, idempotency_key: null,
      });
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
  }

  // --- Permission repair events ---
  if (permissionRepairEvents.length > 0) {
    logger.warn({ events: permissionRepairEvents }, 'Sensitive file permissions repaired at startup');
    for (const evt of permissionRepairEvents) {
      const failed = evt.after === -1;
      deferredAudit.push({
        tool: '_startup', category: 'policy', entity_type: null, entity_id: null,
        status: failed ? 'failure' : 'success',
        reason_code: failed ? 'PERMISSION_REPAIR_FAILED' : 'PERMISSION_REPAIRED',
        request_hash: '',
        target_summary: `${evt.path}: mode ${evt.before.toString(8)} -> ${failed ? 'FAILED' : evt.after.toString(8)}`,
        diff_summary: null, idempotency_key: null,
      });
    }
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

  const killSwitch = new KillSwitch();
  const readBudget = new ReadBudget(policy.read_budgets);
  const bulkDetector = new BulkDetector(
    policy.bulk_detector.window_seconds,
    policy.bulk_detector.threshold,
  );

  // --- Audit log + safe-degraded gate (sec-06) ---
  const auditLog = new AuditLog();
  const safeDegraded: SafeDegradedRef = { value: false, reason: null };
  const initialVerify = auditLog.verifyChain();
  if (!initialVerify.ok) {
    safeDegraded.value = true;
    safeDegraded.reason = 'AUDIT_CHAIN_BROKEN';
    logger.error(
      { breakAtId: initialVerify.breakAtId },
      'AUDIT_CHAIN_BROKEN — entering safe-degraded mode. Writes disabled; reads carry _security_notice. Run `npm run audit-verify` for details.',
    );
  }

  // Write deferred startup events now that the audit log is ready.
  for (const evt of deferredAudit) {
    auditLog.insert(evt);
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

  // Policy hot-check — runtime mismatch flips safe-degraded; does NOT exit.
  // BHG_POLICY_HOT_CHECK_MS overrides the interval for integration testing.
  const policyHotCheckMs = Number(process.env.BHG_POLICY_HOT_CHECK_MS) || 60_000;
  const policyHotCheck = setInterval(() => {
    if (safeDegraded.value) return;
    try {
      const got = recomputeHash(capabilitiesPath);
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
  }, policyHotCheckMs);
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
    policy,
    bulkDetector,
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
