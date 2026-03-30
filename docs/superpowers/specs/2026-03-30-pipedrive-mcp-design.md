# Pipedrive MCP Server — Design Specification

## Overview

An MCP (Model Context Protocol) server that exposes Pipedrive CRM data to AI agents. Built for BHG's internal use (~7 users). Provides 31 tools covering Deals, Persons, Organizations, Activities, Notes, Pipelines/Stages, Users, and Field Metadata.

**Runtime:** TypeScript / Node.js 20 LTS
**Transport:** stdio (default, for Claude Code) and SSE (opt-in, for networked/multi-client use)
**Auth:** Pipedrive personal API token via `PIPEDRIVE_API_TOKEN` environment variable
**Phase 2 candidates:** Leads, Products (pending BHG workflow confirmation)

---

## Architecture

### Layer Diagram

```
MCP Client(s)
    |
    | stdio (default) or SSE (opt-in)
    v
+-----------------------------------------+
|         Pipedrive MCP Server            |
|                                         |
|  1. MCP SDK Layer                       |
|     - Tool registry                     |
|     - stdio / SSE transport             |
|                                         |
|  2. Tool Handlers                       |
|     - One handler per API operation     |
|     - Input validation                  |
|     - Stage resolution (pipeline-aware) |
|     - Entity resolution (name -> ID)    |
|                                         |
|  3. Reference Data Resolver             |
|     - Field label <-> key mapping       |
|     - Enum/set option label <-> ID      |
|     - User name -> ID cache             |
|     - Pipeline/stage name -> ID cache   |
|     - Stale-while-revalidate caching    |
|                                         |
|  4. Error Normalizer                    |
|     - Wraps ALL outbound API calls      |
|     - Normalizes v1/v2 error shapes     |
|     - Consistent error response format  |
|                                         |
|  5. Pipedrive Client                    |
|     - Native fetch (Node 20 built-in)   |
|     - Auth token attachment             |
|     - v1/v2 route registry              |
|     - Rate limit header tracking        |
|     - Single-page fetching              |
+-----------------------------------------+
    |
    v
Pipedrive API (v2 / v1)
```

### Dependency Flow

Tool Handlers -> Reference Data Resolver -> Error Normalizer -> Pipedrive Client -> API

The Reference Data Resolver sits between tool handlers and the error normalizer. It transforms inputs (label -> key) before they go down the stack and transforms outputs (key -> label) on the way back up. Its own API calls (fetching field definitions, user lists) flow through the Error Normalizer and Pipedrive Client like everything else — no circular dependency.

The Error Normalizer wraps all outbound API calls, including those initiated by the Reference Data Resolver. A 401 on a field cache refresh surfaces the same clean error shape as a 401 on a deal update.

### Transport

- **stdio (default):** Runs as a subprocess of Claude Code. No port management, no CORS. MCP protocol on stdout, logs on stderr.
- **SSE (opt-in):** Started with `--transport sse --port 3000`. Token validation happens before `server.listen()` — if the token is bad, the HTTP server never starts.

### Startup

1. Parse environment variables and config
2. Validate `PIPEDRIVE_API_TOKEN` via `GET /v1/users/me` — fail fast with clear error if missing or invalid
3. Initialize Reference Data Resolver (prime caches for fields, users, pipelines/stages)
4. Register tools (respecting enabled categories / disabled tools config)
5. Start transport (stdio or SSE)

### stdout Safety (stdio mode)

Redirect `process.stdout.write` to stderr as early as possible — immediately after parsing env vars, before any dependency imports that might have side effects. This closes the timing gap where module initialization code could write to stdout and corrupt the MCP JSON-RPC protocol stream. The MCP SDK's stdio transport is initialized after the redirect is in place. The logger (pino) is explicitly configured to write to stderr in stdio mode.

---

## Tool Inventory (31 tools)

### Deals (6 tools)

| Tool | Description |
|------|-------------|
| `list-deals` | Browse deals by structured filters (pipeline, stage, owner, status, updated_since). Use when you know what field values to filter on. Returns summary shape. |
| `get-deal` | Get a single deal by ID with all fields resolved to human-readable labels. Returns full record. |
| `create-deal` | Create a new deal. Accepts human-friendly names for pipeline, stage, owner, person, and organization — resolved to IDs automatically. |
| `update-deal` | Update an existing deal by ID. Same field format as create-deal. |
| `delete-deal` | Delete a deal by ID. Requires two-step confirmation. |
| `search-deals` | Find deals by keyword across title and custom fields. Use when you have a name or term but not exact filter values. Returns summary shape. |

