import type { ToolPolicy } from './capability-policy.js';
import { createHash } from 'node:crypto';

// Tools that require user_chat_message alongside `confirm`.
// This is friction + audit, not proof of user intent — a prompt-injected model
// can fabricate both fields. The requirement makes fabrication visible in the
// audit log: every high-risk delete carries a hash of the claimed user message,
// enabling post-hoc comparison if a user disputes they issued the command.
export const HIGH_RISK_DELETES = new Set([
  'delete-deal', 'delete-person', 'delete-activity', 'delete-note',
]);

export function isHighRiskDelete(tool: string): boolean {
  return HIGH_RISK_DELETES.has(tool);
}

export function resolveDeleteConfirmation(toolPolicy: ToolPolicy, entityId: string | number): string {
  return toolPolicy.confirmation_format!.replace('<id>', String(entityId));
}

export function checkUserChatMessage(
  userChatMessage: string | undefined,
  requiredConfirm: string,
): { ok: true; hash: string } | { ok: false; reason: 'MISSING' | 'MISMATCH' } {
  if (typeof userChatMessage !== 'string' || userChatMessage.length === 0) {
    return { ok: false, reason: 'MISSING' };
  }
  if (!userChatMessage.includes(requiredConfirm)) {
    return { ok: false, reason: 'MISMATCH' };
  }
  const hash = createHash('sha256').update(userChatMessage).digest('hex').slice(0, 16);
  return { ok: true, hash };
}

const UPDATE_CONFIRM_MAP: Record<string, string> = {
  status: 'STATUS-CHANGE',
  value: 'VALUE-CHANGE',
  pipeline_id: 'PIPELINE-CHANGE',
  owner_id: 'OWNER-CHANGE',
};

export function needsUpdateConfirmation(
  toolPolicy: ToolPolicy,
  params: Record<string, unknown>,
): { required: string; field: string } | null {
  for (const f of toolPolicy.destructive_updates ?? []) {
    if (params[f] !== undefined) {
      return { required: UPDATE_CONFIRM_MAP[f] ?? `FIELD-CHANGE:${f.toUpperCase()}`, field: f };
    }
  }
  return null;
}

export class BulkDetector {
  private history: { tool: string; ts: number }[] = [];

  constructor(private windowSeconds: number, private threshold: number) {}

  record(tool: string): number {
    const now = Date.now();
    const cutoff = now - this.windowSeconds * 1000;
    this.history = this.history.filter(h => h.ts >= cutoff);
    this.history.push({ tool, ts: now });
    return this.history.filter(h => h.tool === tool).length;
  }

  needsConfirmation(
    tool: string,
    confirm: string | undefined,
    format: string,
  ): { ok: true } | { ok: false; required: string } {
    const count = this.record(tool);
    if (count <= this.threshold) return { ok: true };
    const required = format.replace('<count>', String(count));
    if (confirm === required) return { ok: true };
    return { ok: false, required };
  }
}
