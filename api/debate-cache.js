// Debate-text cache: GET checks for a cached debate, POST writes one.
// Cache key is built from (topic, mode, LLM models, token caps) so any
// env-var change naturally invalidates. Audio is cached separately by
// /api/tts; this layer only handles the LLM-generated text.

import { checkOrigin, debateCacheKey, getCachedDebate, setCachedDebate } from './_shared.js'

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return

  if (req.method === 'GET') {
    const { topic, mode } = req.query || {}
    if (typeof topic !== 'string' || !topic) {
      return res.status(400).json({ error: 'Topic required' })
    }
    const normalizedMode = mode === 'deep' ? 'deep' : 'fast'
    const key = debateCacheKey(topic, normalizedMode)
    const cached = await getCachedDebate(key)
    if (!cached) return res.status(404).json({ cached: false })
    return res.status(200).json({ cached: true, debate: cached })
  }

  if (req.method === 'POST') {
    const { topic, mode, claims, verdict } = req.body || {}
    if (typeof topic !== 'string' || !topic) {
      return res.status(400).json({ error: 'Topic required' })
    }
    if (!Array.isArray(claims) || claims.length === 0) {
      return res.status(400).json({ error: 'Claims required' })
    }
    const normalizedMode = mode === 'deep' ? 'deep' : 'fast'
    const key = debateCacheKey(topic, normalizedMode)
    await setCachedDebate(key, { claims, verdict: verdict || null })
    return res.status(200).json({ stored: true })
  }

  return res.status(405).json({ error: 'GET or POST only' })
}
