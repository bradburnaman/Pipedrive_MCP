# Part sec-08: Docs & SECURITY_CHECKLIST — Cutover

> Part 8 of 9. **This part merges last** — it completes the cutover from `.env` to Keychain and declares the hardening complete.
> **Depends on:** sec-03, sec-04, sec-06, sec-07.
> **Produces:** Deleted `.env` + `.env.example`, rewritten `README.md`, new `SECURITY_CHECKLIST.md` at repo root.

---

## Task 1: Delete `.env` and `.env.example`

- [ ] `rm .env .env.example`.
- [ ] Verify they are also removed from the developer's local working tree.
- [ ] Confirm `.gitignore` keeps `.env` ignored (so a later user can't accidentally re-add one).

## Task 2: Rewrite README — Setup section

Replace the current `## Setup` section (lines ~5–50) with:

```markdown
## Setup

### 1. Rotate/generate your Pipedrive API token

Go to **Pipedrive > Settings > Personal preferences > API**. If you have a prior
token for this app, regenerate it — any prior token is considered compromised
if it ever lived in a `.env` file. Record the new token; you will paste it
once in step 3 and it will be stored in macOS Keychain after that.

### 2. Install and build

```bash
npm ci
npm run build
```

### 3. Run setup

```bash
npm run setup
```

This will:
- prompt you to paste the API token
- validate it against Pipedrive (`GET /v1/users/me`)
- store it (encrypted) in macOS Keychain under service `bhg-pipedrive-mcp`
- create `~/.bhg-pipedrive-mcp/` with `config.json` and `salt.bin`
- print your next rotation due date (90 days)

The token is never written to a `.env` file, never committed to git, and
never logged.

### 4. Configure Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "pipedrive": {
      "command": "node",
      "args": ["/absolute/path/to/pipedrive-mcp/dist/index.js"]
    }
  }
}
```

**No `env:` block is needed** — the server resolves the token from Keychain at
startup. Hardcoding the token in Claude Desktop's config is the same anti-pattern
as `.env` and is not supported.

### 5. Rotating the token

Regenerate the token in Pipedrive, then run:

```bash
npm run setup -- --rotate
```

### 6. Revoking local access

```bash
npm run revoke
```

Wipes the Keychain entry and archives `audit.db`. Remember to also regenerate
the token in Pipedrive UI so the old token cannot be used from elsewhere.
```

- [ ] Update README Setup.

## Task 3: README — Environment Variables and Kill Switch

Replace the table. `PIPEDRIVE_API_TOKEN` is no longer normal; the kill switch gets its own section:

```markdown
### Kill switch (central)

`writes_enabled` in `~/.bhg-pipedrive-mcp/config.json` controls whether any
create / update / delete tool can run. Default `true`. Flip it with:

```bash
npm run kill-switch -- --off --reason "investigating anomaly"
npm run kill-switch -- --on  --reason "resolved"
```

Every flip is logged as an audit row. Each write attempted while writes are
disabled also produces an audit row with reason `WRITES_DISABLED`. The coarse
env category override (`PIPEDRIVE_ENABLED_CATEGORIES=read`) still works — any
source saying "writes off" wins.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PIPEDRIVE_ENABLED_CATEGORIES` | no | `read,create,update,delete` | Comma-separated categories. Coarse override that overlaps with the kill switch. |
| `PIPEDRIVE_DISABLED_TOOLS` | no | — | Comma-separated tool names to disable. |
| `PIPEDRIVE_LOG_LEVEL` | no | `info` | Log level: `info` or `debug`. |
| `PORT` | no | `3000` | HTTP port for SSE mode (not yet implemented). |

### Override flags (restricted; audited)

| Variable(s) | Effect |
|-------------|--------|
| `NODE_ENV=test` or `CI=true` | Allow reading `PIPEDRIVE_API_TOKEN` from env instead of Keychain. Intended for tests only. |
| `BHG_PIPEDRIVE_BREAK_GLASS=1` **and** `BHG_PIPEDRIVE_BREAK_GLASS_REASON="text"` | Allow env-override in a non-test runtime. Both required. Emits stderr warning, audit row, and appends to `exceptions.log`. Use only as a break-glass. |
| `BHG_PIPEDRIVE_ALLOW_STALE=1` **and** `BHG_PIPEDRIVE_STALE_REASON="text"` | Permit startup with a token older than 120 days. Both required. Emits audit row + `exceptions.log`. |
| `BHG_ALLOW_DIRTY_BUILD=1` | Allow `npm run build` from a dirty working tree (local dev only — CI always blocks). |

The legacy `BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE=1` flag is **retired** and has no
effect. Scripts that relied on it must switch to `NODE_ENV=test` for CI, or
to the break-glass flag pair for production.
```

- [ ] Update.

## Task 4: README — Troubleshooting additions

Add entries:

```markdown
### Config path is under cloud sync

```
SyncRootError: Refusing to use config path: /Users/.../OneDrive-.../
```

The server's config directory (`~/.bhg-pipedrive-mcp`) must not be inside a
cloud-synced folder (OneDrive, iCloud, Dropbox, Google Drive, Box). This is
enforced at startup. If your `$HOME` itself is somehow synced, contact the
app owner — this is a rare misconfiguration.

### No token in Keychain

```
No token in Keychain. Run `npm run setup`.
```

First-run or post-revoke. Run `npm run setup`.

### Token is stale

```
Token is 185 days old. Run `npm run setup -- --rotate`.
```

Token rotation is overdue. Rotate in the Pipedrive UI and run the command above.
Override with `BHG_PIPEDRIVE_ALLOW_STALE=1` only if you are aware of the risk
and plan to rotate shortly — this generates a security-relevant audit row.

### Audit chain broken

```
AUDIT_CHAIN_BROKEN — entering safe-degraded mode. Writes will be rejected.
```

The SQLite audit log at `~/.bhg-pipedrive-mcp/audit.db` has been tampered with
or corrupted. Read tools continue; write tools return 503. Investigate
immediately. `npm run audit-verify` prints the first broken row ID. Restore
from backup or, if no backup, archive the DB (`mv audit.db audit.db.corrupt`)
and let a fresh one initialize on next start.
```

- [ ] Update.

## Task 5: README — Development section

Update:

```markdown
### Install (development)

```bash
npm ci          # uses lockfile; do not use `npm install` for reproducible builds
```

### Security check locally

```bash
npm run security:check
```

Runs the forbidden-pattern grep and `npm audit --audit-level=high`.

### Audit log verification

```bash
npm run audit-verify
```

### Integration tests (requires Pipedrive sandbox)

```bash
BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE=1 PIPEDRIVE_API_TOKEN=<sandbox-token> npm run test:integration
```
```

- [ ] Update.

## Task 6: `SECURITY_CHECKLIST.md`

Create at repo root (i.e. `/Users/.../Pipedrive_MCP/SECURITY_CHECKLIST.md`). Use the table from spec v1.1 §16 (Production Readiness) plus the standard §13 checklist, filled out with evidence pointers. The deferred-controls section names Brad as owner and captures signed acceptance per row. Include the template header:

```markdown
# Pipedrive MCP — Security Checklist

**Architecture reference:** `/Users/bburnaman/Library/CloudStorage/OneDrive-TheBlueHorizonsGroupLLC/Apps/Microsoft 365 Send MCP/docs/bhg-app-security-architecture.md` v1.3
**App archetype:** A1-analogous (local stdio MCP, user-delegated via long-lived Pipedrive API token)
**Design spec:** `docs/superpowers/specs/2026-04-24-api-key-security-design.md`
**Plan:** `docs/superpowers/plans/2026-04-24-api-key-security-plan.md`
**Last updated:** <DATE>
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
- [x] No `.env` file in project — enforced at startup; `.env` physically deleted in sec-08
- [x] Nothing secret-adjacent in synced folder or git — startup path-safety check + `.gitignore`
- [x] Rotation schedule documented (90-day warning, 180-day block) — spec §7.3
- [x] Keychain ACL tested for this runtime — probe documented in sec-03; result: ACL constrains to `node` interpreter, so encryption-wrapper fallback is the live control
- [x] Encryption-wrapper implemented — AES-256-GCM with scrypt KDF (seed in Keychain, salt on disk)
- [N/A] MSAL disk cache prohibition — no MSAL

## Operational Controls
- [x] Kill switch (`PIPEDRIVE_ENABLED_CATEGORIES=read` disables all writes)
- [x] Outbound rate limits — existing `PipedriveClient` honors Pipedrive's rate-limit headers
- [Partial] MCP resource limits (§10.12) — existing 30s per-request timeout covers the primary concern; tool-invocation rate / concurrency / circuit breaker deferred
- [x] Hash-chained audit log with no-delete semantics — `src/lib/audit-log.ts`
- [ ] Remote audit mirror — **follow-up**, destination not resolved
- [Partial] Real-time anomaly alerts (§10.13) — deferred; no external alerting sink wired
- [x] Idempotency — existing write tools accept optional idempotency key in the design spec
- [N/A] Whitelist — no external-send surface
- [N/A] Confirmation-based send modes (§10.6) — no send surface; existing two-step delete confirmation covers local CRM-record risk
- [N/A] Confirmation subsystem §10.6.2 — no send surface
- [N/A] Capability policy (§10.8) — deferred; not applicable at current threat level
- [N/A] Session retrieval budgets (§10.11) — Pipedrive data surface does not warrant; deferred
- [N/A] Sensitivity labels — not a Microsoft-labeled data source
- [N/A] Prompt-injection boundary (§10.9) — no tool ingests external free-form text that feeds outbound actions; content in notes is already sanitized by `src/lib/sanitizer.ts`
- [N/A] Attachment controls — no attachments
- [N/A] Privileged delegated user §10.14 — user runs only against their own Pipedrive data

## Runtime Hardening
- [x] Startup check refuses to run if config/data paths inside a synced folder — `src/lib/path-safety.ts`
- [x] No token in stdout/stderr/logs — Pino `redact` + `stripTokenPattern` + forbidden-patterns CI
- [x] Machine migration procedure documented — README "Revoking local access" + re-run `npm run setup`
- [x] Deployed version ID embedded and emitted in every audit row — `src/lib/version-id.ts`

## Supply Chain
- [x] Lockfile committed; no `latest` or unpinned production deps
- [x] CI dependency scanning (`npm audit --audit-level=high`, Dependabot)
- [x] Production installs use `npm ci`
- [x] SBOM generated on build (cyclonedx-json, uploaded as CI artifact)
- [x] Forbidden-pattern grep in CI

## Monitoring
- [Partial] Entra sign-in log review — N/A (not an Entra app)
- [Partial] Alert rules — local anomaly alerts deferred; Pipedrive token creation/use alerts are Pipedrive-side
- [N/A] Conditional Access — not an Entra app
- [x] Internal audit log queryable via admin tool — `npm run audit-verify`
- [x] Runbook for incident response — see §13.5 in design spec

## Lifecycle
- [x] Versioned deployments — `VERSION_ID` embedded
- [x] Rollback rehearsal documented (A1 — documentation only; not rehearsed) — README Development section
- [ ] Decommissioning procedure — `npm run revoke` covers local; Pipedrive-side token deletion is a manual step (documented)

## Documentation
- [x] SECURITY_CHECKLIST.md committed
- [x] Design spec documents owner, purpose, scopes with justification, blast radius
- [N/A] `capabilities.json` — not applicable (deferred per §3 non-goals)
- [x] Decommissioning procedure documented
- [x] Setup procedure reproducible by another engineer — `npm run setup`

## Production approval (explicit, spec §16)

**This release is not approved for production, multi-user, automation, or shared-infrastructure deployment until the remote audit mirror exists.** It is approved for single-user local interactive development on Brad's Mac only. Do not run this MCP under a scheduled job, from CI, on a shared VM, or on behalf of another user.

## Deferred controls — owner acceptance (spec §16)

| # | Deferred control | Owner | Compensating control | Trigger to re-open | Accepted on | Signature |
|---|---|---|---|---|---|---|
| D-01 | Remote audit-log mirror (§10.3) | Brad | Local hash-chained audit; PD-004 documented as residual; **single-user local interactive only** | (a) second user adopts, (b) app runs on shared infra, (c) any A2-style scheduled path, (d) tenant compliance requirement, (e) any production deployment | <DATE> | <initials> |
| D-02 | Real-time anomaly alerts (§10.13) | Brad | Manual audit review; `npm run audit-verify` | Same as D-01 | <DATE> | <initials> |
| D-03 | Full §10.12 resource limits | Brad | Per-request 30s timeout; concurrency not limited | Multi-agent / high-rate usage | <DATE> | <initials> |
| D-04 | Pipedrive OAuth2 migration | Brad | Tier 4 secret with Keychain + encryption wrapper + rotation | Time-boxed in the next calendar quarter | <DATE> | <initials> |
| D-05 | Rollback rehearsal (§12.3) | Brad | Documented procedure in README | Before any multi-user deployment | <DATE> | <initials> |
| D-06 | Cross-platform Keychain review | Brad | macOS-only today | A second user adopts on Windows / Linux | <DATE> | <initials> |

Fill in `<DATE>` and `<initials>` at merge time. Re-sign each row at every full review per architecture §16.

## Open follow-ups

1. Pipedrive OAuth2 migration → Tier 1 secret (scope in a separate spec).
2. Remote audit-log mirror destination (Azure Monitor / Sentinel / workspace TBD).
3. Full §10.12 MCP resource limits (tool-invocation rate, concurrency cap, circuit breakers).
4. Real-time anomaly alerts on the audit stream (§10.13).
```

- [ ] Create. Fill in `<DATE>` at commit time.

## Task 7: Final sweep

- [ ] `git grep -n "\.env"` — should only match `.gitignore`, docs, and this file. Any code reference is a bug.
- [ ] `git grep -n "PIPEDRIVE_API_TOKEN"` — should match the gated override in `src/index.ts`, the override-flag docs in README, `.github/workflows/*`, and integration tests. Should NOT appear in any normal startup path.
- [ ] `git grep -n "BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE"` — only in documentation noting it is retired.
- [ ] `npm run security:check` passes (forbidden-patterns + lifecycle-scripts + `npm audit`).
- [ ] `npm run typecheck && npm test && npm run test:integration && npm run build` all pass.
- [ ] Manual end-to-end: fresh `~/.bhg-pipedrive-mcp/` (backed up, deleted); `npm run setup`; `npm start`; read and write tools work; `npm run audit-verify` shows rows; `npm run kill-switch -- --off` rejects next write; `npm run kill-switch -- --on` restores; `npm run revoke` cleans up.
- [ ] Fill in `<DATE>` + initials in the Deferred-controls acceptance table.

## Task 8: Commit

```bash
git add -A
git commit -m "docs(security): README rewrite, SECURITY_CHECKLIST, delete .env* — cutover complete"
```

---

**Done when:** `.env*` are physically gone; README has no `.env` references; `SECURITY_CHECKLIST.md` exists with every applicable row checked; final sweep greps clean; end-to-end manual run passes.
