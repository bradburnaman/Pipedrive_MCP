// src/index.ts

import { assertConfigDirSafe, assertCwdClean } from './lib/path-safety.js';
import { parseConfig } from './config.js';
import { PipedriveClient } from './lib/pipedrive-client.js';
import { ReferenceResolver } from './lib/reference-resolver/index.js';
import { EntityResolver } from './lib/entity-resolver.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';

async function main() {
  assertConfigDirSafe();
  assertCwdClean();
  const config = parseConfig();

  // Logger writes to stderr (fd 2) in all modes — stdout is reserved for
  // MCP JSON-RPC in stdio mode, and stderr is correct for SSE too.
  const logger = pino({
    level: config.logLevel,
  }, pino.destination(2));

  logger.info({ transport: config.transport }, 'Pipedrive MCP Server starting');

  // Initialize client with logger
  const client = new PipedriveClient(config.apiToken, logger);

  // Validate token — fail fast with clear error if invalid
  try {
    const user = await client.validateToken();
    logger.info({ userId: user.id, userName: user.name }, 'Token validated');
  } catch (err) {
    logger.fatal({ err }, 'Invalid or missing PIPEDRIVE_API_TOKEN. Exiting.');
    process.exit(1);
  }

  // Initialize resolvers — lazy init, caches prime on first access
  // NO initialize() call needed — ReferenceResolver uses lazy loading
  const resolver = new ReferenceResolver(client, logger);
  const entityResolver = new EntityResolver(client, logger);

  // Create MCP server with all dependencies
  const server = createServer(config, client, resolver, entityResolver, logger);

  // Start transport
  if (config.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Server running on stdio');
  } else {
    // SSE mode — not yet implemented
    // The SSE transport API varies across MCP SDK versions and requires
    // verification against the installed version. Implement as a fast-follow
    // after the stdio path is working end-to-end.
    logger.fatal(
      'SSE transport is not yet implemented. Use stdio mode (the default) or implement SSE support against the installed SDK version.'
    );
    process.exit(1);
  }

  // Graceful shutdown — 5-second timeout
  const shutdown = async () => {
    logger.info('Shutting down...');
    const shutdownTimeout = setTimeout(() => {
      logger.warn('Shutdown timed out after 5s, forcing exit');
      process.exit(1);
    }, 5000);
    try {
      await server.close();
    } finally {
      clearTimeout(shutdownTimeout);
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
