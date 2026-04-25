# Part sec-09: Adversarial Integration Tests (PD-001–PD-010 + TC-*)

> Part 9 of the security hardening plan (revised in v1.1).
> **Depends on:** sec-02, sec-03, sec-06, sec-10.
> **Produces:** 14 integration tests that exercise every control added by this plan end-to-end. Maps to spec §18.

All tests live under `tests/integration/` and run via `npm run test:integration`. They use a tempdir `HOME` and a mocked-or-real Keychain (real on darwin; `describe.skip` elsewhere).

---

## Conventions

Shared helper `tests/integration/_harness.ts` provides:

```typescript
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> { /* … */ }
export function startServerProcess(env: Record<string, string>): ChildProcess { /* … */ }
export async function callTool(proc: ChildProcess, tool: string, params: unknown): Promise<unknown> { /* … */ }
export function readAuditRows(home: string): AuditRow[] { /* … */ }
```

- [ ] Build the harness first. Mock Pipedrive at the HTTP layer with a fixture server so tests never hit real Pipedrive.

---

## PD-001 — Env override ignored in normal runtime

File: `tests/integration/pd-001-env-override.integration.test.ts`.

Steps:
1. Populate Keychain via direct `storeToken(realTokenShape)`.
2. Start server with `BHG_PIPEDRIVE_ALLOW_ENV_OVERRIDE=1 PIPEDRIVE_API_TOKEN=DIFFERENT_TOKEN`.
3. Call a read tool.

Expected:
- Server starts using the Keychain token (mock Pipedrive observes the Keychain token, not the env one).
- Stderr contains no "using env" warning.
- Exit is clean.

## PD-001b — Break-glass env override audits correctly

Same file.

Steps:
1. **Empty** Keychain.
2. Start with `BHG_PIPEDRIVE_BREAK_GLASS=1 BHG_PIPEDRIVE_BREAK_GLASS_REASON="rotating" PIPEDRIVE_API_TOKEN=…`.

Expected:
- Server starts (using env).
- Stderr warning mentions "break-glass" and the reason.
- Audit DB contains a row with `reason_code === 'BREAK_GLASS_ENV_OVERRIDE'` and `diff_summary` containing the reason.
- `~/.bhg-pipedrive-mcp/exceptions.log` has an entry with the reason.

## PD-002 — Destructive prompt-injection surfaces friction + audit, not proof of intent

File: `tests/integration/pd-002-destructive-injection.integration.test.ts`.

**Framing:** this test verifies that the typed-confirmation + `user_chat_message` control creates friction and audit artifacts. It explicitly does not claim to prevent a fabricating model.

Steps:
1. Call `delete-deal` with `{ id: 42 }` (no `confirm`).
2. Call `delete-deal` with `{ id: 42, confirm: true }`.
3. Call `delete-deal` with `{ id: 42, confirm: "DELETE-DEAL:42" }` — but **no** `user_chat_message`.
4. Call `delete-deal` with `{ id: 42, confirm: "DELETE-DEAL:42", user_chat_message: "please delete the old test deal" }` — message does NOT contain the substring.
5. Call `delete-deal` with `{ id: 42, confirm: "DELETE-DEAL:42", user_chat_message: "Yes, DELETE-DEAL:42 confirmed" }`.
6. **Framing assertion (documentation):** repeat step 5 with a fabricated `user_chat_message`; assert the call proceeds (this is expected — the control is friction, not prevention) and that the audit row contains the 16-char hash of whatever message was supplied.

Expected:
- Steps 1 & 2: `CONFIRMATION_REQUIRED`; audit `reason_code === 'CONFIRMATION_REQUIRED'`.
- Step 3: `CONFIRMATION_USER_MESSAGE_REQUIRED`; audit `reason_code === 'CONFIRMATION_USER_MESSAGE_MISSING'`.
- Step 4: `CONFIRMATION_USER_MESSAGE_REQUIRED`; audit `reason_code === 'CONFIRMATION_USER_MESSAGE_MISMATCH'`.
- Step 5: delete executes; audit row `status === 'success'`, `diff_summary` contains the 16-char hex hash of the message.
- Step 6: delete executes (friction bypassed by fabrication); audit row captures the fabricated hash — **this is the forensic artifact**.

## PD-003 — Broad CRM scrape blocked by session budget

File: `tests/integration/pd-003-broad-scrape.integration.test.ts`.

