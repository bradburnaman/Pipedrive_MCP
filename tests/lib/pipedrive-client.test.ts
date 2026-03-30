import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipedriveClient } from '../../src/lib/pipedrive-client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('PipedriveClient', () => {
  let client: PipedriveClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PipedriveClient('test-token');
  });

  describe('request', () => {
    it('attaches api_token as query param for v1', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 1 } }));
      await client.request('GET', 'v1', '/users/me');
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api_token=test-token');
      expect(calledUrl).toContain('api.pipedrive.com/v1/users/me');
    });

    it('attaches api_token as query param for v2', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: 1 }] }));
      await client.request('GET', 'v2', '/deals');
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api_token=test-token');
      expect(calledUrl).toContain('api.pipedrive.com/api/v2/deals');
    });

    it('sends JSON body for POST requests', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 1 } }));
      await client.request('POST', 'v2', '/deals', { title: 'Test Deal' });
      const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
      expect(callArgs.method).toBe('POST');
      expect(callArgs.headers).toHaveProperty('Content-Type', 'application/json');
      expect(JSON.parse(callArgs.body as string)).toEqual({ title: 'Test Deal' });
    });

    it('appends query params for GET requests', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
      await client.request('GET', 'v2', '/deals', undefined, { status: 'open', limit: '50' });
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('status=open');
      expect(calledUrl).toContain('limit=50');
    });

    it('tracks rate limit headers', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [] }, 200, {
          'x-ratelimit-remaining': '42',
          'x-ratelimit-reset': '1711641600',
        })
      );
      await client.request('GET', 'v2', '/deals');
      expect(client.rateLimitState.remaining).toBe(42);
      expect(client.rateLimitState.resetTimestamp).toBe(1711641600);
    });

    it('returns status, data, and headers', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 1 } }));
      const result = await client.request('GET', 'v1', '/users/me');
      expect(result).toHaveProperty('status', 200);
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('headers');
      expect(result.headers).toBeInstanceOf(Headers);
    });

    it('uses AbortSignal timeout', async () => {
      mockFetch.mockImplementation(() => new Promise(() => {}));
      const promise = client.request('GET', 'v1', '/users/me', undefined, undefined, 50);
      await expect(promise).rejects.toThrow();
    });
  });

  describe('validateToken', () => {
    it('resolves on valid token', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { id: 1, name: 'Brad' } })
      );
      const user = await client.validateToken();
      expect(user).toEqual({ id: 1, name: 'Brad' });
    });

    it('throws on invalid token', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'unauthorized' }, 401)
      );
      await expect(client.validateToken()).rejects.toThrow();
    });
  });
});
