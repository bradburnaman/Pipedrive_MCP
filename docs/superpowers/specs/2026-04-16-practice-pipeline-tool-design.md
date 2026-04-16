# Design Spec: `get-practice-pipeline` Tool

**Date:** 2026-04-16
**Status:** Approved
**Requirements:** `docs/Pipedrive_MCP_Enhancement_Requirements v2.md`

---

## 1. Purpose

Add one aggregate tool to the Pipedrive MCP server that returns a practice-level pipeline summary for the BHG Weekly Operations Scorecard automation. The tool provides won deals, committed deals, upside deals, and multi-horizon pipeline health metrics — segmented by time period — for one or more BHG Practices values. It is called once per scorecard practice by the orchestrator.

This is a purpose-built scorecard aggregation tool, not a general-purpose deal query endpoint. It returns deal-level pipeline details and must be permissioned accordingly — intended only for trusted internal automation and approved operators, not broad interactive use.

**Future considerations (not v1):**
- `includeDeals` parameter defaulting to `true`, allowing callers to suppress deal-level detail arrays when only aggregate totals are needed
- Per-bucket anomaly counters (`excludedForMissingWonTime`, `excludedForMissingExpectedCloseDate`) for improved operator debuggability without requiring log access

---

## 2. Architectural Approach

**Fetch-and-Classify:** The tool fetches all deals from the BHG Pipeline (open and won separately), normalizes them into a canonical internal model, classifies each deal into zero or more response buckets, aggregates totals, and renders the response.

**Why this approach:**
- BHG's pipeline is ~150 deals. Two paginated API calls (open + won) retrieve the full dataset, typically in one page each (v2 max page size is 500).
- All classification logic is explicit, testable TypeScript. No opaque server-side filter behavior.
- No Pipedrive Filters API lifecycle management (create/delete saved filters), no orphaned filter risk.
- Pagination is handled transparently and completely — the tool continues fetching until the API provides no next cursor, regardless of current volume. The implementation must remain correct whether this is 2 calls or 20.

---

## 3. Processing Pipeline

Four phases, each with a single responsibility and clean boundary.

### Phase 1 — Fetch

Paginate through all deals in the BHG Pipeline, making separate paginated queries for `status=open` and `status=won` via `GET /v2/deals`. Continue fetching each status until the API provides no next cursor. Request the BHG Practices custom field key and Label field key in the `custom_fields` query param so they are included in every response page. Use `limit=500` per page.

This phase knows nothing about practices, labels, or dates. It retrieves the full pipeline dataset.

**Pipeline resolution:** Resolve `"BHG Pipeline"` to a numeric `pipeline_id` via `PipelineResolver.resolvePipelineNameToId()` (cached, no API call). Hard fail if not found.

### Phase 2 — Normalize

Transform each raw API deal into a `CanonicalDeal`:

```typescript
interface CanonicalDeal {
  dealId: number;
  title: string;
  value: number;
  status: 'open' | 'won';
  wonTime: string | null;           // ISO timestamp, only meaningful for won deals
  expectedCloseDate: string | null;  // YYYY-MM-DD
  stage: string;                     // resolved name via PipelineResolver (cached)
  labels: string[];                  // resolved label names via FieldResolver (cached)
  organization: string | null;       // org_name from response, or null
  practiceValues: string[];          // resolved BHG Practices values via FieldResolver (cached)
}
```

**Reference resolution strategy:** All resolution uses pre-cached reference data. Zero per-deal API calls.

| Field | v2 API Source | Resolution |
|---|---|---|
| `dealId` | `id` | Passthrough |
| `title` | `title` | Passthrough |
| `value` | `value` | Passthrough |
| `status` | `status` | Passthrough |
| `wonTime` | `won_time` | Passthrough, null if absent |
| `expectedCloseDate` | `expected_close_date` | Passthrough, null if absent |
| `stage` | `stage_id` | `PipelineResolver.resolveStageIdToName()` — cached |
| `labels` | `label_ids` | Resolve each ID via `FieldResolver.resolveOutputValue()` — cached field metadata |
| `organization` | `org_name` (if present in v2 response) | Use directly; fall back to null if absent. No per-deal lookup. |
| `practiceValues` | `custom_fields[bhg_practices_key]` | Resolve option ID(s) via `FieldResolver.resolveOutputValue()` — cached field metadata. Normalize to `string[]` regardless of source shape. |

