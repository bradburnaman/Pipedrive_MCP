# Part sec-01: Preflight & Security Foundation

> Part 1 of the API key security hardening plan. **This is not just dependency work** — it establishes the security foundation that later parts build on: retired flags, runtime-tier dependency placement, stub CLIs and CI scripts wired in at known names, and a clean working tree.
> **Depends on:** Nothing (but the plan pre-work step — rotate the Pipedrive token, physically delete `.env` — must have been completed).
> **Produces:** Updated `package.json`, new `keytar` + `better-sqlite3` **runtime** dependencies, removed `dotenv`, tightened `.gitignore`, stub CLIs (`setup`, `revoke`, `audit-verify`, `kill-switch`), stub CI scripts (`check-forbidden-patterns.sh`, `check-lifecycle-scripts.mjs`, `embed-version.mjs`), branch ready for subsequent parts.

## Goals for this part

1. Remove `dotenv` completely (both the dependency and any source references).
2. Add `keytar` and `better-sqlite3` as **runtime** dependencies.
3. Pin runtime dependency ranges per spec §15.1.
4. Add empty/stub CLI entry points at the names later parts wire into.
5. Add CI scripts early, even if some are placeholders.
6. Confirm `.env` is physically deleted from the working copy after token rotation. If it still exists, stop — deleting it is part of the pre-work, not sec-01.

---

## Task 1: Create the feature branch

- [ ] **Step 1:** Create branch `security/api-key-hardening` from `main`.
- [ ] **Step 2:** Confirm working tree is clean before starting (`git status`).

## Task 2: Preflight — confirm token rotation + physical `.env` deletion

- [ ] Confirm the Pipedrive API token was rotated per the plan's pre-work step. If not, stop and do it now. The existing token in the repo's `.env` has replicated to OneDrive cloud storage and must be invalidated before code work begins.
- [ ] `ls -la .env` — file should **not exist** in the working copy. If it does, delete it now (`rm .env`). sec-08 will also clean it up, but leaving it around during sec-01–sec-07 means a fresh `npm run dev` could still pick it up (once `dotenv` is gone that is moot, but while `dotenv` is still present for one commit it matters).
- [ ] `git log -- .env` — confirm `.env` has never been committed. If it has, flag immediately (treat every committed token version as compromised and rotate Pipedrive-side for each).

## Task 3: Update dependencies

**Target `package.json` dependency block** (both `keytar` and `better-sqlite3` are **runtime** dependencies — they are required to run the server, not only to test it):

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "~1.29.0",
    "better-sqlite3": "~11.3.0",
    "fastest-levenshtein": "1.0.16",
    "keytar": "~7.9.0",
    "pino": "~10.3.1",
    "striptags": "~3.2.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^25.5.0",
    "tsx": "^4.21.0",
    "typescript": "^6.0.2",
    "vitest": "^4.1.2"
  }
}
```

> Note: `better-sqlite3` and `keytar` both have native-build `install` lifecycle scripts. sec-07 adds a lifecycle-script allowlist — seed it with both package names, and document the rationale in the PR.

- [ ] **Step 1:** Remove `dotenv` from dependencies.
- [ ] **Step 2:** Tighten runtime dependency ranges per the table in `2026-04-24-api-key-security-design.md` §12.1 (caret → tilde for runtime, or exact for tiny utilities).
- [ ] **Step 3:** Install new deps:
  ```bash
  npm install --save-exact keytar@~7.9.0 better-sqlite3@~11.3.0
  npm install --save-dev @types/better-sqlite3
  npm uninstall dotenv
  ```
- [ ] **Step 4:** Regenerate `package-lock.json` by running `npm ci` (or `npm install` + review of the diff).
- [ ] **Step 5:** Verify `npm ls dotenv` reports no matches.

## Task 4: Add scripts

Add to `package.json` `scripts`:

```json
{
  "scripts": {
    "setup": "tsx src/bin/setup.ts",
    "revoke": "tsx src/bin/revoke.ts",
    "audit-verify": "tsx src/bin/audit-verify.ts",
    "kill-switch": "tsx src/bin/kill-switch.ts",
    "prebuild": "node scripts/embed-version.mjs",
    "security:check": "bash scripts/check-forbidden-patterns.sh && node scripts/check-lifecycle-scripts.mjs && npm audit --audit-level=high --production"
  }
}
```

The `setup` / `revoke` / `audit-verify` entry points are created in later parts; stubs are fine for this part.

- [ ] Add the scripts block.
- [ ] Verify `npm run typecheck` still passes.

## Task 5: Tighten `.gitignore`

Current `.gitignore`:

```
node_modules/
dist/
.env
*.tsbuildinfo
```

Add:

```
# Security: generated and private files that must never be committed
src/lib/version-id.ts
*.db
*.db-journal
*.db.archive
salt.bin
dist/sbom.json
```

- [ ] Update `.gitignore`.
- [ ] Run `git check-ignore -v src/lib/version-id.ts` and similar to verify the patterns match.

## Task 6: Create directory scaffolding

- [ ] Create the directories that later parts will populate. Empty directories are not tracked by git, so write a placeholder `.gitkeep` where needed.

```bash
mkdir -p src/bin scripts .github/workflows
```

## Task 7: Create stub entry points

To let `npm run setup` / `revoke` / `audit-verify` resolve without failing during this part, write stub files. Later parts replace the bodies.

- [ ] `src/bin/setup.ts`:
  ```typescript
  console.error('setup CLI is not yet implemented (Part sec-03).');
  process.exit(1);
  ```
- [ ] `src/bin/revoke.ts`: same pattern.
- [ ] `src/bin/audit-verify.ts`: same pattern.
- [ ] `src/bin/kill-switch.ts`: same pattern.
- [ ] `scripts/embed-version.mjs`:
  ```javascript
  console.error('version-id embedder stub — implemented in Part sec-05.');
  process.exit(0);
  ```
- [ ] `scripts/check-forbidden-patterns.sh`:
  ```bash
  #!/usr/bin/env bash
  echo "forbidden-patterns check stub — implemented in Part sec-04/sec-07."
  exit 0
  ```
  `chmod +x scripts/check-forbidden-patterns.sh`.
- [ ] `scripts/check-lifecycle-scripts.mjs`:
  ```javascript
  console.error('lifecycle-scripts check stub — implemented in Part sec-07.');
  process.exit(0);
  ```

## Task 8: Verify build still works

- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes (prebuild stub is a no-op).
- [ ] `npm test` passes (no test changes yet).

## Task 9: Commit

```bash
git add package.json package-lock.json .gitignore src/bin/*.ts scripts/*.mjs scripts/*.sh
git commit -m "chore(security): add keytar + better-sqlite3, remove dotenv, scaffold security CLIs"
```

---

**Done when:** `dotenv` is gone, `keytar` + `better-sqlite3` are installed with pinned versions, `npm run setup` / `revoke` / `audit-verify` exit cleanly with "not yet implemented," typecheck + build + test all green.

---

## Implementation Status

**Shipped:** commit `17e5160` on `security/api-key-hardening`. As-spec, no deviations.
