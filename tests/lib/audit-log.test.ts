import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AuditLog, type InsertInput } from '../../src/lib/audit-log.js';
import { POLICY_HASH, versionString } from '../../src/lib/version-id.js';

let tmp: string;
let dbPath: string;
let log: AuditLog;

function baseInput(overrides: Partial<InsertInput> = {}): InsertInput {
  return {
    tool: 'create-deal',
    category: 'create',
    entity_type: 'deal',
    entity_id: '123',
    status: 'success',
    reason_code: null,
    request_hash: 'r' + '0'.repeat(63),
    target_summary: null,
    diff_summary: null,
    idempotency_key: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'audit-log-test-'));
  dbPath = join(tmp, 'audit.db');
  log = new AuditLog(dbPath);
});

afterEach(() => {
  log.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('AuditLog round-trip', () => {
  it('inserts and verifies a single row', () => {
    log.insert(baseInput());
    expect(log.verifyChain()).toEqual({ ok: true });
  });

  it('inserts five rows and verifies the chain', () => {
    for (let i = 0; i < 5; i++) {
      log.insert(baseInput({ entity_id: String(i) }));
    }
    expect(log.verifyChain()).toEqual({ ok: true });
  });

  it('emits stable correlation_id and assigns one if absent', () => {
    const r = log.insert(baseInput());
    expect(r.correlation_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('every row carries current versionString and POLICY_HASH', () => {
    for (let i = 0; i < 3; i++) log.insert(baseInput({ entity_id: String(i) }));
    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.prepare('SELECT version_id, policy_hash FROM audit_rows').all() as
      { version_id: string; policy_hash: string }[];
    raw.close();
    for (const row of rows) {
      expect(row.version_id).toBe(versionString());
      expect(row.policy_hash).toBe(POLICY_HASH);
    }
  });
});

describe('AuditLog tamper detection', () => {
  function tamper(fn: (db: Database.Database) => void) {
    log.close();
    const raw = new Database(dbPath);
    fn(raw);
    raw.close();
    log = new AuditLog(dbPath);
  }

  it('detects row_hash tamper at row 3', () => {
    for (let i = 0; i < 5; i++) log.insert(baseInput({ entity_id: String(i) }));
    tamper(db => db.prepare("UPDATE audit_rows SET row_hash = 'TAMPERED' WHERE id = 3").run());
    expect(log.verifyChain()).toEqual({ ok: false, breakAtId: 3 });
  });

  it('detects entity_id tamper at row 3 (canonical mismatch)', () => {
    for (let i = 0; i < 5; i++) log.insert(baseInput({ entity_id: String(i) }));
    tamper(db => db.prepare("UPDATE audit_rows SET entity_id = 'tampered' WHERE id = 3").run());
    expect(log.verifyChain()).toEqual({ ok: false, breakAtId: 3 });
  });

  it('detects target_summary tamper at row 3', () => {
    for (let i = 0; i < 5; i++) log.insert(baseInput({ entity_id: String(i), target_summary: `summary-${i}` }));
    tamper(db => db.prepare("UPDATE audit_rows SET target_summary = 'tampered' WHERE id = 3").run());
    expect(log.verifyChain()).toEqual({ ok: false, breakAtId: 3 });
  });

  it('detects deletion mid-chain — break shows at successor row', () => {
    for (let i = 0; i < 5; i++) log.insert(baseInput({ entity_id: String(i) }));
    tamper(db => db.prepare('DELETE FROM audit_rows WHERE id = 4').run());
    // Row 5's previous_hash was set when row 4 existed; row 4 is gone, so the
    // walk anchors row 5 to row 3's row_hash → mismatch on row 5.
    expect(log.verifyChain()).toEqual({ ok: false, breakAtId: 5 });
  });

  it('detects request_hash tamper at row 1 (boundary)', () => {
    for (let i = 0; i < 3; i++) log.insert(baseInput({ entity_id: String(i) }));
    tamper(db => db.prepare("UPDATE audit_rows SET request_hash = 'tampered' WHERE id = 1").run());
    expect(log.verifyChain()).toEqual({ ok: false, breakAtId: 1 });
  });
});

describe('AuditLog verifyTail', () => {
  it('returns ok on empty DB', () => {
    expect(log.verifyTail(100)).toEqual({ ok: true });
  });

  it('passes when nothing has been tampered', () => {
    for (let i = 0; i < 10; i++) log.insert(baseInput({ entity_id: String(i) }));
    expect(log.verifyTail(5)).toEqual({ ok: true });
  });

  it('detects a tail-window tamper (last 5 rows, tamper row 8)', () => {
    for (let i = 0; i < 10; i++) log.insert(baseInput({ entity_id: String(i) }));
    log.close();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE audit_rows SET entity_id = 'tampered' WHERE id = 8").run();
    raw.close();
    log = new AuditLog(dbPath);
    expect(log.verifyTail(5)).toEqual({ ok: false, breakAtId: 8 });
  });

  it('does NOT detect tamper outside the tail window — but verifyChain does', () => {
    for (let i = 0; i < 10; i++) log.insert(baseInput({ entity_id: String(i) }));
    log.close();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE audit_rows SET entity_id = 'tampered' WHERE id = 2").run();
    raw.close();
    log = new AuditLog(dbPath);
    // Tail of 3 covers rows 8,9,10 — anchored to row 7's row_hash (still
    // intact), so the tail walk passes.
    expect(log.verifyTail(3)).toEqual({ ok: true });
    // Full walk catches row 2.
    expect(log.verifyChain()).toEqual({ ok: false, breakAtId: 2 });
  });
});

describe('AuditLog schema nullability (sec-06 → sec-10 contract)', () => {
  it('accepts null target_summary and null diff_summary on insert', () => {
    expect(() =>
      log.insert(baseInput({ target_summary: null, diff_summary: null }))
    ).not.toThrow();
    expect(log.verifyChain()).toEqual({ ok: true });
  });

  // TODO(sec-10): once per-tool helpers populate target_summary and
  // diff_summary for create/update/delete, replace this assertion with one
  // that REQUIRES non-null summaries for those categories. SECURITY_CHECKLIST
  // (sec-08) must explicitly accept null summaries until then.
  it('schema permits NULL target_summary and diff_summary (raw SQL probe)', () => {
    log.close();
    const raw = new Database(dbPath);
    const cols = raw.prepare('PRAGMA table_info(audit_rows)').all() as
      { name: string; notnull: number }[];
    raw.close();
    log = new AuditLog(dbPath);
    const target = cols.find(c => c.name === 'target_summary');
    const diff = cols.find(c => c.name === 'diff_summary');
    expect(target?.notnull).toBe(0);
    expect(diff?.notnull).toBe(0);
  });
});
