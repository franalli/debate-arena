// Shared utilities for serverless API handlers.
// Prefixed with _ so Vercel does not expose this as an endpoint.

import { Redis } from '@upstash/redis'
import { createHash } from 'node:crypto'
import { BEHAVIOR_HASH, LLM_SETTINGS } from './_prompts.js'

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
// TTL is a storage backstop, not the invalidation mechanism. Both cache
// keys are content-addressed (BEHAVIOR_HASH for debates, voice settings
// for TTS) so any input change naturally produces a new key. 30d gives
// Upstash a slow GC floor without serving stale content for that long.
const TTS_CACHE_TTL_SECONDS     = Number(process.env.TTS_CACHE_TTL_SECONDS)     || 2_592_000
const CACHE_TTL_SECONDS         = Number(process.env.CACHE_TTL_SECONDS)         || 2_592_000

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
      // Read-only check — the cooldown key is set by markDebateStart()
      // AFTER the LLM call succeeds. A failed admission (404 model, 502,
      // etc.) shouldn't lock the user out of retrying.
      const cdKey = `rl:cd:${ip}`
      const ttl = await redis.ttl(cdKey)
      if (ttl > 0) {
        return {
          code: 'cooldown',
          message: `Wait ${ttl}s before starting a new debate.`,
          retryAfter: ttl
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

// Mark a successful debate start — call this AFTER the first LLM call
// has returned 200 (or a cache hit has been served). Failures before
// this point won't lock the user out via cooldown.
export async function markDebateStart(ip) {
  const redis = getRedis()
  if (!redis) return
  try {
    const cooldownSeconds = Math.ceil(DEBATE_COOLDOWN_MS / 1000)
    await redis.set(`rl:cd:${ip}`, '1', { ex: cooldownSeconds })
  } catch (err) {
    console.warn('[ratelimit] cooldown set failed:', err.message)
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

// ── TTS cache (content-addressed by every EL input) ──────────────────────────
// Cache value is the FULL NDJSON response body (audio + alignment), so the
// karaoke pipeline replays identically from cache as it does from EL live.
// Key includes voiceSettings so a tweak to stability/style/speed in VOICE_MAP
// auto-invalidates without manual cache wipes.
export function ttsCacheKey(text, model, voice, format, voiceSettings) {
  const settings = JSON.stringify(voiceSettings || {})
  const hash = createHash('sha256').update(`${model}|${voice}|${format}|${settings}|${text}`).digest('hex')
  return `tts:cache:${hash}`
}

// Separate namespace for the streaming-endpoint TTS cache. The body is
// per-chunk NDJSON with chunk_meta + audio events — NOT equivalent to
// the single-shot NDJSON /api/tts produces, so collision with ttsCacheKey
// would serve garbled bytes to the legacy client. Two layers of
// separation: a `stream|` salt at the start of the hashed input (so the
// hashes themselves never collide for the same text+voice combo) plus a
// distinct `ttsstream:` key prefix in Upstash.
export function ttsStreamCacheKey(text, model, voice, format, voiceSettings) {
  const settings = JSON.stringify(voiceSettings || {})
  const hash = createHash('sha256').update(`stream|${model}|${voice}|${format}|${settings}|${text}`).digest('hex')
  return `ttsstream:cache:${hash}`
}

// Wrap/unwrap pair guards against Upstash auto-deserialization clobbering
// single-line NDJSON bodies. A one-chunk body is itself valid JSON
// ('{"…":"…"}\n'), which the SDK would parse on GET; res.write(obj) then
// stringifies to '[object Object]' and breaks the client. The { body }
// wrapper guarantees we always get an object back and read .body.
function makeCacheStore({ ns, ttl, wrap, unwrap }) {
  const tag = `[${ns}-cache]`
  return {
    get: async (key) => {
      const redis = getRedis()
      if (!redis) return null
      try {
        const v = await redis.get(key)
        return v == null ? null : unwrap(v)
      } catch (err) {
        console.error(`${tag} get error:`, err.message)
        return null
      }
    },
    set: async (key, value) => {
      const redis = getRedis()
      if (!redis) return
      try {
        await redis.set(key, wrap(value), { ex: ttl })
      } catch (err) {
        console.error(`${tag} set error:`, err.message)
      }
    },
    del: async (key) => {
      const redis = getRedis()
      if (!redis) return
      try {
        await redis.del(key)
      } catch (err) {
        console.error(`${tag} del error:`, err.message)
      }
    }
  }
}

const ttsStore = makeCacheStore({
  ns: 'tts',
  ttl: TTS_CACHE_TTL_SECONDS,
  wrap: (body) => ({ body }),
  unwrap: (v) => typeof v === 'string' ? v : (typeof v.body === 'string' ? v.body : null)
})
export const getCachedTts = ttsStore.get
export const setCachedTts = ttsStore.set
export const deleteCachedTts = ttsStore.del

const ttsStreamStore = makeCacheStore({
  ns: 'ttsstream',
  ttl: TTS_CACHE_TTL_SECONDS,
  wrap: (body) => ({ body }),
  unwrap: (v) => typeof v === 'string' ? v : (typeof v.body === 'string' ? v.body : null)
})
export const getCachedTtsStream = ttsStreamStore.get
export const setCachedTtsStream = ttsStreamStore.set

// LLM response cache (per-call). Key is JSON-stringified inputs hashed
// with sha256 — BEHAVIOR_HASH covers prompts/sampling; the explicit
// fields cover call-specific args. Survives partial debates so an
// aborted run retains the per-claim text it already generated.
export function llmCacheKey(provider, model, systemPrompt, userMessage, maxTokens) {
  const inputs = JSON.stringify({
    behavior: BEHAVIOR_HASH,
    provider,
    model,
    maxTokens,
    systemPrompt,
    userMessage
  })
  const hash = createHash('sha256').update(inputs).digest('hex')
  return `llm:cache:${hash}`
}

const llmStore = makeCacheStore({
  ns: 'llm',
  ttl: CACHE_TTL_SECONDS,
  wrap: (text) => ({ text }),
  unwrap: (v) => typeof v === 'string' ? v : (typeof v.text === 'string' ? v.text : null)
})
export const getCachedLlm = llmStore.get
export const setCachedLlm = llmStore.set
export const deleteCachedLlm = llmStore.del

// Single source of truth for fast/deep mode coercion. Anything that isn't
// the literal 'deep' falls back to 'fast' — matches /api/debate's behavior.
export function normalizeMode(m) {
  return m === 'deep' ? 'deep' : 'fast'
}

// ── Debate cache (text only — claims + verdict) ──────────────────────────────
// Keyed by every input that affects LLM output: topic (normalized), mode,
// all three model IDs, both token caps, and BEHAVIOR_HASH (fingerprint of
// every prompt/style/sampling setting in _prompts.js). Any edit there
// produces a new key → cached entry becomes unreachable, next visitor
// regenerates. Voice/TTS settings are NOT in this key — they only affect
// audio and are covered by the TTS cache. Topic is trimmed + lowercased
// so trivial casing/whitespace differences hit the same cache entry.
export function debateCacheKey(topic, mode) {
  const inputs = JSON.stringify({
    topic: String(topic).trim().toLowerCase(),
    mode: normalizeMode(mode),
    anthropic: process.env.ANTHROPIC_MODEL || '',
    openai: process.env.OPENAI_MODEL || '',
    google: process.env.GOOGLE_MODEL || '',
    fast: process.env.FAST_MAX_TOKENS || '',
    deep: process.env.DEEP_MAX_TOKENS || '',
    behavior: BEHAVIOR_HASH
  })
  const hash = createHash('sha256').update(inputs).digest('hex')
  return `debate:cache:${hash}`
}

// Upstash auto-serializes the debate object end-to-end; no wrap/unwrap needed.
const debateStore = makeCacheStore({
  ns: 'debate',
  ttl: CACHE_TTL_SECONDS,
  wrap: (v) => v,
  unwrap: (v) => v
})
export const getCachedDebate = debateStore.get
export const setCachedDebate = debateStore.set
export const deleteCachedDebate = debateStore.del

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

// Single place for the LLM cache policy. Each provider wrapper supplies
// just the HTTP-call shape; cache lookup, response validation, and the
// cache write live here. BEHAVIOR_HASH is folded into the key inside
// llmCacheKey so prompt/sampling edits invalidate symmetrically.
async function withLlmCache(provider, model, systemPrompt, userMessage, maxTokens, callProvider) {
  const cacheKey = llmCacheKey(provider, model, systemPrompt, userMessage, maxTokens)
  const cached = await getCachedLlm(cacheKey)
  if (cached) return cached
  const text = await callProvider()
  if (!text) throw new Error('AI service returned empty response')
  await setCachedLlm(cacheKey, text)
  return text
}

export async function callAnthropic(systemPrompt, userMessage, maxTokens) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
  const tokens = maxTokens || 500
  return withLlmCache('anthropic', model, systemPrompt, userMessage, tokens, async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: tokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    })
    if (!res.ok) {
      console.error(`[llm] Anthropic error: ${res.status}`)
      throw new Error('AI service temporarily unavailable')
    }
    const data = await res.json()
    return data.content?.[0]?.text
  })
}

