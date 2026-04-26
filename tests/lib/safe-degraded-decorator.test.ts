import { describe, it, expect } from 'vitest';
import { decorateReadResponse, type SafeDegradedRef } from '../../src/lib/safe-degraded-decorator.js';

const off: SafeDegradedRef = { value: false, reason: null };
const on: SafeDegradedRef = { value: true, reason: 'AUDIT_CHAIN_BROKEN' };

describe('decorateReadResponse', () => {
  it('returns result unchanged when safe-degraded is off', () => {
    expect(decorateReadResponse({ data: [1, 2, 3] }, off)).toEqual({ data: [1, 2, 3] });
  });

  it('prepends _security_notice when safe-degraded is on (object result)', () => {
    const out = decorateReadResponse({ data: 'x' }, on) as Record<string, unknown>;
    expect(out._security_notice).toEqual({
      severity: 'high',
      message: expect.stringContaining('AUDIT_CHAIN_BROKEN'),
    });
    expect(out.data).toBe('x');
  });

  it('lists _security_notice as the first key (so it precedes data in JSON)', () => {
    const out = decorateReadResponse({ data: 'x', other: 'y' }, on) as Record<string, unknown>;
    expect(Object.keys(out)[0]).toBe('_security_notice');
  });

  it('wraps array results so the notice is still surfaced', () => {
    const out = decorateReadResponse([1, 2, 3], on) as { _security_notice: unknown; value: number[] };
    expect(out._security_notice).toBeDefined();
    expect(out.value).toEqual([1, 2, 3]);
  });

  it('wraps primitive results', () => {
    const out = decorateReadResponse('plain', on) as { _security_notice: unknown; value: string };
    expect(out._security_notice).toBeDefined();
    expect(out.value).toBe('plain');
  });

  it('uses reason "unknown" when ref.reason is null but value is true', () => {
    const out = decorateReadResponse({}, { value: true, reason: null }) as Record<string, { message: string }>;
    expect(out._security_notice.message).toContain('unknown');
  });
});
