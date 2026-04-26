import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { configDir, assertPathSafe } from './path-safety.js';
import { versionString, POLICY_HASH } from './version-id.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_rows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  tool            TEXT NOT NULL,
  category        TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  status          TEXT NOT NULL,
  reason_code     TEXT,
  request_hash    TEXT NOT NULL,
  target_summary  TEXT,
  diff_summary    TEXT,
  idempotency_key TEXT,
  correlation_id  TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  policy_hash     TEXT NOT NULL,
  previous_hash   TEXT NOT NULL,
  row_hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ts ON audit_rows(ts);
`;

export type AuditCategory =
  | 'create' | 'update' | 'delete'
  | 'read_budget' | 'broad_query' | 'policy' | 'kill_switch' | 'break_glass';

export type AuditStatus =
  | 'success' | 'failure' | 'rejected' | 'safe_degraded_rejected';

export interface AuditRow {
  id?: number;
  ts: string;
  tool: string;
  category: AuditCategory;
  entity_type: string | null;
  entity_id: string | null;
  status: AuditStatus;
  reason_code: string | null;
  request_hash: string;
  // TODO(sec-10): target_summary and diff_summary remain nullable until per-tool
  // helpers land alongside the confirmation flow. sec-06 audit chain is complete
  // without them; sec-10 either populates them or the SECURITY_CHECKLIST
  // explicitly accepts null summaries for non-destructive writes.
  target_summary: string | null;
  diff_summary: string | null;
  idempotency_key: string | null;
  correlation_id: string;
  version_id: string;
  policy_hash: string;
  previous_hash: string;
  row_hash: string;
}

export type InsertInput =
  Omit<AuditRow, 'id' | 'ts' | 'version_id' | 'policy_hash' | 'previous_hash' | 'row_hash' | 'correlation_id'>
  & { correlation_id?: string };

// Fixed genesis marker — does NOT mix in versionString() so the chain survives
// version changes between runs. version_id travels in each row instead.
const GENESIS = createHash('sha256').update('GENESIS').digest('hex');

function canonicalize(row: Omit<AuditRow, 'id' | 'row_hash'>): string {
  return [
    row.previous_hash,
    row.ts,
    row.tool,
    row.category,
    row.entity_type ?? '',
    row.entity_id ?? '',
    row.status,
    row.reason_code ?? '',
    row.request_hash,
    row.target_summary ?? '',
    row.diff_summary ?? '',
    row.idempotency_key ?? '',
    row.correlation_id,
    row.version_id,
    row.policy_hash,
  ].join('\n');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export class AuditLog {
  private db: Database.Database;

  constructor(dbPath: string = join(configDir(), 'audit.db')) {
    assertPathSafe(dbPath, { purpose: 'audit-db' });
    const dir = join(dbPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  private lastHash(): string {
    const row = this.db
      .prepare('SELECT row_hash FROM audit_rows ORDER BY id DESC LIMIT 1')
      .get() as { row_hash: string } | undefined;
    return row?.row_hash ?? GENESIS;
  }

  insert(input: InsertInput): AuditRow {
    const ts = new Date().toISOString();
    const correlation_id = input.correlation_id ?? randomUUID();
    const previous_hash = this.lastHash();
    const row_no_hash: Omit<AuditRow, 'id' | 'row_hash'> = {
      ts,
      tool: input.tool,
      category: input.category,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      status: input.status,
      reason_code: input.reason_code,
      request_hash: input.request_hash,
      target_summary: input.target_summary,
      diff_summary: input.diff_summary,
      idempotency_key: input.idempotency_key,
      correlation_id,
      version_id: versionString(),
      policy_hash: POLICY_HASH,
      previous_hash,
    };
    const row_hash = sha256(canonicalize(row_no_hash));
    this.db.prepare(`
      INSERT INTO audit_rows (
        ts, tool, category, entity_type, entity_id, status, reason_code,
        request_hash, target_summary, diff_summary,
        idempotency_key, correlation_id, version_id, policy_hash, previous_hash, row_hash
      ) VALUES (
        @ts, @tool, @category, @entity_type, @entity_id, @status, @reason_code,
        @request_hash, @target_summary, @diff_summary,
        @idempotency_key, @correlation_id, @version_id, @policy_hash, @previous_hash, @row_hash
      )
    `).run({ ...row_no_hash, row_hash });
    return { ...row_no_hash, row_hash };
  }

  verifyChain(): { ok: true } | { ok: false; breakAtId: number } {
    const rows = this.db
      .prepare('SELECT * FROM audit_rows ORDER BY id ASC')
      .all() as AuditRow[];
    let expected = GENESIS;
    for (const row of rows) {
      if (row.previous_hash !== expected) return { ok: false, breakAtId: row.id! };
      const recomputed = sha256(canonicalize(row));
      if (recomputed !== row.row_hash) return { ok: false, breakAtId: row.id! };
      expected = row.row_hash;
    }
    return { ok: true };
  }

  // Walks only the last N rows, anchoring expected previous_hash to the row
  // immediately before them. Cheap hot-check for use on a 60s timer. Will NOT
  // detect modifications to rows older than the tail window — those are caught
  // at startup or by the idle re-verify (full verifyChain) in sec-06b.
  verifyTail(n: number = 100): { ok: true } | { ok: false; breakAtId: number } {
    const totalRow = this.db
      .prepare('SELECT COUNT(*) AS c FROM audit_rows')
      .get() as { c: number };
    const total = totalRow.c;
    if (total === 0) return { ok: true };

    const startId = Math.max(1, total - n + 1);
    let expected: string;
    if (startId === 1) {
      expected = GENESIS;
    } else {
      const anchor = this.db
        .prepare('SELECT row_hash FROM audit_rows WHERE id < ? ORDER BY id DESC LIMIT 1')
        .get(startId) as { row_hash: string } | undefined;
      expected = anchor?.row_hash ?? GENESIS;
    }

    const rows = this.db
      .prepare('SELECT * FROM audit_rows WHERE id >= ? ORDER BY id ASC')
      .all(startId) as AuditRow[];
    for (const row of rows) {
      if (row.previous_hash !== expected) return { ok: false, breakAtId: row.id! };
      const recomputed = sha256(canonicalize(row));
      if (recomputed !== row.row_hash) return { ok: false, breakAtId: row.id! };
      expected = row.row_hash;
    }
    return { ok: true };
  }

  close(): void {
    this.db.close();
  }
}