export async function callOpenAI(systemPrompt, userMessage, maxTokens) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o'
  const tokens = maxTokens || 500
  return withLlmCache('openai', model, systemPrompt, userMessage, tokens, async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: tokens,
        reasoning_effort: LLM_SETTINGS.openai.reasoning_effort,
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
    return data.choices?.[0]?.message?.content
  })
}

export async function callGoogle(systemPrompt, userMessage, maxTokens) {
  const model = process.env.GOOGLE_MODEL || 'gemini-3.1-pro-preview'
  const tokens = maxTokens || 500
  return withLlmCache('google', model, systemPrompt, userMessage, tokens, async () => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: {
          maxOutputTokens: tokens,
          thinkingConfig: LLM_SETTINGS.google
        }
      })
    })
    if (!res.ok) {
      console.error(`[llm] Google error: ${res.status}`)
      throw new Error('AI service temporarily unavailable')
    }
    const data = await res.json()
    const parts = data.candidates?.[0]?.content?.parts || []
    return parts.filter(p => !p.thought).map(p => p.text).join('')
  })
}

// ── LLM streaming ────────────────────────────────────────────
// Async iterators that yield raw text token chunks as the upstream LLM
// emits them. Callers are responsible for accumulation, chunking, and
// cache writes — these are bare streams. Abort honored via opts.signal.
//
// Not yet wired into any public endpoint; see `api/debate-stream.js`
// once it lands. The non-streaming call* helpers above remain the
// source of truth for the legacy /api/debate and verdict paths.

