const API_TOKEN_QUERY_RE = /([?&])api_token=[^&#]+/gi;

export function redactUrl(input: string | URL): string {
  const s = typeof input === 'string' ? input : input.toString();
  return s.replace(API_TOKEN_QUERY_RE, '$1api_token=[REDACTED]');
}

const PIPEDRIVE_TOKEN_RE = /\b[a-f0-9]{40}\b/g;

export function stripTokenPattern(input: string): string {
  return input.replace(PIPEDRIVE_TOKEN_RE, '[REDACTED-40HEX]');
}
