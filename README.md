# Pipedrive MCP Server

An MCP (Model Context Protocol) server that exposes Pipedrive CRM data to AI agents. Built for BHG's internal team (~7 users). Provides 32 tools covering Deals, Persons, Organizations, Activities, Notes, Pipelines/Stages, Users, and Field Metadata. Human-friendly inputs throughout — agents send names ("Stacy", "Sales", "Proposal Sent"), not raw IDs.

> **Security model:** The Pipedrive API token is stored in macOS Keychain (AES-256-GCM
> encryption wrapper, scrypt-derived key, salt at `~/.bhg-pipedrive-mcp/salt.bin`).
> Every write tool produces a hash-chained audit row; destructive operations require
> typed confirmation (e.g. `DELETE-DEAL:42`). Approved for **single-user local
> interactive use only** — see [`SECURITY_CHECKLIST.md`](./SECURITY_CHECKLIST.md).

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
- store it (encrypted with AES-256-GCM) in macOS Keychain under service `bhg-pipedrive-mcp`
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
as `.env` and is not supported; startup probes the config and warns if it sees
a `PIPEDRIVE_API_TOKEN` env block.

### 5. Rotating the token

Regenerate the token in Pipedrive, then run:

```bash
npm run setup -- --rotate
```

Rotation reminders fire at 75 days (warning), 90 days (degraded but operational),
and 120 days (refuse to start without a break-glass override).

### 6. Revoking local access

```bash
npm run revoke
```

Wipes the Keychain entry and archives `audit.db`. Remember to also regenerate
the token in Pipedrive UI so the old token cannot be used from elsewhere.

## Available Tools

### Deals (6 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-deals` | read | Browse deals by pipeline, stage, owner, status, updated_since |
| `get-deal` | read | Get a single deal by ID with all fields resolved to labels |
| `create-deal` | create | Create a deal with human-friendly names for pipeline, stage, owner, person, org |
| `update-deal` | update | Update a deal by ID — same field format as create |
| `delete-deal` | delete | Delete a deal by ID (two-step confirmation) |
| `search-deals` | read | Find deals by keyword across title and custom fields |

### Persons (6 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-persons` | read | Browse persons by owner, org, updated_since |
| `get-person` | read | Get a single person by ID with all fields resolved |
| `create-person` | create | Create a person — organization resolved by name or ID |
| `update-person` | update | Update a person by ID |
| `delete-person` | delete | Delete a person by ID (two-step confirmation) |
| `search-persons` | read | Find persons by keyword across name, email, phone |

### Organizations (5 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-organizations` | read | Browse organizations by owner, updated_since |
| `get-organization` | read | Get a single organization by ID with all fields resolved |
| `create-organization` | create | Create an organization |
| `update-organization` | update | Update an organization by ID |
| `search-organizations` | read | Find organizations by keyword |

No delete tool — deleting organizations cascades to linked persons and deals in Pipedrive. Use the Pipedrive UI for org deletion.

### Activities (5 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-activities` | read | List activities by type, deal, person, org, owner, date range, done status |
| `get-activity` | read | Get a single activity by ID |
| `create-activity` | create | Create an activity (call, meeting, task, email, deadline, etc.) |
| `update-activity` | update | Update an activity by ID |
| `delete-activity` | delete | Delete an activity by ID (two-step confirmation) |

### Notes (5 tools)

| Tool | Category | Description |
|------|----------|-------------|
| `list-notes` | read | List notes by deal, person, or org (content truncated to 200 chars) |
| `get-note` | read | Get a single note by ID with full content |
| `create-note` | create | Create a note linked to a deal, person, and/or org (plain text only) |
| `update-note` | update | Update a note by ID |
| `delete-note` | delete | Delete a note by ID (two-step confirmation) |

### Pipelines & Stages (2 tools, read-only)

| Tool | Category | Description |
|------|----------|-------------|
| `list-pipelines` | read | List all pipelines with their stages |
| `list-stages` | read | List stages for a given pipeline by name or ID |

### Users (1 tool, read-only)

| Tool | Category | Description |
|------|----------|-------------|
| `list-users` | read | List all Pipedrive users |

### Field Metadata (1 tool)

| Tool | Category | Description |
|------|----------|-------------|
| `get-fields` | read | Get field definitions for a resource type (deal, person, organization, activity) |

## Access Control

### Category-based (coarse)

Control which categories of tools are available:

```bash
# Default: all categories enabled
PIPEDRIVE_ENABLED_CATEGORIES=read,create,update,delete

# Read-only mode — no writes
PIPEDRIVE_ENABLED_CATEGORIES=read

# Allow reads and creates, but no updates or deletes
PIPEDRIVE_ENABLED_CATEGORIES=read,create
```

Categories: `read` (list, get, search, get-fields), `create`, `update`, `delete`.

Disabled categories' tools are not registered — they don't appear in the tool list at all.

### Per-tool overrides (surgical)

Disable specific tools on top of category settings:

```bash
# Allow all deletes except deal deletion
PIPEDRIVE_ENABLED_CATEGORIES=read,create,update,delete
PIPEDRIVE_DISABLED_TOOLS=delete-deal

# Disable multiple tools
PIPEDRIVE_DISABLED_TOOLS=delete-deal,delete-person,delete-activity
```

Unknown category or tool names are logged as warnings at startup and ignored.

