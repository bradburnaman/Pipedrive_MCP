# Pipedrive MCP — API Key Security Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Each part is a self-contained unit for one subagent.

**Goal:** Retrofit the Pipedrive MCP server to conform to `bhg-app-security-architecture.md` v1.3 at the A1-analogous archetype level. Outcome: no secret on disk, restricted env-override path, no token leakage in logs, tamper-evident audit trail with request/target/diff fields, central kill switch, minimal committed capability policy with build-time hash attestation, session read budgets, typed destructive confirmation, tightened supply chain, and a completed `SECURITY_CHECKLIST.md` with deferred-control owner acceptance.

This release is a **local-hardening milestone**, not full architecture compliance. The remote audit mirror is a declared production-launch blocker for any deployment beyond the current single-user local use.

**Spec:** `docs/superpowers/specs/2026-04-24-api-key-security-design.md` v1.2

**Tech additions:** `keytar` (runtime), `better-sqlite3` (runtime — moved from devDeps), build-time version + policy hash generator, committed `capabilities.json`.

## Implementation Status (as of 2026-04-25)

Branch: `security/api-key-hardening`. See per-part files for shipped-status footers with commit SHAs and deviation notes.

| Part | Status | Commit | Notes |
|------|--------|--------|-------|
| sec-01 | shipped | `17e5160` | as-spec |
| sec-02 | shipped | `2179621` | as-spec |
| sec-03 | shipped | `a67d930` | as-spec; token rotated 2026-04-25 |
| sec-04 | shipped | `b1b4333` | as-spec; minor self-exclusion in forbidden-patterns script |
| sec-05 | shipped | `1a88b0b` | as-spec |
| sec-07 | shipped | `2b9e202` | esbuild added to lifecycle-scripts allowlist (transitive dev-only) |
| sec-06a | shipped | `b72afd4` | core: `AuditLog` class + `audit-verify` CLI + `policy.ts` placeholder |
| sec-06b | shipped | `e5e62cc` | wiring: central dispatch in `server.ts` (deviation from per-handler middleware spec); idle re-verify; safe-degraded gate |
| sec-06 | **incomplete** | — | `target_summary`/`diff_summary` deferred to sec-10; `POLICY_HASH = 'PENDING_SEC_10'`; sec-10 must populate or `SECURITY_CHECKLIST.md` must accept NULL summaries for non-destructive writes |
| sec-10 | not started | — | discharges sec-06 deferred items |
| sec-09 | not started | — | adversarial tests; depends on sec-10 |
| sec-08 | not started | — | docs cutover; merges last |

**Key architecture deviations vs. spec:**
1. **Central dispatch wrapping (sec-06b)**: `server.ts:dispatchToolCall` audits writes and decorates reads at the single SDK request handler; the spec proposed wrapping every tool handler with an `auditWrite()` HOF. Same security guarantee; no per-tool churn.
2. **`target_summary` / `diff_summary` deferred to sec-10**: schema accepts NULL today; `tests/lib/audit-log.test.ts` has a `TODO(sec-10)` assertion; three call sites in `src/server.ts` are marked `TODO(sec-10)`.
3. **`POLICY_HASH` placeholder**: `src/lib/policy.ts` exports the literal string `'PENDING_SEC_10'`. sec-10 replaces it with the SHA-256 of the canonical capability policy (one-line edit).
4. **esbuild in lifecycle-scripts allowlist (sec-07)**: needed because `tsx` and `vitest > vite` pull esbuild's binary postinstall. Verified dev-only via `npm ls --omit=dev esbuild` (empty).

**Production-readiness gate** (per spec §16): even with all 10 parts shipped, this remains restricted to single-user local interactive use until a remote audit-log mirror exists. Do not characterize the merged branch as "production-ready" without that mirror.

## Pre-work (manual, non-code — BEFORE Part sec-01)

**Rotate the Pipedrive API token in Pipedrive UI (Settings → Personal preferences → API → Regenerate).** The current token has been replicating to OneDrive via the synced project folder and must be treated as leaked. Record the issuance date.

## Parts

