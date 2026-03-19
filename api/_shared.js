// Shared utilities for serverless API handlers.
// Prefixed with _ so Vercel does not expose this as an endpoint.

export const CLAIM_ID_RE = /^[a-z]{3}_r\d{1,2}_\d{1,2}$/

export const AGENT_NAME = { advocate: 'Advocate', critic: 'Critic', wildcard: 'Wildcard' }

export function formatHistory(claims) {
  if (!Array.isArray(claims) || claims.length === 0)
    return 'No claims have been made yet. You are first to speak.'
  const VALID_AGENT_IDS = new Set(['advocate', 'critic', 'wildcard'])
  return claims.slice(0, 9).map(c => {
    const agentId = VALID_AGENT_IDS.has(c.agentId) ? c.agentId : 'unknown'
    const name = AGENT_NAME[agentId] || 'Unknown'
    const id = typeof c.id === 'string' && CLAIM_ID_RE.test(c.id) ? c.id : 'unknown'
    const text = String(c.text || '').slice(0, 200)
    const rebuttal = typeof c.rebuts === 'string' && CLAIM_ID_RE.test(c.rebuts) ? ` [rebuts ${c.rebuts}]` : ''
    return `[${id}] ${name}: ${text}${rebuttal}`
  }).join('\n')
}

export async function callAnthropic(systemPrompt, userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS) || 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  })
  if (!res.ok) throw new Error(`Anthropic API error (${res.status})`)
  const data = await res.json()
  const text = data.content?.[0]?.text
  if (!text) throw new Error('Empty response from Anthropic')
  return text
}

export async function callOpenAI(systemPrompt, userMessage) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_completion_tokens: Number(process.env.OPENAI_MAX_TOKENS) || 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  })
  if (!res.ok) throw new Error(`OpenAI API error (${res.status})`)
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty response from OpenAI')
  return text
}

export async function callGoogle(systemPrompt, userMessage) {
  const model = process.env.GOOGLE_MODEL || 'gemini-3-flash-preview'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: {
        maxOutputTokens: Number(process.env.GOOGLE_MAX_TOKENS) || 500,
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  })
  if (!res.ok) throw new Error(`Google API error (${res.status})`)
  const data = await res.json()
  const parts = data.candidates?.[0]?.content?.parts || []
  const text = parts.filter(p => !p.thought).map(p => p.text).join('')
  if (!text) throw new Error('Empty response from Google')
  return text
}
