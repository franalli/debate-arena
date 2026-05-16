// One-shot wipe of the debate + LLM + TTS cache namespaces in Upstash.
// Rate-limit keys (rl:*, tts:chars:*) are left alone so daily quotas and
// cooldowns survive the wipe. Run after deploys that change cache key
// shape (e.g., BEHAVIOR_HASH or voice_settings folded into the key) so
// stale unreachable entries don't sit in Redis until TTL expiry.
//
// Usage:
//   node scripts/wipe-cache.js              # delete matching keys
//   node scripts/wipe-cache.js --dry-run    # list what would be deleted

import { redis, scanAll, CACHE_PATTERNS } from './_redis.js'

const dryRun = process.argv.includes('--dry-run')

let grandTotal = 0
for (const pattern of CACHE_PATTERNS) {
  console.log(`\nScanning ${pattern}`)
  const keys = await scanAll(pattern)
  console.log(`  ${keys.length} key${keys.length === 1 ? '' : 's'} found`)
  if (keys.length === 0) continue

  if (dryRun) {
    for (const k of keys.slice(0, 5)) console.log(`    ${k}`)
    if (keys.length > 5) console.log(`    … and ${keys.length - 5} more`)
    grandTotal += keys.length
    continue
  }

  // Upstash REST has a request size cap; batch DELs of 100 stay well under it
  let deleted = 0
  for (let i = 0; i < keys.length; i += 100) {
    deleted += await redis.del(...keys.slice(i, i + 100))
  }
  console.log(`  Deleted ${deleted}`)
  grandTotal += deleted
}

console.log(`\n${dryRun ? 'Would delete' : 'Deleted'} ${grandTotal} cache key${grandTotal === 1 ? '' : 's'} total.`)
