#!/usr/bin/env bash
# Sync every KEY=VALUE in .env.local to Vercel for the `development`
# and `production` environments. Idempotent: existing values are
# removed first so the new value wins.
#
# Usage:
#   ./scripts/sync-env-to-vercel.sh                 # both envs
#   ./scripts/sync-env-to-vercel.sh development     # one env
#   ./scripts/sync-env-to-vercel.sh production
#
# Requirements: Vercel CLI logged in (`vercel whoami`) and the project
# linked (`.vercel/project.json` present — run `vercel link` once if not).
#
# Values are passed via a chmod-600 tempfile so they never appear in
# shell history or in the script's stdout.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.local"
TARGETS=("${@:-development production}")

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "error: vercel CLI not found (npm i -g vercel)" >&2
  exit 1
fi

if [ ! -f .vercel/project.json ]; then
  echo "error: project not linked. Run: vercel link" >&2
  exit 1
fi

TMPVAL=$(mktemp)
chmod 600 "$TMPVAL"
trap 'rm -f "$TMPVAL"' EXIT

# Strip comments + blank lines, keep only KEY=VALUE (allow leading
# `export `). Use a streaming parser to handle quotes safely.
while IFS= read -r raw_line; do
  # skip comments + blanks
  case "$raw_line" in
    ''|\#*) continue ;;
  esac

  # strip leading `export `
  line="${raw_line#export }"

  # must look like KEY=VALUE
  case "$line" in
    [A-Za-z_]*=*) ;;
    *) continue ;;
  esac

  key="${line%%=*}"
  value="${line#*=}"

  # VERCEL_* are system-reserved (auto-injected by Vercel at runtime).
  # Vercel rejects manual sets with a 4xx, so skip them silently rather
  # than burning two API calls per var just to log failures. The
  # pull-env-from-vercel.sh script strips them too — symmetric pair.
  case "$key" in
    VERCEL_*) continue ;;
  esac

  # strip surrounding single or double quotes
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac

  # write to tempfile (no trailing newline, since `vercel env add` reads stdin verbatim)
  printf '%s' "$value" > "$TMPVAL"

  for target in "${TARGETS[@]}"; do
    echo "→ $key ($target)"

    # Remove any existing entry (suppress noise; --yes accepts the prompt).
    vercel env rm "$key" "$target" --yes >/dev/null 2>&1 || true

    # Add fresh value from tempfile.
    if ! vercel env add "$key" "$target" < "$TMPVAL" >/dev/null 2>&1; then
      echo "  ✗ failed to add $key for $target" >&2
    fi
  done
done < "$ENV_FILE"

echo ""
echo "Done. Verify with:"
echo "  vercel env ls"
echo ""
echo "Note: redeploy to pick up new values in already-deployed envs:"
echo "  vercel --prod         # production"
echo "  vercel                # preview"
