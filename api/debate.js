// One claim per request, non-streaming. Returns { raw: <full LLM response> }.
//
// PERMANENT — do not delete in any future cleanup. /api/debate-stream
// (the streaming companion) is preferred for MSE-capable clients but
// this endpoint is the iOS Safari path (no MediaSource support) and is
// also the cache write source for entries shared with the streaming
// endpoint via getCachedLlm. Removing it would break iOS playback.
import { formatHistory, AGENT_CONFIG, checkOrigin, validateTopic, validateHistory, checkRateLimit, markDebateStart, getIp, VALID_AGENT_IDS, normalizeMode } from './_shared.js'
import { MODES, buildSystemPrompt, buildUserMessage } from './_prompts.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!checkOrigin(req, res)) return

  const ip = getIp(req)
  const round = Number(req.body.round)
  const { agent, history } = req.body
  // Cooldown gates "starting a new debate" — only the first call of a run (round 1, advocate) counts.
  // Other round-1 sub-calls share that debate and must not trip the lock.
  const isNewDebate = Number.isInteger(round) && round === 1 && agent === 'advocate'

  const rateLimit = await checkRateLimit(ip, isNewDebate)
  if (rateLimit) {
    if (rateLimit.retryAfter) res.setHeader('Retry-After', String(rateLimit.retryAfter))
    return res.status(429).json({ error: rateLimit.message, code: rateLimit.code, retryAfter: rateLimit.retryAfter })
  }

  const topic = req.body.topic
  if (!validateTopic(topic, res)) return
  const mode = normalizeMode(req.body.mode)
  const cfg = MODES[mode]

  if (!VALID_AGENT_IDS.has(agent)) return res.status(400).json({ error: 'Invalid agent' })
  if (!Number.isInteger(round) || round < 1 || round > cfg.maxRounds) return res.status(400).json({ error: 'Invalid round' })
  if (!validateHistory(history, round, agent, res)) return

  try {
    const systemPrompt = buildSystemPrompt(agent, mode)
    const userMessage  = buildUserMessage(topic, round, agent, formatHistory(history))
    const raw = await AGENT_CONFIG[agent].caller(systemPrompt, userMessage, cfg.maxTokens)
    // Upstream returned 200 — only now lock in the per-IP cooldown so
    // a failed admission (404/auth-fail) doesn't lock the user out.
    if (isNewDebate) markDebateStart(ip).catch(() => {})
    res.status(200).json({ raw })
  } catch (err) {
    console.error(`[debate] ${agent} error:`, err.message)
    res.status(502).json({ error: 'Service temporarily unavailable' })
  }
}
