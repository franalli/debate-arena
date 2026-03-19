import { formatHistory, callAnthropic, callOpenAI, callGoogle, CLAIM_ID_RE } from './_shared.js'

// ── Mode configs ─────────────────────────────────────────────
const MODES = {
  fast: {
    maxRounds: 3,
    maxTokens: Number(process.env.FAST_MAX_TOKENS) || 100,
    style: `CRITICAL: Respond with exactly ONE claim. Maximum 12 words. Newspaper headline style. Always end with a full stop.`
  },
  deep: {
    maxRounds: 3,
    maxTokens: Number(process.env.DEEP_MAX_TOKENS) || 800,
    style: `Respond with exactly ONE claim. 2-3 sentences max. Support your claim with evidence or a concrete example. Always end with a full stop. Output JSON only — no preamble, no explanation.`
  }
}

function buildSystemPrompt(agent, mode) {
  const cfg = MODES[mode] || MODES.fast

  const prompts = {
    advocate: `You are the Advocate in a structured debate. You SUPPORT the statement — argue that it is TRUE and correct.

RULES:
- ${cfg.style}
- Build strong arguments that the statement is right, with evidence and logic
- Rebut the most compelling opposing argument if one exists

You MUST respond with valid JSON in this exact format:
{"claims": [{"text": "Your argument here", "rebuts": "claim_id or null"}]}

To rebut another agent's claim, set "rebuts" to that claim's ID (e.g. "crt_r1_1").
If not rebutting, set "rebuts" to null.`,

    critic: `You are the Critic in a structured debate. You OPPOSE the statement — argue that it is FALSE or wrong.

RULES:
- ${cfg.style}
- Argue the opposite position: the statement is incorrect, flawed, or misleading
- Rebut the most compelling opposing argument if one exists

You MUST respond with valid JSON in this exact format:
{"claims": [{"text": "Your counterargument here", "rebuts": "claim_id or null"}]}

To rebut another agent's claim, set "rebuts" to that claim's ID.
If not rebutting, set "rebuts" to null.`,

    wildcard: `You are the Wildcard in a structured debate. You are genuinely neutral — you challenge BOTH sides equally.

RULES:
- ${cfg.style}
- Think laterally — analogies, edge cases, historical parallels, philosophical angles
- Alternate who you rebut: if you rebutted the Advocate last turn, rebut the Critic this turn
- Each round, rebut exactly ONE claim from either the Advocate or Critic. Then agree with exactly ONE claim from the OTHER agent. You must pick different sides for rebut vs agree — never rebut and agree with the same agent in the same round. Only rebut and agree with claims from the current round.
- Rebut the WEAKEST argument. Agree with the STRONGEST argument.

You MUST respond with valid JSON in this exact format:
{"claims": [{"text": "Your unexpected insight here", "rebuts": "claim_id", "agrees_with": "claim_id"}]}

Set "rebuts" to the claim ID you are attacking.
Set "agrees_with" to a claim ID from the OTHER agent.
Both must always be set to valid claim IDs (never null).`
  }

  return prompts[agent]
}

const AGENT_PREFIX = { advocate: 'adv', critic: 'crt', wildcard: 'wld' }

// advocate → Google, critic → OpenAI, wildcard → Anthropic
const AGENT_CALLER = { advocate: callGoogle, critic: callOpenAI, wildcard: callAnthropic }

// ── Rate limiting (best-effort in serverless — resets on cold starts) ─────────
const RATE_LIMIT_IP_DAILY     = Number(process.env.RATE_LIMIT_IP_DAILY)    || 30
const RATE_LIMIT_GLOBAL_DAILY = Number(process.env.RATE_LIMIT_GLOBAL_DAILY) || 300
const DEBATE_COOLDOWN_MS      = Number(process.env.DEBATE_COOLDOWN_MS)      || 60_000

const ipCounts = new Map()
let globalDaily = 0
let lastReset = Date.now()

function checkRateLimit(ip, isNewDebate) {
  if (Date.now() - lastReset > 86_400_000) {
    ipCounts.clear()
    globalDaily = 0
    lastReset = Date.now()
  }

  const record = ipCounts.get(ip) || { daily: 0, lastDebate: 0 }

  if (globalDaily >= RATE_LIMIT_GLOBAL_DAILY) return 'Daily limit reached. Back tomorrow.'
  if (record.daily >= RATE_LIMIT_IP_DAILY)    return "You've reached the daily limit. Back tomorrow."
  if (isNewDebate && Date.now() - record.lastDebate < DEBATE_COOLDOWN_MS) {
    const secsLeft = Math.ceil((DEBATE_COOLDOWN_MS - (Date.now() - record.lastDebate)) / 1000)
    return `Wait ${secsLeft}s before starting a new debate.`
  }

  if (isNewDebate) record.lastDebate = Date.now()
  record.daily++
  ipCounts.set(ip, record)
  globalDaily++
  return null
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
  const round = Number(req.body.round)
  const isNewDebate = Number.isInteger(round) && round === 1

  const rateLimitError = checkRateLimit(ip, isNewDebate)
  if (rateLimitError) return res.status(429).json({ error: rateLimitError })

  const topic = req.body.topic
  if (!topic || topic.length < 3) return res.status(400).json({ error: 'Topic required' })

  const { agent, history } = req.body
  const mode = req.body.mode === 'deep' ? 'deep' : 'fast'
  const cfg = MODES[mode]

  if (!['advocate', 'critic', 'wildcard'].includes(agent)) return res.status(400).json({ error: 'Invalid agent' })
  if (!Number.isInteger(round) || round < 1 || round > cfg.maxRounds) return res.status(400).json({ error: 'Invalid round' })

  try {
    const prefix = AGENT_PREFIX[agent]
    const systemPrompt = buildSystemPrompt(agent, mode)
    const userMessage = `DEBATE TOPIC: "${topic}"
CURRENT ROUND: ${round}

CLAIMS SO FAR:
${formatHistory(history)}

Respond with your claims as JSON. Remember to use claim IDs (like "${prefix}_r${round}_1") are assigned automatically — just provide your text and any rebuts reference.`

    const raw = await AGENT_CALLER[agent](systemPrompt, userMessage, cfg.maxTokens)
    res.status(200).json({ raw })
  } catch (err) {
    console.error(`[debate] ${agent} error:`, err.message)
    res.status(502).json({ error: err.message })
  }
}
