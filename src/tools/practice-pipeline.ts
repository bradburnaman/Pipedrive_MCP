import type { ToolDefinition } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { parseStrictDate } from '../lib/date-utils.js';
import type { Logger } from 'pino';
import type { CanonicalDeal, ClassificationResult, BucketAccumulator } from '../lib/pipeline-classifier.js';
import { classifyDeals } from '../lib/pipeline-classifier.js';

const CANONICAL_PRACTICES = ['Varicent', 'Xactly', 'CIQ/Emerging', 'Advisory', 'AI Product'] as const;
const BHG_PRACTICES_FIELD_LABEL = 'BHG Practices';
const BHG_PIPELINE_NAME = 'BHG Pipeline';

export interface ValidatedParams {
  practiceValues: string[];
  monthEnd: string;
  quarterEnd: string;
  nextQuarterStart: string;
  nextQuarterEnd: string;
  wonPeriodStart: string;
  wonPeriodEnd: string;
  wonQuarterStart: string;
  nextMonthEnd: string;
  nextThreeMonthsEnd: string;
}

/**
 * Validate and normalize input parameters.
 * Fail-fast: presence, format, canonical values, date coherence.
 */
export function validateParams(params: Record<string, unknown>): ValidatedParams {
  // Layer 1: presence and type
  const rawPractices = params.practiceValues;
  if (!Array.isArray(rawPractices) || rawPractices.length === 0) {
    throw new Error('practiceValues must be a non-empty array of strings.');
  }
  if (!rawPractices.every((v: unknown) => typeof v === 'string')) {
    throw new Error('practiceValues must contain only strings.');
  }

  // De-duplicate
  const practiceValues = [...new Set(rawPractices as string[])];

  // Layer 2: canonical practice values
  for (const v of practiceValues) {
    if (!(CANONICAL_PRACTICES as readonly string[]).includes(v)) {
      throw new Error(
        `Unknown practice value '${v}'. Valid values: ${CANONICAL_PRACTICES.join(', ')}.`
      );
    }
  }

  // Layer 2: strict date parsing
  const dateFields = [
    'monthEnd', 'quarterEnd', 'nextQuarterStart', 'nextQuarterEnd',
    'wonPeriodStart', 'wonPeriodEnd', 'wonQuarterStart',
    'nextMonthEnd', 'nextThreeMonthsEnd',
  ] as const;

  const dates: Record<string, string> = {};
  for (const field of dateFields) {
    const raw = params[field];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`${field} is required and must be a non-empty string.`);
    }
    dates[field] = parseStrictDate(raw, field);
  }

  // Layer 3: date coherence
  const coherenceChecks: [string, string][] = [
    ['monthEnd', 'quarterEnd'],
    ['nextQuarterStart', 'nextQuarterEnd'],
    ['nextMonthEnd', 'nextThreeMonthsEnd'],
    ['wonPeriodStart', 'wonPeriodEnd'],
    ['wonQuarterStart', 'wonPeriodStart'],
  ];

  for (const [earlier, later] of coherenceChecks) {
    if (dates[earlier] > dates[later]) {
      throw new Error(
        `Invalid date range: ${earlier} (${dates[earlier]}) is after ${later} (${dates[later]}).`
      );
    }
  }

  return {
    practiceValues,
    monthEnd: dates.monthEnd,
    quarterEnd: dates.quarterEnd,
    nextQuarterStart: dates.nextQuarterStart,
    nextQuarterEnd: dates.nextQuarterEnd,
    wonPeriodStart: dates.wonPeriodStart,
    wonPeriodEnd: dates.wonPeriodEnd,
    wonQuarterStart: dates.wonQuarterStart,
    nextMonthEnd: dates.nextMonthEnd,
    nextThreeMonthsEnd: dates.nextThreeMonthsEnd,
  };
}

/**
 * Transform a raw Pipedrive v2 deal into a CanonicalDeal.
 * All resolution uses cached reference data — zero per-deal API calls.
 */
