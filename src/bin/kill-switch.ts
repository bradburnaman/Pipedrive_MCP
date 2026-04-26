import { KillSwitch } from '../lib/kill-switch.js';
import { AuditLog } from '../lib/audit-log.js';
import { assertConfigDirSafe } from '../lib/path-safety.js';

const args = process.argv.slice(2);
const off = args.includes('--off');
const on = args.includes('--on');
const reasonIdx = args.indexOf('--reason');
const reason = reasonIdx >= 0 ? (args[reasonIdx + 1] ?? '') : '';

if ((off && on) || (!off && !on)) {
  console.error('Use exactly one of --off or --on. Optional: --reason "text".');
  process.exit(1);
}

assertConfigDirSafe();
const ks = new KillSwitch();
const before = ks.writesEnabled;
ks.setWritesEnabled(!off);
const after = ks.writesEnabled;

const auditLog = new AuditLog();
auditLog.insert({
  tool: '_kill_switch',
  category: 'kill_switch',
  entity_type: null,
  entity_id: null,
  status: 'success',
  reason_code: before === after ? 'KILL_SWITCH_NO_CHANGE' : 'KILL_SWITCH_FLIP',
  request_hash: '',
  target_summary: `writes_enabled: ${before} -> ${after}`,
  diff_summary: `reason: ${reason || '(none)'}`,
  idempotency_key: null,
});
auditLog.close();

console.log(`writes_enabled: ${before} -> ${after}${reason ? ` (reason: ${reason})` : ''}`);
