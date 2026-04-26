#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { assertConfigDirSafe, configDir } from '../lib/path-safety.js';
import { storeToken, getToken } from '../lib/secret-store.js';
import { PipedriveClient } from '../lib/pipedrive-client.js';

const args = process.argv.slice(2);
const isRotate = args.includes('--rotate');

async function main() {
  assertConfigDirSafe();
  if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true, mode: 0o700 });

  if (isRotate) {
    const existing = await getToken();
    if (!existing) {
      console.error('No existing token to rotate. Run `npm run setup` (without --rotate).');
      process.exit(1);
    }
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const token = (await rl.question('Paste Pipedrive API token: ')).trim();
  rl.close();

  if (!/^[a-f0-9]{40}$/.test(token)) {
    console.error('Token shape is unexpected. Pipedrive tokens are 40 lowercase hex characters.');
    process.exit(1);
  }

  const logger = pino({ level: 'info' }, pino.destination(2));
  const client = new PipedriveClient(token, logger);
  try {
    const user = await client.validateToken();
    console.log(`Token validated: user ${user.name} (id=${user.id}).`);
  } catch {
    console.error('Token rejected by Pipedrive. Not saved.');
    process.exit(1);
  }

  await storeToken(token);

  const configPath = join(configDir(), 'config.json');
  const nextRotation = new Date(Date.now() + 90 * 86_400_000).toISOString();
  writeFileSync(
    configPath,
    JSON.stringify({ setupAt: new Date().toISOString(), nextRotationDue: nextRotation }, null, 2),
    { mode: 0o600 },
  );

  console.log(`Token stored in macOS Keychain. Next rotation due: ${nextRotation.slice(0, 10)}.`);
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