export function normalizeDeal(
  raw: Record<string, unknown>,
  fieldResolver: { resolveOutputValue: (key: string, value: unknown) => unknown },
  pipelineResolver: { resolveStageIdToName: (id: number) => string },
  bhgPracticesKey: string,
  logger?: Logger
): CanonicalDeal {
  // Defensive guards on API response shape
  if (typeof raw.id !== 'number') {
    throw new Error(`Deal missing numeric id`);
  }
  const status = raw.status as string;
  if (status !== 'open' && status !== 'won') {
    throw new Error(`Deal ${raw.id} has unexpected status '${status}'`);
  }
  if (typeof raw.value !== 'number') {
    throw new Error(`Deal ${raw.id} has missing or non-numeric value`);
  }

  // Resolve practice values from custom_fields
  const customFields = (raw.custom_fields ?? {}) as Record<string, unknown>;
  const rawPractice = customFields[bhgPracticesKey];
  let practiceValues: string[] = [];
  if (rawPractice != null) {
    const resolved = fieldResolver.resolveOutputValue(bhgPracticesKey, rawPractice);
    const allResolved = Array.isArray(resolved) ? resolved : [resolved];
    const strings = allResolved.filter((v): v is string => typeof v === 'string');
    const unresolved = allResolved.filter(v => typeof v !== 'string');
    // Hard fail if any option ID is unresolvable — partial resolution would silently
    // alter practice membership and produce incorrect scorecard totals.
    if (unresolved.length > 0 || strings.length === 0) {
      throw new Error(
        'A deal has an unresolvable BHG Practices value. Field metadata may be inconsistent.'
      );
    }
    practiceValues = strings;
  }

  // Resolve labels from label_ids
  const rawLabelIds = raw.label_ids;
  const labels: string[] = [];
  if (Array.isArray(rawLabelIds)) {
    for (const id of rawLabelIds) {
      if (id == null) continue;
      try {
        const resolved = fieldResolver.resolveOutputValue('label', id);
        if (typeof resolved === 'string') labels.push(resolved);
      } catch {
        logger?.warn({ dealId: raw.id, labelId: id }, 'Unknown label option ID');
      }
    }
  }

  return {
    dealId: raw.id as number,
    title: (raw.title as string) ?? '',
    value: raw.value as number,
    status: status as 'open' | 'won',
    wonTime: raw.won_time ? String(raw.won_time) : null,
    expectedCloseDate: raw.expected_close_date ? String(raw.expected_close_date) : null,
    stage: raw.stage_id ? pipelineResolver.resolveStageIdToName(raw.stage_id as number) : '',
    labels,
    organization: (raw.org_name as string) ?? null,
    practiceValues,
  };
}

interface DealDetail {
  dealId: number;
  title: string;
  value: number;
  wonTime?: string;
  expectedCloseDate?: string;
  stage: string;
  labels: string[];
  organization: string | null;
}

interface BucketResult {
  totalValue: number;
  dealCount: number;
  deals: DealDetail[];
  truncated?: boolean;
}

interface PipelineHealthBucketResult extends BucketResult {
  periodEnd: string;
}

/**
 * Render a finalized bucket into the response shape.
 * Buckets are already sorted + truncated by finalizeBucket() in the classifier.
 * This function only maps CanonicalDeal → DealDetail and selects the contextual date field.
 */
function renderBucket(
  bucket: BucketAccumulator,
  dateField: 'wonTime' | 'expectedCloseDate'
): BucketResult {
  const deals: DealDetail[] = bucket.deals.map(d => {
    const detail: DealDetail = {
      dealId: d.dealId,
      title: d.title,
      value: d.value,
      stage: d.stage,
      labels: d.labels,
      organization: d.organization,
    };
    if (dateField === 'wonTime') {
      detail.wonTime = d.wonTime ?? undefined;
    } else {
      detail.expectedCloseDate = d.expectedCloseDate ?? undefined;
    }
    return detail;
  });
  return {
    totalValue: bucket.totalValue,
    dealCount: bucket.dealCount,
    deals,
    ...(bucket.truncated ? { truncated: true } : {}),
  };
}

