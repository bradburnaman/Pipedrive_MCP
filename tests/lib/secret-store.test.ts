import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// In-memory keytar mock — keyed by `${service}|${account}`.
const keytarStore = new Map<string, string>();

vi.mock('keytar', () => ({
  default: {
    setPassword: async (s: string, a: string, p: string) => { keytarStore.set(`${s}|${a}`, p); },
    getPassword: async (s: string, a: string) => keytarStore.get(`${s}|${a}`) ?? null,
    deletePassword: async (s: string, a: string) => keytarStore.delete(`${s}|${a}`),
  },
}));

// Override configDir() to point at a tempdir so tests don't touch real $HOME.
let tempHome: string;
vi.mock('../../src/lib/path-safety.js', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/path-safety.js')>();
  return {
    ...actual,
    configDir: () => tempHome,
    assertPathSafe: () => undefined, // skip sync-root check on /tmp
  };
});

// Imported lazily after mocks are registered.
let secretStore: typeof import('../../src/lib/secret-store.js');

beforeEach(async () => {
  tempHome = mkdtempSync(join(tmpdir(), 'secret-store-test-'));
  keytarStore.clear();
  secretStore = await import('../../src/lib/secret-store.js');
  secretStore.permissionRepairEvents.length = 0;
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('secret-store', () => {
  describe('round-trip', () => {
    it('storeToken → getToken returns the same value', async () => {
      const token = 'a'.repeat(40);
      await secretStore.storeToken(token);
      const got = await secretStore.getToken();
      expect(got).not.toBeNull();
      expect(got!.token).toBe(token);
      expect(got!.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('getToken returns null when no entry exists', async () => {
      const got = await secretStore.getToken();
      expect(got).toBeNull();
    });

    it('clearToken wipes both Keychain entries', async () => {
      await secretStore.storeToken('a'.repeat(40));
      await secretStore.clearToken();
      const got = await secretStore.getToken();
      expect(got).toBeNull();
    });
  });

  describe('tampering detection', () => {
    it('throws when payload bytes are flipped', async () => {
      await secretStore.storeToken('b'.repeat(40));
      // Tamper: replace stored payload with a corrupted version.
      const account = process.env.USER ?? process.env.USERNAME ?? 'default';
      const original = keytarStore.get(`bhg-pipedrive-mcp|${account}`)!;
      const buf = Buffer.from(original, 'base64');
      buf[14] = buf[14] ^ 0xff; // flip a tag byte
      keytarStore.set(`bhg-pipedrive-mcp|${account}`, buf.toString('base64'));
      await expect(secretStore.getToken()).rejects.toThrow();
    });
  });

  describe('salt.bin permission enforcement', () => {
    it('creates salt.bin with mode 0600 when missing', async () => {
      await secretStore.storeToken('c'.repeat(40));
      const sp = join(tempHome, 'salt.bin');
      expect(existsSync(sp)).toBe(true);
      expect(statSync(sp).mode & 0o777).toBe(0o600);
    });

    it('repairs loose permissions and records a repair event', async () => {
      await secretStore.storeToken('d'.repeat(40));
      const sp = join(tempHome, 'salt.bin');
      chmodSync(sp, 0o644);
      // Trigger a fresh read path to invoke ensureSalt.
      await secretStore.getToken();
      expect(statSync(sp).mode & 0o777).toBe(0o600);
      const events = secretStore.permissionRepairEvents.filter(e => e.path === sp);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].before).toBe(0o644);
      expect(events[0].after).toBe(0o600);
    });
  });

  describe('enforceSensitivePerms', () => {
    it('repairs each existing sensitive file', () => {
      const files = ['salt.bin', 'config.json', 'audit.db', 'exceptions.log'];
      for (const f of files) {
        writeFileSync(join(tempHome, f), 'x', { mode: 0o644 });
      }
      secretStore.enforceSensitivePerms();
      for (const f of files) {
        expect(statSync(join(tempHome, f)).mode & 0o777).toBe(0o600);
      }
      expect(secretStore.permissionRepairEvents.length).toBe(files.length);
    });

    it('skips files that do not exist', () => {
      secretStore.enforceSensitivePerms();
      expect(secretStore.permissionRepairEvents.length).toBe(0);
    });
  });

  describe('evaluateRotation', () => {
    function isoDaysAgo(days: number): string {
      return new Date(Date.now() - days * 86_400_000).toISOString();
    }

    it('returns fresh for 10-day-old token', () => {
      expect(secretStore.evaluateRotation(isoDaysAgo(10)).status).toBe('fresh');
    });
    it('returns due for 80-day-old token', () => {
      expect(secretStore.evaluateRotation(isoDaysAgo(80)).status).toBe('due');
    });
    it('returns degraded for 95-day-old token', () => {
      expect(secretStore.evaluateRotation(isoDaysAgo(95)).status).toBe('degraded');
    });
    it('returns refuse for 125-day-old token', () => {
      expect(secretStore.evaluateRotation(isoDaysAgo(125)).status).toBe('refuse');
    });
  });

  describe('envOverrideAllowed', () => {
    it('allows NODE_ENV=test', () => {
      const r = secretStore.envOverrideAllowed({ NODE_ENV: 'test' });
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('test_mode');
    });

    it('allows CI=true', () => {
      const r = secretStore.envOverrideAllowed({ CI: 'true' });
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('test_mode');
    });

    it('rejects break-glass alone (no reason)', () => {
      const r = secretStore.envOverrideAllowed({ BHG_PIPEDRIVE_BREAK_GLASS: '1' });
      expect(r.allowed).toBe(false);
    });

    it('rejects break-glass with whitespace-only reason', () => {
      const r = secretStore.envOverrideAllowed({
        BHG_PIPEDRIVE_BREAK_GLASS: '1',
        BHG_PIPEDRIVE_BREAK_GLASS_REASON: '   ',
      });
      expect(r.allowed).toBe(false);
    });

    it('allows break-glass with non-empty reason', () => {
      const r = secretStore.envOverrideAllowed({
        BHG_PIPEDRIVE_BREAK_GLASS: '1',
        BHG_PIPEDRIVE_BREAK_GLASS_REASON: 'rotating',
      });
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('break_glass:rotating');
    });

    it('does not honor legacy BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE', () => {
      const r = secretStore.envOverrideAllowed({ BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE: '1' });
      expect(r.allowed).toBe(false);
    });

    it('rejects empty env', () => {
      const r = secretStore.envOverrideAllowed({});
      expect(r.allowed).toBe(false);
    });
  });
});