## Kill switch (central)

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

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PIPEDRIVE_ENABLED_CATEGORIES` | no | `read,create,update,delete` | Comma-separated categories. Coarse override that overlaps with the kill switch. |
| `PIPEDRIVE_DISABLED_TOOLS` | no | — | Comma-separated tool names to disable. |
| `PIPEDRIVE_LOG_LEVEL` | no | `info` | Log level: `info` or `debug`. |
| `PORT` | no | `3000` | HTTP port for SSE mode (not yet implemented). |

CLI arguments: `--transport stdio|sse`, `--port 3000`

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

## Troubleshooting

### Config path is under cloud sync

```
SyncRootError: Refusing to use config path: /Users/.../OneDrive-.../...
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
Override with `BHG_PIPEDRIVE_ALLOW_STALE=1` **and** `BHG_PIPEDRIVE_STALE_REASON="<text>"`
only if you are aware of the risk and plan to rotate shortly — this generates
a security-relevant audit row and an entry in `exceptions.log`.

### Audit chain broken

```
AUDIT_CHAIN_BROKEN — entering safe-degraded mode. Writes will be rejected.
```

The SQLite audit log at `~/.bhg-pipedrive-mcp/audit.db` has been tampered with
or corrupted. Read tools continue (with a `_security_notice` field); write
tools return 503. Investigate immediately. `npm run audit-verify` prints the
first broken row ID. Restore from backup or, if no backup, archive the DB
(`mv audit.db audit.db.corrupt`) and let a fresh one initialize on next start.

### Policy hash mismatch

```
POLICY_HASH_MISMATCH_STARTUP — refusing to start.
```

The shipped `capabilities.json` no longer matches the hash baked into
`src/lib/version-id.ts`. Either the file was tampered with, or it was edited
without rebuilding. Re-run `npm run build` from a clean checkout. A
runtime-detected mismatch (`POLICY_HASH_MISMATCH_RUNTIME`) flips the server
to safe-degraded but does not exit, to avoid abruptly killing a session.

### Invalid or missing API token

```
FATAL: Invalid or missing PIPEDRIVE_API_TOKEN. Exiting.
```

The server validates the token on startup via `GET /v1/users/me`. If the token
is missing, empty, or invalid, the server exits immediately with code 1.
Re-run `npm run setup` to store a valid token in Keychain.

### Rate limited

```json
{ "error": true, "code": 429, "message": "Rate limited by Pipedrive. Try again after 2s." }
```

The server retries once automatically on 429 responses. If the retry also fails, this error is returned. Wait the indicated time and try again. At BHG's usage volume, this should be extremely rare.

### Unknown field

```json
{ "error": true, "message": "Unknown field 'Pratice Area' on deal. Did you mean 'Practice Area'?" }
```

The field name doesn't match any known field. If the name is close to a known field (within Levenshtein distance 2), a suggestion is provided. The call is always rejected — fix the field name and retry.

### Ambiguous stage

```json
{ "error": true, "message": "Stage 'Qualified' exists in multiple pipelines: 'Sales', 'Partnerships'. Specify a pipeline to disambiguate." }
```

The stage name exists in more than one pipeline. Add the `pipeline` parameter to specify which one.

### Multiple entity matches

```json
{ "error": true, "message": "Multiple persons match 'John Smith': John Smith (Acme Corp, ID 456), John Smith (Globex, ID 789). Use a person_id to be specific." }
```

Entity resolution (name to ID) found multiple matches. Use a specific ID instead of a name.

### No entity match

```json
{ "error": true, "message": "No person found matching 'John Smith'. Create one first or use a person_id." }
```

No entity matches the provided name. Create the entity first or use its ID directly.

### Permission denied

```json
{ "error": true, "code": 403, "message": "Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan." }
```

The API token doesn't have access to this endpoint. Check your Pipedrive plan and user permissions.

### Network error

```json
{ "error": true, "code": 0, "message": "Unable to reach Pipedrive API. Check network connection." }
```

The server couldn't connect to Pipedrive's API. Check your network connection and that `api.pipedrive.com` is reachable.

### Request timeout

```json
{ "error": true, "code": 0, "message": "Request to Pipedrive API timed out." }
```

The API call took longer than 30 seconds. Pipedrive may be experiencing issues. Try again.

## Development

### Install (development)

```bash
npm ci          # uses lockfile; do not use `npm install` for reproducible builds
```

### Security check locally

```bash
npm run security:check
```

Runs the forbidden-pattern grep, the npm-lifecycle-scripts allowlist check,
and `npm audit --audit-level=high`.

### Audit log verification

```bash
npm run audit-verify
```

Walks the hash chain in `~/.bhg-pipedrive-mcp/audit.db` and reports the first
broken row, if any.

### Run tests

```bash
# Unit tests
npm test

# Unit tests in watch mode
npm run test:watch

# Integration tests (security suite — runs in-process, no live token required)
npm run test:integration

# Live Pipedrive sandbox tests (requires PIPEDRIVE_API_TOKEN sandbox token + dotenv)
NODE_ENV=test PIPEDRIVE_API_TOKEN=<sandbox-token> npx vitest run tests/integration/deals.integration.test.ts

# Type checking
npm run typecheck
```

### Dev mode

```bash
# stdio mode with tsx (no build step)
npm run dev

# SSE mode with tsx
npm run dev:sse
```

### Build

```bash
npm run build
npm start
```

### Project structure

```
src/
  index.ts              — entry point, stdout safety, transport init
  server.ts             — MCP server setup, tool registration, audit logging
  config.ts             — env var parsing, access control
  types.ts              — shared type definitions
  tools/                — tool handlers (one file per entity type)
  lib/
    pipedrive-client.ts — HTTP client, auth, rate limit tracking
    error-normalizer.ts — error normalization across v1/v2
    reference-resolver/ — field/user/pipeline/stage resolution with caching
    entity-resolver.ts  — name-to-ID search and disambiguation
    sanitizer.ts        — input trimming, length limits, HTML stripping
    cursor.ts           — pagination cursor encode/decode
tests/
  lib/                  — unit tests for lib modules
  tools/                — unit tests for tool handlers
  integration/          — integration tests (Pipedrive sandbox)
```
