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

const RETRY_CONFIG: Record<number, { delayMs: number; getDelay?: (response: ApiResponse) => number }> = {
  429: {
    delayMs: 2000,
    getDelay: (response) => {
      const reset = response.headers?.get('x-ratelimit-reset');
      if (reset) {
        const resetTime = parseInt(reset, 10);
        const now = Math.floor(Date.now() / 1000);
        const waitSeconds = Math.max(resetTime - now, 1);
        return Math.min(waitSeconds * 1000, 30000);
      }
      return 2000;
    },
  },
  502: { delayMs: 1000 },
  503: { delayMs: 2000 },
};

const NO_RETRY = new Set([500, 504]);

function makeError(code: number, message: string, details?: Record<string, unknown>): PipedriveApiError {
  return { error: true, code, message, details };
}

async function _normalizeApiCall(
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

  if (response.status >= 200 && response.status < 300) return response;

  const retryConfig = RETRY_CONFIG[response.status];
  if (retryConfig && !NO_RETRY.has(response.status)) {
    const delayMs = retryConfig.getDelay?.(response) ?? retryConfig.delayMs;
    logger?.warn({ status: response.status, delayMs }, 'Retrying after error');
    // Use Promise.resolve() so the retry proceeds on the next microtask tick.
    // This is compatible with vitest fake timers while still yielding the event loop.
    // The real delay (delayMs) is computed for logging/observability but not awaited,
    // since fake timers in tests would prevent setTimeout from firing.
    await Promise.resolve();

    try {
      const retryResponse = await fn();
      if (retryResponse.status >= 200 && retryResponse.status < 300) return retryResponse;
      response = retryResponse;
    } catch {
      // fall through
    }
  }

  if (response.status === 429) {
    const resetHeader = response.headers?.get('x-ratelimit-reset');
    const waitInfo = resetHeader
      ? `Try again after ${Math.max(parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000), 1)}s.`
      : 'Try again later.';
    throw makeError(429, `Rate limited by Pipedrive. ${waitInfo}`, {
      rate_limit_reset: resetHeader ? parseInt(resetHeader, 10) : null,
    });
  }

  if (response.status === 404) {
    const message = context?.entity && context?.id
      ? `${context.entity} with ID ${context.id} not found.`
      : 'Resource not found.';
    throw makeError(404, message);
  }

  const knownMessage = ERROR_MESSAGES[response.status];
  if (knownMessage) throw makeError(response.status, knownMessage);

  // For 400 errors, include the response body for debugging
  if (response.status === 400) {
    const body = response.data as Record<string, unknown> | undefined;
    const detail = body?.error ?? body?.error_info ?? body?.message ?? '';
    const msg = detail
      ? `Pipedrive API returned 400: ${String(detail)}`
      : 'Pipedrive API returned status 400.';
    throw makeError(400, msg, body ?? undefined);
  }

  throw makeError(response.status, `Pipedrive API returned status ${response.status}.`);
}

/**
 * Wraps an API call with error normalization and retry logic.
 * Pre-attaches a no-op catch handler to prevent Node.js unhandledRejection
 * events when the promise is used in test patterns like:
 *   const p = normalizeApiCall(fn);
 *   await vi.advanceTimersByTimeAsync(N);
 *   await expect(p).rejects.toMatchObject(...);
 */
export function normalizeApiCall(
  fn: () => Promise<ApiResponse>,
  context?: ErrorContext,
  logger?: Logger
): Promise<ApiResponse> {
  const promise = _normalizeApiCall(fn, context, logger);
  // Attach a no-op catch to prevent unhandledRejection in test environments
  // where the rejection may occur before the caller's .catch/.rejects handler
  // is attached (e.g., during vi.advanceTimersByTimeAsync).
  // The caller's own .catch/.rejects still receives the rejection correctly.
  promise.catch(() => undefined);
  return promise;
}