### Persons (6 tools)

| Tool | Description |
|------|-------------|
| `list-persons` | Browse persons by structured filters (owner, org_id, updated_since). Returns summary shape. |
| `get-person` | Get a single person by ID with all fields resolved. Returns full record. |
| `create-person` | Create a new person. Accepts organization by name or ID. |
| `update-person` | Update an existing person by ID. Same field format as create-person. |
| `delete-person` | Delete a person by ID. Requires two-step confirmation. |
| `search-persons` | Find persons by keyword across name, email, phone, and custom fields. Returns summary shape. |

### Organizations (5 tools)

| Tool | Description |
|------|-------------|
| `list-organizations` | Browse organizations by structured filters. Returns summary shape. |
| `get-organization` | Get a single organization by ID with all fields resolved. Returns full record. |
| `create-organization` | Create a new organization. |
| `update-organization` | Update an existing organization by ID. |
| `search-organizations` | Find organizations by keyword across name and custom fields. Returns summary shape. |

No delete — intentional. Deleting organizations cascades to linked persons and deals in Pipedrive. Too destructive for agent-initiated action. Use the Pipedrive UI for org deletion.

### Activities (5 tools)

| Tool | Description |
|------|-------------|
| `list-activities` | List activities filtered by type, deal, person, org, owner, date range, done status. Returns summary shape. |
| `get-activity` | Get a single activity by ID. Returns full record. |
| `create-activity` | Create an activity (call, meeting, task, email, etc.). Common types: call, meeting, task, email, deadline. Use get-fields with resource_type 'activity' to see all configured types. |
| `update-activity` | Update an activity by ID. |
| `delete-activity` | Delete an activity by ID. Requires two-step confirmation. |

### Notes (5 tools)

| Tool | Description |
|------|-------------|
| `list-notes` | List notes filtered by deal, person, or org. Returns summary shape with content truncated to 200 chars. Includes `truncated: true` flag when content is cut. |
| `get-note` | Get a single note by ID with full content. |
| `create-note` | Create a note linked to a deal, person, and/or org. At least one of deal_id, person_id, or org_id must be provided. Content is plain text only (HTML is stripped). |
| `update-note` | Update a note by ID. |
| `delete-note` | Delete a note by ID. Requires two-step confirmation. |

### Pipelines & Stages (2 tools, read-only)

| Tool | Description |
|------|-------------|
| `list-pipelines` | List all pipelines with their stages. Read-only — pipeline configuration changes should be made in Pipedrive UI. |
| `list-stages` | List stages for a given pipeline by name or ID, including stage order and rotten-day settings. |

### Users (1 tool, read-only)

| Tool | Description |
|------|-------------|
| `list-users` | List all Pipedrive users. Enables resolving user names (e.g., 'Stacy') to IDs for owner assignment. |

### Field Metadata (1 tool)

| Tool | Description |
|------|-------------|
| `get-fields` | Get field definitions for a resource type (deal, person, organization, activity), including custom fields and option sets for enum fields. Useful for discovering what fields exist and what values are valid. Note: the agent doesn't need to call this before creates/updates — field resolution happens automatically. |

---

## Input Schemas

### Design Principles

1. **Human-friendly inputs everywhere.** The agent sends names ("Stacy", "Sales", "Proposal Sent"), never raw IDs — unless it already has an ID from a previous response. Both are accepted where applicable (string | number types).
2. **Required fields are minimal.** Only truly required API fields are marked required.
3. **Enums are explicit.** Anywhere there's a closed set of valid values, the schema enumerates them.
4. **Custom fields are freeform by necessity.** The `fields` object can't have a static schema. The `get-fields` tool and tool descriptions guide the agent.
5. **Consistent create/update pattern.** Update tools accept the same top-level params as create tools (all optional except id), plus `fields` for custom fields.
6. **Example values in descriptions** (not in schema — agents sometimes treat schema examples as defaults): "Pipeline name, e.g. 'Sales' or 'Partnerships'"

