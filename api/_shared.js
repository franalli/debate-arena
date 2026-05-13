// Shared utilities for serverless API handlers.
// Prefixed with _ so Vercel does not expose this as an endpoint.

export const CLAIM_ID_RE = /^[a-z]{3}_r\d{1,2}_\d{1,2}$/

export const AGENT_NAME = { advocate: 'Advocate', critic: 'Critic', wildcard: 'Wildcard' }

const MAX_TOPIC_LENGTH = 500
const MAX_CLAIM_TEXT_LENGTH = 2000

// ── Origin check ──────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://debate-arena-ten.vercel.app',
  'http://localhost:5173',   // local dev
  'http://localhost:3001'    // local Express
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

const VALID_AGENT_IDS = new Set(['advocate', 'critic', 'wildcard'])
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
  const model = process.env.GOOGLE_MODEL || 'gemini-3-flash-preview'
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