Steps:
1. Call `list-deals` with no filter (broad).
2. Observe the required broad-confirm string.
3. Call again with `confirm: "BROAD-READ:list-deals"`.
4. Loop `list-deals` with filters until `max_records_per_session` exceeded.
5. Call `list-deals` once more.

Expected:
- Step 1: `BROAD_READ_CONFIRMATION_REQUIRED`, audit row `category === 'broad_query'`.
- Step 3: proceeds; budget counters increment.
- Step 5: `SESSION_READ_BUDGET_RECORDS_EXCEEDED`. Audit row `category === 'read_budget'`.

## PD-004 — Audit rollback (documented residual)

File: `tests/integration/pd-004-audit-rollback.integration.test.ts`.

Steps:
1. Produce 5 audit rows via write tool calls.
2. Copy `audit.db` to `audit.db.old`.
3. Produce 5 more audit rows.
4. Stop server; replace `audit.db` with `audit.db.old`.
5. Start server.

Expected:
- `verifyChain()` **passes** on the old DB (this is the known limitation).
- This test asserts the limitation (not a defect) and is named explicitly so future contributors know the compensating control is the remote mirror (§16).

```typescript
it('documents local-only rollback cannot be detected without remote mirror', () => {
  // ...
  expect(verifier.verifyChain()).toEqual({ ok: true }); // this is the point
});
```

## PD-005 — Sync-root symlink refused

File: `tests/integration/pd-005-sync-root-symlink.integration.test.ts`.

Steps:
1. In tempdir, create `fakeOneDrive/` and `home/`.
2. Symlink `home/.bhg-pipedrive-mcp → fakeOneDrive/config`.
3. Start server with `HOME=home`.

Expected:
- Exit 1 within 5 seconds.
- Stderr contains "cloud-synced" / "OneDrive"-family message.
- No Keychain read attempted (mock Keychain records zero calls).

## PD-006 — URL token leak redacted

File: `tests/integration/pd-006-url-token-leak.integration.test.ts`.

Steps:
1. Configure mock Pipedrive to respond 500 with a body containing the literal URL `https://api.pipedrive.com/v1/deals?api_token=<TOKEN>`.
2. Call any read tool.
3. Capture stderr.

Expected:
- Stderr contains no 40-hex token value.
- Stderr contains `[REDACTED]` or `[REDACTED-40HEX]` where the token would be.
- Normalized error response does not include the token.

## PD-007 — Stale-token bypass audited

File: `tests/integration/pd-007-stale-token.integration.test.ts`.

Steps:
1. Populate Keychain with a token whose `issued_at_iso` is 150 days ago.
2. Start server (no env flags) → should refuse.
3. Start with `BHG_PIPEDRIVE_ALLOW_STALE=1` alone (no reason) → refuse.
4. Start with `BHG_PIPEDRIVE_ALLOW_STALE=1 BHG_PIPEDRIVE_STALE_REASON="scheduled rotation tomorrow"` → accept.

Expected:
- Steps 2, 3: exit 1.
- Step 4: server starts. Audit row `reason_code === 'STALE_TOKEN_EXCEPTION'` with the reason. `exceptions.log` entry.

## PD-008 — Bulk-write triggers BULK confirmation

File: `tests/integration/pd-008-bulk-write.integration.test.ts`.

Steps:
1. Call `update-deal` 11 times in a tight loop with distinct `id`s and no destructive fields.

Expected:
- Calls 1–10: succeed (one audit row each).
- Call 11: `CONFIRMATION_REQUIRED` with `required_confirmation === "BULK:11"`.
- Re-issuing call 11 with `confirm: "BULK:11"` succeeds.

## PD-009 — Keychain ACL reality check (ciphertext-only, with residual-risk note)

File: `tests/integration/pd-009-keychain-acl.integration.test.ts`.

Requires real Keychain — `describe.skip` on non-darwin.

**Framing:** this test asserts what the wrapper actually buys (ciphertext-only against passive single-entry exfiltration) and **documents** what it does not (same-user code execution can combine all three and decrypt). It does not claim cryptographic confidentiality against a local attacker.

Steps:
1. `storeToken('a'.repeat(40))`.
2. Spawn an **unrelated** Node one-liner against **only** the token entry:
   ```
   node -e "import('keytar').then(k => k.default.getPassword('bhg-pipedrive-mcp', process.env.USER).then(v => console.log(v)))"
   ```
