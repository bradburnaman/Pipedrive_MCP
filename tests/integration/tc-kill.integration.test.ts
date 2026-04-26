// TC-KILL-1: Kill switch end-to-end.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KillSwitch } from '../../src/lib/kill-switch.js';
import {
  createTestDeps, cleanupTestDeps, dispatch, makeToolMap, mockCreateTool, readAuditRows,
  type TestDeps,
} from './_harness.js';

let deps: TestDeps;
let toolMap: ReturnType<typeof makeToolMap>;

beforeEach(() => {
  deps = createTestDeps();
  toolMap = makeToolMap([mockCreateTool('create-deal')]);
});

afterEach(() => cleanupTestDeps(deps));

describe('TC-KILL-1 — kill switch end-to-end', () => {
  it('writes succeed when kill switch is on', async () => {
    expect(deps.killSwitch.writesEnabled).toBe(true);
    const r = await dispatch('create-deal', { title: 'Test' }, toolMap, deps);
    expect(r.id).toBe(42);
  });

  it('setWritesEnabled(false) causes next write to be rejected with WRITES_DISABLED', async () => {
    deps.killSwitch.setWritesEnabled(false);

    const r = await dispatch('create-deal', { title: 'Test' }, toolMap, deps);
    expect(r.reason).toBe('WRITES_DISABLED');
    expect(r.code).toBe(503);

    const rows = readAuditRows(deps.dbPath);
    expect(rows.at(-1)?.reason_code).toBe('WRITES_DISABLED');
    expect(rows.at(-1)?.status).toBe('rejected');
  });

  it('a new KillSwitch instance reads the persisted false value', () => {
    deps.killSwitch.setWritesEnabled(false);
    const ks2 = new KillSwitch(deps.configPath);
    expect(ks2.writesEnabled).toBe(false);
  });

  it('the existing instance picks up out-of-process flips (CLI cross-process scenario)', async () => {
    // First write succeeds — switch is on
    let r = await dispatch('create-deal', { title: 'Pre-flip' }, toolMap, deps);
    expect(r.id).toBe(42);

    // Simulate the CLI flipping the switch in another process by writing
    // directly to config.json, bypassing the in-memory instance entirely.
    const fs = await import('node:fs');
    fs.writeFileSync(deps.configPath, JSON.stringify({ writes_enabled: false }), { mode: 0o600 });

    // The running server's existing KillSwitch instance must observe the change
    r = await dispatch('create-deal', { title: 'Post-flip' }, toolMap, deps);
    expect(r.reason).toBe('WRITES_DISABLED');
    expect(r.code).toBe(503);
  });

  it('re-enabling writes allows subsequent calls to succeed', async () => {
    deps.killSwitch.setWritesEnabled(false);
    await dispatch('create-deal', { title: 'Blocked' }, toolMap, deps);

    deps.killSwitch.setWritesEnabled(true);
    const r = await dispatch('create-deal', { title: 'Allowed' }, toolMap, deps);
    expect(r.id).toBe(42);
  });
});