| Part | File | Scope | Depends On |
|------|------|-------|------------|
| sec-01 | [parts/security/01-preflight-and-dependencies.md](parts/security/01-preflight-and-dependencies.md) | Add `keytar` + `better-sqlite3` (both runtime), remove `dotenv`, tighten runtime pins, update `.gitignore`, stub CLIs | — |
| sec-02 | [parts/security/02-path-safety.md](parts/security/02-path-safety.md) | `PathSafety` module; sync-root + CWD-forbidden-files refusal; startup enforcement | sec-01 |
| sec-03 | [parts/security/03-secret-store.md](parts/security/03-secret-store.md) | `SecretStore` (Keychain + AES-256-GCM wrapper + file-mode enforcement); restricted env-override; tightened rotation (75/90/120); setup / rotate / revoke CLIs; Claude Desktop config probe | sec-01, sec-02 |
| sec-04 | [parts/security/04-log-redaction.md](parts/security/04-log-redaction.md) | Pino `redact`, `redactUrl`, error-normalizer strip, forbidden-patterns CI (incl. `env:` blocks with `PIPEDRIVE_API_TOKEN`) | sec-01 |
| sec-05 | [parts/security/05-version-id.md](parts/security/05-version-id.md) | Build-time `VERSION_ID` **+ `POLICY_HASH`**; CI dirty-build gate | sec-01 |
| sec-06 | [parts/security/06-audit-log.md](parts/security/06-audit-log.md) | Hash-chained SQLite audit with `request_hash` / `target_summary` / `diff_summary` / `policy_hash` fields; `auditWrite` middleware; safe-degraded = writes-off + reads-warning-prefixed; hot-check every 60s | sec-02, sec-05 |
| sec-07 | [parts/security/07-supply-chain.md](parts/security/07-supply-chain.md) | `npm audit` high/critical; Dependabot; lockfile-integrity check; lifecycle-scripts probe; SBOM | sec-01 |
| sec-10 | [parts/security/10-capability-policy-kill-switch-budgets-confirmation.md](parts/security/10-capability-policy-kill-switch-budgets-confirmation.md) | `capabilities.json` + hash attestation; central `writes_enabled` kill switch + CLI; session read budgets (records/bytes/depth) + broad-query confirmation; typed destructive confirmation (`DELETE-*`, `BULK:*`, `OWNER-CHANGE`, `STATUS-CHANGE`, `VALUE-CHANGE`, `PIPELINE-CHANGE`) | sec-05, sec-06 |
| sec-09 | [parts/security/09-integration-tests.md](parts/security/09-integration-tests.md) | Adversarial tests PD-001..PD-010 + TC-AUDIT-1 / TC-POLICY-1 / TC-KILL-1 / TC-PERM-1 | sec-02, sec-03, sec-06, sec-10 |
| sec-08 | [parts/security/08-docs-and-checklist.md](parts/security/08-docs-and-checklist.md) | Delete `.env`/`.env.example`; README rewrite; `SECURITY_CHECKLIST.md` with deferred-control owner-acceptance section | sec-03, sec-04, sec-06, sec-07, sec-09, sec-10 |

## Execution Order

Pre-work (rotate token) → sec-01 → sec-02 → sec-03 → (sec-04, sec-05, sec-07 in parallel) → sec-06 → sec-10 → sec-09 → **sec-08 merges last** (docs + `.env*` deletion, finishes cutover)

## File Structure (additions & changes)

```
capabilities.json                      — NEW: committed policy file at repo root
SECURITY_CHECKLIST.md                  — NEW: §13 checklist + deferred-control acceptance
scripts/
  embed-version.mjs                    — NEW: writes src/lib/version-id.ts with VERSION_ID + POLICY_HASH
  check-forbidden-patterns.sh          — NEW
  check-lifecycle-scripts.mjs          — NEW
src/
  bin/
    setup.ts                           — NEW (`npm run setup`)
    revoke.ts                          — NEW (`npm run revoke`)
    audit-verify.ts                    — NEW (`npm run audit-verify`)
    kill-switch.ts                     — NEW (`npm run kill-switch -- --on|--off`)
  lib/
    path-safety.ts                     — NEW
    secret-store.ts                    — NEW
    claude-desktop-probe.ts            — NEW
    version-id.ts                      — NEW (generated; gitignored)
    audit-log.ts                       — NEW (with request_hash/target_summary/diff_summary)
    audit-middleware.ts                — NEW
    sanitize-log.ts                    — NEW
    capability-policy.ts               — NEW
    kill-switch.ts                     — NEW
    read-budget.ts                     — NEW
    typed-confirmation.ts              — NEW
    error-normalizer.ts                — MODIFIED: token-pattern strip
  index.ts                             — MODIFIED: new startup sequence
  config.ts                            — MODIFIED: token no longer read from env in normal path
  server.ts                            — MODIFIED: middleware wiring (kill switch, capability policy, read budget, typed confirmation, auditWrite)
  types.ts                             — MODIFIED: ServerConfig minus apiToken; add SafeDegradedRef
tests/
  lib/
    path-safety.test.ts                — NEW
    secret-store.test.ts               — NEW (round-trip, tamper, rotation gate, perm repair)
    audit-log.test.ts                  — NEW
    version-id.test.ts                 — NEW
    sanitize-log.test.ts               — NEW
    capability-policy.test.ts          — NEW
    kill-switch.test.ts                — NEW
    read-budget.test.ts                — NEW
    typed-confirmation.test.ts         — NEW
    claude-desktop-probe.test.ts       — NEW
    error-normalizer.test.ts           — EXTENDED
  integration/
    pd-001-env-override.integration.test.ts
    pd-002-destructive-injection.integration.test.ts
    pd-003-broad-scrape.integration.test.ts
    pd-004-audit-rollback.integration.test.ts
    pd-005-sync-root-symlink.integration.test.ts
    pd-006-url-token-leak.integration.test.ts
    pd-007-stale-token.integration.test.ts
    pd-008-bulk-write.integration.test.ts
    pd-009-keychain-acl.integration.test.ts
    pd-010-dirty-build.integration.test.ts
    tc-audit.integration.test.ts
    tc-policy.integration.test.ts
    tc-kill.integration.test.ts
    tc-perm.integration.test.ts
.github/
  workflows/security.yml               — NEW
  dependabot.yml                       — NEW
.env.example                           — DELETED
.env                                   — DELETED (must also be physically removed from local disk)
README.md                              — MODIFIED: setup, env-var table, troubleshooting, kill-switch section
package.json                           — MODIFIED: remove dotenv; add keytar + better-sqlite3 as runtime; pin ranges; add CLI scripts
package-lock.json                      — REGENERATED
```

