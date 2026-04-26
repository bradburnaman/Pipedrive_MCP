import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeApiCall } from '../../src/lib/error-normalizer.js';

describe('normalizeApiCall', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('passes through successful responses', async () => {
    const result = await normalizeApiCall(async () => ({ status: 200, data: { success: true, data: { id: 1 } } }));
    expect(result).toEqual({ status: 200, data: { success: true, data: { id: 1 } } });
  });

  it('normalizes 401 errors', async () => {
    await expect(normalizeApiCall(async () => ({ status: 401, data: { success: false } }))).rejects.toMatchObject({ error: true, code: 401, message: 'API token is invalid. Restart the server with a valid token.' });
  });

  it('normalizes 403 errors', async () => {
    await expect(normalizeApiCall(async () => ({ status: 403, data: { success: false } }))).rejects.toMatchObject({ error: true, code: 403, message: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.' });
  });

  it('normalizes 404 with entity context', async () => {
    await expect(normalizeApiCall(async () => ({ status: 404, data: { success: false } }), { entity: 'Deal', id: 123 })).rejects.toMatchObject({ code: 404, message: 'Deal with ID 123 not found.' });
  });

  it('normalizes 404 without context', async () => {
    await expect(normalizeApiCall(async () => ({ status: 404, data: {} }))).rejects.toMatchObject({ code: 404, message: 'Resource not found.' });
  });

  it('normalizes 500', async () => {
    await expect(normalizeApiCall(async () => ({ status: 500, data: {} }))).rejects.toMatchObject({ code: 500, message: 'Pipedrive API error. Try again.' });
  });

  it('normalizes 502', async () => {
    await expect(normalizeApiCall(async () => ({ status: 502, data: {} }))).rejects.toMatchObject({ code: 502 });
  });

  it('normalizes 504', async () => {
    await expect(normalizeApiCall(async () => ({ status: 504, data: {} }))).rejects.toMatchObject({ code: 504, message: 'Pipedrive API timed out.' });
  });

  it('normalizes network failures', async () => {
    await expect(normalizeApiCall(async () => { throw new TypeError('fetch failed'); })).rejects.toMatchObject({ code: 0, message: 'Unable to reach Pipedrive API. Check network connection.' });
  });

  it('normalizes timeout errors', async () => {
    await expect(normalizeApiCall(async () => { throw new DOMException('aborted', 'AbortError'); })).rejects.toMatchObject({ code: 0, message: 'Request to Pipedrive API timed out.' });
  });

  it('retries 502 once', async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls === 1) return { status: 502, data: {} }; return { status: 200, data: { success: true } }; };
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(calls).toBe(2);
    expect(result).toEqual({ status: 200, data: { success: true } });
  });

  it('retries 503 once', async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls === 1) return { status: 503, data: {} }; return { status: 200, data: { success: true } }; };
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(2500);
    await promise;
    expect(calls).toBe(2);
  });

  it('does not retry 500', async () => {
    let calls = 0;
    await expect(normalizeApiCall(async () => { calls++; return { status: 500, data: {} }; })).rejects.toMatchObject({ code: 500 });
    expect(calls).toBe(1);
  });

  it('does not retry 504', async () => {
    let calls = 0;
    await expect(normalizeApiCall(async () => { calls++; return { status: 504, data: {} }; })).rejects.toMatchObject({ code: 504 });
    expect(calls).toBe(1);
  });

  it('retries 429 once using rate limit header', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) return { status: 429, data: {}, headers: new Headers({ 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 2) }) };
      return { status: 200, data: { success: true } };
    };
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
  });

  it('throws after 429 retry fails', async () => {
    const fn = async () => ({ status: 429, data: {}, headers: new Headers({ 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 2) }) });
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).rejects.toMatchObject({ error: true, code: 429 });
  });

  it('handles 429 without rate limit header', async () => {
    const fn = async () => ({ status: 429, data: {} });
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).rejects.toMatchObject({ error: true, code: 429 });
  });

  it('handles unknown status codes', async () => {
    await expect(normalizeApiCall(async () => ({ status: 418, data: {} }))).rejects.toMatchObject({ code: 418, message: 'Pipedrive API returned status 418.' });
  });

  it('strips 40-hex token patterns from 400-error messages', async () => {
    const token = '0123456789abcdef0123456789abcdef01234567';
    const fn = async () => ({ status: 400, data: { error: `bad request near ${token} oops` } });
    await expect(normalizeApiCall(fn)).rejects.toMatchObject({
      code: 400,
      message: expect.not.stringContaining(token),
    });
    await expect(normalizeApiCall(fn)).rejects.toMatchObject({
      code: 400,
      message: expect.stringContaining('[REDACTED-40HEX]'),
    });
  });

  it('strips 40-hex token patterns from 400-error details', async () => {
    const token = 'fedcba9876543210fedcba9876543210fedcba98';
    const fn = async () => ({
      status: 400,
      data: { error: 'bad', context: `token ${token} embedded`, nested: { also: token } },
    });
    try {
      await normalizeApiCall(fn);
    } catch (e) {
      const err = e as { details?: Record<string, unknown> };
      const serialized = JSON.stringify(err.details);
      expect(serialized).not.toContain(token);
      expect(serialized).toContain('[REDACTED-40HEX]');
    }
  });
});
