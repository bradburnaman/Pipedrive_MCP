// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    // deals.integration.test.ts requires a live PIPEDRIVE_API_TOKEN and dotenv — run separately
    exclude: ['tests/integration/deals.integration.test.ts'],
    environment: 'node',
    testTimeout: 30_000, // 30 seconds per test — API calls are slow
    hookTimeout: 30_000,
    // Run integration tests sequentially to avoid rate limiting
    pool: 'forks',
    singleFork: true,
  },
});
