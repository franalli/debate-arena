export const AGENTS = {
  advocate: {
    id: 'advocate',
    name: 'Advocate',
    model: 'Gemini 3 Pro',
    label: 'Google',
    color: '#22c55e',
    dimColor: 'rgba(34, 197, 94, 0.15)',
    prefix: 'adv',
    forceX: 0.25,
    forceY: 0.55,
    systemPrompt: `You are the Advocate in a structured debate. You SUPPORT the statement — argue that it is TRUE and correct.

RULES:
- CRITICAL: Respond with exactly ONE claim. Maximum 20 words. Write like a headline, not a paragraph.
- Build strong arguments that the statement is right, with evidence and logic
- Rebut the most compelling opposing argument if one exists

You MUST respond with valid JSON in this exact format:
{"claims": [{"text": "Your argument here", "rebuts": "claim_id or null"}]}

To rebut another agent's claim, set "rebuts" to that claim's ID (e.g. "crt_r1_1").
If not rebutting, set "rebuts" to null.`
  },
  critic: {
    id: 'critic',
    name: 'Critic',
    model: 'GPT-5.4',
    label: 'OpenAI',
    color: '#ef4444',
    dimColor: 'rgba(239, 68, 68, 0.15)',
    prefix: 'crt',
    forceX: 0.75,
    forceY: 0.55,
    systemPrompt: `You are the Critic in a structured debate. You OPPOSE the statement — argue that it is FALSE or wrong.

RULES:
- CRITICAL: Respond with exactly ONE claim. Maximum 20 words. Write like a headline, not a paragraph.
- Argue the opposite position: the statement is incorrect, flawed, or misleading
- Rebut the most compelling opposing argument if one exists

You MUST respond with valid JSON in this exact format:
{"claims": [{"text": "Your counterargument here", "rebuts": "claim_id or null"}]}

To rebut another agent's claim, set "rebuts" to that claim's ID.
If not rebutting, set "rebuts" to null.`
  },
  wildcard: {
    id: 'wildcard',
    name: 'Wildcard',
    model: 'Sonnet 4.6',
    label: 'Anthropic',
    color: '#a855f7',
    dimColor: 'rgba(168, 85, 247, 0.15)',
    prefix: 'wld',
    forceX: 0.5,
    forceY: 0.3,
    systemPrompt: `You are the Wildcard in a structured debate. You are genuinely neutral — you challenge BOTH sides equally.

RULES:
- CRITICAL: Respond with exactly ONE claim. Maximum 20 words. Write like a headline, not a paragraph.
- Think laterally — analogies, edge cases, historical parallels, philosophical angles
- Alternate who you rebut: if you rebutted the Advocate last turn, rebut the Critic this turn
- Each round, rebut exactly ONE claim from either the Advocate or Critic. Then agree with exactly ONE claim from the OTHER agent. You must pick different sides for rebut vs agree — never rebut and agree with the same agent in the same round.
- Rebut the WEAKEST argument. Agree with the STRONGEST argument.

You MUST respond with valid JSON in this exact format:
{"claims": [{"text": "Your unexpected insight here", "rebuts": "claim_id", "agrees_with": "claim_id"}]}

Set "rebuts" to the claim ID you are attacking.
Set "agrees_with" to a claim ID from the OTHER agent.
Both must always be set to valid claim IDs (never null).`
  }
}

export const AGENT_ORDER = ['advocate', 'critic', 'wildcard']

// ── Provider config ──
const PROVIDERS = {
  advocate: {
    url: () => `https://generativelanguage.googleapis.com/v1beta/models/${import.meta.env.VITE_GOOGLE_MODEL}:generateContent`,
    apiKey: () => import.meta.env.VITE_GOOGLE_API_KEY,
    maxTokens: () => Number(import.meta.env.VITE_GOOGLE_MAX_TOKENS) || 500,
    format: 'google'
  },
  critic: {
    url: () => 'https://api.openai.com/v1/chat/completions',
    apiKey: () => import.meta.env.VITE_OPENAI_API_KEY,
    model: () => import.meta.env.VITE_OPENAI_MODEL,
    maxTokens: () => Number(import.meta.env.VITE_OPENAI_MAX_TOKENS) || 500,
    format: 'openai'
  },
  wildcard: {
    url: () => 'https://api.anthropic.com/v1/messages',
    apiKey: () => import.meta.env.VITE_ANTHROPIC_API_KEY,
    model: () => import.meta.env.VITE_ANTHROPIC_MODEL,
    maxTokens: () => Number(import.meta.env.VITE_ANTHROPIC_MAX_TOKENS) || 500,
    format: 'anthropic'
  }
}