## Success Criteria

All of the following must be true before sec-08 merges and the hardening is declared complete:

1. **No `.env`** present in the repo or the developer's working copy. `dotenv` absent from dependencies.
2. **Keychain** populated via `npm run setup`; a fresh `npm start` reads the token from Keychain with no env var set.
3. **Env-override is gated** — unset `BHG_PIPEDRIVE_BREAK_GLASS`, startup with `BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE=1 PIPEDRIVE_API_TOKEN=…` **ignores the env var** and proceeds via Keychain (or fails if Keychain is empty). Test mode + break-glass + reason paths both function and audit (PD-001, PD-001b).
4. **Audit rows** for write calls include `request_hash`, `target_summary`, `diff_summary`, `version_id`, `policy_hash`. Chain verifies. Direct row edit detected by `verifyChain` (TC-AUDIT-1, PD-004 caveat documented).
5. **Audit chain break** → safe-degraded: writes rejected with 503; read responses prefixed with `_security_notice`. Next start still in safe-degraded until `audit-verify --acknowledge-and-reset`.
6. **Path safety** — `HOME` pointed at a simulated sync root, startup exits 1 before any secret read (PD-005). `.env` / `.npmrc` / `*.db` / `*.log` / 40-hex file in CWD cause exit 1.
7. **Log redaction** — crafted Pipedrive error whose `err.config.url` carries `?api_token=X` produces stderr with no token value (PD-006).
8. **Kill switch** — `npm run kill-switch -- --off` flips `writes_enabled`; every write tool rejects with `WRITES_DISABLED`; audit row on flip and on each rejection (TC-KILL-1).
9. **Capability policy** — editing `capabilities.json` after build causes runtime hash mismatch; process enters safe-degraded mode within 60s (TC-POLICY-1). Policy-version bump rules enforced in PR review (doc requirement in `SECURITY_CHECKLIST.md`).
10. **Read budgets** — exhausting `max_records_per_session` blocks subsequent reads; broad `list-deals` without filters requires `confirm: "BROAD-READ:list-deals"` (PD-003).
11. **Typed destructive confirmation** — `delete-deal` with `confirm: true` rejects; with `confirm: "DELETE-DEAL:123"` proceeds. Bulk pattern triggers `BULK:<count>` confirmation (PD-002, PD-008).
12. **File permissions** — `salt.bin` at 0644 is repaired to 0600 with an audit row; un-repairable loose perms trigger safe-degraded (TC-PERM-1).
13. **Rotation** — token age 74d silent, 76d warn, 91d per-call warn, 121d hard-block unless `ALLOW_STALE=1` + reason; reason missing → still refused (PD-007).
14. **CI** fails on: high `npm audit`, dirty-build commit to main (PD-010), forbidden-pattern match (incl. `env:` with `PIPEDRIVE_API_TOKEN` in sample configs committed in the repo), lockfile drift, unexpected lifecycle scripts.
15. **`SECURITY_CHECKLIST.md`** committed with every applicable row either checked or marked N/A with reason; deferred-controls section names owner (Brad), trigger for re-opening, and signature date.
16. **Claude Desktop probe** — when `~/Library/Application Support/Claude/claude_desktop_config.json` contains `PIPEDRIVE_API_TOKEN` in an `env:` block, a loud stderr warning appears at startup and an audit row is written. (Non-fatal.)

## Out of Scope for This Plan (tracked in `SECURITY_CHECKLIST.md` deferred-controls section)

- **Remote audit-log mirror** — launch blocker for multi-user / shared-infra deployment. Accepted as residual risk for current single-user local use, with signed owner acceptance. Destination selection (Azure Monitor / Sentinel / workspace) is a separate infra task.
- **Real-time anomaly alerts on the audit stream.** Deferred for interactive single-user; blocking for any A2-style scheduled path.
- **Full §10.12 resource limits.** Per-request timeout is in place; tool-invocation rate, concurrency cap, circuit breakers deferred until traffic justifies.
- **Pipedrive OAuth2 migration.** Separate follow-up spec. This would move the app from §9.1 Tier 4 to Tier 1 and is the most impactful single improvement still available.
- **Rollback rehearsal.** Documented; not rehearsed.
- **Cross-platform Keychain review.** Deferred until a second user adopts.
