import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { POLICY_HASH } from './version-id.js';

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
}

export interface CapabilityPolicy {
  version: string;
  writes_enabled_default: boolean;
  tools: Record<string, ToolPolicy>;
  read_budgets: ReadBudgetPolicy;
  bulk_detector: BulkDetectorPolicy;
}

export interface ToolPolicy {
  enabled: boolean;
  category: 'read' | 'create' | 'update' | 'delete';
  destructive?: boolean;
  confirmation_format?: string;
  destructive_updates?: string[];
  max_page_size?: number;
  prefer_soft_delete_hint?: string;
}

export interface ReadBudgetPolicy {
  max_records_per_session: number;
  max_bytes_per_session: number;
  max_pagination_depth: number;
  broad_query_confirmation: boolean;
  broad_query_confirmation_format: string;
}

export interface BulkDetectorPolicy {
  window_seconds: number;
  threshold: number;
  confirmation_format: string;
}

export class PolicyHashMismatchError extends Error {
  constructor(public expected: string, public got: string) {
    super(`Capability policy hash mismatch. expected=${expected} got=${got}`);
    this.name = 'PolicyHashMismatchError';
  }
}

export function loadPolicy(path = 'capabilities.json'): CapabilityPolicy {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as CapabilityPolicy;
  const hash = createHash('sha256').update(canonicalJson(parsed)).digest('hex');
  if (hash !== POLICY_HASH) {
    throw new PolicyHashMismatchError(POLICY_HASH, hash);
  }
  return parsed;
}

export function recomputeHash(path = 'capabilities.json'): string {
  const raw = readFileSync(path, 'utf8');
  return createHash('sha256').update(canonicalJson(JSON.parse(raw))).digest('hex');
}
