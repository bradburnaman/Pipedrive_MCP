#!/usr/bin/env bash
set -euo pipefail

# 1. No .env files tracked
if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$'; then
  echo "ERROR: .env file(s) tracked in git"
  exit 1
fi

# 2. No curl-piped-to-shell install patterns in scripts/package.json/installers
# Excludes this script itself (its comments describe the very pattern it forbids).
if grep -rE '(curl|wget)[^|]*\|\s*(ba)?sh' . \
    --include='*.sh' --include='package.json' --include='Dockerfile*' \
    --exclude='check-forbidden-patterns.sh' \
    --exclude-dir=node_modules --exclude-dir=dist; then
  echo "ERROR: curl-piped-to-shell install pattern detected"
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
