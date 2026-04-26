import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadPolicy, recomputeHash, PolicyHashMismatchError } from '../../src/lib/capability-policy.js';
import { POLICY_HASH } from '../../src/lib/version-id.js';

// Canonical JSON: deterministic over key order (mirrors embed-version.mjs logic)
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + (v as unknown[]).map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
}

function sha256(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

const REAL_POLICY_PATH = 'capabilities.json';

describe('loadPolicy', () => {
  it('returns parsed policy when hash matches', () => {
    const policy = loadPolicy(REAL_POLICY_PATH);
    expect(policy.version).toBe('1.0.0');
    expect(typeof policy.writes_enabled_default).toBe('boolean');
    expect(policy.tools).toBeDefined();
    expect(policy.read_budgets).toBeDefined();
    expect(policy.bulk_detector).toBeDefined();
  });

  it('POLICY_HASH in version-id matches actual capabilities.json', () => {
    const hash = recomputeHash(REAL_POLICY_PATH);
    expect(hash).toBe(POLICY_HASH);
  });

  it('throws PolicyHashMismatchError when file is mutated', () => {
    const tmp = join(tmpdir(), `cap-policy-test-${Date.now()}.json`);
    const good = JSON.parse(readFileSync(REAL_POLICY_PATH, 'utf8'));
    // Mutate: flip writes_enabled_default
    good.writes_enabled_default = !good.writes_enabled_default;
    writeFileSync(tmp, JSON.stringify(good));
    try {
      expect(() => loadPolicy(tmp)).toThrow(PolicyHashMismatchError);
      expect(() => loadPolicy(tmp)).toThrow(/hash mismatch/);
    } finally {
      unlinkSync(tmp);
    }
  });
});

describe('recomputeHash', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `cap-hash-test-${Date.now()}.json`);
  });

  afterEach(() => {
    if (existsSync(tmp)) unlinkSync(tmp);
  });

  it('is stable across key-order permutations of equivalent JSON', () => {
    const objA = { b: 2, a: 1, c: { z: 26, a: 1 } };
    const objB = { a: 1, c: { a: 1, z: 26 }, b: 2 };

    writeFileSync(tmp, JSON.stringify(objA));
    const hashA = recomputeHash(tmp);

    writeFileSync(tmp, JSON.stringify(objB));
    const hashB = recomputeHash(tmp);

    expect(hashA).toBe(hashB);
  });

  it('differs when content changes', () => {
    const obj = { version: '1.0.0', flag: true };
    writeFileSync(tmp, JSON.stringify(obj));
    const h1 = recomputeHash(tmp);

    writeFileSync(tmp, JSON.stringify({ ...obj, flag: false }));
    const h2 = recomputeHash(tmp);

    expect(h1).not.toBe(h2);
  });

  it('canonical hash matches manual computation', () => {
    const obj = { b: 2, a: 1 };
    writeFileSync(tmp, JSON.stringify(obj));
    const got = recomputeHash(tmp);
    const expected = sha256(canonicalJson(obj));
    expect(got).toBe(expected);
  });
});

describe('PolicyHashMismatchError', () => {
  it('carries expected and got fields', () => {
    const err = new PolicyHashMismatchError('aaa', 'bbb');
    expect(err.expected).toBe('aaa');
    expect(err.got).toBe('bbb');
    expect(err.name).toBe('PolicyHashMismatchError');
    expect(err instanceof Error).toBe(true);
  });
});
