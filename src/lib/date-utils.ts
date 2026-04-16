// Relies on lexicographic ordering of YYYY-MM-DD strings. Do not change format without updating comparison logic.

/**
 * Parse and validate a strict YYYY-MM-DD date string.
 * Rejects malformed formats, impossible calendar dates, and whitespace.
 * Returns the validated string unchanged.
 */
export function parseStrictDate(value: string, paramName: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date format for ${paramName}: '${value}'. Expected YYYY-MM-DD.`);
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid date for ${paramName}: '${value}'. Month ${month} is out of range.`);
  }
  // Use Date constructor to get last day of month (day 0 of next month = last day of this month)
  const maxDays = new Date(year, month, 0).getDate();
  if (day < 1 || day > maxDays) {
    throw new Error(`Invalid date for ${paramName}: '${value}'. Day ${day} is out of range for month ${month}.`);
  }
  return value;
}

/**
 * Extract the YYYY-MM-DD date portion from an ISO timestamp.
 * "2026-04-08T14:30:00Z" → "2026-04-08"
 */
function toDateOnly(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * Check if wonTime falls within [start, end] inclusive.
 * Compares date portion only (ignores time-of-day).
 * Returns false if wonTime is null.
 */
export function isWonInPeriod(
  wonTime: string | null,
  start: string,
  end: string
): boolean {
  if (wonTime === null) return false;
  const date = toDateOnly(wonTime);
  return date >= start && date <= end;
}

/**
 * Check if expectedCloseDate is at or before ceiling.
 * Ceiling-only — no floor. Intentionally includes overdue deals.
 * Returns false if expectedCloseDate is null.
 */
export function isClosingByDate(
  expectedCloseDate: string | null,
  ceiling: string
): boolean {
  if (expectedCloseDate === null) return false;
  return expectedCloseDate <= ceiling;
}

/**
 * Check if expectedCloseDate falls within [floor, ceiling] inclusive.
 * Both boundaries enforced. Used only for next-quarter commit/upside.
 * Returns false if expectedCloseDate is null.
 */
export function isClosingInWindow(
  expectedCloseDate: string | null,
  floor: string,
  ceiling: string
): boolean {
  if (expectedCloseDate === null) return false;
  return expectedCloseDate >= floor && expectedCloseDate <= ceiling;
}
