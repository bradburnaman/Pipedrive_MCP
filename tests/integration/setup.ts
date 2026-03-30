// tests/integration/setup.ts
import 'dotenv/config';
import { PipedriveClient } from '../../src/lib/pipedrive-client.js';
import { ReferenceResolver } from '../../src/lib/reference-resolver/index.js';
import { EntityResolver } from '../../src/lib/entity-resolver.js';
import pino from 'pino';

const API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

if (!API_TOKEN) {
  throw new Error(
    'PIPEDRIVE_API_TOKEN is required for integration tests. ' +
    'Set it in your .env file or environment.'
  );
}

// Create a test logger that writes to stderr at debug level
const logger = pino(
  { level: 'debug' },
  pino.destination(2)
);

// Shared instances for all integration tests
export const client = new PipedriveClient(API_TOKEN, logger);
export const resolver = new ReferenceResolver(client, logger);
export const entityResolver = new EntityResolver(client, logger);
export { logger };

/**
 * Validate the token before running any tests.
 * Called once in the top-level beforeAll of each test file.
 */
export async function validateSetup(): Promise<void> {
  const user = await client.validateToken();
  logger.info({ userId: user.id, userName: user.name }, 'Integration test token validated');
}

/**
 * Helper to pause between API calls to avoid rate limiting.
 * Pipedrive's rate limits are generous but sequential CRUD
 * operations can occasionally hit them.
 */
export function pause(ms: number = 500): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
