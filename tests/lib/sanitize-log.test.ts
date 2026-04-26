import { describe, it, expect } from 'vitest';
import { redactUrl, stripTokenPattern } from '../../src/lib/sanitize-log.js';

describe('redactUrl', () => {
  it('redacts api_token in query string', () => {
    expect(redactUrl('https://api.pipedrive.com/v1/deals?api_token=abcdef1234'))
      .toBe('https://api.pipedrive.com/v1/deals?api_token=[REDACTED]');
  });

  it('redacts api_token regardless of position', () => {
    expect(redactUrl('https://x/y?a=1&api_token=foo&b=2'))
      .toBe('https://x/y?a=1&api_token=[REDACTED]&b=2');
  });

  it('leaves URLs without api_token unchanged', () => {
    expect(redactUrl('https://x/y?a=1')).toBe('https://x/y?a=1');
  });

  it('accepts a URL object', () => {
    const u = new URL('https://api.pipedrive.com/v1/deals?api_token=secret&limit=10');
    expect(redactUrl(u)).toBe('https://api.pipedrive.com/v1/deals?api_token=[REDACTED]&limit=10');
  });

  it('preserves fragment after redaction', () => {
    expect(redactUrl('https://x/y?api_token=abc#frag'))
      .toBe('https://x/y?api_token=[REDACTED]#frag');
  });

  it('redacts multiple api_token occurrences', () => {
    expect(redactUrl('https://x/y?api_token=a&z=1&api_token=b'))
      .toBe('https://x/y?api_token=[REDACTED]&z=1&api_token=[REDACTED]');
  });
});

describe('stripTokenPattern', () => {
  it('strips 40-char hex tokens', () => {
    const t = 'a'.repeat(40);
    expect(stripTokenPattern(`error at ${t} boom`)).toContain('[REDACTED-40HEX]');
    expect(stripTokenPattern(`error at ${t} boom`)).not.toContain(t);
  });

  it('does not strip shorter hex strings', () => {
    expect(stripTokenPattern('abc123')).toBe('abc123');
  });

  it('does not strip 39 or 41 hex chars', () => {
    const short = 'a'.repeat(39);
    const long = 'a'.repeat(41);
    expect(stripTokenPattern(short)).toBe(short);
    expect(stripTokenPattern(long)).toBe(long);
  });

  it('does not strip non-hex 40-char strings', () => {
    const nonHex = 'g'.repeat(40);
    expect(stripTokenPattern(nonHex)).toBe(nonHex);
  });

  it('strips multiple tokens in one string', () => {
    const t1 = '0123456789abcdef0123456789abcdef01234567';
    const t2 = 'fedcba9876543210fedcba9876543210fedcba98';
    const out = stripTokenPattern(`${t1} and ${t2}`);
    expect(out).not.toContain(t1);
    expect(out).not.toContain(t2);
    expect(out.match(/\[REDACTED-40HEX\]/g)?.length).toBe(2);
  });
});
