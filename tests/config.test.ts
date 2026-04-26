import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseConfig, isToolEnabled } from '../src/config.js';

describe('parseConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('parses valid config with all defaults', () => {
    const config = parseConfig();
    expect(config.port).toBe(3000);
    expect(config.transport).toBe('stdio');
    expect(config.enabledCategories).toEqual(new Set(['read', 'create', 'update', 'delete']));
    expect(config.disabledTools).toEqual(new Set());
    expect(config.logLevel).toBe('info');
  });

  it('parses custom port', () => {
    process.env.PORT = '8080';
    const config = parseConfig();
    expect(config.port).toBe(8080);
  });

  it('parses enabled categories', () => {
    process.env.PIPEDRIVE_ENABLED_CATEGORIES = 'read,create';
    const config = parseConfig();
    expect(config.enabledCategories).toEqual(new Set(['read', 'create']));
  });

  it('warns on unknown categories and ignores them', () => {
    process.env.PIPEDRIVE_ENABLED_CATEGORIES = 'read,bogus,create';
    const config = parseConfig();
    expect(config.enabledCategories).toEqual(new Set(['read', 'create']));
  });

  it('parses disabled tools', () => {
    process.env.PIPEDRIVE_DISABLED_TOOLS = 'delete-deal,delete-person';
    const config = parseConfig();
    expect(config.disabledTools).toEqual(new Set(['delete-deal', 'delete-person']));
  });

  it('parses log level', () => {
    process.env.PIPEDRIVE_LOG_LEVEL = 'debug';
    const config = parseConfig();
    expect(config.logLevel).toBe('debug');
  });

  it('defaults log level to info for unknown values', () => {
    process.env.PIPEDRIVE_LOG_LEVEL = 'trace';
    const config = parseConfig();
    expect(config.logLevel).toBe('info');
  });

  it('parses transport from args', () => {
    const config = parseConfig(['--transport', 'sse']);
    expect(config.transport).toBe('sse');
  });

  it('parses port from args', () => {
    const config = parseConfig(['--port', '9090']);
    expect(config.port).toBe(9090);
  });

  it('isToolEnabled checks both categories and disabled tools', () => {
    process.env.PIPEDRIVE_ENABLED_CATEGORIES = 'read,create,delete';
    process.env.PIPEDRIVE_DISABLED_TOOLS = 'delete-deal';
    const config = parseConfig();

    expect(isToolEnabled(config, 'list-deals', 'read')).toBe(true);
    expect(isToolEnabled(config, 'delete-deal', 'delete')).toBe(false);
    expect(isToolEnabled(config, 'update-deal', 'update')).toBe(false);
  });
});