### Deals

**`create-deal`**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | **yes** | Deal title |
| `pipeline` | string | no | Pipeline name, e.g. 'Sales' (default: Pipedrive default pipeline) |
| `stage` | string | no | Stage name within the pipeline, e.g. 'Proposal Sent' |
| `owner` | string | no | User name, e.g. 'Stacy' |
| `person` | string \| number | no | Person name or ID to link |
| `organization` | string \| number | no | Organization name or ID to link |
| `value` | number | no | Deal monetary value |
| `currency` | string | no | 3-letter currency code, e.g. 'USD' |
| `status` | enum | no | `"open"`, `"won"`, `"lost"` |
| `expected_close_date` | string | no | ISO date (YYYY-MM-DD) |
| `fields` | object | no | Custom fields as `{ "Label Name": value }` |

**`update-deal`** — same params as create-deal, all optional except `id` (number, required). At least one field beyond `id` must be provided.

**`get-deal`** / **`delete-deal`** — `id` (number, required), `confirm` (boolean, delete only)

**`list-deals`**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | enum | no | `"open"`, `"won"`, `"lost"`, `"all_not_deleted"` |
| `pipeline` | string | no | Pipeline name |
| `stage` | string | no | Stage name. Same disambiguation as create/update: if globally unique, pipeline is inferred; if ambiguous, error requires pipeline to be specified. |
| `owner` | string | no | User name |
| `person_id` | number | no | Filter by linked person |
| `org_id` | number | no | Filter by linked organization |
| `updated_since` | string | no | ISO date (YYYY-MM-DD) — return deals updated on or after this date |
| `sort_by` | string | no | Field to sort on |
| `sort_order` | enum | no | `"asc"`, `"desc"` |
| `limit` | number | no | Page size (default per Pipedrive API limit) |
| `cursor` | string | no | Pagination cursor from previous response |

**`search-deals`** — `query` (string, required), `status` (enum, optional), `limit` (number, optional — default matches Pipedrive search API cap), `cursor` (string, optional)

### Persons

**`create-person`**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **yes** | Person's full name |
| `email` | string \| string[] | no | Email address(es) |
| `phone` | string \| string[] | no | Phone number(s) |
| `organization` | string \| number | no | Organization name or ID |
| `owner` | string | no | User name |
| `fields` | object | no | Custom fields |

**`update-person`** — same params, all optional except `id`
**`list-persons`** — filters: `owner`, `org_id`, `updated_since`, `sort_by`, `sort_order`, `limit`, `cursor`
**`search-persons`** — `query` (string, required), `limit` (number, optional), `cursor` (string, optional)

### Organizations

**`create-organization`**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **yes** | Organization name |
| `owner` | string | no | User name |
| `address` | string | no | Full address |
| `fields` | object | no | Custom fields |

**`update-organization`** — same params, all optional except `id`
**`list-organizations`** — filters: `owner`, `updated_since`, `sort_by`, `sort_order`, `limit`, `cursor`
**`search-organizations`** — `query` (string, required), `limit` (number, optional), `cursor` (string, optional)

### Activities

**`create-activity`**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | **yes** | Activity type. Common types: call, meeting, task, email, deadline. Use get-fields to see all configured types. |
| `subject` | string | **yes** | Activity subject line |
| `due_date` | string | no | ISO date (YYYY-MM-DD) |
| `due_time` | string | no | HH:MM format |
| `duration` | string | no | HH:MM format |
| `deal_id` | number | no | Link to deal |
| `person_id` | number | no | Link to person |
| `org_id` | number | no | Link to organization |
| `owner` | string | no | User name |
| `note` | string | no | Activity description/body |
| `done` | boolean | no | Mark as completed |

**`update-activity`** — same params, all optional except `id`
**`list-activities`** — filters: `type`, `deal_id`, `person_id`, `org_id`, `owner`, `done`, `start_date` (YYYY-MM-DD), `end_date` (YYYY-MM-DD), `updated_since` (YYYY-MM-DD), `limit`, `cursor`

### Notes

**`create-note`**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | **yes** | Note body (plain text only — HTML is stripped) |
| `deal_id` | number | no | Link to deal |
| `person_id` | number | no | Link to person |
| `org_id` | number | no | Link to organization |