**Normalization invariant:** Normalization must never silently invent missing business data. Missing `wonTime` on a won deal stays `null`. Missing `expectedCloseDate` stays `null`.

**Unknown option ID handling:** For BHG Practices, if the field is populated but the option ID cannot be resolved, this is a **hard failure** — the deal's practice membership cannot be determined, which means classification correctness is compromised. For labels, unknown option IDs are logged as data-quality warnings and normalized to empty, since label classification gracefully handles an empty label set (the deal simply enters no commit/upside buckets).

**Implementation note:** Verify during implementation that `org_name` is reliably present in the v2 deals response. If only `org_id` is available, fall back to null rather than introducing N+1 lookups.

### Phase 3 — Classify

#### Practice Gate

Before any bucket logic, filter the full deal set to only deals whose `practiceValues` overlap the requested `practiceValues` parameter. This uses **exact string match** — no case-insensitive or fuzzy matching. The field resolver maps option IDs to the canonical display strings (`"Varicent"`, `"Xactly"`, `"CIQ/Emerging"`, `"Advisory"`, `"AI Product"`); comparison happens post-resolution on these resolved strings.

This gate runs once, centrally. It produces the working set for all downstream classification.

#### Status-Driven Eligibility

Status is a hard gate that determines which classification paths are eligible — not an independent axis. After the practice gate:

- **Won deals** → eligible for won time-period buckets only
- **Open deals** → eligible for pipeline health buckets AND commit/upside time-period buckets

#### Classification Tracks for Open Deals

Open deals are evaluated by two separate, independent classification tracks:

**Track A — Pipeline Health** (`classifyOpenPipelineHealth`):
Label-free horizon views. These never consider labels.

- `totalOpenPipeline`: All open deals after practice gate. No date filter, no label filter. **Invariant:** totalOpenPipeline is a pure subset of `status == 'open'` after the practice gate, independent of label and expected close date.
- `nextMonthPipeline`: `isClosingByDate(deal.expectedCloseDate, params.nextMonthEnd)` — ceiling-only, no floor
- `nextThreeMonthsPipeline`: `isClosingByDate(deal.expectedCloseDate, params.nextThreeMonthsEnd)` — ceiling-only, no floor

**Track B — Commit/Upside** (`classifyOpenCommitUpside`):
Label-driven time-period buckets. Requires label classification first.

- Determine label class via `classifyLabel(deal.labels)` → `'commit' | 'upside' | null`
- If `null`, skip all commit/upside buckets
- Month: `isClosingByDate(deal.expectedCloseDate, params.monthEnd)` — ceiling-only
- Quarter: `isClosingByDate(deal.expectedCloseDate, params.quarterEnd)` — ceiling-only
- Next Quarter: `isClosingInWindow(deal.expectedCloseDate, params.nextQuarterStart, params.nextQuarterEnd)` — bounded, both floor and ceiling

#### Classification for Won Deals

- Month won: `isWonInMonth(deal.wonTime, params.wonPeriodStart, params.wonPeriodEnd)` — inclusive both ends
- Quarter won: `isWonInQuarter(deal.wonTime, params.wonQuarterStart, params.wonPeriodEnd)` — inclusive both ends

No next-quarter won bucket. The scorecard does not track won deals for a future quarter.

#### Label Classification Function

```
classifyLabel(labels: string[]): 'commit' | 'upside' | null
  1. If labels includes "Commit" → return 'commit'  (Commit takes precedence)
  2. Else if labels includes "Upside" → return 'upside'
  3. Else → return null
```

Uses exact resolved label set membership, not substring search. The precedence rule is explicit and deterministic.

#### Date Predicates (four distinct functions)

Each predicate corresponds to a specific date semantic. They are separate functions because the business rules are not uniform.

