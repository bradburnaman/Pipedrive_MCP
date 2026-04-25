import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeClaudeDesktopConfig } from '../../src/lib/claude-desktop-probe.js';

describe('probeClaudeDesktopConfig', () => {
  let tempDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-probe-'));
    cfgPath = join(tempDir, 'claude_desktop_config.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    expect(probeClaudeDesktopConfig([cfgPath])).toBeNull();
  });

  it('returns null when there is no PIPEDRIVE_API_TOKEN', () => {
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: { other: { command: 'node', env: { OTHER: 'x' } } },
    }));
    expect(probeClaudeDesktopConfig([cfgPath])).toBeNull();
  });

  it('returns null when there is no env block at all', () => {
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: { pipedrive: { command: 'node', args: ['/path/index.js'] } },
    }));
    expect(probeClaudeDesktopConfig([cfgPath])).toBeNull();
  });

  it('detects a single server with the token in env', () => {
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: { pipedrive: { command: 'node', env: { PIPEDRIVE_API_TOKEN: 'x' } } },
    }));
    const finding = probeClaudeDesktopConfig([cfgPath]);
    expect(finding).not.toBeNull();
    expect(finding!.servers).toEqual(['pipedrive']);
    expect(finding!.path).toBe(cfgPath);
  });

  it('aggregates multiple server hits into one finding', () => {
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        pipedrive: { env: { PIPEDRIVE_API_TOKEN: 'x' } },
        other: { env: { OTHER: 'y' } },
        backup: { env: { PIPEDRIVE_API_TOKEN: 'z' } },
      },
    }));
    const finding = probeClaudeDesktopConfig([cfgPath]);
    expect(finding).not.toBeNull();
    expect(finding!.servers.sort()).toEqual(['backup', 'pipedrive']);
  });

  it('returns null on malformed JSON', () => {
    writeFileSync(cfgPath, '{ this is not valid json');
    expect(probeClaudeDesktopConfig([cfgPath])).toBeNull();
  });
});