At least one of `deal_id`, `person_id`, or `org_id` must be provided.

**`update-note`** — `id` (number, required), `content` (string, optional), `deal_id` (number, optional), `person_id` (number, optional), `org_id` (number, optional). At least one param beyond `id` must be provided. Associations can be changed after creation — Pipedrive's PUT /notes/{id} accepts deal_id, person_id, and org_id as updatable fields.
**`list-notes`** — filters: `deal_id`, `person_id`, `org_id`, `limit`, `cursor`

### Reference Tools

**`list-pipelines`** — no params
**`list-stages`** — `pipeline` (string, required): pipeline name or ID
**`list-users`** — no params
**`get-fields`** — `resource_type` (enum, required): `"deal"`, `"person"`, `"organization"`, `"activity"`

---

## Data Flow

### Request Flow Example: `update-deal`

```
Agent calls: update-deal({ id: 123, stage: "Proposal Sent", fields: { "Practice Area": "Varicent" } })

1. Tool Handler
   - Validates: id present, at least one field provided
   - Trims string inputs, rejects empty-after-trim
   - Checks field lengths against limits

2. Tool Handler — Stage Resolution
   - Fetches deal 123's current pipeline from cache or API
   - Looks up "Proposal Sent" within that pipeline's stages
   - If ambiguous (multiple pipelines have that stage name): error with disambiguation
   - Resolves to stage_id

3. Reference Data Resolver (input: label -> key)
   - "Practice Area" -> "abc123_practice_area" (from cached field map)
   - If "Varicent" is an enum option label, resolves to option ID

4. Error Normalizer
   - Wraps the PATCH call

5. Pipedrive Client
   - PATCH /api/v2/deals/123 with resolved payload
   - Reads rate-limit headers

6. Pipedrive Client
   - GET /api/v2/deals/123 (confirmation read — returns actual persisted state)

7. Error Normalizer (on both responses)
   - 2xx: passes through
   - 4xx/5xx: normalizes to consistent error shape

8. Reference Data Resolver (output: key -> label)
   - All hash keys -> human labels
   - Enum IDs -> display labels

9. Tool Handler
   - Formats final MCP response
   - Returns full resolved record to agent
```

### Entity Resolution Flow (name -> ID)

When a tool receives a string where an entity ID is expected (e.g., `person: "John Smith"`):

1. Search the entity type for the provided name
2. **Exactly one match** -> use that ID
3. **Multiple matches** -> error with context: `"Multiple persons match 'John Smith': John Smith (Acme Corp, ID 456), John Smith (Globex, ID 789). Use a person_id to be specific."`
4. **No matches** -> error: `"No person found matching 'John Smith'. Create one first or use a person_id."`
5. **Search API failure** -> error: `"Unable to resolve person name. Use a person_id instead."`

Matching is case-insensitive but requires full name match. `"stacy"` matches `"Stacy"`, but `"Stac"` does not.

### Response Shapes

**List/Search — summary schema (per entity type):**

| Entity | Summary Fields |
|--------|---------------|
| Deal | `id`, `title`, `status`, `pipeline`, `stage`, `owner`, `value`, `updated_at` |
| Person | `id`, `name`, `email`, `phone`, `organization`, `owner`, `updated_at` |
| Organization | `id`, `name`, `owner`, `address`, `updated_at` |
| Activity | `id`, `type`, `subject`, `due_date`, `done`, `deal`, `person`, `owner` |
| Note | `id`, `content` (truncated 200 chars), `truncated` (boolean), `deal`, `person`, `org`, `updated_at` |

Summary schemas are enforced in tool handlers — fields are explicitly selected/mapped, not API passthrough.

**Pagination envelope (all list/search tools):**

```json
{
  "items": [...],
  "has_more": true,
  "next_cursor": "eyJ2IjoiMiIsImN1cnNvciI6ImFiYzEyMyJ9"
}
```

Default page size: matches Pipedrive API per-endpoint limits. List endpoints: 100. Search endpoints: per Pipedrive's search cap (likely 50 — verified at build time).

**Get — full record:** All fields including custom fields at top level with human-readable labels. System fields always win on name collision; colliding custom fields get `"custom:"` prefix.