// Parse one SSE event block (separated by \n\n) and route the JSON
// payload to extractToken. Returns the extracted text or null. [DONE]
// sentinels and lines without a `data:` prefix are dropped.
function extractSseEvent(evt, extractToken) {
  const dataLines = evt.split(/\r?\n/).filter(l => l.startsWith('data:'))
  if (dataLines.length === 0) return null
  // Per SSE spec, multi-line `data:` joins with \n. Strip the prefix
  // (and a conventional single leading space) before parsing.
  const payload = dataLines.map(l => l.replace(/^data:\s?/, '')).join('\n')
  if (payload === '[DONE]') return null
  try {
    return extractToken(JSON.parse(payload))
  } catch {
    return null
  }
}

async function* sseTokens(res, extractToken) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // SSE event boundary is two consecutive line breaks; some servers use
  // CRLF (\r\n\r\n) instead of LF (\n\n), so accept either.
  const boundary = /\r?\n\r?\n/
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) {
          const token = extractSseEvent(buffer, extractToken)
          if (token) yield token
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split(boundary)
      buffer = events.pop()  // last (possibly partial) event waits for more bytes
      for (const evt of events) {
        const token = extractSseEvent(evt, extractToken)
        if (token) yield token
      }
    }
  } finally {
    try { reader.cancel() } catch (e) { console.debug('[sseTokens] reader.cancel suppressed:', e.message) }
  }
}

export async function* streamAnthropic(systemPrompt, userMessage, maxTokens, opts = {}) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
  const tokens = maxTokens || 500
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: tokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      stream: true
    })
  })
  if (!res.ok) {
    console.error(`[llm-stream] Anthropic error: ${res.status}`)
    throw new Error('AI service temporarily unavailable')
  }
  yield* sseTokens(res, (evt) =>
    evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta'
      ? evt.delta.text
      : null
  )
}

export async function* streamOpenAI(systemPrompt, userMessage, maxTokens, opts = {}) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o'
  const tokens = maxTokens || 500
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: tokens,
      reasoning_effort: LLM_SETTINGS.openai.reasoning_effort,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      stream: true
    })
  })
  if (!res.ok) {
    console.error(`[llm-stream] OpenAI error: ${res.status}`)
    throw new Error('AI service temporarily unavailable')
  }
  yield* sseTokens(res, (evt) => evt.choices?.[0]?.delta?.content || null)
}

export async function* streamGoogle(systemPrompt, userMessage, maxTokens, opts = {}) {
  const model = process.env.GOOGLE_MODEL || 'gemini-3.1-pro-preview'
  const tokens = maxTokens || 500
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_API_KEY}`
  const res = await fetch(url, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: {
        maxOutputTokens: tokens,
        thinkingConfig: LLM_SETTINGS.google
      }
    })
  })
  if (!res.ok) {
    console.error(`[llm-stream] Google error: ${res.status}`)
    throw new Error('AI service temporarily unavailable')
  }
  yield* sseTokens(res, (evt) => {
    const parts = evt.candidates?.[0]?.content?.parts || []
    return parts.filter(p => !p.thought).map(p => p.text || '').join('') || null
  })
}

// ── Per-agent provider + model resolution ────────────────────
// Single source of truth for agent → provider mapping. Replaces what
// were four parallel maps in /api/debate-stream.js (streamer / provider
// / modelEnv / modelDefault) plus AGENT_CALLER in /api/debate.js — any
// future provider swap touches one row instead of five.
export const AGENT_CONFIG = {
  advocate: { caller: callGoogle,    streamer: streamGoogle,    provider: 'google',    modelEnv: 'GOOGLE_MODEL',    modelDefault: 'gemini-3.1-pro-preview' },
  critic:   { caller: callOpenAI,    streamer: streamOpenAI,    provider: 'openai',    modelEnv: 'OPENAI_MODEL',    modelDefault: 'gpt-4o' },
  wildcard: { caller: callAnthropic, streamer: streamAnthropic, provider: 'anthropic', modelEnv: 'ANTHROPIC_MODEL', modelDefault: 'claude-sonnet-4-6' }
}
