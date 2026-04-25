import { describe, it, expect } from 'vitest';
import { VERSION_ID, versionString } from '../../src/lib/version-id.js';

describe('VERSION_ID', () => {
  it('has sha, ts, dirty fields', () => {
    expect(typeof VERSION_ID.sha).toBe('string');
    expect(typeof VERSION_ID.ts).toBe('string');
    expect(typeof VERSION_ID.dirty).toBe('boolean');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(VERSION_ID)).toBe(true);
  });

  it('versionString() includes short sha and ts', () => {
    const s = versionString();
    expect(s).toContain(VERSION_ID.sha.slice(0, 12));
    expect(s).toContain(VERSION_ID.ts);
  });

  it('versionString() appends -dirty when dirty', () => {
    if (VERSION_ID.dirty) {
      expect(versionString()).toMatch(/-dirty$/);
    }
  });
});
