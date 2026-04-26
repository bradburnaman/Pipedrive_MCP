# Pipedrive MCP — Security Checklist

**Architecture reference:** `/Users/bburnaman/Documents/Apps/Microsoft 365 Send MCP/docs/bhg-app-security-architecture.md` v1.3
**App archetype:** A1-analogous (local stdio MCP, user-delegated via long-lived Pipedrive API token)
**Design spec:** `docs/superpowers/specs/2026-04-24-api-key-security-design.md`
**Plan:** `docs/superpowers/plans/2026-04-24-api-key-security-plan.md`
**Last updated:** 2026-04-26
**Owner:** Brad Burnaman

## Archetype Selection
- [x] Archetype chosen (A1-analogous) and documented with rationale — design §4
- [N/A] A2/A3/A4 justifications — not applicable
- [N/A] Privileged delegated user §10.14 — Pipedrive scope does not include org-wide admin

## App Registration
- [N/A] Single-tenant / redirect URI / public client flows — Pipedrive API token is not an Entra registration

## Permissions
- [N/A] Delegated > Application — Pipedrive personal token is inherently delegated
- [x] Blast-radius documented — design §4, §5
- [N/A] AAP / RSC / Sites.Selected — not a Microsoft app

## Secrets
- [x] Secret tier documented (Tier 4 long-lived; Tier 1 aspiration via OAuth2 follow-up) — design §4
- [x] Stored in Keychain (local) — implementation `src/lib/secret-store.ts`
- [x] No `.env` file in project — `.env.example` deleted in sec-08; CWD-clean check in `src/lib/path-safety.ts` blocks `.env*`, `.npmrc`, `.db`, `.log`, 40-hex filenames, and renamed-env content scans
- [x] Nothing secret-adjacent in synced folder or git — startup path-safety check (`src/lib/path-safety.ts`) + `.gitignore` excludes `salt.bin`, `*.db`, `dist/sbom.json`, `src/lib/version-id.ts`
- [x] Rotation schedule documented — fresh ≤74d, due 75–89d (warn), degraded 90–119d, refuse ≥120d (spec §7.5; `evaluateRotation` in `src/lib/secret-store.ts`; PD-007 unit-tested)
- [x] Keychain ACL tested for this runtime — probe documented at top of `src/lib/secret-store.ts` (recorded 2026-04-25); macOS ACL on a Node interpreter cannot constrain to this binary, so AES-256-GCM encryption wrapper is the live confidentiality control. Documented as residual PD-009.
- [x] Encryption-wrapper implemented — AES-256-GCM with scrypt KDF (N=2^15, r=8, p=1; seed in Keychain service `bhg-pipedrive-mcp-kdf`, salt at `~/.bhg-pipedrive-mcp/salt.bin` mode 0600)
- [N/A] MSAL disk cache prohibition — no MSAL

## Operational Controls
- [x] Kill switch (central) — `KillSwitch` writes_enabled flag in `~/.bhg-pipedrive-mcp/config.json`; `npm run kill-switch -- --off|--on --reason "..."`; every flip + WRITES_DISABLED rejection audited (sec-10; TC-KILL-1 verified)
- [x] Coarse env category override (`PIPEDRIVE_ENABLED_CATEGORIES=read`) overlaps with kill switch — any source saying "writes off" wins
- [x] Outbound rate limits — existing `PipedriveClient` honors Pipedrive's rate-limit headers
- [Partial] MCP resource limits (§10.12) — existing 30s per-request timeout covers the primary concern; tool-invocation rate / concurrency cap / circuit breaker deferred (D-03)
- [x] Hash-chained audit log with no-delete semantics — `src/lib/audit-log.ts` (SHA-256 chain over GENESIS → row hashes; tamper detection at startup, 60s tail hot-check, and 15-min idle re-verify; TC-AUDIT-1 verified)
- [ ] Remote audit mirror — **deferred (D-01)**, destination not resolved
- [Partial] Real-time anomaly alerts (§10.13) — deferred (D-02); manual review via `npm run audit-verify`
- [x] Idempotency — write tools accept optional idempotency key (audit row carries `idempotency_key` column)
- [N/A] External-send whitelist — no external-send surface
- [N/A] §10.6.2 confirmation subsystem (full out-of-LLM cryptographic confirmation) — not applicable; there is no outbound-send surface to gate
- [x] Typed destructive-action confirmation for CRM writes/deletes — implemented per spec §10.6-lite (friction + audit, not cryptographic proof of intent). `src/lib/typed-confirmation.ts`: HIGH_RISK deletes require `confirm: "DELETE-<entity>:<id>"` plus a `user_chat_message` containing the same string (16-char SHA-256 hash captured to `audit_rows.diff_summary`). Bulk detector (sliding window) blocks runaway sequences with `BULK:<count>` confirmation. Spec §11 explicitly notes a fabricated `user_chat_message` passes — it is friction + forensic capture, not cryptographic proof.
- [x] Capability policy (§10.8) — `capabilities.json` enumerates 32 tools with categories, destructive flags, max page sizes, and read-budget / bulk-detector parameters. Canonical SHA-256 baked into `src/lib/version-id.ts` at build time. Startup mismatch → exit 1. Runtime mismatch → safe-degraded (TC-POLICY-1a/1b verified).
- [x] Session retrieval budgets (§10.11) — `src/lib/read-budget.ts` enforces per-session record/byte/pagination-depth limits and broad-query confirmation (session-sticky per tool). PD-003 verified.
- [N/A] Sensitivity labels — not a Microsoft-labeled data source
- [N/A] Prompt-injection boundary (§10.9) — no tool ingests external free-form text that feeds outbound actions; note content sanitized by `src/lib/sanitizer.ts`
- [N/A] Attachment controls — no attachments
- [N/A] Privileged delegated user §10.14 — user runs only against their own Pipedrive data

