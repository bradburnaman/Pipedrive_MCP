// PD-006: URL token leak prevention via log sanitizer.
// Verifies that api_token query params and raw 40-hex tokens are
// stripped before any string reaches the audit log or error messages.
import { describe, it, expect } from 'vitest';
import { redactUrl, stripTokenPattern } from '../../src/lib/sanitize-log.js';

describe('PD-006 — URL token redaction (redactUrl)', () => {
  const FAKE_TOKEN = 'a'.repeat(40); // 40-hex placeholder

  it('redacts api_token= in a bare query string', () => {
    const raw = `https://api.pipedrive.com/v1/deals?api_token=${FAKE_TOKEN}`;
    expect(redactUrl(raw)).toBe('https://api.pipedrive.com/v1/deals?api_token=[REDACTED]');
  });

  it('redacts api_token= when not the first query param', () => {
    const raw = `https://api.pipedrive.com/v1/deals?start=0&api_token=${FAKE_TOKEN}&limit=100`;
    expect(redactUrl(raw)).toBe('https://api.pipedrive.com/v1/deals?start=0&api_token=[REDACTED]&limit=100');
  });

  it('redacts api_token= in a URL object', () => {
    const url = new URL(`https://api.pipedrive.com/v1/persons?api_token=${FAKE_TOKEN}`);
    expect(redactUrl(url)).toBe(`https://api.pipedrive.com/v1/persons?api_token=[REDACTED]`);
  });

  it('is case-insensitive on the param name (replacement is always lowercase)', () => {
    // The /gi flag matches API_TOKEN= but the replacement string is literal 'api_token='
    const raw = `https://api.pipedrive.com/v1/deals?API_TOKEN=${FAKE_TOKEN}`;
    expect(redactUrl(raw)).toBe('https://api.pipedrive.com/v1/deals?api_token=[REDACTED]');
  });

  it('leaves unrelated query params untouched', () => {
    const raw = 'https://api.pipedrive.com/v1/deals?start=0&limit=100';
    expect(redactUrl(raw)).toBe(raw);
  });
});

describe('PD-006 — raw token pattern stripping (stripTokenPattern)', () => {
  const REAL_LOOKING_TOKEN = 'deadbeef'.repeat(5); // 40-char hex

  it('redacts a 40-hex token embedded in an error message', () => {
    const msg = `Request failed: token=${REAL_LOOKING_TOKEN}`;
    expect(stripTokenPattern(msg)).toBe('Request failed: token=[REDACTED-40HEX]');
  });

  it('redacts multiple 40-hex tokens in the same string', () => {
    const msg = `token1=${REAL_LOOKING_TOKEN} token2=${REAL_LOOKING_TOKEN}`;
    expect(stripTokenPattern(msg)).not.toContain(REAL_LOOKING_TOKEN);
  });

  it('does NOT redact strings shorter than 40 hex chars', () => {
    const short = 'deadbeef'; // 8 chars
    expect(stripTokenPattern(short)).toBe(short);
  });

  it('does NOT redact non-hex 40-char strings', () => {
    const nonHex = 'z'.repeat(40);
    expect(stripTokenPattern(nonHex)).toBe(nonHex);
  });

  it('does NOT redact 41-char hex strings (too long)', () => {
    const tooLong = 'a'.repeat(41);
    expect(stripTokenPattern(tooLong)).toBe(tooLong);
  });
});
