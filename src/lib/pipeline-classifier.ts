import { isWonInPeriod, isClosingByDate, isClosingInWindow } from './date-utils.js';
import type { Logger } from 'pino';

export interface CanonicalDeal {
  dealId: number;
  title: string;
  value: number;
  status: 'open' | 'won';
  wonTime: string | null;
  expectedCloseDate: string | null;
  stage: string;
  labels: string[];
  organization: string | null;
  practiceValues: string[];
}

export type LabelClass = 'commit' | 'upside' | null;

/**
 * Classify a deal's label set into commit, upside, or null.
 * Uses exact set membership. Commit takes precedence if both present.
 */
export function classifyLabel(labels: string[]): LabelClass {
  if (labels.includes('Commit')) return 'commit';
  if (labels.includes('Upside')) return 'upside';
  return null;
}

/**
 * Check if a deal's practice values overlap with the requested set.
 * Uses exact string match — no case normalization.
 */
export function practiceMatches(
  dealPractices: string[],
  requestedPractices: string[]
): boolean {
  return dealPractices.some(p => requestedPractices.includes(p));
}

export interface BucketAccumulator {
  totalValue: number;
  dealCount: number;
  deals: CanonicalDeal[];
  truncated: boolean;
}

/**
 * Create a zeroed bucket accumulator.
 */
export function createEmptyBucket(): BucketAccumulator {
  return { totalValue: 0, dealCount: 0, deals: [], truncated: false };
}

const MAX_DETAIL_DEALS = 50;

/**
 * Add a deal to a bucket. Always increments aggregates unconditionally.
 * Detail array collects all eligible deals during classification.
 * Call finalizeBucket() after classification to sort + truncate.
 */
export function addToBucket(bucket: BucketAccumulator, deal: CanonicalDeal): void {
  bucket.totalValue += deal.value;
  bucket.dealCount += 1;
  bucket.deals.push(deal);
}

/**
 * Sort deals and truncate to MAX_DETAIL_DEALS. Call once per bucket
 * after classification is complete. Totals are never affected.
 *
 * Memory note: at ~150 deals with cross-bucket duplication factor ~3-4x,
 * worst case is ~600 deal references across all buckets. These are
 * references to the same CanonicalDeal objects, not copies. Acceptable
 * for current volume; revisit if pipeline exceeds ~1000 deals.
 */
export function finalizeBucket(
  bucket: BucketAccumulator,
  sortFn: (a: CanonicalDeal, b: CanonicalDeal) => number
): void {
  bucket.deals.sort(sortFn);
  if (bucket.deals.length > MAX_DETAIL_DEALS) {
    bucket.deals.length = MAX_DETAIL_DEALS; // truncate in place
    bucket.truncated = true;
  }
}

/**
 * Sort won deals: wonTime descending (most recent first), dealId ascending tie-breaker.
 */
export function sortWonDeals(a: CanonicalDeal, b: CanonicalDeal): number {
  if (a.wonTime && b.wonTime) {
    if (a.wonTime > b.wonTime) return -1;
    if (a.wonTime < b.wonTime) return 1;
  }
  if (a.wonTime && !b.wonTime) return -1;
  if (!a.wonTime && b.wonTime) return 1;
  return a.dealId - b.dealId;
}

/**
 * Sort by expectedCloseDate ascending (soonest first), nulls last, dealId ascending tie-breaker.
 */
export function sortByCloseDate(a: CanonicalDeal, b: CanonicalDeal): number {
  if (a.expectedCloseDate && b.expectedCloseDate) {
    if (a.expectedCloseDate < b.expectedCloseDate) return -1;
    if (a.expectedCloseDate > b.expectedCloseDate) return 1;
  }
  if (a.expectedCloseDate && !b.expectedCloseDate) return -1;
  if (!a.expectedCloseDate && b.expectedCloseDate) return 1;
  return a.dealId - b.dealId;
}