## Runtime Hardening
- [x] Startup check refuses to run if config/data paths inside a synced folder — `src/lib/path-safety.ts` (`assertConfigDirSafe`, denylist covers OneDrive / iCloud / Dropbox / Google Drive / Box / Sync; resolves symlinks to defeat indirection; PD-005 verified)
- [x] Startup check refuses to run if CWD contains `.env*`/`.npmrc`/40-hex/`.db`/`.log` — `assertCwdClean`
- [x] No token in stdout/stderr/logs — Pino `redact` paths + `redactUrl` (api_token query param) + `stripTokenPattern` (40-hex pattern) + forbidden-patterns grep in CI; PD-006 verified
- [x] Restricted env-override gating — `envOverrideAllowed` in `src/lib/secret-store.ts` allows `PIPEDRIVE_API_TOKEN` env var only under `NODE_ENV=test` / `CI=true` or `BHG_PIPEDRIVE_BREAK_GLASS=1` + non-empty `BHG_PIPEDRIVE_BREAK_GLASS_REASON`. Break-glass writes audit row `BREAK_GLASS_ENV_OVERRIDE` + appends to `~/.bhg-pipedrive-mcp/exceptions.log`. Legacy `BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE` retired. PD-001/001b verified.
- [x] Sensitive file permission enforcement — `enforceSensitivePerms` repairs `salt.bin` / `config.json` / `audit.db` / `exceptions.log` to 0o600 at startup; each repair audited as `PERMISSION_REPAIRED` (TC-PERM-1 verified)
- [x] Machine migration procedure documented — README "Revoking local access" + re-run `npm run setup`
- [x] Deployed version ID embedded and emitted in every audit row — `src/lib/version-id.ts` (generated at build time; SHA + timestamp + dirty flag); CI dirty-build guard refuses to ship a dirty tree (PD-010 verified)
- [x] Safe-degraded mode — broken audit chain or runtime policy mismatch flips a process-level flag; subsequent writes return 503; reads continue and carry `_security_notice` field (sec-06b)

## Supply Chain
- [x] Lockfile committed; no `latest` or unpinned production deps
- [x] CI dependency scanning — `npm audit --audit-level=high` in `.github/workflows/security.yml` + Dependabot (`.github/dependabot.yml`)
- [x] Production installs use `npm ci`
- [x] SBOM generated on build — cyclonedx-json at `dist/sbom.json`, uploaded as CI artifact
- [x] Forbidden-pattern grep in CI — `scripts/check-forbidden-patterns.sh`
- [x] npm lifecycle-scripts allowlist — `scripts/check-lifecycle-scripts.mjs` permits only `keytar`, `better-sqlite3`, `esbuild`; new postinstall scripts fail CI

## Monitoring
- [N/A] Entra sign-in log review — not an Entra app
- [Partial] Alert rules — local anomaly alerts deferred (D-02); Pipedrive token creation/use alerts are Pipedrive-side
- [N/A] Conditional Access — not an Entra app
- [x] Internal audit log queryable via admin tool — `npm run audit-verify`
- [x] Runbook for incident response — design spec §13.5 + README Troubleshooting

## Lifecycle
- [x] Versioned deployments — `VERSION_ID` embedded; logged at startup; emitted in every audit row's `version_id` column
- [Partial] Rollback rehearsal documented — README references procedure; not rehearsed (D-05)
- [x] Decommissioning procedure — `npm run revoke` wipes Keychain + archives `audit.db`; Pipedrive-side token deletion is a manual step (documented in README)

