import type { ReadBudgetPolicy } from './capability-policy.js';

export class ReadBudget {
  private records = 0;
  private bytes = 0;
  private depthByTool = new Map<string, number>();
  private broadConfirmedThisSession = new Set<string>();

  constructor(private policy: ReadBudgetPolicy) {}

  add(tool: string, newRecords: number, newBytes: number, incrementDepth: boolean): void {
    this.records += newRecords;
    this.bytes += newBytes;
    if (incrementDepth) {
      this.depthByTool.set(tool, (this.depthByTool.get(tool) ?? 0) + 1);
    }
  }

  checkRecords(): { ok: boolean; reason?: string } {
    if (this.records >= this.policy.max_records_per_session)
      return { ok: false, reason: 'SESSION_READ_BUDGET_RECORDS_EXCEEDED' };
    return { ok: true };
  }

  checkBytes(): { ok: boolean; reason?: string } {
    if (this.bytes >= this.policy.max_bytes_per_session)
      return { ok: false, reason: 'SESSION_READ_BUDGET_BYTES_EXCEEDED' };
    return { ok: true };
  }

  checkPagination(tool: string): { ok: boolean; reason?: string } {
    const d = this.depthByTool.get(tool) ?? 0;
    if (d >= this.policy.max_pagination_depth)
      return { ok: false, reason: 'PAGINATION_DEPTH_EXCEEDED' };
    return { ok: true };
  }

  // Broad-query detection: unfiltered list* calls or empty/single-char search* queries.
  isBroadQuery(tool: string, params: Record<string, unknown>): boolean {
    if (tool.startsWith('search-')) {
      const q = (params.query as string | undefined)?.trim() ?? '';
      return q.length < 2;
    }
    if (tool.startsWith('list-')) {
      const filterKeys = [
        'owner', 'owner_id', 'pipeline', 'pipeline_id', 'stage', 'stage_id',
        'status', 'updated_since', 'org', 'organization_id', 'person', 'person_id', 'type',
      ];
      return !filterKeys.some(k => params[k] !== undefined && params[k] !== '');
    }
    return false;
  }

  needsBroadConfirmation(
    tool: string,
    params: Record<string, unknown>,
    confirm: string | undefined,
  ): { ok: true } | { ok: false; required: string } {
    if (!this.policy.broad_query_confirmation) return { ok: true };
    if (!this.isBroadQuery(tool, params)) return { ok: true };
    const required = this.policy.broad_query_confirmation_format.replace('<tool>', tool);
    if (this.broadConfirmedThisSession.has(tool)) return { ok: true };
    if (confirm === required) {
      this.broadConfirmedThisSession.add(tool);
      return { ok: true };
    }
    return { ok: false, required };
  }
}
