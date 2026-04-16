import type { ToolDefinition } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { parseStrictDate } from '../lib/date-utils.js';
import type { Logger } from 'pino';
import type { CanonicalDeal, ClassificationResult, BucketAccumulator } from '../lib/pipeline-classifier.js';

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
    if (Array.isArray(resolved)) {
      practiceValues = resolved.filter((v): v is string => typeof v === 'string');
    } else if (typeof resolved === 'string') {
      practiceValues = [resolved];
    }
    // Hard fail if field is populated but unresolvable
    if (practiceValues.length === 0) {
      throw new Error(
        'A deal has an unresolvable BHG Practices value. Field metadata may be inconsistent.'
      );
    }
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
        logger?.warn({ labelId: id }, 'Unknown label option ID');
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