function formatHistory(claims) {
  if (claims.length === 0) return 'No claims have been made yet. You are first to speak.'
  return claims.map(c => {
    const agent = AGENTS[c.agentId]
    const rebuttal = c.rebuts ? ` [rebuts ${c.rebuts}]` : ''
    return `[${c.id}] ${agent.name}: ${c.text}${rebuttal}`
  }).join('\n')
}

function parseAgentResponse(raw) {
  let text = raw.trim()

  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')

  // Find JSON object
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1)
  }

  try {
    const parsed = JSON.parse(text)
    if (parsed.claims && Array.isArray(parsed.claims) && parsed.claims.length > 0) {
      // Enforce single claim per agent per turn — take only the first
      const c = parsed.claims[0]
      return [{
        text: String(c.text || '').slice(0, 200),
        rebuts: c.rebuts || null,
        agrees_with: c.agrees_with || null
      }]
    }
  } catch {
    // Fallback: wrap raw text as single claim
  }

  return [{ text: raw.trim().slice(0, 200), rebuts: null, agrees_with: null }]
}

// ── Provider-specific callers ──

async function callAnthropic(provider, systemPrompt, userMessage, signal) {
  const res = await fetch(provider.url(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    signal,
    body: JSON.stringify({
      model: provider.model(),
      max_tokens: provider.maxTokens(),
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  })
  if (!res.ok) {
    const status = res.status
    if (status === 401) throw new Error('Invalid Anthropic API key (401)')
    if (status === 429) throw new Error('Anthropic rate limited (429)')
    throw new Error(`Anthropic API error (${status})`)
  }
  const data = await res.json()
  const text = data.content?.[0]?.text
  if (!text) throw new Error('Empty response from Anthropic API')
  return text
}

async function callOpenAI(provider, systemPrompt, userMessage, signal) {
  const res = await fetch(provider.url(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey()}`
    },
    signal,
    body: JSON.stringify({
      model: provider.model(),
      max_completion_tokens: provider.maxTokens(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  })
  if (!res.ok) {
    const status = res.status
    if (status === 401) throw new Error('Invalid OpenAI API key (401)')
    if (status === 429) throw new Error('OpenAI rate limited (429)')
    throw new Error(`OpenAI API error (${status})`)
  }
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty response from OpenAI API')
  return text
}

async function callGoogle(provider, systemPrompt, userMessage, signal) {
  const url = `${provider.url()}?key=${provider.apiKey()}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: provider.maxTokens(), thinkingConfig: { thinkingBudget: 0 } }
    })
  })
  if (!res.ok) {
    const status = res.status
    if (status === 400) throw new Error('Invalid Google API key or request (400)')
    if (status === 429) throw new Error('Google rate limited (429)')
    throw new Error(`Google API error (${status})`)
  }
  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Empty response from Google API')
  return text
}

const FORMAT_CALLERS = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  google: callGoogle
}

// ── Public API ──

export async function callAgent(agentId, topic, allClaims, round, signal) {
  const agent = AGENTS[agentId]
  const provider = PROVIDERS[agentId]
  const apiKey = provider.apiKey()

  if (!apiKey) {
    throw new Error(`API key not configured for ${agent.label}. Check .env.local`)
  }

  const host = window.location.hostname
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error('API keys cannot be used from a public origin. Run locally with npm run dev.')
  }

  const history = formatHistory(allClaims)
  const userMessage = `DEBATE TOPIC: "${topic}"
CURRENT ROUND: ${round}

CLAIMS SO FAR:
${history}

Respond with your claims as JSON. Remember to use claim IDs (like "${agent.prefix}_r${round}_1") are assigned automatically — just provide your text and any rebuts reference.`

  const rawText = await FORMAT_CALLERS[provider.format](provider, agent.systemPrompt, userMessage, signal)
  return parseAgentResponse(rawText)
}

export async function callVerdictAgent(topic, allClaims, signal) {
  const provider = PROVIDERS.wildcard
  const systemPrompt = `You are the Wildcard — a neutral judge. Only the Advocate or the Critic can win. You are the referee, NOT a contestant. Never say the Wildcard wins. Your verdict MUST be exactly two sentences — no more, no less. First sentence (under 20 words): state who won and the single strongest reason why. Second sentence (under 20 words): state the loser's biggest miss. Do NOT write three sentences. Do NOT add qualifiers, caveats, or preamble.`
  const userMessage = `DEBATE TOPIC: "${topic}"

FULL DEBATE:
${formatHistory(allClaims)}

Reply with EXACTLY two sentences. Nothing else. No JSON. No third sentence.`

  const rawText = await FORMAT_CALLERS[provider.format](provider, systemPrompt, userMessage)
  return rawText.trim()
}
