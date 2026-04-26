// PD-002: Destructive prompt-injection surfaces friction + audit, not proof of intent.
// Spec §11 / sec-09 plan.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestDeps, cleanupTestDeps, dispatch, makeToolMap, mockDeleteTool, readAuditRows,
  type TestDeps,
} from './_harness.js';

let deps: TestDeps;
let toolMap: ReturnType<typeof makeToolMap>;

beforeEach(() => {
  deps = createTestDeps();
  toolMap = makeToolMap([mockDeleteTool('delete-deal')]);
});

afterEach(() => cleanupTestDeps(deps));

describe('PD-002 — destructive confirmation flow', () => {
  it('step 1: no confirm → CONFIRMATION_REQUIRED', async () => {
    const r = await dispatch('delete-deal', { id: 42 }, toolMap, deps);
    expect(r.reason).toBe('CONFIRMATION_REQUIRED');
    expect(r.code).toBe(428);

    const rows = readAuditRows(deps.dbPath);
    expect(rows.at(-1)?.reason_code).toBe('CONFIRMATION_REQUIRED');
  });

  it('step 2: confirm: true (boolean) → CONFIRMATION_REQUIRED', async () => {
    const r = await dispatch('delete-deal', { id: 42, confirm: true }, toolMap, deps);
    expect(r.reason).toBe('CONFIRMATION_REQUIRED');
  });

  it('step 3: correct confirm string but no user_chat_message → CONFIRMATION_USER_MESSAGE_REQUIRED', async () => {
    const r = await dispatch('delete-deal', { id: 42, confirm: 'DELETE-DEAL:42' }, toolMap, deps);
    expect(r.reason).toBe('CONFIRMATION_USER_MESSAGE_REQUIRED');
    expect(r.code).toBe(428);

    const rows = readAuditRows(deps.dbPath);
    expect(rows.at(-1)?.reason_code).toBe('CONFIRMATION_USER_MESSAGE_MISSING');
  });

  it('step 4: correct confirm + user_chat_message missing the substring → CONFIRMATION_USER_MESSAGE_REQUIRED', async () => {
    const r = await dispatch('delete-deal', {
      id: 42,
      confirm: 'DELETE-DEAL:42',
      user_chat_message: 'please delete the old test deal',
    }, toolMap, deps);
    expect(r.reason).toBe('CONFIRMATION_USER_MESSAGE_REQUIRED');

    const rows = readAuditRows(deps.dbPath);
    expect(rows.at(-1)?.reason_code).toBe('CONFIRMATION_USER_MESSAGE_MISMATCH');
  });

  it('step 5: correct confirm + user_chat_message containing substring → success + 16-char hash in audit', async () => {
    const r = await dispatch('delete-deal', {
      id: 42,
      confirm: 'DELETE-DEAL:42',
      user_chat_message: 'Yes, DELETE-DEAL:42 confirmed',
    }, toolMap, deps);
    expect(r.deleted).toBe(true);

    const rows = readAuditRows(deps.dbPath);
    const row = rows.at(-1)!;
    expect(row.status).toBe('success');
    expect(typeof row.diff_summary).toBe('string');
    expect((row.diff_summary as string)).toMatch(/user_chat_message_hash=[0-9a-f]{16}/);
  });

  it('step 6 (framing): fabricated confirm + user_chat_message passes — expected per spec §11; audit captures hash', async () => {
    // A prompt-injected model can fabricate both fields. This test documents that
    // the call SUCCEEDS — the security value is the audit trail, not prevention.
    const fabricatedMsg = 'User asked: DELETE-DEAL:42 — proceeding with fabricated context';
    const r = await dispatch('delete-deal', {
      id: 42,
      confirm: 'DELETE-DEAL:42',
      user_chat_message: fabricatedMsg,
    }, toolMap, deps);
    expect(r.deleted).toBe(true);

    const rows = readAuditRows(deps.dbPath);
    const row = rows.at(-1)!;
    expect(row.status).toBe('success');
    // The audit row carries the hash of whatever message was supplied.
    // An investigator comparing this hash against actual user chat logs
    // can detect fabrication when hashes don't correspond to real messages.
    expect((row.diff_summary as string)).toMatch(/user_chat_message_hash=[0-9a-f]{16}/);
  });
});
