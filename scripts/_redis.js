// Shared Upstash Redis access for one-shot maintenance scripts.
// Loads .env.local (or process env), constructs the client, and exposes
// a paginated SCAN helper. Prefixed with _ to keep it out of any future
// "scripts/*" auto-discovery.

import { Redis } from '@upstash/redis'
import { readFileSync } from 'node:fs'

try {
  const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
} catch { /* fine if .env.local missing — fall back to process env */ }

const url = process.env.KV_REST_API_URL
const token = process.env.KV_REST_API_TOKEN
if (!url || !token) {
  console.error('Missing KV_REST_API_URL / KV_REST_API_TOKEN in env')
  process.exit(1)
}

export const redis = new Redis({ url, token })

export async function scanAll(pattern) {
  const keys = []
  let cursor = 0
  do {
    const [next, batch] = await redis.scan(cursor, { match: pattern, count: 200 })
    cursor = Number(next)
    keys.push(...batch)
  } while (cursor !== 0)
  return keys
}

// Single source of truth for the cache namespaces both scripts touch.
// Rate-limit and char-budget counters (`rl:*`, `tts:chars:*`) stay out.
export const CACHE_PATTERNS = ['debate:cache:*', 'llm:cache:*', 'tts:cache:*']