export interface ClassificationParams {
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

export interface ClassificationResult {
  month: { won: BucketAccumulator; commit: BucketAccumulator; upside: BucketAccumulator };
  quarter: { won: BucketAccumulator; commit: BucketAccumulator; upside: BucketAccumulator };
  nextQuarter: { commit: BucketAccumulator; upside: BucketAccumulator };
  totalOpenPipeline: BucketAccumulator;
  nextMonthPipeline: BucketAccumulator;
  nextThreeMonthsPipeline: BucketAccumulator;
}

function createEmptyResult(): ClassificationResult {
  return {
    month: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
    quarter: { won: createEmptyBucket(), commit: createEmptyBucket(), upside: createEmptyBucket() },
    nextQuarter: { commit: createEmptyBucket(), upside: createEmptyBucket() },
    totalOpenPipeline: createEmptyBucket(),
    nextMonthPipeline: createEmptyBucket(),
    nextThreeMonthsPipeline: createEmptyBucket(),
  };
}

/**
 * Classify deals into scorecard buckets.
 * Applies practice gate, then status-driven eligibility, then date/label predicates.
 */
export function classifyDeals(
  deals: CanonicalDeal[],
  requestedPractices: string[],
  params: ClassificationParams,
  logger?: Logger
): ClassificationResult {
  const result = createEmptyResult();
  const practices = [...new Set(requestedPractices)];

  let anomalyNullWonTime = 0;
  let anomalyNullCloseDate = 0;

  for (const deal of deals) {
    if (!practiceMatches(deal.practiceValues, practices)) continue;

    if (deal.status === 'won') {
      if (deal.wonTime === null) {
        anomalyNullWonTime++;
        continue;
      }
      if (isWonInPeriod(deal.wonTime, params.wonPeriodStart, params.wonPeriodEnd)) {
        addToBucket(result.month.won, deal);
      }
      if (isWonInPeriod(deal.wonTime, params.wonQuarterStart, params.wonPeriodEnd)) {
        addToBucket(result.quarter.won, deal);
      }
    } else if (deal.status === 'open') {
      // Track A — Pipeline Health (label-free)
      addToBucket(result.totalOpenPipeline, deal);
      if (isClosingByDate(deal.expectedCloseDate, params.nextMonthEnd)) {
        addToBucket(result.nextMonthPipeline, deal);
      }
      if (isClosingByDate(deal.expectedCloseDate, params.nextThreeMonthsEnd)) {
        addToBucket(result.nextThreeMonthsPipeline, deal);
      }

      // Track B — Commit/Upside (label-driven)
      const labelClass = classifyLabel(deal.labels);
      if (labelClass !== null) {
        if (deal.expectedCloseDate === null) {
          anomalyNullCloseDate++;
          continue;
        }
        const bucketKey = labelClass;
        if (isClosingByDate(deal.expectedCloseDate, params.monthEnd)) {
          addToBucket(result.month[bucketKey], deal);
        }
        if (isClosingByDate(deal.expectedCloseDate, params.quarterEnd)) {
          addToBucket(result.quarter[bucketKey], deal);
        }
        if (isClosingInWindow(deal.expectedCloseDate, params.nextQuarterStart, params.nextQuarterEnd)) {
          addToBucket(result.nextQuarter[bucketKey], deal);
        }
      }
    }
  }

  if (anomalyNullWonTime > 0) {
    logger?.warn({ count: anomalyNullWonTime }, 'Won deals with null wonTime excluded from won buckets');
  }
  if (anomalyNullCloseDate > 0) {
    logger?.warn({ count: anomalyNullCloseDate }, 'Open labeled deals with null expectedCloseDate excluded from dated buckets');
  }

  finalizeBucket(result.month.won, sortWonDeals);
  finalizeBucket(result.quarter.won, sortWonDeals);
  finalizeBucket(result.month.commit, sortByCloseDate);
  finalizeBucket(result.month.upside, sortByCloseDate);
  finalizeBucket(result.quarter.commit, sortByCloseDate);
  finalizeBucket(result.quarter.upside, sortByCloseDate);
  finalizeBucket(result.nextQuarter.commit, sortByCloseDate);
  finalizeBucket(result.nextQuarter.upside, sortByCloseDate);
  finalizeBucket(result.totalOpenPipeline, sortByCloseDate);
  finalizeBucket(result.nextMonthPipeline, sortByCloseDate);
  finalizeBucket(result.nextThreeMonthsPipeline, sortByCloseDate);

  return result;
}
