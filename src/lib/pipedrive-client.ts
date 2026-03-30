import type { RateLimitState, HttpMethod } from '../types.js';
import type { Logger } from 'pino';

const BASE_URL = 'https://api.pipedrive.com';
const DEFAULT_TIMEOUT = 30_000;
const STARTUP_TIMEOUT = 10_000;

export class PipedriveClient {
  private apiToken: string;
  private logger?: Logger;
  public rateLimitState: RateLimitState = { remaining: null, resetTimestamp: null };

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
    url.searchParams.set('api_token', this.apiToken);

    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== '') {
          url.searchParams.set(key, value);
        }
      }
    }

    const signal = AbortSignal.timeout(timeoutMs);

    const options: RequestInit = {
      method,
      signal,
    };

    if (body && method !== 'GET') {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });

    const response = await Promise.race([fetch(url.toString(), options), abortPromise]);

    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.rateLimitState.remaining = parseInt(remaining, 10);
    if (reset !== null) this.rateLimitState.resetTimestamp = parseInt(reset, 10);

    if (this.logger) {
      this.logger.debug(
        { method, version, path, status: response.status, rateLimitRemaining: this.rateLimitState.remaining },
        'Pipedrive API call'
      );
    }

    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }

  async validateToken(): Promise<{ id: number; name: string }> {
    const result = await this.request('GET', 'v1', '/users/me', undefined, undefined, STARTUP_TIMEOUT);
    const data = result.data as { success: boolean; data?: { id: number; name: string } };
    if (result.status !== 200 || !data.success || !data.data) {
      throw new Error('API token is invalid. Restart the server with a valid token.');
    }
    return data.data;
  }
}
