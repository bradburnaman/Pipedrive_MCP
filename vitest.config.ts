import { defineConfig } from 'vitest/config';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('src/lib/version-id.ts')) {
  execSync('node scripts/embed-version.mjs', { stdio: 'inherit' });
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    environment: 'node',
  },
});
