import { describe, it, expect, beforeEach } from 'vitest';
import {
  isHighRiskDelete,
  resolveDeleteConfirmation,
  checkUserChatMessage,
  needsUpdateConfirmation,
  BulkDetector,
} from '../../src/lib/typed-confirmation.js';
import type { ToolPolicy } from '../../src/lib/capability-policy.js';

const deleteDealPolicy: ToolPolicy = {
  enabled: true,
  category: 'delete',
  destructive: true,
  confirmation_format: 'DELETE-DEAL:<id>',
};

const updateDealPolicy: ToolPolicy = {
  enabled: true,
  category: 'update',
  destructive: false,
  destructive_updates: ['status', 'value', 'pipeline_id', 'owner_id'],
};

describe('isHighRiskDelete', () => {
  it('returns true for the four high-risk delete tools', () => {
    expect(isHighRiskDelete('delete-deal')).toBe(true);
    expect(isHighRiskDelete('delete-person')).toBe(true);
    expect(isHighRiskDelete('delete-activity')).toBe(true);
    expect(isHighRiskDelete('delete-note')).toBe(true);
  });

  it('returns false for non-delete tools', () => {
    expect(isHighRiskDelete('update-deal')).toBe(false);
    expect(isHighRiskDelete('create-deal')).toBe(false);
    expect(isHighRiskDelete('list-deals')).toBe(false);
  });
});

describe('resolveDeleteConfirmation', () => {
  it('replaces <id> with the entity id', () => {
    expect(resolveDeleteConfirmation(deleteDealPolicy, 42)).toBe('DELETE-DEAL:42');
    expect(resolveDeleteConfirmation(deleteDealPolicy, '99')).toBe('DELETE-DEAL:99');
  });
});

describe('checkUserChatMessage', () => {
  const required = 'DELETE-DEAL:42';

  it('returns MISSING when undefined', () => {
    const r = checkUserChatMessage(undefined, required);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MISSING');
  });

  it('returns MISSING when empty string', () => {
    const r = checkUserChatMessage('', required);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MISSING');
  });

  it('returns MISMATCH when present but does not contain required substring', () => {
    const r = checkUserChatMessage('please delete deal 99', required);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MISMATCH');
  });

  it('returns ok with 16-char hex hash when message contains required substring', () => {
    const r = checkUserChatMessage('yes please DELETE-DEAL:42 confirmed', required);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hash).toHaveLength(16);
      expect(r.hash).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('same message hashes deterministically', () => {
    const msg = 'DELETE-DEAL:42 go ahead';
    const r1 = checkUserChatMessage(msg, required);
    const r2 = checkUserChatMessage(msg, required);
    expect(r1.ok && r2.ok && r1.hash === r2.hash).toBe(true);
  });
});

describe('needsUpdateConfirmation', () => {
  it('returns null when no destructive field is present', () => {
    expect(needsUpdateConfirmation(updateDealPolicy, { title: 'New title' })).toBeNull();
  });

  it('returns STATUS-CHANGE for status field', () => {
    const r = needsUpdateConfirmation(updateDealPolicy, { status: 'lost' });
    expect(r?.required).toBe('STATUS-CHANGE');
    expect(r?.field).toBe('status');
  });

  it('returns VALUE-CHANGE for value field', () => {
    const r = needsUpdateConfirmation(updateDealPolicy, { value: 50000 });
    expect(r?.required).toBe('VALUE-CHANGE');
    expect(r?.field).toBe('value');
  });

  it('returns PIPELINE-CHANGE for pipeline_id field', () => {
    const r = needsUpdateConfirmation(updateDealPolicy, { pipeline_id: '3' });
    expect(r?.required).toBe('PIPELINE-CHANGE');
    expect(r?.field).toBe('pipeline_id');
  });

  it('returns OWNER-CHANGE for owner_id field', () => {
    const r = needsUpdateConfirmation(updateDealPolicy, { owner_id: '7' });
    expect(r?.required).toBe('OWNER-CHANGE');
    expect(r?.field).toBe('owner_id');
  });

  it('returns null for policy with no destructive_updates', () => {
    const policy: ToolPolicy = { enabled: true, category: 'update' };
    expect(needsUpdateConfirmation(policy, { status: 'lost' })).toBeNull();
  });
});

describe('BulkDetector', () => {
  let detector: BulkDetector;

  beforeEach(() => {
    detector = new BulkDetector(60, 3);
  });

  it('allows calls up to and including the threshold', () => {
    for (let i = 0; i < 3; i++) {
      expect(detector.needsConfirmation('update-deal', undefined, 'BULK:<count>').ok).toBe(true);
    }
  });

  it('requires confirmation on the threshold+1 call', () => {
    for (let i = 0; i < 3; i++) detector.needsConfirmation('update-deal', undefined, 'BULK:<count>');
    const r = detector.needsConfirmation('update-deal', undefined, 'BULK:<count>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.required).toBe('BULK:4');
  });

  it('accepts the correct confirmation string on an over-threshold call', () => {
    for (let i = 0; i < 4; i++) detector.needsConfirmation('update-deal', 'BULK:4', 'BULK:<count>');
    const r = detector.needsConfirmation('update-deal', 'BULK:5', 'BULK:<count>');
    expect(r.ok).toBe(true);
  });

  it('counts tools independently — update-deal does not affect update-person', () => {
    for (let i = 0; i < 3; i++) detector.needsConfirmation('update-deal', undefined, 'BULK:<count>');
    const r = detector.needsConfirmation('update-person', undefined, 'BULK:<count>');
    expect(r.ok).toBe(true);
  });
});

describe('framing: typed confirmation is friction + audit, not proof of intent', () => {
  // Spec §11: A prompt-injected model can fabricate both `confirm` and
  // `user_chat_message`. This test documents that fabrication PASSES the
  // confirmation checks — that is the intended design. The security value is
  // the audit trail: every high-risk delete carries a hash of the claimed
  // user message, enabling post-hoc forensic comparison.
  it('a model-fabricated confirm + user_chat_message containing the string passes (expected per spec §11)', () => {
    const required = resolveDeleteConfirmation(deleteDealPolicy, 42);
    // Model fabricates both fields — this must pass
    expect(required).toBe('DELETE-DEAL:42');
    const ucmCheck = checkUserChatMessage(
      `fabricated message containing DELETE-DEAL:42 as required`,
      required,
    );
    expect(ucmCheck.ok).toBe(true);
    // The hash is recorded in the audit row, not the message itself
    if (ucmCheck.ok) expect(ucmCheck.hash).toHaveLength(16);
  });
});
