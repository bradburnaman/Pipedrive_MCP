import { describe, it, expect } from 'vitest';
import {
  sanitizeParams,
  canonicalJson,
  requestHash,
  extractEntityId,
} from '../../src/lib/audit-middleware.js';

describe('sanitizeParams', () => {
  it('replaces PII string fields with a 16-char hash object', () => {
    const out = sanitizeParams({ email: 'brad@example.com', name: 'Brad' });
    expect(out.email).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(out.name).toBe('Brad');
  });

  it('hashes deterministically for the same input', () => {
    const a = sanitizeParams({ note: 'hi' });
    const b = sanitizeParams({ note: 'hi' });
    expect(a).toEqual(b);
  });

  it('redacts PII inside nested objects', () => {
    const out = sanitizeParams({ payload: { phone: '555-1212', label: 'cell' } }) as Record<string, Record<string, unknown>>;
    expect(out.payload.phone).toEqual({ hash: expect.any(String) });
    expect(out.payload.label).toBe('cell');
  });

  it('walks arrays and redacts PII inside object elements', () => {
    const out = sanitizeParams({ contacts: [{ email: 'a@b.com' }, { email: 'c@d.com' }] }) as
      { contacts: { email: { hash: string } }[] };
    expect(out.contacts[0].email).toEqual({ hash: expect.any(String) });
    expect(out.contacts[1].email).toEqual({ hash: expect.any(String) });
    expect(out.contacts[0].email.hash).not.toBe(out.contacts[1].email.hash);
  });

  it('passes non-string PII fields through unchanged', () => {
    const out = sanitizeParams({ email: null, phone: 42 });
    expect(out.email).toBeNull();
    expect(out.phone).toBe(42);
  });
});

describe('canonicalJson', () => {
  it('produces identical output regardless of key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('handles nested objects with sorted keys at every level', () => {
    expect(canonicalJson({ x: { c: 3, b: 2, a: 1 } }))
      .toBe('{"x":{"a":1,"b":2,"c":3}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(42)).toBe('42');
  });
});

describe('requestHash', () => {
  it('is stable across key order', () => {
    const a = requestHash('create-deal', { title: 't', value: 100 });
    const b = requestHash('create-deal', { value: 100, title: 't' });
    expect(a).toBe(b);
  });

  it('changes when tool name changes', () => {
    expect(requestHash('create-deal', { id: 1 })).not.toBe(requestHash('update-deal', { id: 1 }));
  });

  it('changes when params change', () => {
    expect(requestHash('create-deal', { id: 1 })).not.toBe(requestHash('create-deal', { id: 2 }));
  });

  it('produces a 64-char sha256 hex', () => {
    expect(requestHash('t', {})).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes PII consistently — request_hash collapses raw PII into stable token', () => {
    const a = requestHash('add-note', { content: 'secret' });
    const b = requestHash('add-note', { content: 'secret' });
    const c = requestHash('add-note', { content: 'different' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('extractEntityId', () => {
  it('reads result.id when present', () => {
    expect(extractEntityId({}, { id: 42 })).toBe('42');
  });

  it('reads result.data.id when present', () => {
    expect(extractEntityId({}, { data: { id: 'abc' } })).toBe('abc');
  });

  it('falls back to params.id', () => {
    expect(extractEntityId({ id: 7 }, null)).toBe('7');
  });

  it('falls back to entity-typed id keys in params', () => {
    expect(extractEntityId({ deal_id: 99 }, null)).toBe('99');
    expect(extractEntityId({ person_id: 'p1' }, null)).toBe('p1');
  });

  it('returns null when nothing matches', () => {
    expect(extractEntityId({ unrelated: 1 }, { other: 2 })).toBeNull();
  });

  it('prefers result.id over params.id', () => {
    expect(extractEntityId({ id: 1 }, { id: 2 })).toBe('2');
  });
});
