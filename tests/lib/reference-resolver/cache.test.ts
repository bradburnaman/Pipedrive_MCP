// tests/lib/reference-resolver/cache.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaleWhileRevalidateCache } from '../../../src/lib/reference-resolver/cache.js';

describe('StaleWhileRevalidateCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches data on first access', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a', 'b', 'c']);
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);
    const result = await cache.get();
    expect(result).toEqual(['a', 'b', 'c']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns cached data within TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a', 'b', 'c']);
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);
    await cache.get();
    vi.advanceTimersByTime(3000); // within TTL
    const result = await cache.get();
    expect(result).toEqual(['a', 'b', 'c']);
    expect(fetcher).toHaveBeenCalledTimes(1); // no refetch
  });

  it('serves stale data and triggers background refresh after TTL', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? ['old'] : ['new'];
    });
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);

    await cache.get(); // initial fetch
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // past TTL

    const staleResult = await cache.get(); // should return stale immediately
    expect(staleResult).toEqual(['old']); // stale data served

    // Let the background refresh complete
    await vi.runAllTimersAsync();

    const freshResult = await cache.get(); // should have new data now
    expect(freshResult).toEqual(['new']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refresh calls', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      return [`data-${callCount}`];
    });
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);

    await cache.get(); // initial fetch
    vi.advanceTimersByTime(6000); // expire

    // Two concurrent calls while cache is stale
    const [r1, r2] = await Promise.all([cache.get(), cache.get()]);

    // Both get stale data
    expect(r1).toEqual(['data-1']);
    expect(r2).toEqual(['data-1']);

    // Only one refresh triggered
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(2); // initial + 1 refresh (not 2)
  });

  it('clears refreshInFlight on rejection', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('API error');
      return [`data-${callCount}`];
    });
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);

    await cache.get(); // initial fetch succeeds
    vi.advanceTimersByTime(6000); // expire

    await cache.get(); // triggers refresh that will fail
    await vi.runAllTimersAsync(); // let the failed refresh complete

    vi.advanceTimersByTime(6000); // expire again

    // Should be able to trigger another refresh (not stuck on rejected promise)
    fetcher.mockResolvedValueOnce(['recovered']);
    await cache.get();
    await vi.runAllTimersAsync();

    const result = await cache.get();
    expect(result).toEqual(['recovered']);
  });

  it('throws on first access if fetcher fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('API down'));
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);
    await expect(cache.get()).rejects.toThrow('API down');
  });

  it('allows manual cache priming', async () => {
    const fetcher = vi.fn().mockResolvedValue(['fetched']);
    const cache = new StaleWhileRevalidateCache(fetcher, 5000);
    cache.prime(['primed']);
    const result = await cache.get();
    expect(result).toEqual(['primed']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('logs warning on background refresh failure', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('API error');
      return [`data-${callCount}`];
    });
    const mockLogger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any;
    const cache = new StaleWhileRevalidateCache(fetcher, 5000, mockLogger);

    await cache.get(); // initial fetch succeeds
    vi.advanceTimersByTime(6000); // expire

    await cache.get(); // triggers refresh that will fail
    await vi.runAllTimersAsync(); // let the failed refresh complete

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Cache background refresh failed, serving stale data'
    );
  });
});
