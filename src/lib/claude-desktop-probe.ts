import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATHS = [
  join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json'),
];

export interface ProbeFinding {
  path: string;
  servers: string[];
}

export function probeClaudeDesktopConfig(paths: string[] = CONFIG_PATHS): ProbeFinding | null {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let cfg: { mcpServers?: Record<string, { env?: Record<string, unknown> }> };
    try {
      cfg = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    const servers = cfg?.mcpServers ?? {};
    const hits: string[] = [];
    for (const [name, srv] of Object.entries(servers)) {
      const env = srv?.env ?? {};
      if ('PIPEDRIVE_API_TOKEN' in env) hits.push(name);
    }
    if (hits.length > 0) return { path: p, servers: hits };
  }
  return null;
}
