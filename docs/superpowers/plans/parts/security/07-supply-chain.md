# Part sec-07: Supply Chain Controls

> Part 7 of 9.
> **Depends on:** sec-01.
> **Produces:** `.github/workflows/security.yml`, `.github/dependabot.yml`, SBOM in build output, existing forbidden-pattern grep extended.

Implements spec §12.

---

## Task 1: GitHub Actions workflow

`.github/workflows/security.yml`:

```yaml
name: security

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install with lockfile (npm ci)
        run: npm ci

      - name: Lockfile integrity — no drift
        run: |
          git diff --exit-code package-lock.json || \
            (echo "package-lock.json drifted after npm ci — lockfile inconsistent" && exit 1)

      - name: Forbidden-pattern grep
        run: bash scripts/check-forbidden-patterns.sh

      - name: Lifecycle-script allowlist
        run: node scripts/check-lifecycle-scripts.mjs

      - name: npm audit (high/critical, production)
        run: npm audit --audit-level=high --production

      - name: Typecheck
        run: npm run typecheck

      - name: Unit tests
        run: npm test

      - name: Build (runs prebuild embed-version)
        env:
          CI: 'true'
        run: npm run build

      - name: Generate SBOM
        run: |
          mkdir -p dist
          npx --yes @cyclonedx/cdxgen -o dist/sbom.json

      - name: Upload SBOM
        uses: actions/upload-artifact@v4
        with:
          name: sbom-${{ github.sha }}
          path: dist/sbom.json
```

- [ ] Create the workflow.

## Task 2: Dependabot config

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    groups:
      dev-dependencies:
        dependency-type: development
        update-types: [minor, patch]
    ignore:
      # Major bumps require manual review (architecture §15).
      - dependency-name: '*'
        update-types: [version-update:semver-major]
    commit-message:
      prefix: chore(deps)
      include: scope
```

- [ ] Create.

## Task 3: Build uses `npm ci` not `npm install`

- [ ] Verify `package.json`'s `build` script path is reachable via `npm ci && npm run build` in CI. Document this in `README.md` Development section (touched in sec-08).

## Task 4: Forbidden-patterns extension

Already written in sec-04. Re-verify it runs in CI via the workflow above.

## Task 4b: Lifecycle-scripts allowlist

`scripts/check-lifecycle-scripts.mjs`:

```javascript
#!/usr/bin/env node
import { execSync } from 'node:child_process';

// Seeded allowlist. Each entry should have a PR note explaining why a native-build
// install script is trusted.
const ALLOWLIST = new Set([
  'keytar',              // native binding for macOS Keychain
  'better-sqlite3',      // native SQLite binding
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
```

Note: `npm ls --all` output shape varies across npm versions. Walk may need adjustment; test against the installed npm.

- [ ] Replace the stub. Run locally. Should pass with `keytar` + `better-sqlite3` on the list.
- [ ] Run the CI workflow locally using `act` if available, or push the branch and confirm the workflow goes green.

## Task 5: SBOM retention

SBOM is uploaded as a workflow artifact. Retention default is 90 days — acceptable for incident response. Document the retrieval procedure in `SECURITY_CHECKLIST.md` (added in sec-08).

- [ ] Note in checklist.

## Task 6: Commit

```bash
git add .github/workflows/security.yml .github/dependabot.yml scripts/check-lifecycle-scripts.mjs
git commit -m "ci(security): npm audit, SBOM, Dependabot, lifecycle-scripts allowlist, lockfile integrity"
```

---

**Done when:** `security.yml` runs on PRs and pushes; a high-severity advisory fails the build; lockfile drift after `npm ci` fails the build; a package with an install lifecycle script not on the allowlist fails `check-lifecycle-scripts`; SBOM is attached to each successful build; Dependabot PRs appear weekly and major bumps require manual approval.
