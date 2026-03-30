# Part 3: HTTP Layer

> Part 3 of 13 — Pipedrive HTTP client and error normalizer with retry logic
> **Depends on:** Part 01
> **Produces:** `src/lib/pipedrive-client.ts`, `tests/lib/pipedrive-client.test.ts`, `src/lib/error-normalizer.ts`, `tests/lib/error-normalizer.test.ts`

**Note:** This part incorporates fixes from the addendum: the error normalizer includes 429 retry logic, `ApiResponse` includes `headers`, `PipedriveClient.request` returns `{ status, data, headers }`, and both modules accept a logger parameter.

---

## Task 6: Pipedrive Client

**Files:**
- Create: `src/lib/pipedrive-client.ts`
- Create: `tests/lib/pipedrive-client.test.ts`

- [ ] **Step 1: Write Pipedrive client tests**

```typescript
// tests/lib/pipedrive-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipedriveClient } from '../../src/lib/pipedrive-client.js';

// Mock global fetch
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
      mockFetch.mockImplementation(() => new Promise(() => {})); // never resolves
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/pipedrive-client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write Pipedrive client implementation**

The `request` method returns `{ status, data, headers }` so the error normalizer can read rate limit headers for 429 retry logic.

```typescript
// src/lib/pipedrive-client.ts
import type { RateLimitState, HttpMethod } from '../types.js';
import type { Logger } from 'pino';

const BASE_URL = 'https://api.pipedrive.com';
const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const STARTUP_TIMEOUT = 10_000; // 10 seconds

export class PipedriveClient {
  private apiToken: string;
  private logger?: Logger;
  public rateLimitState: RateLimitState = {
    remaining: null,
    resetTimestamp: null,
  };

  constructor(apiToken: string, logger?: Logger) {
    this.apiToken = apiToken;
    this.logger = logger;
  }