**Create/Update — full record:** Same as get. Tool handler does a GET after successful write to return actual persisted state.

**Delete — confirmed deletion:**

```json
{ "id": 123, "title": "BHG - Acme Corp", "deleted": true }
```

Title/name fetched before delete (best-effort — falls back to ID-only if GET fails).

**Error — consistent shape:**

```json
{
  "error": true,
  "code": 429,
  "message": "Rate limited by Pipedrive. Try again after 2s.",
  "details": { "rate_limit_reset": 1711641600 }
}
```

### Cursor Encoding

Cursors are base64-encoded JSON: `{"v":"v1","offset":200}` or `{"v":"v2","cursor":"abc123"}`. On decode, the server validates structure (valid JSON, recognized `v` field, offset is non-negative integer). Malformed cursors return: `"Invalid cursor — start a new list request without a cursor."`

---

## Reference Data Resolver

### Caching Strategy

**Pattern:** Stale-while-revalidate with per-type TTLs.

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Field definitions (per resource type) | 5 minutes | Custom fields change occasionally |
| User list | 30 minutes | Users change extremely rarely |
| Pipelines and stages | 30 minutes | Structural, rarely modified |
| Activity types | 30 minutes | Configured once, rarely changed |

**On cache expiry:** Serve the stale data immediately. Trigger a background refresh (non-awaited promise). The refresh updates the cache for subsequent requests.

**Deduplication:** A `refreshInFlight` promise reference per data type. If a refresh is already in progress, subsequent cache misses await the existing promise instead of firing a duplicate API call.

**Hard failure:** Only when no cached data exists at all (first call after server start) and the API call fails. In that case, surface the error. The tool cannot proceed without reference data.

**Concurrency (SSE mode):** Node.js single-threaded event loop handles this naturally. The `refreshInFlight` promise deduplication is concurrency-safe by design — first caller creates the promise, subsequent callers await the same one. Flagged for verification during SSE integration testing with concurrent requests.

### Field Resolution

**Input (label -> key):**

1. Check label map (human-readable label -> Pipedrive hash key)
2. Check if input is a known Pipedrive key directly (exists in field definitions)
3. If neither matches -> error with fuzzy suggestion

No silent passthrough. Step 2 validates that raw keys actually exist in field definitions.

**Output (key -> label):** Always resolved. Hash keys never surface to the agent.

**Enum/set fields:** Resolved bidirectionally. Agent sends option labels, receives option labels. IDs are internal.

**Resolution precedence (documented explicitly):** Label map wins (step 1). If a custom field label collides with a system field key, the label map resolves it. Raw keys still work via step 2.

### Custom Field / System Field Name Collision

System fields always win at the top level.

- **On output:** System field occupies the top-level key. Colliding custom field gets `"custom:"` prefix (e.g., `"custom:status"`). Prefix only applied when there's an actual collision.
- **On input:** `"status"` always means the system field. `"custom:status"` targets the custom field.

### Fuzzy Field Matching

- Suggestion-only, never auto-applied. Hard design rule.
- Uses Levenshtein distance (via `fastest-levenshtein`) with maximum distance threshold of 2.
- Far enough for typos ("Pratice Area" -> "Practice Area"), close enough to reject unrelated strings.
- If no match within threshold: `"Unknown field 'xyz' on deal."` (no suggestion).
- Error always rejects the call. Agent must retry with corrected name.

### Stage Resolution

Handled in the tool handler, not the Reference Data Resolver. Stage names are not globally unique — two pipelines can have a "Qualified" stage with different IDs.

- **`create-deal`:** If both pipeline and stage are provided, resolve stage within that pipeline. If stage is provided without pipeline:
  - If the stage name is globally unique (exists in only one pipeline): infer the pipeline automatically. Include the inferred pipeline in the response so the agent sees what happened: `"Deal created in pipeline 'Sales' (inferred from stage 'Proposal Sent')."`
  - If the stage name exists in multiple pipelines: `"Stage 'Qualified' exists in multiple pipelines: 'Sales', 'Partnerships'. Specify a pipeline to disambiguate."`
- **`update-deal`:** Tool handler fetches deal's current pipeline (from record or cache), resolves stage within that pipeline. If the agent is changing both pipeline and stage in the same update, uses the new pipeline.

---

## Pipedrive Client

