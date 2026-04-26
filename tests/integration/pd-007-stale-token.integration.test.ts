// PD-007: Stale token detection via evaluateRotation().
// Per spec §7.5 the rotation schedule is:
//   0–74 days  → fresh  (silent)
//  75–89 days  → due    (logged warning)
//  90–119 days → degraded (writes still work but logged)
// 120+ days   → refuse  (server refuses to start)
import { describe, it, expect } from 'vitest';
import { evaluateRotation } from '../../src/lib/secret-store.js';

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe('PD-007 — stale token detection (evaluateRotation)', () => {
  it('returns fresh for a token issued today', () => {
    const r = evaluateRotation(daysAgoIso(0));
    expect(r.status).toBe('fresh');
    expect(r.ageDays).toBeLessThan(1);
  });

  it('returns fresh at 74 days', () => {
    const r = evaluateRotation(daysAgoIso(74));
    expect(r.status).toBe('fresh');
  });

  it('returns due at exactly 75 days', () => {
    const r = evaluateRotation(daysAgoIso(75));
    expect(r.status).toBe('due');
  });

  it('returns due at 89 days', () => {
    const r = evaluateRotation(daysAgoIso(89));
    expect(r.status).toBe('due');
  });

  it('returns degraded at 90 days', () => {
    const r = evaluateRotation(daysAgoIso(90));
    expect(r.status).toBe('degraded');
  });

  it('returns degraded at 119 days', () => {
    const r = evaluateRotation(daysAgoIso(119));
    expect(r.status).toBe('degraded');
  });

  it('returns refuse at exactly 120 days', () => {
    const r = evaluateRotation(daysAgoIso(120));
    expect(r.status).toBe('refuse');
  });

  it('returns refuse for a very old token (365 days)', () => {
    const r = evaluateRotation(daysAgoIso(365));
    expect(r.status).toBe('refuse');
    expect(r.ageDays).toBeGreaterThan(364);
  });

  it('populates issuedAt as a Date object', () => {
    const iso = daysAgoIso(10);
    const r = evaluateRotation(iso);
    expect(r.issuedAt).toBeInstanceOf(Date);
    // Allow 5s tolerance for test execution time
    expect(Math.abs(r.issuedAt.getTime() - new Date(iso).getTime())).toBeLessThan(5_000);
  });
});
