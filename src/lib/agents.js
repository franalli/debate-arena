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

// Reverse map: claim-ID prefix -> agent id (e.g. 'adv' -> 'advocate').
// Lets callers recover the speaker from a claim ID without re-stating the
// 'adv' / 'crt' / 'wld' mapping inline.
export const PREFIX_TO_AGENT = Object.fromEntries(
  Object.entries(AGENTS).map(([id, a]) => [a.prefix, id])
)

// Strip markdown fences and extract the inner-most JSON object span.
// Returns { cleaned, jsonSlice } — both available so callers can fall back
// to plain text (cleaned) when JSON.parse fails on the slice.
function extractJsonSlice(raw) {
  const cleaned = raw.trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  const jsonSlice = (first !== -1 && last > first) ? cleaned.slice(first, last + 1) : cleaned
  return { cleaned, jsonSlice }
}

function parseAgentResponse(raw) {
  const { cleaned, jsonSlice } = extractJsonSlice(raw)

  try {
    const parsed = JSON.parse(jsonSlice)
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
    // Truncated/malformed JSON — try to salvage the partial "text" field
    // and the rebuts/agrees_with refs via regex before the response stops.
    const textMatch = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/)
    if (textMatch && textMatch[1]) {
      const rebutsMatch = raw.match(/"rebuts"\s*:\s*"([^"]+)"/)
      const agreesMatch = raw.match(/"agrees_with"\s*:\s*"([^"]+)"/)
      // Un-escape common JSON-escaped chars in the partial text
      const cleaned = textMatch[1]
        .replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\')
      return [{
        text: cleaned,
        rebuts: rebutsMatch ? rebutsMatch[1] : null,
        agrees_with: agreesMatch ? agreesMatch[1] : null
      }]
    }
  }

  // Last resort: never return the markdown-wrapped JSON literal to the UI.
  return [{ text: cleaned, rebuts: null, agrees_with: null }]
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
  const { cleaned, jsonSlice } = extractJsonSlice(raw)
  // Try the full cleaned text first (e.g. when the model returned raw JSON
  // without fences), then the brace-isolated slice.
  const candidates = cleaned === jsonSlice ? [cleaned] : [cleaned, jsonSlice]

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
