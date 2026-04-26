export interface SafeDegradedRef {
  value: boolean;
  reason: string | null;
}

export interface SecurityNotice {
  severity: 'high';
  message: string;
}

// Prepends a _security_notice to read-tool responses when safe-degraded mode
// is active. The audit chain integrity has been compromised — results may have
// been shaped by a tampered process or DB, so we surface that in-band so any
// caller (human or LLM) sees the warning before acting on the data.
export function decorateReadResponse<T>(
  result: T,
  ref: SafeDegradedRef,
): T | (T & { _security_notice: SecurityNotice }) {
  if (!ref.value) return result;
  const notice: SecurityNotice = {
    severity: 'high',
    message: `Audit integrity failure (${ref.reason ?? 'unknown'}). Results may have been shaped by a compromised process. Investigate before acting.`,
  };
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { _security_notice: notice, ...(result as object) } as T & { _security_notice: SecurityNotice };
  }
  // Non-object (or array) result — wrap it.
  return { _security_notice: notice, value: result } as unknown as T & { _security_notice: SecurityNotice };
}