/**
 * Transform ClassificationResult into the final API response shape.
 */
export function renderResponse(
  result: ClassificationResult,
  practiceValues: string[],
  nextMonthEnd: string,
  nextThreeMonthsEnd: string
): Record<string, unknown> {
  return {
    practiceValues,
    pipeline: 'BHG Pipeline',
    month: {
      won: renderBucket(result.month.won, 'wonTime'),
      commit: renderBucket(result.month.commit, 'expectedCloseDate'),
      upside: renderBucket(result.month.upside, 'expectedCloseDate'),
    },
    quarter: {
      won: renderBucket(result.quarter.won, 'wonTime'),
      commit: renderBucket(result.quarter.commit, 'expectedCloseDate'),
      upside: renderBucket(result.quarter.upside, 'expectedCloseDate'),
    },
    nextQuarter: {
      commit: renderBucket(result.nextQuarter.commit, 'expectedCloseDate'),
      upside: renderBucket(result.nextQuarter.upside, 'expectedCloseDate'),
    },
    totalOpenPipeline: renderBucket(result.totalOpenPipeline, 'expectedCloseDate'),
    nextMonthPipeline: {
      ...renderBucket(result.nextMonthPipeline, 'expectedCloseDate'),
      periodEnd: nextMonthEnd,
    },
    nextThreeMonthsPipeline: {
      ...renderBucket(result.nextThreeMonthsPipeline, 'expectedCloseDate'),
      periodEnd: nextThreeMonthsEnd,
    },
  };
}

/**
 * Paginate through all deals for a given pipeline + status.
 * Continues until the API provides no next cursor.
 */
async function fetchAllDeals(
  client: PipedriveClient,
  pipelineId: number,
  status: string,
  customFieldKeys: string[],
  logger?: Logger
): Promise<Record<string, unknown>[]> {
  const allDeals: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  do {
    const queryParams: Record<string, string> = {
      pipeline_id: String(pipelineId),
      status,
      limit: '500',
    };
    if (customFieldKeys.length > 0) {
      queryParams.custom_fields = customFieldKeys.join(',');
    }
    if (cursor) {
      queryParams.cursor = cursor;
    }

    const response = await normalizeApiCall(
      async () => client.request('GET', 'v2', '/deals', undefined, queryParams),
      undefined, logger
    );

    const respData = (response as any).data;
    const items = Array.isArray(respData.data) ? respData.data : [];
    allDeals.push(...items);

    cursor = respData.additional_data?.next_cursor ?? undefined;
  } while (cursor);

  return allDeals;
}

