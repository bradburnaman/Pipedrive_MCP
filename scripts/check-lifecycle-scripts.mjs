#!/usr/bin/env node
import { execSync } from 'node:child_process';

// Seeded allowlist. Each entry should have a PR note explaining why a native-build
// install script is trusted.
const ALLOWLIST = new Set([
  'keytar',              // native binding for macOS Keychain
  'better-sqlite3',      // native SQLite binding
  // esbuild — postinstall fetches platform binary. Reached transitively via
  // tsx and vitest>vite; both dev-only, not bundled into dist/. Verified
  // 2026-04-25 with `npm ls --omit=dev esbuild` returning empty.
  'esbuild',
]);

// Ask npm for the flattened tree with install-time script presence.
const raw = execSync('npm ls --all --json --long', { encoding: 'utf8' });
const tree = JSON.parse(raw);

const offenders = [];
function walk(node, path = []) {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    const scripts = child.scripts ?? {};
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      if (scripts[hook] && !ALLOWLIST.has(name)) {
        offenders.push({ name, hook, script: scripts[hook], path: [...path, name].join(' > ') });
      }
    }
    walk(child, [...path, name]);
  }
}
walk(tree);

if (offenders.length > 0) {
  console.error('Disallowed lifecycle scripts found:');
  for (const o of offenders) console.error(`  ${o.path}  [${o.hook}]  "${o.script}"`);
  console.error('\nAdd the package to the ALLOWLIST with a PR note if it is intentional.');
  process.exit(1);
}
console.log('Lifecycle-scripts check passed.');
