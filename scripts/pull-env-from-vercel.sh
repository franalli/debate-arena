#!/usr/bin/env bash
# Pull env vars from the linked Vercel project's Development environment
# into .env.local, stripping VERCEL_* system-reserved vars that Vercel
# injects automatically at runtime (and rejects on manual set — they
# only clutter the file and confuse re-sync).
#
# Usage:
#   ./scripts/pull-env-from-vercel.sh                  # default: development
#   ./scripts/pull-env-from-vercel.sh production       # pull production env
#   ./scripts/pull-env-from-vercel.sh preview          # pull preview env
#
# Effects:
#   - Backs up existing .env.local to .env.local.bak.<timestamp> (gitignored
#     via the .env*.bak* rule).
#   - Overwrites .env.local with the filtered values from Vercel.
#   - Prints the variables now present (names only, no values).

set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-development}"

case "$TARGET" in
  development|preview|production) ;;
  *) echo "error: invalid target '$TARGET' (use development | preview | production)" >&2; exit 1 ;;
esac

if ! command -v vercel >/dev/null 2>&1; then
  echo "error: vercel CLI not found (npm i -g vercel)" >&2
  exit 1
fi

if [ ! -f .vercel/project.json ]; then
  echo "error: project not linked. Run: vercel link" >&2
  exit 1
fi

TMPFILE=$(mktemp)
chmod 600 "$TMPFILE"
trap 'rm -f "$TMPFILE"' EXIT

echo "→ pulling $TARGET env from Vercel"
vercel env pull "$TMPFILE" --environment="$TARGET" --yes >/dev/null

if [ -f .env.local ]; then
  BACKUP=".env.local.bak.$(date +%s)"
  cp .env.local "$BACKUP"
  echo "→ backed up existing .env.local to $BACKUP"
fi

SKIPPED=$(grep -c "^VERCEL_" "$TMPFILE" || true)
grep -v "^VERCEL_" "$TMPFILE" > .env.local
chmod 600 .env.local

KEPT=$(grep -cE "^[A-Z][A-Z0-9_]*=" .env.local || true)
echo "→ wrote .env.local ($KEPT app vars; $SKIPPED VERCEL_* lines stripped)"
echo ""
echo "Variables in new .env.local (names only):"
grep -E "^[A-Z][A-Z0-9_]*=" .env.local | cut -d= -f1 | sort | sed 's/^/  /'

echo ""
echo "Done. Restart vercel dev to pick up changes:"
echo "  Ctrl+C in the vercel dev terminal, then: vercel dev"
