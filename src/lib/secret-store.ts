// ACL probe (recorded 2026-04-25, sec-03 Task 5):
//   security find-generic-password -s bhg-pipedrive-mcp -w
// returned the Base64 ciphertext blob without any unlock / ACL-allow prompt.
// Conclusion (per spec §7.6): the macOS Keychain ACL on a Node interpreter
// cannot constrain the entry to this binary — any same-user code can read it.
// The AES-256-GCM encryption wrapper below is therefore the live confidentiality
// control against passive single-entry exfiltration. Same-user code execution
// that can also read salt.bin and the bhg-pipedrive-mcp-kdf entry can still
// decrypt; that residual is documented in spec §7.6 and PD-009.

import keytar from 'keytar';
import {
  readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync, statSync,
} from 'node:fs';
import {
  randomBytes, scrypt, createCipheriv, createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { configDir, assertPathSafe } from './path-safety.js';

const SERVICE_TOKEN = 'bhg-pipedrive-mcp';
const SERVICE_KDF = 'bhg-pipedrive-mcp-kdf';

// scrypt with N=2^15, r=8, p=1 needs ~33MB; default maxmem is 32MB so we
// raise it to 64MB explicitly to avoid "memory limit exceeded" from Node.
const SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const scryptAsync = promisify(scrypt) as (
  password: Buffer, salt: Buffer, keylen: number, opts?: object,
) => Promise<Buffer>;

async function deriveKey(kdfSeed: Buffer, salt: Buffer): Promise<Buffer> {
  return scryptAsync(kdfSeed, salt, 32, SCRYPT_OPTS);
}

function encrypt(token: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const issuedAt = new Date().toISOString();
  return Buffer.concat([
    nonce, tag, ciphertext, Buffer.from('|' + issuedAt, 'utf8'),
  ]).toString('base64');
}

function decrypt(payload: string, key: Buffer): { token: string; issuedAt: string } {
  const buf = Buffer.from(payload, 'base64');
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const rest = buf.subarray(28);
  const sep = rest.lastIndexOf(0x7c); // '|'
  if (sep < 0) throw new Error('Malformed token payload (no separator)');
  const ciphertext = rest.subarray(0, sep);
  const issuedAt = rest.subarray(sep + 1).toString('utf8');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return { token, issuedAt };
}

function account(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'default';
}

function saltPath(): string { return join(configDir(), 'salt.bin'); }

async function ensureKdfSeed(): Promise<Buffer> {
  const existing = await keytar.getPassword(SERVICE_KDF, account());
  if (existing) return Buffer.from(existing, 'base64');
  const seed = randomBytes(32);
  await keytar.setPassword(SERVICE_KDF, account(), seed.toString('base64'));
  return seed;
}

function ensureSalt(): Buffer {
  assertPathSafe(configDir(), { purpose: 'config' });
  if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  if (!existsSync(saltPath())) {
    writeFileSync(saltPath(), randomBytes(32), { mode: 0o600 });
  }
  // Enforce mode 0600 on every read; surface a repair event for the audit log.
  const before = statSync(saltPath()).mode & 0o777;
  if (before !== 0o600) {
    chmodSync(saltPath(), 0o600);
    const after = statSync(saltPath()).mode & 0o777;
    if (after !== 0o600) {
      throw new Error(`Unable to enforce 0600 on salt.bin (mode now ${after.toString(8)})`);
    }
    permissionRepairEvents.push({ path: saltPath(), before, after });
  }
  return readFileSync(saltPath());
}

// Module-level buffer for permission-repair events observed during startup.
// index.ts reads this after audit-log init and emits one audit row per entry.
export const permissionRepairEvents: { path: string; before: number; after: number }[] = [];

// Single source of truth for files that must be 0600. sec-06 and sec-10 land
// audit.db / exceptions.log here so future additions don't slip through.
export function sensitiveFilesInConfigDir(): string[] {
  const dir = configDir();
  return [
    join(dir, 'salt.bin'),
    join(dir, 'config.json'),
    join(dir, 'audit.db'),
    join(dir, 'exceptions.log'),
  ];
}

export function enforceSensitivePerms(): void {
  for (const p of sensitiveFilesInConfigDir()) {
    if (!existsSync(p)) continue;
    const mode = statSync(p).mode & 0o777;
    if (mode === 0o600) continue;
    try {
      chmodSync(p, 0o600);
      permissionRepairEvents.push({ path: p, before: mode, after: 0o600 });
    } catch {
      // Caller (index.ts) sees -1 sentinel and flips safeDegraded.
      permissionRepairEvents.push({ path: p, before: mode, after: -1 });
    }
  }
}

export async function storeToken(token: string): Promise<void> {
  const kdf = await ensureKdfSeed();
  const salt = ensureSalt();
  const key = await deriveKey(kdf, salt);
  const payload = encrypt(token, key);
  await keytar.setPassword(SERVICE_TOKEN, account(), payload);
}

export async function getToken(): Promise<{ token: string; issuedAt: string } | null> {
  const payload = await keytar.getPassword(SERVICE_TOKEN, account());
  if (!payload) return null;
  const kdf = await ensureKdfSeed();
  const salt = ensureSalt();
  const key = await deriveKey(kdf, salt);
  return decrypt(payload, key);
}

export async function clearToken(): Promise<void> {
  await keytar.deletePassword(SERVICE_TOKEN, account());
  await keytar.deletePassword(SERVICE_KDF, account());
}

export interface RotationStatus {
  issuedAt: Date;
  ageDays: number;
  status: 'fresh' | 'due' | 'degraded' | 'refuse';
}

// Per spec §7.5: 0–74 silent, 75–89 warn, 90–119 degraded, 120+ refuse.
export function evaluateRotation(issuedAtIso: string): RotationStatus {
  const issuedAt = new Date(issuedAtIso);
  const ageDays = (Date.now() - issuedAt.getTime()) / 86_400_000;
  let status: RotationStatus['status'];
  if (ageDays < 75) status = 'fresh';
  else if (ageDays < 90) status = 'due';
  else if (ageDays < 120) status = 'degraded';
  else status = 'refuse';
  return { issuedAt, ageDays, status };
}

export interface EnvOverrideResult { allowed: boolean; reason?: string }

// Restricted env-override gating per spec §7.4. Legacy
// BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE is retired and intentionally not honored.
export function envOverrideAllowed(env: NodeJS.ProcessEnv = process.env): EnvOverrideResult {
  const isTest = env.NODE_ENV === 'test' || env.CI === 'true';
  if (isTest) return { allowed: true, reason: 'test_mode' };
  const breakGlass = env.BHG_PIPEDRIVE_BREAK_GLASS === '1';
  const reason = (env.BHG_PIPEDRIVE_BREAK_GLASS_REASON ?? '').trim();
  if (breakGlass && reason.length > 0) {
    return { allowed: true, reason: `break_glass:${reason}` };
  }
  return { allowed: false };
}