## Documentation
- [x] SECURITY_CHECKLIST.md committed — this file
- [x] Design spec documents owner, purpose, scopes with justification, blast radius
- [x] `capabilities.json` committed and hash-pinned to the binary
- [x] Decommissioning procedure documented
- [x] Setup procedure reproducible by another engineer — `npm run setup`

## Adversarial Test Coverage (sec-09)

The following test cases from the adversarial test plan are implemented and pass under `npm run test:integration` (63 tests, all green as of 2026-04-26):

| Case | Coverage | File |
|------|----------|------|
| PD-001 | Restricted env-override gating | `tests/integration/pd-001-env-override.integration.test.ts` |
| PD-001b | Break-glass audit row | (same as above) |
| PD-002 | Destructive confirmation flow + framing invariant | `tests/integration/pd-002-destructive-injection.integration.test.ts` |
| PD-003 | Broad-query confirmation + session record budget | `tests/integration/pd-003-broad-scrape.integration.test.ts` |
| PD-004 | Audit rollback residual risk (documented limitation) | `tests/integration/pd-004-audit-rollback.integration.test.ts` |
| PD-005 | Sync-root symlink → startup exit 1 | `tests/integration/pd-005-sync-root-symlink.integration.test.ts` |
| PD-006 | URL token redaction + 40-hex stripping | `tests/integration/pd-006-url-sanitizer.integration.test.ts` |
| PD-007 | Stale-token rotation schedule | `tests/integration/pd-007-stale-token.integration.test.ts` |
| PD-008 | Bulk-write detector + BULK confirmation | `tests/integration/pd-008-bulk-write.integration.test.ts` |
| PD-009 | Keychain ACL bypass | Documented as untestable in automation (spec §7.6); ACL bypass succeeds by design on macOS |
| PD-010 | CI dirty-build refusal | `tests/integration/pd-010-dirty-build.integration.test.ts` |
| TC-AUDIT-1 | Tamper detection (modify/delete/truncate) | `tests/integration/tc-audit.integration.test.ts` |
| TC-KILL-1 | Kill switch end-to-end | `tests/integration/tc-kill.integration.test.ts` |
| TC-PERM-1 | Sensitive file permission repair | `tests/integration/tc-perm-001-permission-repair.integration.test.ts` |
| TC-POLICY-1a | Startup hash mismatch → exit 1 | `tests/integration/tc-policy.integration.test.ts` |
| TC-POLICY-1b | Runtime hash mismatch → safe-degraded | (same as above) |

## Production approval (explicit, spec §16)

**This release is not approved for production, multi-user, automation, or shared-infrastructure deployment until the remote audit mirror exists.** It is approved for single-user local interactive development on Brad's Mac only. Do not run this MCP under a scheduled job, from CI, on a shared VM, or on behalf of another user.

## Deferred controls — owner acceptance (spec §16)

| # | Deferred control | Owner | Compensating control | Trigger to re-open | Accepted on | Signature |
|---|---|---|---|---|---|---|
| D-01 | Remote audit-log mirror (§10.3) | Brad | Local hash-chained audit; PD-004 documented as residual; **single-user local interactive only** | (a) second user adopts, (b) app runs on shared infra, (c) any A2-style scheduled path, (d) tenant compliance requirement, (e) any production deployment | 2026-04-26 | `BB` |
| D-02 | Real-time anomaly alerts (§10.13) | Brad | Manual audit review; `npm run audit-verify` | Same as D-01 | 2026-04-26 | `BB` |
| D-03 | Full §10.12 resource limits | Brad | Per-request 30s timeout; concurrency not limited | Multi-agent / high-rate usage | 2026-04-26 | `BB` |
| D-04 | Pipedrive OAuth2 migration | Brad | Tier 4 secret with Keychain + AES-256-GCM encryption wrapper + 90-day rotation | Time-boxed in the next calendar quarter | 2026-04-26 | `BB` |
| D-05 | Rollback rehearsal (§12.3) | Brad | Documented procedure in README | Before any multi-user deployment | 2026-04-26 | `BB` |
| D-06 | Cross-platform Keychain review | Brad | macOS-only today | A second user adopts on Windows / Linux | 2026-04-26 | `BB` |

Replace `BB` at merge time. Re-sign each row at every full review per architecture §16.

## Open follow-ups

1. Pipedrive OAuth2 migration → Tier 1 secret (scope in a separate spec).
2. Remote audit-log mirror destination (Azure Monitor / Sentinel / workspace TBD).
3. Full §10.12 MCP resource limits (tool-invocation rate, concurrency cap, circuit breakers).
4. Real-time anomaly alerts on the audit stream (§10.13).
5. URL-encoded `api_token=%61%62…` and mixed-case 40-hex variant tests for `stripTokenPattern` (Brad flagged 2026-04-25).
