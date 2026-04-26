// Helpers used by the central dispatcher in server.ts to populate audit rows.
// We bypass a higher-order-function "middleware" wrapper because all tool calls
// already flow through one CallToolRequestSchema handler — the dispatcher
// branches on tool.category and calls these helpers directly.

import { createHash } from 'node:crypto';

const PII_KEYS = new Set(['content', 'note', 'description', 'email', 'phone']);

export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (PII_KEYS.has(k) && typeof v === 'string') {
      out[k] = { hash: createHash('sha256').update(v).digest('hex').slice(0, 16) };
    } else if (Array.isArray(v)) {
      out[k] = v.map(item =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? sanitizeParams(item as Record<string, unknown>)
          : item
      );
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeParams(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k]));
  return '{' + parts.join(',') + '}';
}

export function requestHash(tool: string, params: Record<string, unknown>): string {
  return createHash('sha256').update(tool + '\n' + canonicalJson(sanitizeParams(params))).digest('hex');
}

// Best-effort entity_id extraction for create/update/delete audit rows.
// Order: result.id → result.data.id → params.id → params.deal_id/person_id/etc.
export function extractEntityId(params: Record<string, unknown>, result: unknown): string | null {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.id === 'number' || typeof r.id === 'string') return String(r.id);
    const data = r.data;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (typeof d.id === 'number' || typeof d.id === 'string') return String(d.id);
    }
  }
  for (const k of ['id', 'deal_id', 'person_id', 'organization_id', 'activity_id', 'note_id']) {
    const v = params[k];
    if (typeof v === 'number' || typeof v === 'string') return String(v);
  }
  return null;
}
