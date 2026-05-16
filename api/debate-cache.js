// Debate-text cache: GET checks for a cached debate, POST writes one.
// Cache key is built from (topic, mode, LLM models, token caps) so any
// env-var change naturally invalidates. Audio is cached separately by
// /api/tts; this layer only handles the LLM-generated text.
//
// POST validation reuses validateTopic + validateHistory so an attacker
// can't poison the cache with arbitrarily-shaped content for 24h. Without
// these, anyone (origin headers are forgeable from non-browser clients)
// could write fabricated claims keyed to a popular topic.

import {
  checkOrigin,
  debateCacheKey,
  getCachedDebate,
  setCachedDebate,
  normalizeMode,
  validateTopic
} from './_shared.js'

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return

  if (req.method === 'GET') {
    const topic = req.query?.topic
    if (!validateTopic(topic, res)) return
    const key = debateCacheKey(topic, normalizeMode(req.query?.mode))
    const cached = await getCachedDebate(key)
    if (!cached) return res.status(404).json({ cached: false })
    return res.status(200).json({ cached: true, debate: cached })
  }

  if (req.method === 'POST') {
    const { topic, mode, claims, verdict } = req.body || {}
    if (!validateTopic(topic, res)) return
    if (!Array.isArray(claims) || claims.length === 0 || claims.length > 12) {
      return res.status(400).json({ error: 'Invalid claims' })
    }
    if (!claims.every(isValidClaim)) {
      return res.status(400).json({ error: 'Invalid claim shape' })
    }
    if (verdict && !isValidVerdict(verdict)) {
      return res.status(400).json({ error: 'Invalid verdict shape' })
    }
    const key = debateCacheKey(topic, normalizeMode(mode))
    await setCachedDebate(key, { claims, verdict: verdict || null })
    return res.status(200).json({ stored: true })
  }

  return res.status(405).json({ error: 'GET or POST only' })
}

const CLAIM_ID_RE = /^[a-z]{3}_r\d{1,2}_\d{1,2}$/
const AGENTS = new Set(['advocate', 'critic', 'wildcard'])

function isValidClaim(c) {
  return c &&
    typeof c.id === 'string' && CLAIM_ID_RE.test(c.id) &&
    AGENTS.has(c.agentId) &&
    typeof c.round === 'number' && c.round >= 1 && c.round <= 3 &&
    typeof c.text === 'string' && c.text.length > 0 && c.text.length <= 2000
}

function isValidVerdict(v) {
  return v &&
    Array.isArray(v.winningArguments) &&
    v.winningArguments.every(s => typeof s === 'string' && s.length <= 1000) &&
    (v.loserGap === undefined || typeof v.loserGap === 'string')
}