### API Version Strategy

Internal route registry maps each endpoint to its API version. Tool handlers call `client.deals.list()` without knowing which version is used. When Pipedrive migrates endpoints to v2, the route registry is updated in one place.

### Rate Limiting

- **Strategy:** Reactive retry with informative errors.
- **Tracking:** Reads `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers on every response.
- **On 429:** Waits for reset period, retries once. If still limited: `"Rate limited by Pipedrive. Try again after {reset_time}s."`
- **No proactive throttling or internal queuing** — not needed at human-paced call volumes.

### HTTP Error Handling

| Status | Behavior |
|--------|----------|
| 401 | `"API token is invalid. Restart the server with a valid token."` |
| 402/403 | `"Permission denied. Your Pipedrive account may not have access to this feature. Check your Pipedrive plan."` |
| 404 | `"[Entity] with ID [id] not found."` |
| 429 | Auto-retry once after reset period; surface error with wait time if still limited |
| 500 | No retry: `"Pipedrive API error. Try again."` |
| 502 | Retry once after 1s delay |
| 503 | Retry once after 2s delay |
| 504 | No retry: `"Pipedrive API timed out."` |
| Network failure | `"Unable to reach Pipedrive API. Check network connection."` |

### Pagination

Single-page fetch with agent-controlled iteration. No auto-pagination.

V1 offset-based and v2 cursor-based pagination are abstracted behind a unified cursor interface. The agent sees only `next_cursor` and `has_more` regardless of API version.

---

## Input Sanitization

All write operations go through sanitization in the tool handler:

- **Trim whitespace** on all string inputs
- **Reject empty-after-trim** strings
- **Enforce length limits** sourced from Pipedrive field definitions (`max_length`). For fields without explicit limits: title 255, name 255, note content 50,000
- **Note content:** Plain text only. HTML stripped via `striptags`: all tags removed, `<br>` and `<p>` converted to newlines, HTML entities decoded, runs of 3+ newlines collapsed to 2

---

## Delete Confirmation

All delete tools (deal, person, activity, note) use a two-step soft contract:

1. **First call** (`delete-deal({ id: 123 })`): Returns `{ confirm_required: true, message: "This will permanently delete deal 'Acme Q3 Renewal' (ID 123). Call delete-deal again with confirm: true to proceed." }`
2. **Second call** (`delete-deal({ id: 123, confirm: true })`): Executes the delete.

**Statefulness model:** Stateless soft contract. The server does not track whether a warning was issued. An agent that sends `confirm: true` on the first call bypasses the warning. Accepted because: (a) the user can see and approve every tool call in the MCP client, (b) token-based confirmation overhead doesn't match the threat model of an internal tool for 7 people.

**Delete flow ordering:** GET for title (best-effort) -> DELETE -> return response. If the GET fails for a transient reason, the delete proceeds with ID-only response.

---

## Security & Operations

### Authentication

- **Source:** `PIPEDRIVE_API_TOKEN` environment variable. Required.
- **Startup validation:** `GET /v1/users/me`. Fail fast with clear error if missing or invalid.
- **No token in logs:** API token is never logged, included in error messages, or exposed through MCP responses.
- **Rotation runbook:**
  1. Generate a new API token in Pipedrive Settings > Personal preferences > API
  2. Update the `PIPEDRIVE_API_TOKEN` environment variable (`.env` file or MCP config)
  3. Restart the MCP server
  4. Verify the server starts successfully (startup validation confirms the new token works)
  5. The old token is invalidated automatically by Pipedrive upon regeneration
  6. Check Pipedrive's audit log (Settings > Security > Audit log) for any unauthorized activity between suspected compromise and rotation
- **File permissions:** The `.env` file must be `chmod 600` (owner read/write only). The MCP client config file containing environment variables should be treated with the same sensitivity — it contains the API token.
- **Known security debt:** Pipedrive personal API tokens have full read/write access with no scope restrictions. OAuth2 app tokens with configurable scopes (e.g., `deals:read`, `persons:full`) would reduce blast radius. Evaluate for a future hardening pass — not a v1 blocker.

### Trust Boundary

This MCP server assumes all connected clients are trusted internal users. Specific implications:
- **Entity resolution error messages** include CRM data (org names, entity IDs) for disambiguation. If the trust boundary ever expands to external agents, these should return IDs and match counts only.
- **Cursor encoding** is base64 JSON, decodable and modifiable by any client. Cursors are validated on decode but not tamper-proof (no HMAC signing). Worst case: a malformed API call that Pipedrive rejects. If tamper resistance is ever needed, HMAC-sign the cursor payload.
- **Access control settings** (`PIPEDRIVE_ENABLED_CATEGORIES`, `PIPEDRIVE_DISABLED_TOOLS`) are configured via environment variables, which may live in MCP client config files. These files should be permission-restricted like `.env`.

### Access Control

**Category-based (coarse):**

```
PIPEDRIVE_ENABLED_CATEGORIES=read,create,update,delete
```

Default: all enabled. Categories: `read` (list/get/search/get-fields), `create`, `update`, `delete`. Disabled categories' tools are not registered — they don't appear in tool definitions.

**Per-tool overrides (surgical, optional):**

```
PIPEDRIVE_DISABLED_TOOLS=delete-deal
```

For exceptions on top of category settings. Unknown category/tool names logged as warnings at startup.

### Logging

**Logger:** Pino, structured JSON, stderr output.

**Default level — PII-aware:**
- Logged: tool name, entity type, entity ID(s), outcome (success/error), duration, Pipedrive endpoints called, deal titles, stage names
- Not logged: person names, emails, phones, note content, activity descriptions

**Debug level (`PIPEDRIVE_LOG_LEVEL=debug`):**
- Full param logging for all tools. Development/debugging only.

### Graceful Shutdown

- **SIGTERM/SIGINT handling:** Register handlers for both signals.
- **SSE mode:** Close active SSE connections cleanly, allow in-flight Pipedrive API calls to complete (5-second timeout), then exit.
- **stdio mode:** Handle parent process closing stdin (EOF on stdin triggers graceful shutdown). The MCP SDK likely handles this — verify during implementation.
- **Exit code:** 0 on clean shutdown, 1 on startup failure (bad token, missing env var).

### MCP Server Rate Limiting (SSE mode only)

No server-level rate limiting in v1. In stdio mode, requests are sequential from a single client — not a concern. In SSE mode with a single team of ~7 users, misbehaving clients are unlikely. If SSE mode is ever used with multiple concurrent clients, add a per-client request rate limit to prevent one client from exhausting Pipedrive's API rate limit for everyone. Flagged as a known operational concern for multi-client SSE scenarios.

### GET-After-Write Eventual Consistency

Pipedrive's API is eventually consistent on some computed/rollup fields. The confirmation GET after a write may occasionally show stale derived values. Documented as known behavior — not mitigated with artificial delays. Rare in practice (millisecond-scale consistency lag).

---

## Testing Strategy

### Unit Tests

- Reference Data Resolver: field label <-> key resolution, collisions, fuzzy matching (within threshold, outside threshold, no suggestion), cache expiry behavior, refresh deduplication
- Stage resolution: single pipeline, ambiguous stage across pipelines, unknown stage, pipeline + stage combo, stage without pipeline (globally unique — infer pipeline), stage without pipeline (ambiguous — error)
- Entity resolution: single match, multiple matches (disambiguation), no matches, search API failure, case-insensitive matching, partial name rejection
- Error normalizer: v1 error shapes, v2 error shapes, network failures, each HTTP status code behavior
- Cursor: encode/decode round-trip, v1 offset format, v2 cursor format, malformed input (invalid base64, invalid JSON, missing fields, negative offset)
- Input sanitization: whitespace trimming, empty-after-trim rejection, length limit enforcement, HTML stripping (tags, `<br>` to newline, entity decoding, whitespace collapsing)
- Delete confirmation: first call returns warning, second call with confirm executes, confirm on first call bypasses

### Integration Tests (Pipedrive sandbox)

- Full CRUD lifecycle per entity: create -> get -> update -> get (confirm) -> list -> search -> delete
- Custom field round-trip: create with label -> get back with label -> verify Pipedrive stored the key
- Pagination: verify cursor handling across multiple pages, verify cursor format isolation between v1/v2
- Rate limit: verify retry behavior and error messaging on 429
- Auth failure: verify clean error on invalid token
- Entity resolution end-to-end: create two persons with same name, verify disambiguation on deal create

### Smoke Tests (BHG production, read-heavy)

- Field resolution with BHG's actual custom fields
- Pipeline/stage name resolution
- User name -> ID resolution for actual team members
- Read-only first, then writes on test/throwaway records

### SSE-Specific Tests

- Concurrent requests (10 parallel tool calls): verify cache consistency, no double-refresh
- Protocol stream integrity: 100+ sequential tool calls with no stdout corruption (stdio mode)

---

## Module Structure

```
src/
  index.ts              — entry point, transport init, startup validation
  server.ts             — MCP server setup, tool registration
  tools/
    deals.ts            — deal tool handlers
    persons.ts          — person tool handlers
    organizations.ts    — org tool handlers
    activities.ts       — activity tool handlers
    notes.ts            — note tool handlers
    pipelines.ts        — pipeline/stage tool handlers
    users.ts            — user tool handler
    fields.ts           — get-fields tool handler
  lib/
    pipedrive-client.ts      — HTTP client, auth, route registry, rate tracking
    error-normalizer.ts      — error catching and normalization
    reference-resolver/
      index.ts               — public API, orchestrates sub-resolvers
      cache.ts               — shared stale-while-revalidate cache with per-type TTLs
      field-resolver.ts      — field label <-> key, enum option label <-> ID
      user-resolver.ts       — user name -> ID
      pipeline-resolver.ts   — pipeline/stage name -> ID
      activity-types.ts      — activity type validation and caching
    entity-resolver.ts       — name -> ID search and disambiguation
    sanitizer.ts             — input trimming, length limits, HTML stripping
    cursor.ts                — cursor encode/decode/validate
  config.ts             — env var parsing, category/tool access control
  types.ts              — shared type definitions
