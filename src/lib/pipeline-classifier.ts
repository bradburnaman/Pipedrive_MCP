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