export function createPracticePipelineTools(
  client: PipedriveClient,
  resolver: ReferenceResolver,
  logger?: Logger
): ToolDefinition[] {
  return [
    {
      name: 'get-practice-pipeline',
      category: 'read' as const,
      description: 'Returns a practice-level pipeline summary for BHG Pipeline scorecard automation. Aggregates won, committed, upside, and pipeline health metrics by time period for the specified BHG Practices values. Not a general-purpose deal query tool.',
      inputSchema: {
        type: 'object',
        properties: {
          practiceValues: {
            type: 'array',
            items: { type: 'string', enum: [...CANONICAL_PRACTICES] },
            minItems: 1,
            description: 'BHG Practices values to include. Valid: Varicent, Xactly, CIQ/Emerging, Advisory, AI Product.',
          },
          monthEnd: { type: 'string', description: 'Ceiling for month commit/upside (YYYY-MM-DD)' },
          quarterEnd: { type: 'string', description: 'Ceiling for quarter commit/upside (YYYY-MM-DD)' },
          nextQuarterStart: { type: 'string', description: 'Floor for next-quarter commit/upside (YYYY-MM-DD)' },
          nextQuarterEnd: { type: 'string', description: 'Ceiling for next-quarter commit/upside (YYYY-MM-DD)' },
          wonPeriodStart: { type: 'string', description: 'Start of month won window (YYYY-MM-DD)' },
          wonPeriodEnd: { type: 'string', description: 'End of won windows — month and quarter (YYYY-MM-DD)' },
          wonQuarterStart: { type: 'string', description: 'Start of quarter won window (YYYY-MM-DD)' },
          nextMonthEnd: { type: 'string', description: 'Ceiling for next-month pipeline health (YYYY-MM-DD)' },
          nextThreeMonthsEnd: { type: 'string', description: 'Ceiling for next-three-months pipeline health (YYYY-MM-DD)' },
        },
        required: [
          'practiceValues', 'monthEnd', 'quarterEnd', 'nextQuarterStart', 'nextQuarterEnd',
          'wonPeriodStart', 'wonPeriodEnd', 'wonQuarterStart', 'nextMonthEnd', 'nextThreeMonthsEnd',
        ],
      },
      handler: async (params: Record<string, unknown>) => {
        // Phase 0: Validate
        const validated = validateParams(params);

        // Resolve field + pipeline metadata (cached, no API calls)
        const fieldResolver = await resolver.getFieldResolver('deal');
        const pipelineResolver = await resolver.getPipelineResolver();

        // Resolve BHG Practices field key
        let bhgPracticesKey: string;
        try {
          bhgPracticesKey = fieldResolver.resolveInputField(BHG_PRACTICES_FIELD_LABEL);
        } catch {
          throw new Error(
            `Custom field '${BHG_PRACTICES_FIELD_LABEL}' not found on deal fields. Check whether the Pipedrive field was renamed or removed.`
          );
        }

        // Verify requested practice option values exist in metadata
        for (const practice of validated.practiceValues) {
          try {
            fieldResolver.resolveInputValue(bhgPracticesKey, practice);
          } catch {
            throw new Error(
              `BHG Practices option '${practice}' not found in field metadata. Verify the field options still include the expected canonical values.`
            );
          }
        }

        // Resolve pipeline
        let pipelineId: number;
        try {
          pipelineId = pipelineResolver.resolvePipelineNameToId(BHG_PIPELINE_NAME);
        } catch {
          logger?.error({ pipeline: BHG_PIPELINE_NAME }, 'Pipeline not found');
          throw new Error(
            `Pipeline '${BHG_PIPELINE_NAME}' not found. Check whether the pipeline was renamed or removed.`
          );
        }

        // Phase 1: Fetch (sequential — deterministic mock ordering, trivial latency at ~150 deals)
        const rawOpenDeals = await fetchAllDeals(client, pipelineId, 'open', [bhgPracticesKey], logger);
        const rawWonDeals = await fetchAllDeals(client, pipelineId, 'won', [bhgPracticesKey], logger);

        const totalFetched = rawOpenDeals.length + rawWonDeals.length;
        if (totalFetched === 0) {
          logger?.info('No deals found in BHG Pipeline with status open/won');
        }

        // Phase 2: Normalize
        const allDeals: CanonicalDeal[] = [];
        for (const raw of [...rawOpenDeals, ...rawWonDeals]) {
          try {
            allDeals.push(normalizeDeal(raw, fieldResolver, pipelineResolver, bhgPracticesKey, logger));
          } catch (err) {
            logger?.error({ dealId: (raw as any).id, error: (err as Error).message },
              'Deal normalization failed');
            throw new Error(
              'Pipeline data configuration error. Check Pipedrive field setup.'
            );
          }
        }

        // Phase 3: Classify
        const classified = classifyDeals(allDeals, validated.practiceValues, validated, logger);

        if (totalFetched > 0 && classified.totalOpenPipeline.dealCount === 0 && classified.quarter.won.dealCount === 0) {
          logger?.info(
            { fetched: totalFetched, practices: validated.practiceValues },
            'Deals fetched from BHG Pipeline but none matched requested practice values'
          );
        }

        // Phase 4: Render
        return renderResponse(classified, validated.practiceValues, validated.nextMonthEnd, validated.nextThreeMonthsEnd);
      },
    },
  ];
}
