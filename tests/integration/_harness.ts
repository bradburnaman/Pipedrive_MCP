// Shared helpers for security integration tests.
// These tests run in-process (no Keychain, no Pipedrive) using real security
// deps (AuditLog, KillSwitch, ReadBudget, BulkDetector) pointed at temp dirs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pino from 'pino';
import { Writable } from 'node:stream';
import { AuditLog } from '../../src/lib/audit-log.js';
import { loadPolicy } from '../../src/lib/capability-policy.js';
import { KillSwitch } from '../../src/lib/kill-switch.js';
import { ReadBudget } from '../../src/lib/read-budget.js';
import { BulkDetector } from '../../src/lib/typed-confirmation.js';
import { dispatchToolCall, type ServerDeps } from '../../src/server.js';
import type { ToolDefinition } from '../../src/types.js';
import type { SafeDegradedRef } from '../../src/lib/safe-degraded-decorator.js';

export const silentLogger = pino({ level: 'silent' }, new Writable({ write(_c, _e, cb) { cb(); } }));

export interface TestDeps extends ServerDeps {
  tmpDir: string;
  dbPath: string;
  configPath: string;
}

// Creates a full ServerDeps backed by temp files. Caller must call cleanup() when done.
export function createTestDeps(): TestDeps {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bhg-sec-test-'));
  const dbPath = join(tmpDir, 'audit.db');
  const configPath = join(tmpDir, 'config.json');
  const policy = loadPolicy(); // from real CWD capabilities.json
  const auditLog = new AuditLog(dbPath);
  const safeDegraded: SafeDegradedRef = { value: false, reason: null };
  const killSwitch = new KillSwitch(configPath);
  const readBudget = new ReadBudget(policy.read_budgets);
  const bulkDetector = new BulkDetector(
    policy.bulk_detector.window_seconds,
    policy.bulk_detector.threshold,
  );
  return {
    tmpDir, dbPath, configPath,
    auditLog, safeDegraded, killSwitch, readBudget, policy, bulkDetector,
    activity: { lastActivityMs: Date.now() },
  };
}

export function cleanupTestDeps(deps: TestDeps): void {
  deps.auditLog.close();
  rmSync(deps.tmpDir, { recursive: true, force: true });
}

// Read audit rows directly from the db after tests
export function readAuditRows(dbPath: string): Array<Record<string, unknown>> {
  // Import lazily so we don't bring in better-sqlite3 at module load time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof import('better-sqlite3').default;
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM audit_rows ORDER BY id ASC').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

// Mock ToolDefinition builders
export function mockReadTool(name: string, result: unknown = { items: [] }): ToolDefinition {
  return {
    name,
    category: 'read',
    description: `mock ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => result,
  };
}

export function mockCreateTool(name: string, result: unknown = { id: 42 }): ToolDefinition {
  return {
    name,
    category: 'create',
    description: `mock ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => result,
  };
}

export function mockUpdateTool(name: string, result: unknown = { id: 42 }): ToolDefinition {
  return {
    name,
    category: 'update',
    description: `mock ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => result,
  };
}

export function mockDeleteTool(name: string, result: unknown = { id: 42, deleted: true }): ToolDefinition {
  return {
    name,
    category: 'delete',
    description: `mock ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => result,
  };
}

export function makeToolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map(t => [t.name, t]));
}

// Convenience: dispatch a tool call and parse the result JSON
export async function dispatch(
  toolName: string,
  params: Record<string, unknown>,
  toolMap: Map<string, ToolDefinition>,
  deps: ServerDeps,
): Promise<Record<string, unknown>> {
  const r = await dispatchToolCall(toolName, params, toolMap, deps, silentLogger);
  return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
}

// Spawn a child process and return { exitCode, stderr }. Used for tests that
// verify startup-exit behaviour without a full server lifecycle.
export interface SpawnResult { exitCode: number; stderr: string; stdout: string }
export function spawnProcess(cmd: string, args: string[], opts: {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
} = {}): SpawnResult {
  const result = spawnSync(cmd, args, {
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd ?? process.cwd(),
    timeout: opts.timeoutMs ?? 10_000,
    encoding: 'utf8',
  });
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}