  async request(
    method: HttpMethod,
    version: 'v1' | 'v2',
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
    timeoutMs: number = DEFAULT_TIMEOUT
  ): Promise<{ status: number; data: unknown; headers: Headers }> {
    const basePath = version === 'v1' ? '/v1' : '/api/v2';
    const url = new URL(`${basePath}${path}`, BASE_URL);

    // Auth via query param (works for both v1 and v2 with personal tokens)
    url.searchParams.set('api_token', this.apiToken);

    // Additional query params
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== '') {
          url.searchParams.set(key, value);
        }
      }
    }

    const options: RequestInit = {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (body && method !== 'GET') {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), options);

    // Track rate limit headers
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining !== null) {
      this.rateLimitState.remaining = parseInt(remaining, 10);
    }
    if (reset !== null) {
      this.rateLimitState.resetTimestamp = parseInt(reset, 10);
    }

    if (this.logger) {
      this.logger.debug({
        method, version, path,
        status: response.status,
        rateLimitRemaining: this.rateLimitState.remaining,
      }, 'Pipedrive API call');
    }

    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }

  async validateToken(): Promise<{ id: number; name: string }> {
    const result = await this.request('GET', 'v1', '/users/me', undefined, undefined, STARTUP_TIMEOUT);

    const data = result.data as { success: boolean; data?: { id: number; name: string }; error?: string };

    if (result.status !== 200 || !data.success || !data.data) {
      throw new Error('API token is invalid. Restart the server with a valid token.');
    }

    return data.data;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/pipedrive-client.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipedrive-client.ts tests/lib/pipedrive-client.test.ts
git commit -m "feat: Pipedrive HTTP client with auth, rate limit tracking, timeouts"
```

---

## Task 7: Error Normalizer

**Files:**
- Create: `src/lib/error-normalizer.ts`
- Create: `tests/lib/error-normalizer.test.ts`

This implementation includes 429 retry logic (reading rate limit headers from the response), retries for 502/503, and a logger parameter. The `ApiResponse` interface includes `headers?: Headers` so the 429 handler can read `x-ratelimit-reset`.

- [ ] **Step 1: Write error normalizer tests**

```typescript
// tests/lib/error-normalizer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeApiCall } from '../../src/lib/error-normalizer.js';

describe('normalizeApiCall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it('passes through successful responses', async () => {
    const result = await normalizeApiCall(async () => ({
      status: 200,
      data: { success: true, data: { id: 1 } },
    }));
    expect(result).toEqual({ status: 200, data: { success: true, data: { id: 1 } } });
  });

  it('normalizes 401 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 401,
        data: { success: false, error: 'unauthorized' },
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 401,
      message: 'API token is invalid. Restart the server with a valid token.',
    });
  });

  it('normalizes 403 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 403,
        data: { success: false, error: 'forbidden' },
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 403,
      message: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.',
    });
  });

  it('normalizes 404 errors with entity context', async () => {
    await expect(
      normalizeApiCall(
        async () => ({ status: 404, data: { success: false } }),
        { entity: 'Deal', id: 123 }
      )
    ).rejects.toMatchObject({
      error: true,
      code: 404,
      message: 'Deal with ID 123 not found.',
    });
  });

  it('normalizes 404 without entity context', async () => {
    await expect(
      normalizeApiCall(async () => ({ status: 404, data: { success: false } }))
    ).rejects.toMatchObject({
      error: true,
      code: 404,
      message: 'Resource not found.',
    });
  });

  it('normalizes 500 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 500,
        data: { success: false, error: 'internal error' },
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 500,
      message: 'Pipedrive API error. Try again.',
    });
  });

  it('normalizes 502 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 502,
        data: {},
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 502,
      message: 'Pipedrive API is temporarily unavailable. Try again.',
    });
  });

  it('normalizes 504 errors', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 504,
        data: {},
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 504,
      message: 'Pipedrive API timed out.',
    });
  });

  it('normalizes network failures', async () => {
    await expect(
      normalizeApiCall(async () => {
        throw new TypeError('fetch failed');
      })
    ).rejects.toMatchObject({
      error: true,
      code: 0,
      message: 'Unable to reach Pipedrive API. Check network connection.',
    });
  });

  it('normalizes timeout errors', async () => {
    await expect(
      normalizeApiCall(async () => {
        const err = new DOMException('The operation was aborted', 'AbortError');
        throw err;
      })
    ).rejects.toMatchObject({
      error: true,
      code: 0,
      message: 'Request to Pipedrive API timed out.',
    });
  });

  it('retries 502 once', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) return { status: 502, data: {} };
      return { status: 200, data: { success: true, data: { id: 1 } } };
    };
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(1500); // 502 retries after 1s
    const result = await promise;
    expect(calls).toBe(2);
    expect(result).toEqual({ status: 200, data: { success: true, data: { id: 1 } } });
  });

  it('retries 503 once', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) return { status: 503, data: {} };
      return { status: 200, data: { success: true, data: { id: 1 } } };
    };
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(2500); // 503 retries after 2s
    const result = await promise;
    expect(calls).toBe(2);
  });

  it('does not retry 500', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { status: 500, data: { success: false } };
    };
    await expect(normalizeApiCall(fn)).rejects.toMatchObject({ code: 500 });
    expect(calls).toBe(1);
  });

  it('does not retry 504', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { status: 504, data: {} };
    };
    await expect(normalizeApiCall(fn)).rejects.toMatchObject({ code: 504 });
    expect(calls).toBe(1);
  });

  it('retries 429 once using rate limit header', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) {
        return {
          status: 429,
          data: {},
          headers: new Headers({
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 2),
          }),
        };
      }
      return { status: 200, data: { success: true, data: { id: 1 } } };
    };
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(3000); // advance past the 2s reset delay
    const result = await promise;
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
  });

  it('throws after 429 retry fails', async () => {
    const fn = async () => ({
      status: 429,
      data: {},
      headers: new Headers({
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 2),
      }),
    });
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).rejects.toMatchObject({
      error: true,
      code: 429,
    });
  });

  it('handles 429 without rate limit header', async () => {
    const fn = async () => ({
      status: 429,
      data: {},
    });
    const promise = normalizeApiCall(fn);
    await vi.advanceTimersByTimeAsync(3000); // fallback delay is 2s
    await expect(promise).rejects.toMatchObject({
      error: true,
      code: 429,
    });
  });

  it('handles unknown status codes', async () => {
    await expect(
      normalizeApiCall(async () => ({
        status: 418,
        data: {},
      }))
    ).rejects.toMatchObject({
      error: true,
      code: 418,
      message: 'Pipedrive API returned status 418.',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/error-normalizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write error normalizer implementation**

```typescript
// src/lib/error-normalizer.ts
import type { PipedriveApiError } from '../types.js';
import type { Logger } from 'pino';

interface ApiResponse {
  status: number;
  data: unknown;
  headers?: Headers;
}

interface ErrorContext {
  entity?: string;
  id?: number;
}

const ERROR_MESSAGES: Record<number, string> = {
  401: 'API token is invalid. Restart the server with a valid token.',
  402: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.',
  403: 'Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan.',
  500: 'Pipedrive API error. Try again.',
  502: 'Pipedrive API is temporarily unavailable. Try again.',
  503: 'Pipedrive API is temporarily unavailable. Try again.',
  504: 'Pipedrive API timed out.',
};

// Retry config: status code -> delay in ms (before first retry)
const RETRY_CONFIG: Record<number, { delayMs: number; getDelay?: (response: ApiResponse) => number }> = {
  429: {
    delayMs: 2000, // fallback if no header
    getDelay: (response) => {
      const reset = response.headers?.get('x-ratelimit-reset');
      if (reset) {
        const resetTime = parseInt(reset, 10);
        const now = Math.floor(Date.now() / 1000);
        const waitSeconds = Math.max(resetTime - now, 1);
        return Math.min(waitSeconds * 1000, 30000); // cap at 30s
      }
      return 2000;
    },
  },
  502: { delayMs: 1000 },
  503: { delayMs: 2000 },
};

// NOT retryable
const NO_RETRY = new Set([500, 504]);

function makeError(code: number, message: string, details?: Record<string, unknown>): PipedriveApiError {
  return { error: true, code, message, details };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function normalizeApiCall(
  fn: () => Promise<ApiResponse>,
  context?: ErrorContext,
  logger?: Logger
): Promise<ApiResponse> {
  let response: ApiResponse;

  try {
    response = await fn();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw makeError(0, 'Request to Pipedrive API timed out.');
    }
    if (err instanceof TypeError) {
      throw makeError(0, 'Unable to reach Pipedrive API. Check network connection.');
    }
    throw makeError(0, `Unexpected error: ${String(err)}`);
  }

  // Success
  if (response.status >= 200 && response.status < 300) {
    return response;
  }

  // Check if retryable
  const retryConfig = RETRY_CONFIG[response.status];
  if (retryConfig && !NO_RETRY.has(response.status)) {
    const delayMs = retryConfig.getDelay?.(response) ?? retryConfig.delayMs;
    logger?.warn({ status: response.status, delayMs }, 'Retrying after error');
    await sleep(delayMs);

    try {
      const retryResponse = await fn();
      if (retryResponse.status >= 200 && retryResponse.status < 300) {
        return retryResponse;
      }
      // Retry also failed — fall through with retry response
      response = retryResponse;
    } catch {
      // Retry threw — fall through with original response
    }
  }

  // 429 — rate limited (after retry failed or no retry)
  if (response.status === 429) {
    const resetHeader = response.headers?.get('x-ratelimit-reset');
    const waitInfo = resetHeader
      ? `Try again after ${Math.max(parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000), 1)}s.`
      : 'Try again later.';
    throw makeError(429, `Rate limited by Pipedrive. ${waitInfo}`, {
      rate_limit_reset: resetHeader ? parseInt(resetHeader, 10) : null,
    });
  }

  // 404 — not found with entity context
  if (response.status === 404) {
    const message = context?.entity && context?.id
      ? `${context.entity} with ID ${context.id} not found.`
      : 'Resource not found.';
    throw makeError(404, message);
  }

  // Known error codes
  const knownMessage = ERROR_MESSAGES[response.status];
  if (knownMessage) {
    throw makeError(response.status, knownMessage);
  }

  throw makeError(response.status, `Pipedrive API returned status ${response.status}.`);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/error-normalizer.test.ts
```

Expected: All tests PASS. Retry tests use `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync()` to avoid real delays.

- [ ] **Step 5: Commit**

```bash
git add src/lib/error-normalizer.ts tests/lib/error-normalizer.test.ts
git commit -m "feat: error normalizer with 429/502/503 retry and consistent error shapes"
```
