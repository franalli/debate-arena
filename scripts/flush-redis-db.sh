#!/usr/bin/env bash
# FLUSHDB-equivalent — removes every key in the Upstash Redis DB used
# by this project. Wider than wipe-cache.js — also wipes rate-limit
# counters, cooldown locks, and TTS char budgets. Use when you want a
# fully clean slate (post-incident, dev reset, load test).
#
# Calls the Upstash REST API directly. No Node required — only curl
# and python3 (for tiny JSON unwrap; both ship with macOS / Linux).
#
# Usage:
#   ./scripts/flush-redis-db.sh --dry-run   # report dbsize, no delete
#   ./scripts/flush-redis-db.sh --yes       # actually flush
#
# Refuses to run without an explicit flag so a bare invocation can't
# wipe production state by accident.

set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=false
CONFIRMED=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes)     CONFIRMED=true ;;
    -h|--help)
      echo "Usage: $0 --dry-run | --yes"
      exit 0
      ;;
    *)
      echo "error: unknown flag '$arg' (use --dry-run or --yes)" >&2
      exit 1
      ;;
  esac
done

if [ "$DRY_RUN" = false ] && [ "$CONFIRMED" = false ]; then
  echo "Refusing to flush without explicit --yes flag." >&2
  echo "" >&2
  echo "Usage:" >&2
  echo "  $0 --dry-run   # report dbsize, no delete" >&2
  echo "  $0 --yes       # actually flush" >&2
  exit 1
fi

# Pull KV creds from .env.local without sourcing the file (avoids
# accidentally executing shell metacharacters in arbitrary env values).
extract() {
  grep "^$1=" .env.local 2>/dev/null | tail -1 \
    | cut -d= -f2- \
    | tr -d '"' | tr -d "'" | tr -d '[:space:]'
}

URL=$(extract KV_REST_API_URL)
TOKEN=$(extract KV_REST_API_TOKEN)

if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
  echo "error: KV_REST_API_URL and KV_REST_API_TOKEN must be set in .env.local" >&2
  exit 1
fi

# Upstash REST: each command is GET (or POST) to $URL/<command>[/args].
# Auth is a bearer token. Response is { "result": ... }.
unwrap_result() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])'
}

if [ "$DRY_RUN" = true ]; then
  size=$(curl -sS -H "Authorization: Bearer $TOKEN" "$URL/dbsize" | unwrap_result)
  echo "Database has $size key(s)."
  echo "(dry-run — no flush)"
  exit 0
fi

result=$(curl -sS -H "Authorization: Bearer $TOKEN" "$URL/flushdb" | unwrap_result)
echo "FLUSHDB → $result"
echo ""
echo "Done. Note: rate-limit counters, cooldown locks, and TTS char budgets"
echo "were also wiped. First requests after this bypass quota protection"
echo "until counters re-populate on their own."
