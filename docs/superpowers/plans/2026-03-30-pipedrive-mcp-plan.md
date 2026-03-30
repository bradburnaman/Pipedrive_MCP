# Pipedrive MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Each part is a self-contained unit for one subagent.

**Goal:** Build a 31-tool MCP server that exposes Pipedrive CRM data to AI agents for BHG's internal team.

**Architecture:** Five-layer stack (MCP SDK -> Tool Handlers -> Reference Data Resolver -> Error Normalizer -> Pipedrive Client). Dual transport (stdio default, SSE opt-in). Human-friendly inputs with automatic field/entity/stage resolution.

**Tech Stack:** TypeScript, Node.js 20 LTS, @modelcontextprotocol/sdk, Pino logger, Vitest, native fetch.

**Spec:** `docs/superpowers/specs/2026-03-30-pipedrive-mcp-design.md`

## Parts

| Part | File | Scope | Depends On |
|------|------|-------|------------|
| 01 | [parts/01-project-setup.md](parts/01-project-setup.md) | Scaffolding, types, config | — |
| 02 | [parts/02-foundation-utilities.md](parts/02-foundation-utilities.md) | Cursor, sanitizer | 01 |
| 03 | [parts/03-http-layer.md](parts/03-http-layer.md) | Pipedrive client, error normalizer | 01 |
| 04 | [parts/04-reference-resolver.md](parts/04-reference-resolver.md) | Cache, field/user/pipeline/activity-type resolvers | 01, 03 |
| 05 | [parts/05-entity-resolver.md](parts/05-entity-resolver.md) | Name→ID search and disambiguation | 01, 03 |
| 06 | [parts/06-read-only-tools.md](parts/06-read-only-tools.md) | Pipelines, users, fields tools | 01, 04 |
| 07 | [parts/07-deal-tools.md](parts/07-deal-tools.md) | 6 deal tools | 01-05 |
| 08 | [parts/08-person-tools.md](parts/08-person-tools.md) | 6 person tools | 01-05 |
| 09 | [parts/09-organization-tools.md](parts/09-organization-tools.md) | 5 org tools (no delete) | 01-05 |
| 10 | [parts/10-activity-tools.md](parts/10-activity-tools.md) | 5 activity tools | 01-05 |
| 11 | [parts/11-note-tools.md](parts/11-note-tools.md) | 5 note tools | 01-05, 02 |
| 12 | [parts/12-server-entry-point.md](parts/12-server-entry-point.md) | Server setup, entry point, SSE | 01-11 |
| 13 | [parts/13-readme-integration-tests.md](parts/13-readme-integration-tests.md) | README, integration test scaffolding | 01-12 |

## Execution Order

Parts 01 → 02, 03 (parallel) → 04, 05 (parallel) → 06 → 07, 08, 09, 10, 11 (parallel) → 12 → 13

## File Structure

```
src/
  index.ts                          — entry point, stdout safety, transport init, startup validation
  server.ts                         — MCP server setup, tool registration with access control
  types.ts                          — shared types (PipedriveError, PaginatedResponse, SummaryShapes, etc.)
  config.ts                         — env var parsing, category/tool access control
  tools/
    deals.ts                        — 6 deal tool handlers
    persons.ts                      — 6 person tool handlers
    organizations.ts                — 5 org tool handlers
    activities.ts                   — 5 activity tool handlers
    notes.ts                        — 5 note tool handlers
    pipelines.ts                    — 2 pipeline/stage tool handlers
    users.ts                        — 1 user tool handler
    fields.ts                       — 1 get-fields tool handler
  lib/
    pipedrive-client.ts             — HTTP client, auth, route registry, rate tracking, fetch timeouts
    error-normalizer.ts             — error catching and normalization across v1/v2
    reference-resolver/
      index.ts                      — public API, orchestrates sub-resolvers
      cache.ts                      — generic stale-while-revalidate cache with TTL
      field-resolver.ts             — field label<->key, enum option label<->ID, fuzzy matching
      user-resolver.ts              — user name->ID resolution and caching
      pipeline-resolver.ts          — pipeline/stage name->ID, stage disambiguation
      activity-types.ts             — activity type validation and caching
    entity-resolver.ts              — name->ID search, case-insensitive match, disambiguation
    sanitizer.ts                    — input trimming, length limits, HTML stripping
    cursor.ts                       — base64 cursor encode/decode/validate
tests/
  lib/
    cursor.test.ts
    sanitizer.test.ts
    error-normalizer.test.ts
    pipedrive-client.test.ts
    entity-resolver.test.ts
    reference-resolver/
      cache.test.ts
      field-resolver.test.ts
      user-resolver.test.ts
      pipeline-resolver.test.ts
      activity-types.test.ts
  tools/
    deals.test.ts
    persons.test.ts
    organizations.test.ts
    activities.test.ts
    notes.test.ts
    pipelines.test.ts
    users.test.ts
    fields.test.ts
  config.test.ts
  integration/                      — Pipedrive sandbox tests (run separately)
    deals.integration.test.ts
    persons.integration.test.ts
    organizations.integration.test.ts
    activities.integration.test.ts
    notes.integration.test.ts
```
