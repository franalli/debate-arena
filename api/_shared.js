// Shared utilities for serverless API handlers.
// Prefixed with _ so Vercel does not expose this as an endpoint.

import { Redis } from '@upstash/redis'
import { createHash } from 'node:crypto'

export const CLAIM_ID_RE = /^[a-z]{3}_r\d{1,2}_\d{1,2}$/

export const AGENT_NAME = { advocate: 'Advocate', critic: 'Critic', wildcard: 'Wildcard' }

const MAX_TOPIC_LENGTH = 500
const MAX_CLAIM_TEXT_LENGTH = 2000

// ── Origin check ──────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://debate-arena-ten.vercel.app',
  'http://localhost:3000',   // vercel dev default
  'http://localhost:3002',   // vercel dev alt
  'http://localhost:5173'    // vite dev (standalone)
]

export function checkOrigin(req, res) {
  const origin = req.headers['origin'] || ''
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}

// ── Input validation ──────────────────────────────────────────
export function validateTopic(topic, res) {
  if (!topic || typeof topic !== 'string') {
    res.status(400).json({ error: 'Topic required' })
    return false
  }
  if (topic.length < 3) {
    res.status(400).json({ error: 'Topic too short' })
    return false
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    res.status(400).json({ error: `Topic too long (max ${MAX_TOPIC_LENGTH} characters)` })
    return false
  }
  return true
}

export const VALID_AGENT_IDS = new Set(['advocate', 'critic', 'wildcard'])
const AGENT_ORDER = ['advocate', 'critic', 'wildcard']

export function validateHistory(history, round, agent, res) {
  if (!Array.isArray(history)) {
    // Accept missing/null history for the first call
    if (round === 1 && agent === 'advocate') return true
    res.status(400).json({ error: 'Invalid history' })
    return false
  }

  // Expected claim count: for round R, agent at index A → (R-1)*3 + A
  const agentIndex = AGENT_ORDER.indexOf(agent)
  const expectedMax = (round - 1) * 3 + agentIndex
  if (history.length > expectedMax) {
    res.status(400).json({ error: 'Invalid history' })
    return false
  }

  // Validate each claim in history
  for (const claim of history) {
    if (typeof claim.id !== 'string' || !CLAIM_ID_RE.test(claim.id)) {
      res.status(400).json({ error: 'Invalid history' })
      return false
    }
    if (!VALID_AGENT_IDS.has(claim.agentId)) {
      res.status(400).json({ error: 'Invalid history' })
      return false
    }
    if (typeof claim.text !== 'string' || claim.text.length > MAX_CLAIM_TEXT_LENGTH) {
      res.status(400).json({ error: 'Invalid history' })
      return false
    }
  }

  return true
}

// ── Rate limiting (KV-backed; shared across serverless instances) ────────────
const RATE_LIMIT_IP_DAILY       = Number(process.env.RATE_LIMIT_IP_DAILY)       || 30
const RATE_LIMIT_GLOBAL_DAILY   = Number(process.env.RATE_LIMIT_GLOBAL_DAILY)   || 300
const DEBATE_COOLDOWN_MS        = Number(process.env.DEBATE_COOLDOWN_MS)        || 60_000
const TTS_CHARS_IP_DAILY        = Number(process.env.TTS_CHARS_IP_DAILY)        || 20_000
const TTS_CHARS_GLOBAL_DAILY    = Number(process.env.TTS_CHARS_GLOBAL_DAILY)    || 200_000
const TTS_MAX_CHARS_PER_REQUEST = Number(process.env.TTS_MAX_CHARS_PER_REQUEST) || 1_000
const TTS_CACHE_TTL_SECONDS     = Number(process.env.TTS_CACHE_TTL_SECONDS)     || 604_800

const DAY_PLUS_BUFFER_SECONDS = 90_000  // 25h — daily keys auto-expire after the day rolls over

let _redis = null
function getRedis() {
  if (_redis) return _redis
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token) {
    console.warn('[ratelimit] KV env vars missing; rate limiting disabled')
    return null
  }
  _redis = new Redis({ url, token })
  return _redis
}

function isoDate() {
  return new Date().toISOString().slice(0, 10)
}

export function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
}

