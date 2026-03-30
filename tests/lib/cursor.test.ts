import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/lib/cursor.js';

describe('encodeCursor', () => {
  it('encodes a v2 cursor', () => {
    const encoded = encodeCursor({ v: 'v2', cursor: 'abc123' });
    expect(typeof encoded).toBe('string');
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ v: 'v2', cursor: 'abc123' });
  });

  it('encodes a v1 offset', () => {
    const encoded = encodeCursor({ v: 'v1', offset: 200 });
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ v: 'v1', offset: 200 });
  });
});

describe('decodeCursor', () => {
  it('decodes a valid v2 cursor', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v2', cursor: 'xyz' })).toString('base64');
    expect(decodeCursor(payload)).toEqual({ v: 'v2', cursor: 'xyz' });
  });

  it('decodes a valid v1 offset', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: 100 })).toString('base64');
    expect(decodeCursor(payload)).toEqual({ v: 'v1', offset: 100 });
  });

  it('throws on invalid base64', () => {
    expect(() => decodeCursor('not-valid-base64!!!')).toThrow('Invalid cursor — start a new list request without a cursor.');
  });

  it('throws on invalid JSON', () => {
    const payload = Buffer.from('not json').toString('base64');
    expect(() => decodeCursor(payload)).toThrow('Invalid cursor — start a new list request without a cursor.');
  });

  it('throws on missing v field', () => {
    const payload = Buffer.from(JSON.stringify({ offset: 100 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow('Invalid cursor — start a new list request without a cursor.');
  });

  it('throws on unrecognized v value', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v3', offset: 100 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow('Invalid cursor — start a new list request without a cursor.');
  });

  it('throws on negative offset for v1', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: -5 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow('Invalid cursor — start a new list request without a cursor.');
  });

  it('throws on non-integer offset for v1', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: 3.14 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow('Invalid cursor — start a new list request without a cursor.');
  });

  it('throws on missing cursor for v2', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v2' })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow('Invalid cursor — start a new list request without a cursor.');
  });
});