3. Assert the output is the ciphertext Base64 blob — not the plaintext 40-hex token.
4. Try to decode the ciphertext without the KDF seed / salt and assert the AES-GCM auth step fails.
5. **Residual-risk assertion (documentation test, expected to pass):**
   - Spawn a second one-liner that reads **both** Keychain entries (`bhg-pipedrive-mcp` and `bhg-pipedrive-mcp-kdf`) **and** the salt file at `~/.bhg-pipedrive-mcp/salt.bin`.
   - Assert that decryption **succeeds** — this confirms the known residual risk and makes it impossible to silently regress into believing the wrapper is confidentiality against a local user.

Expected:
- Steps 2–4: ciphertext-only, decryption fails.
- Step 5: decryption succeeds. Test body contains an explicit comment pointing to spec §7.6 so future readers understand this is documentation, not a defect.

(Document both outcomes in `SECURITY_CHECKLIST.md` alongside the Task 5 probe from sec-03.)

## PD-010 — Dirty build blocked in CI

File: `tests/integration/pd-010-dirty-build.integration.test.ts`.

Steps:
1. Touch an uncommitted file in the repo.
2. Run `CI=true node scripts/embed-version.mjs`.

Expected:
- Exit code 1.
- Stderr message about dirty tree.
- With `BHG_ALLOW_DIRTY_BUILD=1 CI=true`: exits 0, but `VERSION_ID.dirty === true` in the generated file.

## TC-AUDIT-1 — Audit tamper suite

File: `tests/integration/tc-audit.integration.test.ts`.

Three sub-cases: modify a row, delete a row, truncate the table. Each ends with the next server start in safe-degraded mode (writes rejected 503, reads annotated with `_security_notice`).

## TC-POLICY-1 — Policy hash mismatch (startup vs runtime)

File: `tests/integration/tc-policy.integration.test.ts`.

**Two sub-cases** reflecting spec §12.2's distinction:

### TC-POLICY-1a — Startup mismatch → exit 1 (no server)

Steps:
1. Build normally.
2. Edit `capabilities.json` BEFORE starting the server.
3. Start the server.

Expected:
- Process exits **1** within a few seconds.
- No MCP stdio transport attached.
- Audit DB contains a row `reason_code === 'POLICY_HASH_MISMATCH_STARTUP'` with `category === 'policy'`, `status === 'failure'`.
- Stderr mentions "refusing to start."

### TC-POLICY-1b — Runtime mismatch → safe-degraded (no exit)

Steps:
1. Build normally; start server; confirm policy verifies.
2. Edit `capabilities.json` (raise `max_records_per_session`).
3. Wait 65 seconds.
4. Call a write tool.

Expected:
- After step 3: `safeDegraded === true`. Audit row `reason_code === 'POLICY_HASH_MISMATCH_RUNTIME'`.
- Step 4: rejected 503.
- Process is still running (key distinction from TC-POLICY-1a).

## TC-KILL-1 — Kill switch end-to-end

File: `tests/integration/tc-kill.integration.test.ts`.

Steps:
1. `npm run kill-switch -- --off --reason "test"`.
2. Start server.
3. Call `create-deal`.
4. Flip on: `npm run kill-switch -- --on --reason "test done"`.
5. Restart server; call `create-deal`.

Expected:
- Step 3: `WRITES_DISABLED` 503. Audit row.
- Step 5: succeeds.
- Kill-switch CLI invocations each produce one `KILL_SWITCH_FLIP` audit row.

## TC-PERM-1 — Loose permissions repaired or safe-degraded

File: `tests/integration/tc-perm.integration.test.ts`.

Steps:
1. Setup normally. Inspect `~/.bhg-pipedrive-mcp/salt.bin` (should be 0600).
2. `chmod 0644 salt.bin`.
3. Start server.
4. Inspect mode again.
5. Simulate un-repairable: make parent dir read-only before start.

Expected:
- Step 4: mode is 0600 (repair succeeded). Audit row `reason_code === 'PERMISSION_REPAIRED'`.
- Step 5: safe-degraded (writes rejected 503). Audit row `reason_code === 'PERMISSION_REPAIR_FAILED'`.

---

## Commit

```bash
git add tests/integration/_harness.ts tests/integration/pd-*.integration.test.ts tests/integration/tc-*.integration.test.ts
git commit -m "test(security): adversarial PD-001..PD-010 + TC-AUDIT/POLICY/KILL/PERM integration tests"
```

---

**Done when:** all 14 tests run under `npm run test:integration`; each maps 1:1 to a row in spec §18; assertions are specific enough that silently weakening the corresponding control (e.g., switching typed confirmation back to `confirm: true`) breaks a test. PD-004's "expected: rollback undetected" is explicitly named as residual-risk documentation, not a defect.
