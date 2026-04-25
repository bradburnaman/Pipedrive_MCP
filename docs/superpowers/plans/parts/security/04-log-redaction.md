# Part sec-04: Log Redaction & Token Sanitization

> Part 4 of 9.
> **Depends on:** sec-01.
> **Produces:** `src/lib/sanitize-log.ts`, Pino `redact` config in `src/index.ts`, token-pattern sanitization in `error-normalizer.ts`, ESLint rule (or grep-based CI check) for forbidden log patterns.

Implements spec §9. Defense-in-depth: even though no current code path logs the token, this part adds the redaction filter so any future regression is caught.

---

## Task 1: `redactUrl` helper + tests

`src/lib/sanitize-log.ts`:

```typescript
const API_TOKEN_QUERY_RE = /([?&])api_token=[^&#]+/gi;

export function redactUrl(input: string | URL): string {
  const s = typeof input === 'string' ? input : input.toString();
  return s.replace(API_TOKEN_QUERY_RE, '$1api_token=[REDACTED]');
}

// Pipedrive tokens are 40 lowercase hex characters. This regex strips accidental
// inclusions from arbitrary error/log strings.
const PIPEDRIVE_TOKEN_RE = /\b[a-f0-9]{40}\b/g;

export function stripTokenPattern(input: string): string {
  return input.replace(PIPEDRIVE_TOKEN_RE, '[REDACTED-40HEX]');
}
```

`tests/lib/sanitize-log.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { redactUrl, stripTokenPattern } from '../../src/lib/sanitize-log.js';

describe('redactUrl', () => {
  it('redacts api_token in query string', () => {
    expect(redactUrl('https://api.pipedrive.com/v1/deals?api_token=abcdef1234'))
      .toBe('https://api.pipedrive.com/v1/deals?api_token=[REDACTED]');
  });
  it('redacts api_token regardless of position', () => {
    expect(redactUrl('https://x/y?a=1&api_token=foo&b=2'))
      .toBe('https://x/y?a=1&api_token=[REDACTED]&b=2');
  });
  it('leaves URLs without api_token unchanged', () => {
    expect(redactUrl('https://x/y?a=1')).toBe('https://x/y?a=1');
  });
});

describe('stripTokenPattern', () => {
  it('strips 40-char hex tokens', () => {
    const t = 'a'.repeat(40);
    expect(stripTokenPattern(`error at ${t} boom`)).toContain('[REDACTED-40HEX]');
  });
  it('does not strip shorter hex strings', () => {
    expect(stripTokenPattern('abc123')).toBe('abc123');
  });
});
```

- [ ] Implement and test.

## Task 2: Pino `redact` configuration

Edit `src/index.ts` — replace the current `pino(...)` call:

```typescript
const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: [
        'apiToken',
        'api_token',
        'token',
        'config.apiToken',
        'req.url',
        'url',
        'headers.authorization',
        'headers.Authorization',
        'req.headers.authorization',
        'err.config.url',
        '*.apiToken',
        '*.api_token',
      ],
      remove: true,
    },
  },
  pino.destination(2)
);
```

- [ ] Update.
- [ ] Verify: run a small probe in dev that calls `logger.info({ apiToken: 'SHOULD_NOT_APPEAR' })` and `logger.error({ url: '…?api_token=X' })`. Confirm neither value appears in stderr. Remove the probe.

## Task 3: Harden `error-normalizer.ts`

Edit `src/lib/error-normalizer.ts` — on every outgoing `message` or `details` string, pass through `stripTokenPattern` before returning. For example:

```typescript
import { stripTokenPattern } from './sanitize-log.js';

// In the normalization function:
return {
  error: true,
  code,
  message: stripTokenPattern(message),
  ...(details && { details: sanitizeDetails(details) }),
};

function sanitizeDetails(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'string') out[k] = stripTokenPattern(v);
    else if (typeof v === 'object' && v !== null) out[k] = sanitizeDetails(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
```

- [ ] Add.
- [ ] Extend `tests/lib/error-normalizer.test.ts` with a case that crafts an error whose message embeds a 40-hex token; assert the normalized output does not contain the token.

## Task 4: Forbidden-patterns CI check

Extend `scripts/check-forbidden-patterns.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. No .env files tracked
if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$'; then
  echo "ERROR: .env file(s) tracked in git"
  exit 1
fi

# 2. No curl | bash patterns in scripts/package.json/installers
if grep -rE '(curl|wget)[^|]*\|\s*(ba)?sh' . \
    --include='*.sh' --include='package.json' --include='Dockerfile*' \
    --exclude-dir=node_modules --exclude-dir=dist; then
  echo "ERROR: curl|bash install pattern detected"
  exit 1
fi

# 3. No naive logging of apiToken / api_token without redaction
# Very loose check — catches obvious mistakes, not clever ones.
if grep -rnE '(console\.(log|info|error|warn)|logger\.(info|warn|error|debug|fatal))\([^)]*\b(api_?[Tt]oken|apiToken)\b' src/ tests/ \
    --include='*.ts' --include='*.js'; then
  echo "ERROR: possible token being logged without redaction"
  exit 1
fi

# 4. No PIPEDRIVE_API_TOKEN in sample JSON configs committed under the repo
# (e.g., sample Claude Desktop configs in README or examples/).
if grep -rnE '"PIPEDRIVE_API_TOKEN"\s*:' . \
    --include='*.json' --include='*.md' \
    --exclude-dir=node_modules --exclude-dir=dist \
  | grep -v 'SECURITY_CHECKLIST\|your_token_here\|\[REDACTED\]\|override'; then
  echo "ERROR: sample config contains PIPEDRIVE_API_TOKEN outside documented override contexts"
  exit 1
fi

echo "Forbidden-patterns check passed."
```

- [ ] Replace the stub script.
- [ ] Run it locally: `bash scripts/check-forbidden-patterns.sh`. Should pass.

## Task 5: Commit

```bash
git add src/lib/sanitize-log.ts src/lib/error-normalizer.ts src/index.ts \
        tests/lib/sanitize-log.test.ts tests/lib/error-normalizer.test.ts \
        scripts/check-forbidden-patterns.sh
git commit -m "feat(security): log redaction, token-pattern sanitization, forbidden-patterns CI check"
```

---

**Done when:** tests pass; a probe confirms the token is never emitted under common logger shapes; `check-forbidden-patterns.sh` is part of the `security:check` script and passes on current main.
