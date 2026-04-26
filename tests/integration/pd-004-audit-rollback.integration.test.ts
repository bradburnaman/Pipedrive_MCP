// PD-004: Audit rollback — documented residual risk.
// This test asserts a KNOWN LIMITATION: local-only DB rollback cannot be detected
// without a remote mirror. It is named explicitly so future contributors understand
// this is documentation of a residual risk, not a defect. See spec §16.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from '../../src/lib/audit-log.js';
import {
  createTestDeps, cleanupTestDeps, dispatch, makeToolMap, mockCreateTool, type TestDeps,
} from './_harness.js';

let deps: TestDeps;
let toolMap: ReturnType<typeof makeToolMap>;

beforeEach(() => {
  deps = createTestDeps();
  toolMap = makeToolMap([mockCreateTool('create-deal')]);
});

afterEach(() => cleanupTestDeps(deps));

describe('PD-004 — audit rollback residual risk (documented limitation)', () => {
  it('documents that local-only rollback cannot be detected without a remote mirror', async () => {
    // Produce 5 rows
    for (let i = 0; i < 5; i++) {
      await dispatch('create-deal', { title: `Deal ${i}` }, toolMap, deps);
    }

    const snapshot = join(deps.tmpDir, 'audit.db.snapshot');
    copyFileSync(deps.dbPath, snapshot);

    // Produce 5 more rows
    for (let i = 5; i < 10; i++) {
      await dispatch('create-deal', { title: `Deal ${i}` }, toolMap, deps);
    }

    // "Roll back" by closing current log and restoring snapshot
    deps.auditLog.close();
    copyFileSync(snapshot, deps.dbPath);

    // Open a fresh AuditLog on the rolled-back DB
    const rolledBackLog = new AuditLog(deps.dbPath);
    const result = rolledBackLog.verifyChain();
    rolledBackLog.close();

    // This is the residual risk: the rolled-back chain still verifies.
    // The compensating control is the remote audit-log mirror (spec §16).
    expect(result).toEqual({ ok: true }); // rollback undetected — this is the point

    // Prevent cleanupTestDeps from trying to close the already-closed log
    deps.auditLog = new AuditLog(deps.dbPath);
  });
});
