import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KillSwitch } from '../../src/lib/kill-switch.js';

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ks-test-'));
  configPath = join(tmp, 'config.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('KillSwitch', () => {
  it('defaults writesEnabled to true when no config.json exists', () => {
    const ks = new KillSwitch(configPath);
    expect(ks.writesEnabled).toBe(true);
  });

  it('setWritesEnabled(false) persists; a new instance reads it back as false', () => {
    const ks = new KillSwitch(configPath);
    ks.setWritesEnabled(false);
    const ks2 = new KillSwitch(configPath);
    expect(ks2.writesEnabled).toBe(false);
  });

  it('setWritesEnabled(true) after false restores enabled state', () => {
    const ks = new KillSwitch(configPath);
    ks.setWritesEnabled(false);
    ks.setWritesEnabled(true);
    const ks2 = new KillSwitch(configPath);
    expect(ks2.writesEnabled).toBe(true);
  });

  it('written config.json has mode 0o600', () => {
    const ks = new KillSwitch(configPath);
    ks.setWritesEnabled(false);
    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('preserves existing config.json fields when updating writes_enabled', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ setupAt: '2026-01-01', nextRotationDue: '2026-04-01' }, null, 2),
      { mode: 0o600 },
    );
    const ks = new KillSwitch(configPath);
    ks.setWritesEnabled(false);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.setupAt).toBe('2026-01-01');
    expect(cfg.nextRotationDue).toBe('2026-04-01');
    expect(cfg.writes_enabled).toBe(false);
  });
});