```

---

## Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server SDK | `~1.12.x` (pin to current stable at build time) |
| `pino` | Structured JSON logger | `^9.x` |
| `dotenv` | Load `.env` for local dev | `^16.x` |
| `fastest-levenshtein` | Fuzzy field name matching | `^1.x` |
| `striptags` | HTML stripping for note content | `^4.x` |

| Dev Package | Purpose | Version |
|-------------|---------|---------|
| `typescript` | Type safety | `^5.x` |
| `vitest` | Testing | `^3.x` |
| `tsx` | TS execution for dev | `^4.x` |
| `@types/node` | Node.js types | `^22.x` |

Zod is a peer dependency of `@modelcontextprotocol/sdk` — not listed separately. Let the SDK's version win.

Native `fetch` (Node 20 built-in) — no HTTP client dependency.

**Node.js:** 20 LTS required.

---

## Build Deliverables

1. Working MCP server with all 31 tools
2. Unit test suite
3. Integration test suite (Pipedrive sandbox)
4. README.md covering: setup (env vars, Claude Code MCP config), available tools by category, access control configuration, troubleshooting (common errors and what they mean)

---

## Implementation Notes

Items to address during build, not requiring spec changes:

1. **refreshInFlight cleanup on rejection.** The `refreshInFlight` promise reference must be cleared on both success and rejection. Otherwise, a failed refresh leaves a rejected promise that causes all subsequent cache misses to fail immediately without retrying.
2. **Entity resolver search result limit warning.** When Pipedrive's search returns a full page of results and no exact match is found, log a warning suggesting the match might exist beyond the first page. Extremely unlikely at BHG's data volume but prevents silent false negatives.
3. **Block-level HTML element handling.** The HTML stripping for notes should treat all block-level elements (`<div>`, `<li>`, `<h1>`-`<h6>`, `<p>`, `<br>`) as newline boundaries. Stripping `<div>First</div><div>Second</div>` must produce `First\nSecond`, not `FirstSecond`.
4. **Fetch timeout.** Add `AbortSignal.timeout()` to every outbound fetch call. 30 seconds for standard API calls, 10 seconds for the startup validation call. Without this, a Pipedrive outage leaves the server hanging silently.

---

## Phase 2 Candidates

- **Leads:** Add when BHG begins using the Pipedrive leads inbox. Tools: list-leads, get-lead, create-lead, update-lead, delete-lead.
- **Products:** Add when product line items on deals become a regular workflow. Currently low-frequency (SOW line items on managed services deals).
