export const AGENTS = {
  advocate: {
    name: 'Advocate',
    model: 'Gemini 3.1 Pro',
    color: '#22c55e',
    dimColor: 'rgba(34, 197, 94, 0.15)',
    prefix: 'adv',
  },
  critic: {
    name: 'Critic',
    model: 'GPT-5.5',
    color: '#ef4444',
    dimColor: 'rgba(239, 68, 68, 0.15)',
    prefix: 'crt',
  },
  wildcard: {
    name: 'Wildcard',
    model: 'Sonnet 4.6',
    color: '#a855f7',
    dimColor: 'rgba(168, 85, 247, 0.15)',
    prefix: 'wld',
  }
}

export const AGENT_ORDER = ['advocate', 'critic', 'wildcard']

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
        text: String(c.text || ''),
        rebuts: c.rebuts || null,
        agrees_with: c.agrees_with || null
      }]
    }
  } catch {
    // Fallback: wrap raw text as single claim
  }

  return [{ text: raw.trim(), rebuts: null, agrees_with: null }]
}

// ── Public API ──

export async function callAgent(agentId, topic, allClaims, round, signal, mode) {
  const res = await fetch('/api/debate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ agent: agentId, topic, history: allClaims, round, mode })
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const e = new Error(err.error || `Server error (${res.status})`)
    e.status = res.status
    if (err.code) e.code = err.code
    if (err.retryAfter) e.retryAfter = err.retryAfter
    throw e
  }

  const { raw } = await res.json()
  return parseAgentResponse(raw)
}

export async function callVerdictAgent(topic, allClaims, signal) {
  const res = await fetch('/api/verdict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ topic, history: allClaims })
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const e = new Error(err.error || `Server error (${res.status})`)
    e.status = res.status
    if (err.code) e.code = err.code
    if (err.retryAfter) e.retryAfter = err.retryAfter
    throw e
  }

  const { raw } = await res.json()
  return parseVerdictResponse(raw.trim())
}

function parseVerdictResponse(raw) {
  let text = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')

  // Try parsing the full text first, then try extracting a JSON object
  const candidates = [text]
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed.winning_arguments) && parsed.winning_arguments.length > 0) {
        return {
          winningArguments: parsed.winning_arguments.slice(0, 3).map(s => String(s)),
          loserGap: String(parsed.loser_gap || '')
        }
      }
    } catch { /* try next candidate */ }
  }

  // Fallback: strip any JSON wrapper and show as plain text
  const plain = raw.replace(/[{}[\]"]/g, '').replace(/winning_arguments:|loser_gap:/g, '').trim()
  return { winningArguments: [plain], loserGap: '' }
}
