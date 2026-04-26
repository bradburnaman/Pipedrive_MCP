import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { Writable } from 'node:stream';
import { dispatchToolCall, type ServerDeps, type ToolCallResult } from '../src/server.js';
import { AuditLog } from '../src/lib/audit-log.js';
import type { ToolDefinition } from '../src/types.js';

let tmp: string;
let dbPath: string;
let auditLog: AuditLog;
let deps: ServerDeps;
const sink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = pino({ level: 'silent' }, sink);

function readToolResult(r: ToolCallResult): unknown {
  return JSON.parse((r.content[0] as { text: string }).text);
}

function rowsFor(tool: string) {
  const raw = new Database(dbPath, { readonly: true });
  const out = raw.prepare('SELECT * FROM audit_rows WHERE tool = ? ORDER BY id ASC').all(tool);
  raw.close();
  return out as Record<string, unknown>[];
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'server-dispatch-test-'));
  dbPath = join(tmp, 'audit.db');
  auditLog = new AuditLog(dbPath);
  deps = {
    auditLog,
    safeDegraded: { value: false, reason: null },
    killSwitch: { writesEnabled: true } as any,
    activity: { lastActivityMs: 0 },
  };
});

afterEach(() => {
  auditLog.close();
  rmSync(tmp, { recursive: true, force: true });
});

const readTool: ToolDefinition = {
  name: 'get-thing',
  category: 'read',
  description: 'reads',
  inputSchema: { type: 'object' },
  handler: async () => ({ data: 'ok' }),
};

const writeTool: ToolDefinition = {
  name: 'create-thing',
  category: 'create',
  description: 'creates',
  inputSchema: { type: 'object' },
  handler: async (params) => ({ id: 99, echo: params }),
};

const errorWriteTool: ToolDefinition = {
  name: 'update-thing',
  category: 'update',
  description: 'updates with error envelope',
  inputSchema: { type: 'object' },
  handler: async () => ({ error: true, code: 404, message: 'not found' }),
};

const throwingWriteTool: ToolDefinition = {
  name: 'delete-thing',
  category: 'delete',
  description: 'throws',
  inputSchema: { type: 'object' },
  handler: async () => { throw new Error('boom'); },
};

function map(...tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map(t => [t.name, t]));
}

describe('dispatchToolCall — read path', () => {
  it('returns result and writes NO audit row', async () => {
    const r = await dispatchToolCall('get-thing', {}, map(readTool), deps, logger);
    expect(readToolResult(r)).toEqual({ data: 'ok' });
    expect(rowsFor('get-thing')).toHaveLength(0);
  });

  it('bumps activity.lastActivityMs', async () => {
    deps.activity.lastActivityMs = 0;
    await dispatchToolCall('get-thing', {}, map(readTool), deps, logger);
    expect(deps.activity.lastActivityMs).toBeGreaterThan(0);
  });

  it('decorates read result with _security_notice when safe-degraded', async () => {
    deps.safeDegraded.value = true;
    deps.safeDegraded.reason = 'AUDIT_CHAIN_BROKEN';
    const r = await dispatchToolCall('get-thing', {}, map(readTool), deps, logger);
    const out = readToolResult(r) as Record<string, unknown>;
    expect(out._security_notice).toMatchObject({ severity: 'high' });
    expect(out.data).toBe('ok');
    expect(rowsFor('get-thing')).toHaveLength(0);
  });
});

describe('dispatchToolCall — write path (happy)', () => {
  it('returns result and writes a success audit row', async () => {
    const r = await dispatchToolCall('create-thing', { title: 't' }, map(writeTool), deps, logger);
    expect(readToolResult(r)).toMatchObject({ id: 99 });
    const rows = rowsFor('create-thing');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'create-thing',
      category: 'create',
      status: 'success',
      reason_code: null,
      entity_id: '99',
    });
    expect(rows[0].request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].target_summary).toBeNull();
    expect(rows[0].diff_summary).toBeNull();
  });

  it('writes a failure row when handler returns error envelope', async () => {
    const r = await dispatchToolCall('update-thing', { id: 1 }, map(errorWriteTool), deps, logger);
    expect(readToolResult(r)).toMatchObject({ error: true, code: 404 });
    const rows = rowsFor('update-thing');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failure',
      reason_code: '404',
    });
  });

  it('writes a failure row when handler throws', async () => {
    const r = await dispatchToolCall('delete-thing', { id: 1 }, map(throwingWriteTool), deps, logger);
    expect(r.isError).toBe(true);
    expect(readToolResult(r)).toMatchObject({ error: true });
    const rows = rowsFor('delete-thing');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failure',
      reason_code: 'EXCEPTION',
    });
  });
});

describe('dispatchToolCall — safe-degraded gate', () => {
  it('rejects writes with 503 + safe_degraded_rejected audit row', async () => {
    deps.safeDegraded.value = true;
    deps.safeDegraded.reason = 'AUDIT_CHAIN_BROKEN';
    const r = await dispatchToolCall('create-thing', { x: 1 }, map(writeTool), deps, logger);
    expect(r.isError).toBe(true);
    const out = readToolResult(r) as Record<string, unknown>;
    expect(out).toMatchObject({ error: true, code: 503 });
    expect(out.message).toContain('AUDIT_CHAIN_BROKEN');

    const rows = rowsFor('create-thing');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'safe_degraded_rejected',
      reason_code: 'AUDIT_CHAIN_BROKEN',
    });
  });

  it('does NOT call the underlying handler when in safe-degraded mode', async () => {
    let called = false;
    const tool: ToolDefinition = {
      ...writeTool,
      handler: async () => { called = true; return { id: 1 }; },
    };
    deps.safeDegraded.value = true;
    deps.safeDegraded.reason = 'AUDIT_CHAIN_BROKEN';
    await dispatchToolCall('create-thing', {}, map(tool), deps, logger);
    expect(called).toBe(false);
  });

  it('preserves audit chain integrity across rejections', async () => {
    deps.safeDegraded.value = true;
    deps.safeDegraded.reason = 'AUDIT_CHAIN_BROKEN';
    for (let i = 0; i < 3; i++) {
      await dispatchToolCall('create-thing', { i }, map(writeTool), deps, logger);
    }
    expect(auditLog.verifyChain()).toEqual({ ok: true });
  });
});

describe('dispatchToolCall — unknown tool', () => {
  it('returns error envelope without auditing', async () => {
    const r = await dispatchToolCall('nope', {}, map(), deps, logger);
    expect(r.isError).toBe(true);
    expect((readToolResult(r) as { message: string }).message).toContain("Tool 'nope' not found");
  });
});
