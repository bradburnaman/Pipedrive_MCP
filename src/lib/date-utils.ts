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
