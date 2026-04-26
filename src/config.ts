import type { ServerConfig, ToolCategory } from './types.js';

const VALID_CATEGORIES: ToolCategory[] = ['read', 'create', 'update', 'delete'];

export function parseConfig(args: string[] = process.argv.slice(2)): ServerConfig {
  // Token resolution lives in src/index.ts (Keychain-first, restricted env override).
  // parseConfig only handles non-secret runtime configuration.

  let transport: 'stdio' | 'sse' = 'stdio';
  let cliPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--transport' && args[i + 1]) {
      transport = args[i + 1] === 'sse' ? 'sse' : 'stdio';
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      cliPort = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const port = cliPort ?? parseInt(process.env.PORT ?? '3000', 10);

  const categoriesEnv = process.env.PIPEDRIVE_ENABLED_CATEGORIES?.trim();
  let enabledCategories: Set<ToolCategory>;
  if (categoriesEnv) {
    const parsed = categoriesEnv.split(',').map(s => s.trim());
    const valid = parsed.filter((c): c is ToolCategory =>
      VALID_CATEGORIES.includes(c as ToolCategory)
    );
    const invalid = parsed.filter(c => !VALID_CATEGORIES.includes(c as ToolCategory));
    if (invalid.length > 0) {
      console.error(`Warning: Unknown categories ignored: ${invalid.join(', ')}`);
    }
    enabledCategories = new Set(valid);
  } else {
    enabledCategories = new Set(VALID_CATEGORIES);
  }

  const disabledToolsEnv = process.env.PIPEDRIVE_DISABLED_TOOLS?.trim();
  const disabledTools = disabledToolsEnv
    ? new Set(disabledToolsEnv.split(',').map(s => s.trim()).filter(Boolean))
    : new Set<string>();

  const logLevelEnv = process.env.PIPEDRIVE_LOG_LEVEL?.trim();
  const logLevel = logLevelEnv === 'debug' ? 'debug' : 'info';

  return { port, transport, enabledCategories, disabledTools, logLevel };
}

export function isToolEnabled(
  config: ServerConfig,
  toolName: string,
  category: ToolCategory
): boolean {
  if (!config.enabledCategories.has(category)) return false;
  if (config.disabledTools.has(toolName)) return false;
  return true;
}
