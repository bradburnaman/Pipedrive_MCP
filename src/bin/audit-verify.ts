#!/usr/bin/env node
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from '../lib/audit-log.js';
import { configDir } from '../lib/path-safety.js';

const acknowledgeAndReset = process.argv.includes('--acknowledge-and-reset');
const dbPath = join(configDir(), 'audit.db');

const auditLog = new AuditLog(dbPath);
const result = auditLog.verifyChain();
auditLog.close();

if (result.ok) {
  console.log('Audit chain verified — OK.');
  process.exit(0);
}

console.error(`Audit chain broken at row id ${result.breakAtId}.`);

if (!acknowledgeAndReset) {
  console.error('To acknowledge and reset: npm run audit-verify -- --acknowledge-and-reset');
  process.exit(1);
}

if (existsSync(dbPath)) {
  const archive = `${dbPath}.broken-${Date.now()}.archive`;
  renameSync(dbPath, archive);
  console.error(`Archived broken DB to ${archive}.`);
}

const fresh = new AuditLog(dbPath);
fresh.insert({
  tool: '_audit',
  category: 'policy',
  entity_type: null,
  entity_id: null,
  status: 'success',
  reason_code: 'CHAIN_RESET',
  request_hash: '',
  target_summary: `reset from broken chain at row ${result.breakAtId}`,
  diff_summary: null,
  idempotency_key: null,
});
fresh.close();
console.log('Fresh audit chain started with CHAIN_RESET row.');
