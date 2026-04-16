import type { ToolDefinition } from '../types.js';
import type { ReferenceResolver } from '../lib/reference-resolver/index.js';
import type { PipedriveClient } from '../lib/pipedrive-client.js';
import { normalizeApiCall } from '../lib/error-normalizer.js';
import { parseStrictDate } from '../lib/date-utils.js';
import type { Logger } from 'pino';

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
