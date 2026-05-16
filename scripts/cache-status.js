// Read-only inspection of the debate + LLM + TTS cache in Upstash.
// Use to confirm whether a run actually populated the cache before
// concluding "caching isn't working." For each entry, prints a
// namespace-specific summary (claim count for debates, char count + a
// snippet for LLM, byte count for TTS).
//
// Usage: node scripts/cache-status.js

import { redis, scanAll } from './_redis.js'

async function summarize(pattern, formatRow, previewLimit = 20) {
  console.log(`\n── ${pattern} ──`)
  const keys = await scanAll(pattern)
  console.log(`  ${keys.length} entr${keys.length === 1 ? 'y' : 'ies'}`)
  const preview = keys.slice(0, previewLimit)
  // Parallel GETs — one round-trip per key, fired together. ~50x faster
  // than awaiting each sequentially on a typical full cache.
  const values = await Promise.all(preview.map((k) => redis.get(k)))
  for (let i = 0; i < preview.length; i++) {
    console.log(`    ${preview[i].slice(0, 30)}…  ${formatRow(values[i])}`)
  }
  if (keys.length > previewLimit) console.log(`    … and ${keys.length - previewLimit} more`)
}

await summarize('debate:cache:*', (v) => {
  const claims = Array.isArray(v?.claims) ? v.claims.length : '?'
  return `claims=${claims}  ${v?.verdict ? 'verdict✓' : 'verdict✗'}`
}, 10)

await summarize('llm:cache:*', (v) => {
  const text = typeof v?.text === 'string' ? v.text : (typeof v === 'string' ? v : '')
  const preview = text.replace(/\s+/g, ' ').slice(0, 60)
  return `${text.length} chars  "${preview}${text.length > 60 ? '…' : ''}"`
})

await summarize('tts:cache:*', (v) => {
  const bytes = typeof v?.body === 'string' ? v.body.length : (typeof v === 'string' ? v.length : 0)
  return `${bytes.toLocaleString()} bytes`
})

console.log()