**`isWonInMonth(wonTime, wonPeriodStart, wonPeriodEnd): boolean`**
- Returns false if `wonTime` is null
- `wonPeriodStart <= wonTimeDate <= wonPeriodEnd` — inclusive both ends

**`isWonInQuarter(wonTime, wonQuarterStart, wonPeriodEnd): boolean`**
- Returns false if `wonTime` is null
- `wonQuarterStart <= wonTimeDate <= wonPeriodEnd` — inclusive both ends

**`isClosingByDate(expectedCloseDate, ceiling): boolean`**
- Returns false if `expectedCloseDate` is null
- `expectedCloseDate <= ceiling` — **ceiling-only, no floor**
- Intentionally includes overdue deals (rep hasn't updated close date)

**`isClosingInWindow(expectedCloseDate, floor, ceiling): boolean`**
- Returns false if `expectedCloseDate` is null
- `floor <= expectedCloseDate <= ceiling` — **bounded, both ends inclusive**
- Used only for next-quarter commit/upside

#### Bucket Assignment Rules

- **Non-exclusive across time scopes:** A deal can appear in both `month.won` and `quarter.won`, or both `month.commit` and `quarter.commit`. Month is nested within quarter by ceiling-only semantics. This is intentional and must not be deduplicated.
- **Exclusive across label class:** `classifyLabel` returns exactly one classification. A deal is commit OR upside, never both.
- **Exclusive across status families:** Won deals never enter open-deal buckets; open deals never enter won buckets. Enforced by status gating.
- **Pipeline health nesting:** `nextMonthPipeline ⊆ nextThreeMonthsPipeline ⊆ totalOpenPipeline` — enforced invariant, verified in tests.

#### Null Handling

| Scenario | Behavior | Severity |
|---|---|---|
| Won deal, null `wonTime` | Excluded from all won buckets | Data-quality warning (anomalous) |
| Open labeled deal, null `expectedCloseDate` | Enters `totalOpenPipeline` only; excluded from all dated buckets | Data-quality warning (anomalous) |
| Open unlabeled deal, null `expectedCloseDate` | Enters `totalOpenPipeline` only | Normal — no label, no dated eligibility |
| Open unlabeled deal, non-null `expectedCloseDate` | Enters pipeline health dated buckets as appropriate; no commit/upside | Normal — label-independence of pipeline health |

#### Bucket Accumulator Structure

Each bucket maintains two separate concerns:

```typescript
interface BucketAccumulator {
  // Aggregate state — ALWAYS updated, unconditionally
  totalValue: number;
  dealCount: number;

  // Detail collection — gated on length < 50
  deals: CanonicalDeal[];
  truncated: boolean;
}
```

The `addToBucket` operation:
1. **Always** increments `totalValue += deal.value` and `dealCount += 1`
2. **Conditionally** appends to `deals` only if `deals.length < 50`, otherwise sets `truncated = true`

These two concerns are unconditionally separate. Totals are never affected by truncation.

#### Stable Ordering Before Truncation

Each bucket sorts its own eligible deals independently before truncation. Sorting is bucket-local — the working set is not pre-sorted globally.

- **Won buckets:** `wonTime` descending (most recent first), then `dealId` ascending as tie-breaker
- **Commit/upside buckets:** `expectedCloseDate` ascending (soonest first), nulls last, then `dealId` ascending
- **Pipeline health buckets:** `expectedCloseDate` ascending, nulls last, then `dealId` ascending
- **`totalOpenPipeline`:** `expectedCloseDate` ascending, nulls last, then `dealId` ascending

### Phase 4 — Render

Transform each `BucketAccumulator` into the response shape, selecting the appropriate date field for deal details based on bucket type (won buckets include `wonTime`; all other buckets include `expectedCloseDate`). Pipeline health buckets include `periodEnd`. Internal fields are dropped.

---

## 4. Response Shape

### Types

```typescript
interface PracticePipelineResponse {
  practiceValues: string[];
  pipeline: string;                              // "BHG Pipeline"

  month: {
    won: BucketResult;
    commit: BucketResult;
    upside: BucketResult;
  };

  quarter: {
    won: BucketResult;
    commit: BucketResult;
    upside: BucketResult;
  };

  nextQuarter: {
    commit: BucketResult;                        // No won bucket
    upside: BucketResult;
  };

  totalOpenPipeline: BucketResult;
  nextMonthPipeline: PipelineHealthBucketResult;
  nextThreeMonthsPipeline: PipelineHealthBucketResult;
}

interface BucketResult {
  totalValue: number;
  dealCount: number;
  deals: DealDetail[];                           // Capped at 50
  truncated?: boolean;                           // Present and true only when capped
}

interface PipelineHealthBucketResult extends BucketResult {
  periodEnd: string;                             // Echoes the ceiling date parameter
}

interface DealDetail {
  dealId: number;
  title: string;
  value: number;
  wonTime?: string;                              // Present for won bucket deals
  expectedCloseDate?: string;                    // Present for all other bucket deals
  stage: string;
  labels: string[];                              // All resolved labels; preserves full info for consumers
  organization: string | null;
}
```

### Design Decisions

1. `nextQuarter` has no `won` bucket — requirements explicitly exclude it.
2. `truncated` is bucket-local and only present when `true`.
3. `DealDetail` includes the contextually relevant date field per bucket type.
4. `periodEnd` on pipeline health buckets echoes the input ceiling for traceability.
5. `labels` in `DealDetail` preserves the full resolved label set. This avoids lossy collapse: consumers can see all labels, and the Commit-precedence classification is reflected by which bucket the deal appears in, not by which label is shown.
6. `organization` is best-effort — null if the deal has no linked organization. If a cached resolution path becomes available in the future, this can be improved.

### Consumer Guidance

The response contains two bucket result variants and contextual fields that vary by bucket type. To consume correctly:

| Field | Present In | Notes |
|---|---|---|
| `wonTime` | Won bucket deals only | Not present in commit/upside/pipeline health deals |
| `expectedCloseDate` | All non-won bucket deals | Not present in won bucket deals |
| `periodEnd` | `nextMonthPipeline`, `nextThreeMonthsPipeline` only | Echoes the ceiling date input parameter |
| `truncated` | Any bucket where deals were capped at 50 | Omitted (not `false`) when all deals fit |
| `labels` | All deals | Full resolved label set; may be empty |

**Deal-level arrays are per-bucket diagnostic views, not a unique-deal listing.** The same deal can appear in multiple buckets (e.g., both `month.won` and `quarter.won`, or both `nextMonthPipeline` and `nextThreeMonthsPipeline`). This is intentional and reflects the overlapping time-scope semantics. Do not sum deal-level arrays across buckets to count unique deals.

### Response Size

Worst-case estimate: 11 buckets x 50 deals x ~200 bytes per `DealDetail` = ~110KB. In practice, BHG's pipeline (~150 deals) means most buckets will have far fewer than 50 deals, and total response size will typically be well under 50KB. No additional response size guard is needed beyond per-bucket truncation.

---

## 5. Tool Registration & Parameters

### Tool Identity

- **MCP name:** `get-practice-pipeline` (kebab-case, matching `list-deals`, `search-deals`)
- **Requirements doc name:** `get_practice_pipeline` (conceptual reference)
- **Category:** `read`
- **Description:** "Returns a practice-level pipeline summary for BHG Pipeline scorecard automation. Aggregates won, committed, upside, and pipeline health metrics by time period for the specified BHG Practices values. Not a general-purpose deal query tool."

### Factory Signature

```typescript
function createPracticePipelineTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  logger?: Logger
): ToolDefinition[]
```

No `entityResolver` — this tool consumes deal data, not entity name-to-ID references.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `practiceValues` | `string[]` (`minItems: 1`) | Yes | BHG Practices values to include |
| `monthEnd` | `string` (YYYY-MM-DD) | Yes | Ceiling for month commit/upside |
| `quarterEnd` | `string` (YYYY-MM-DD) | Yes | Ceiling for quarter commit/upside |
| `nextQuarterStart` | `string` (YYYY-MM-DD) | Yes | Floor for next-quarter commit/upside |
| `nextQuarterEnd` | `string` (YYYY-MM-DD) | Yes | Ceiling for next-quarter commit/upside |
| `wonPeriodStart` | `string` (YYYY-MM-DD) | Yes | Start of month won window |
| `wonPeriodEnd` | `string` (YYYY-MM-DD) | Yes | End of won windows (month and quarter) |
| `wonQuarterStart` | `string` (YYYY-MM-DD) | Yes | Start of quarter won window |
| `nextMonthEnd` | `string` (YYYY-MM-DD) | Yes | Ceiling for next-month pipeline health |
| `nextThreeMonthsEnd` | `string` (YYYY-MM-DD) | Yes | Ceiling for next-three-months pipeline health |

### Validation (three layers, fail-fast)

**Layer 1 — Presence & type:**
All parameters required. `practiceValues` must be a non-empty array of strings. Date parameters must be non-empty strings. Duplicate practice values are silently de-duplicated.

**Layer 2 — Format & canonical values:**
- Each date string must be a **calendar-valid** `YYYY-MM-DD` date. Strict parsing: `2026-02-31` fails, `2026-2-09` fails, whitespace-padded inputs fail. No reliance on JavaScript's `new Date()` auto-correction.
- Each `practiceValues` entry must be one of: `"Varicent"`, `"Xactly"`, `"CIQ/Emerging"`, `"Advisory"`, `"AI Product"`. Unknown values fail with: `"Unknown practice value 'X'. Valid values: Varicent, Xactly, CIQ/Emerging, Advisory, AI Product."`

**Layer 3 — Date coherence:**
- `monthEnd <= quarterEnd`
- `nextQuarterStart <= nextQuarterEnd`
- `nextMonthEnd <= nextThreeMonthsEnd`
- `wonPeriodStart <= wonPeriodEnd`
- `wonQuarterStart <= wonPeriodStart <= wonPeriodEnd`

Violation returns: `"Invalid date range: wonPeriodStart (2026-04-17) is after wonPeriodEnd (2026-04-01)."`

---

## 6. Error Handling

### Principle: Concise External Errors, Detailed Internal Logs

Error messages returned to callers must be actionable but must not leak internal metadata (available pipeline names, field option lists, etc.). Detailed diagnostics go to the internal log only.

### Hard Failures (abort, return error)

| Condition | External Error (returned to caller) | Internal Log (detailed) |
|---|---|---|
| Pipeline `"BHG Pipeline"` not found | `"Pipeline 'BHG Pipeline' not found. Check whether the pipeline was renamed or removed."` | Log available pipelines |
| BHG Practices custom field not found | `"Custom field 'BHG Practices' not found on deal fields. Check whether the Pipedrive field was renamed or removed."` | Log available deal field labels |
| BHG Practices option missing/renamed | `"BHG Practices option 'Varicent' not found in field metadata. Verify the field options still include the expected canonical values."` | Log available option values |
| BHG Practices populated but option ID unresolvable on a deal | `"Deal [dealId] has an unresolvable BHG Practices value. Field metadata may be inconsistent."` | Log the raw option ID |
| Label field metadata unavailable | `"Unable to resolve label field metadata for deal fields. Check Pipedrive field configuration."` | Log field resolution details |
| Date validation failure | Parameter-specific: `"Invalid date range: wonPeriodStart (2026-04-17) is after wonPeriodEnd (2026-04-01)."` | — |
| Unknown practice value in input | `"Unknown practice value 'X'. Valid values: Varicent, Xactly, CIQ/Emerging, Advisory, AI Product."` | — (canonical set is not sensitive) |
| API errors (after retry) | Handled by existing `normalizeApiCall()` layer | — |

### Soft Warnings (log only, continue processing)

| Condition | Log Level | Behavior |
|---|---|---|
| Won deal with null `wonTime` | warn | Excluded from won buckets; log deal ID only |
| Open labeled deal with null `expectedCloseDate` | warn | Enters `totalOpenPipeline` only; log deal ID only |
| Unresolved org name | info | Falls back to null; do not log org details |
| Unknown label option ID | warn | Normalized to empty labels; log the raw option ID |

### Log Hygiene Rules

- **Log deal IDs** sparingly and only for anomaly identification
- **Never log** deal titles, organization names, deal values, or person references
- **Aggregate repeated anomalies** into counts where possible (e.g., "3 won deals had null wonTime" rather than 3 separate warnings)
- **Rate-limit repetitive warnings** for unknown option IDs across many deals — log the first occurrence with the ID, then summarize the count

### Empty Results (valid, not errors)

| Condition | Log Level | Response |
|---|---|---|
| No deals fetched for pipeline at all | info: `"No deals found in BHG Pipeline with status open/won"` | Zero-value buckets |
| Deals fetched, none match practices | info: `"N deals fetched from BHG Pipeline, 0 matched practice values [requested values]"` | Zero-value buckets |

---

## 7. Testing Strategy

Three tiers from predicates up to scorecard parity.

### Tier 1: Unit Tests — Pure Functions

**Date parser tests:**
- Valid dates: `2026-04-16`, `2028-02-29` (leap year)
- Invalid dates: `2026-02-29` (non-leap), `2026-02-31`, `2026-13-01`
- Malformed: `2026-2-09`, `2026-02-9`, `not-a-date`, `""`
- Whitespace: `" 2026-04-16"`, `"2026-04-16 "`

**Date predicate tests (each function, ~5-6 tests):**
- `isWonInMonth` / `isWonInQuarter`: inclusive boundaries, null returns false, boundary-exact dates included, one-day-out-of-range excluded
- `isClosingByDate`: ceiling-only (no floor), overdue dates included, null returns false, boundary-exact included
- `isClosingInWindow`: bounded both ends, both boundaries inclusive, null returns false, one-day-out excluded on each side

**Label classification tests:**
- `["Commit"]` → `'commit'`
- `["Upside"]` → `'upside'`
- `["Commit", "Upside"]` → `'commit'` (precedence)
- `[]` → `null`
- `["SomeOtherLabel"]` → `null`

**Practice gate tests:**
- Exact match succeeds
- Case mismatch fails (exact, not case-insensitive)
- Multi-value practice field with one matching value passes
- No overlap returns false

### Tier 2: Classification Integration Tests

Test the full classification pipeline using `CanonicalDeal` inputs (post-normalization). No API mocks needed.

**Bucket assignment (parameter-specific, not calendar-assumed):**
- Won deal in month window → `month.won` and `quarter.won`
- Won deal in quarter but outside month window → `quarter.won` only
- Open Commit deal with `expectedCloseDate <= monthEnd` → `month.commit`, `quarter.commit`, `totalOpenPipeline`; also `nextMonthPipeline` / `nextThreeMonthsPipeline` only if `expectedCloseDate` is at or before those specific ceilings in the test parameters
- Open Upside deal with `expectedCloseDate` in next-quarter window → `nextQuarter.upside`, `totalOpenPipeline`; `nextThreeMonthsPipeline` only if `expectedCloseDate <= nextThreeMonthsEnd` in the test parameters
- Open deal with no label → pipeline health buckets only (totalOpen, nextMonth, nextThreeMonths as parameter-appropriate)

**Nesting invariants (enforced):**
- `nextMonthPipeline.deals ⊆ nextThreeMonthsPipeline.deals ⊆ totalOpenPipeline.deals` — verified by deal ID set membership
- Corresponding count and value ordering consistent with subset relationship
- `nextMonthPipeline.periodEnd === params.nextMonthEnd`
- `nextThreeMonthsPipeline.periodEnd === params.nextThreeMonthsEnd`

**Cross-bucket overlap (intentional, parameter-controlled):**
- With `monthEnd <= quarterEnd`: month commit is a subset of quarter commit
- Month won is a subset of quarter won (wonPeriodStart/wonQuarterStart relationship)
- Tests make date parameter dependency visible

**Label-independence of pipeline health:**
- Open unlabeled deal with non-null `expectedCloseDate` before `nextMonthEnd` → appears in `nextMonthPipeline` and `nextThreeMonthsPipeline`
- Proves pipeline health never inherits commit/upside label constraints

**Commit-precedence edge case:**
- Deal with both Commit and Upside labels → classified as Commit, absent from Upside buckets

**Null handling:**
- Won deal, null `wonTime` → no won bucket, warning logged
- Open Commit deal, null `expectedCloseDate` → `totalOpenPipeline` only, no dated buckets, warning logged
- Open unlabeled deal, null `expectedCloseDate` → `totalOpenPipeline` only

**Truncation (boundary tests):**
- Exactly 50 deals in bucket → `truncated` absent, all 50 retained
- 51+ deals in bucket → `truncated === true`, first 50 retained per sort order, `dealCount` and `totalValue` reflect full set

**Stable ordering (with tie-breakers):**
- Won bucket: deals sorted by `wonTime` descending, `dealId` ascending
- Commit/upside/pipeline health: deals sorted by `expectedCloseDate` ascending, nulls last, `dealId` ascending
- Tie-breaker tests: same `expectedCloseDate` with different `dealId`; same `wonTime` with different `dealId`

**De-duplication:**
- Duplicate practice values in input do not double-count any bucket totals

### Tier 3: Fixture-Based Scorecard Parity Tests

Deterministic synthetic fixtures committed to the repo. Designed to produce the known-good expected values from Week 16, ending April 17, 2026:

| Practice | Metric | Expected |
|---|---|---|
| Varicent | Committed Deals (Quarter) | $202,000 |
| Varicent | Upside Deals (Quarter) | $201,750 |
| Varicent | Next Month Pipeline | $1,301,600 |
| Varicent | Next 3 Months Pipeline | $2,881,750 |
| Xactly | Won Pipeline (Quarter) | $25,600 |
| Xactly | Committed Deals (Quarter) | $899,796 |
| CaptivateIQ | Won Pipeline (Quarter) | $232,536.50 |
| CaptivateIQ | Next Month Pipeline | $58,000 |
| Advisory & AI | Won Pipeline (Quarter) | $190,000 |
| Advisory & AI | Next Month Pipeline | $250,000 |

These test the entire pipeline end-to-end: fetch (mocked client) → normalize → classify → aggregate → render.

**Zero-result parity:** Valid practice with no matching deals returns zero-value buckets, not errors.

**Historical cross-check:** Optionally validate against real Pipedrive data during implementation as a one-off, separate from the automated suite.

### Pagination Tests

- Two-page open deals, single-page won deals
- Single-page open deals, two-page won deals
- Two-page open deals, two-page won deals

Verifies independent transparent pagination of both datasets.

### Validation Tests

- Invalid date formats rejected with parameter name in error
- Calendar-invalid dates (`2026-02-31`) rejected
- Incoherent date ranges rejected with both values in message
- Unknown practice values rejected with valid values list
- Empty `practiceValues` array rejected
- Canonical practice value accepted after de-duplication

### Metadata Drift Hard-Failure Tests

- BHG Practices field missing from deal fields → clear error
- Expected practice option value missing/renamed → clear error
- Label field metadata unavailable → clear error
- Pipeline `"BHG Pipeline"` resolution failure → clear error with available pipelines

---

## 8. Registration & Authorization

The `createPracticePipelineTools` factory is imported in `server.ts` alongside existing tool factories. Its tools are added to `allTools` and pass through the same `isToolEnabled` access control filtering. Called with `(client, resolver, logger)`.

**Authorization scope:** This tool is intended for trusted internal scorecard automation and approved operators only. It should not be exposed to general users simply because they have access to other `read`-category tools. If the access control system supports tool-level granularity in the future, this tool should have its own permission gate.

**Expected call frequency:** The orchestrator calls this tool once per scorecard practice, typically 4 calls per weekly scorecard run. Normal usage is fewer than 10 calls per week. Significantly higher frequency suggests misconfiguration or abusive orchestration. The existing Pipedrive API rate limiting (via `PipedriveClient` rate-limit tracking) provides the underlying protection; no additional rate limiting is needed in the tool itself.

---

## 9. Scorecard Orchestration Reference

The orchestrator calls this tool once per scorecard practice:

```
# Varicent (week ending April 17, 2026)
get-practice-pipeline(
  practiceValues=["Varicent"],
  monthEnd="2026-04-30",
  quarterEnd="2026-06-30",
  nextQuarterStart="2026-07-01",
  nextQuarterEnd="2026-09-30",
  wonPeriodStart="2026-04-01",
  wonPeriodEnd="2026-04-17",
  wonQuarterStart="2026-04-01",
  nextMonthEnd="2026-05-31",
  nextThreeMonthsEnd="2026-07-31"
)

# Advisory & AI (aggregates two practice values)
get-practice-pipeline(
  practiceValues=["Advisory", "AI Product"],
  monthEnd="2026-04-30",
  quarterEnd="2026-06-30",
  nextQuarterStart="2026-07-01",
  nextQuarterEnd="2026-09-30",
  wonPeriodStart="2026-04-01",
  wonPeriodEnd="2026-04-17",
  wonQuarterStart="2026-04-01",
  nextMonthEnd="2026-05-31",
  nextThreeMonthsEnd="2026-07-31"
)
```

Response-to-spreadsheet mapping:

| Response Field | Spreadsheet Cell | Weighting |
|---|---|---|
| `month.won.totalValue` | Won Pipeline (Month) | Face value |
| `quarter.won.totalValue` | Won Pipeline (Quarter) | Face value |
| `month.commit.totalValue` | Committed (Month) | Also x 0.90 |
| `month.upside.totalValue` | Upside (Month) | Also x 0.70 |
| `quarter.commit.totalValue` | Committed (Quarter) | Also x 0.90 |
| `quarter.upside.totalValue` | Upside (Quarter) | Also x 0.70 |
| `nextQuarter.commit.totalValue` | Committed (Next Quarter) | Also x 0.90 |
| `nextQuarter.upside.totalValue` | Upside (Next Quarter) | Also x 0.70 |
| `nextMonthPipeline.totalValue` | Total Pipeline (B30) | Face value |
| `nextThreeMonthsPipeline.totalValue` | Total Pipeline (C30) | Face value |

Weighting and derived calculations are handled by spreadsheet formulas. The tool provides face values only.

### Compact Example Response

Illustrates one tracking bucket, one pipeline-health bucket with `periodEnd`, and truncation:

```json
{
  "practiceValues": ["Varicent"],
  "pipeline": "BHG Pipeline",
  "month": {
    "won": {
      "totalValue": 50000,
      "dealCount": 1,
      "deals": [
        {
          "dealId": 101,
          "title": "Acme Varicent Implementation",
          "value": 50000,
          "wonTime": "2026-04-10T14:00:00Z",
          "stage": "Closed Won",
          "labels": ["Commit"],
          "organization": "Acme Corp"
        }
      ]
    },
    "commit": { "totalValue": 0, "dealCount": 0, "deals": [] },
    "upside": { "totalValue": 0, "dealCount": 0, "deals": [] }
  },
  "quarter": { "...": "same structure" },
  "nextQuarter": { "commit": { "...": "..." }, "upside": { "...": "..." } },
  "totalOpenPipeline": {
    "totalValue": 5200000,
    "dealCount": 55,
    "deals": ["... first 50 deals sorted by expectedCloseDate asc ..."],
    "truncated": true
  },
  "nextMonthPipeline": {
    "totalValue": 1301600,
    "dealCount": 8,
    "periodEnd": "2026-05-31",
    "deals": [
      {
        "dealId": 202,
        "title": "BigCorp Varicent Phase 2",
        "value": 300000,
        "expectedCloseDate": "2026-05-01",
        "stage": "Proposal Sent",
        "labels": ["Commit"],
        "organization": "BigCorp"
      }
    ]
  },
  "nextThreeMonthsPipeline": {
    "totalValue": 2881750,
    "dealCount": 15,
    "periodEnd": "2026-07-31",
    "deals": ["..."]
  }
}
```
