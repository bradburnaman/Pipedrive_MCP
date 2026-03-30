// src/lib/reference-resolver/cache.ts
import type { Logger } from 'pino';

export class StaleWhileRevalidateCache<T> {
  private data: T | null = null;
  private fetchedAt: number = 0;
  private ttlMs: number;
  private fetcher: () => Promise<T>;
  private refreshInFlight: Promise<T> | null = null;
  private logger?: Logger;

  constructor(fetcher: () => Promise<T>, ttlMs: number, logger?: Logger) {
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
    this.logger = logger;
  }

  async get(): Promise<T> {
    // No cached data — must fetch synchronously
    if (this.data === null) {
      this.data = await this.fetcher();
      this.fetchedAt = Date.now();
      return this.data;
    }

    // Cache is fresh
    if (Date.now() - this.fetchedAt < this.ttlMs) {
      return this.data;
    }

    // Cache is stale — serve stale, trigger background refresh
    if (this.refreshInFlight === null) {
      this.refreshInFlight = this.fetcher()
        .then(freshData => {
          this.data = freshData;
          this.fetchedAt = Date.now();
          this.refreshInFlight = null;
          return freshData;
        })
        .catch(err => {
          this.refreshInFlight = null; // Clear so next call can retry
          this.logger?.warn({ err }, 'Cache background refresh failed, serving stale data');
          return this.data as T;
        });
    }

    return this.data;
  }

  prime(data: T): void {
    this.data = data;
    this.fetchedAt = Date.now();
  }

  invalidate(): void {
    this.fetchedAt = 0;
  }
}