function secondsUntilUtcMidnight() {
  const now = new Date()
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

// Returns null on success, or { code, message, retryAfter } on rate-limit hit.
// code ∈ { 'cooldown', 'ip_daily', 'global_daily' } so the UI can render a typed label.
export async function checkRateLimit(ip, isNewDebate) {
  const redis = getRedis()
  if (!redis) return null  // fail open: provider-side spend caps are the last line of defense

  const day = isoDate()
  const ipKey = `rl:ip:${day}:${ip}`
  const globalKey = `rl:global:${day}`

  try {
    if (isNewDebate) {
      const cdKey = `rl:cd:${ip}`
      const cooldownSeconds = Math.ceil(DEBATE_COOLDOWN_MS / 1000)
      const acquired = await redis.set(cdKey, '1', { nx: true, ex: cooldownSeconds })
      if (acquired === null) {
        const ttl = await redis.ttl(cdKey)
        const wait = ttl > 0 ? ttl : cooldownSeconds
        return {
          code: 'cooldown',
          message: `Wait ${wait}s before starting a new debate (one debate per minute).`,
          retryAfter: wait
        }
      }
    }

    const results = await redis.pipeline()
      .incr(ipKey)
      .expire(ipKey, DAY_PLUS_BUFFER_SECONDS)
      .incr(globalKey)
      .expire(globalKey, DAY_PLUS_BUFFER_SECONDS)
      .exec()
    const ipCount = results[0]
    const globalCount = results[2]

    if (globalCount > RATE_LIMIT_GLOBAL_DAILY) {
      return {
        code: 'global_daily',
        message: 'Site-wide daily limit reached — service is over capacity. Try again tomorrow.',
        retryAfter: secondsUntilUtcMidnight()
      }
    }
    if (ipCount > RATE_LIMIT_IP_DAILY) {
      return {
        code: 'ip_daily',
        message: "You've used today's debate quota. Try again tomorrow.",
        retryAfter: secondsUntilUtcMidnight()
      }
    }
    return null
  } catch (err) {
    console.error('[ratelimit] KV error:', err.message)
    return null
  }
}

// ── TTS char budget (for /api/tts when added) ────────────────────────────────
export async function checkCharBudget(ip, chars) {
  if (!Number.isInteger(chars) || chars <= 0) return 'Invalid request size.'
  if (chars > TTS_MAX_CHARS_PER_REQUEST) {
    return `Text too long (max ${TTS_MAX_CHARS_PER_REQUEST} chars per request).`
  }

  const redis = getRedis()
  if (!redis) return null

  const day = isoDate()
  const ipKey = `tts:chars:ip:${day}:${ip}`
  const globalKey = `tts:chars:global:${day}`

  try {
    const results = await redis.pipeline()
      .incrby(ipKey, chars)
      .expire(ipKey, DAY_PLUS_BUFFER_SECONDS)
      .incrby(globalKey, chars)
      .expire(globalKey, DAY_PLUS_BUFFER_SECONDS)
      .exec()
    const ipChars = results[0]
    const globalChars = results[2]

    if (globalChars > TTS_CHARS_GLOBAL_DAILY) return 'Daily TTS budget reached. Back tomorrow.'
    if (ipChars > TTS_CHARS_IP_DAILY) return "You've reached today's TTS limit."
    return null
  } catch (err) {
    console.error('[tts-budget] KV error:', err.message)
    return null
  }
}

// ── TTS cache (content-addressed by model + voice + text) ────────────────────
export function ttsCacheKey(text, model, voice) {
  const hash = createHash('sha256').update(`${model}|${voice}|${text}`).digest('hex')
  return `tts:cache:${hash}`
}

export async function getCachedTts(key) {
  const redis = getRedis()
  if (!redis) return null
  try {
    return await redis.get(key)
  } catch (err) {
    console.error('[tts-cache] get error:', err.message)
    return null
  }
}

export async function setCachedTts(key, audioBase64) {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.set(key, audioBase64, { ex: TTS_CACHE_TTL_SECONDS })
  } catch (err) {
    console.error('[tts-cache] set error:', err.message)
  }
}

// ── History formatting ────────────────────────────────────────
export function formatHistory(claims) {
  if (!Array.isArray(claims) || claims.length === 0)
    return 'No claims have been made yet. You are first to speak.'
  return claims.map(c => {
    const agentId = VALID_AGENT_IDS.has(c.agentId) ? c.agentId : 'unknown'
    const name = AGENT_NAME[agentId] || 'Unknown'
    const id = typeof c.id === 'string' && CLAIM_ID_RE.test(c.id) ? c.id : 'unknown'
    const text = String(c.text || '').slice(0, MAX_CLAIM_TEXT_LENGTH)
    const rebuttal = typeof c.rebuts === 'string' && CLAIM_ID_RE.test(c.rebuts) ? ` [rebuts ${c.rebuts}]` : ''
    return `[${id}] ${name}: ${text}${rebuttal}`
  }).join('\n')
}

export async function callAnthropic(systemPrompt, userMessage, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: maxTokens || 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  })
  if (!res.ok) {
    console.error(`[llm] Anthropic error: ${res.status}`)
    throw new Error('AI service temporarily unavailable')
  }
  const data = await res.json()
  const text = data.content?.[0]?.text
  if (!text) throw new Error('AI service returned empty response')
  return text
}

export async function callOpenAI(systemPrompt, userMessage, maxTokens) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_completion_tokens: maxTokens || 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  })
  if (!res.ok) {
    console.error(`[llm] OpenAI error: ${res.status}`)
    throw new Error('AI service temporarily unavailable')
  }
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('AI service returned empty response')
  return text
}

export async function callGoogle(systemPrompt, userMessage, maxTokens) {
  const model = process.env.GOOGLE_MODEL || 'gemini-3.1-pro-preview'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: {
        maxOutputTokens: maxTokens || 500,
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  })
  if (!res.ok) {
    console.error(`[llm] Google error: ${res.status}`)
    throw new Error('AI service temporarily unavailable')
  }
  const data = await res.json()
  const parts = data.candidates?.[0]?.content?.parts || []
  const text = parts.filter(p => !p.thought).map(p => p.text).join('')
  if (!text) throw new Error('AI service returned empty response')
  return text
}
