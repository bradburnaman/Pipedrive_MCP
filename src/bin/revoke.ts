#!/usr/bin/env node
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, assertConfigDirSafe } from '../lib/path-safety.js';
import { clearToken } from '../lib/secret-store.js';

async function main() {
  assertConfigDirSafe();
  await clearToken();
  const saltP = join(configDir(), 'salt.bin');
  if (existsSync(saltP)) rmSync(saltP);
  const db = join(configDir(), 'audit.db');
  if (existsSync(db)) {
    renameSync(db, join(configDir(), `audit-${Date.now()}.db.archive`));
  }
  console.log(
    'Keychain entry removed; salt deleted; audit.db archived. ' +
    'Rotate or revoke the token in Pipedrive UI now.',
  );
}

main().catch(err => { console.error(err); process.exit(1); });
