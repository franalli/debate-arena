import { formatHistory, callAnthropic } from './_shared.js'

const VERDICT_SYSTEM_PROMPT = `You are the Wildcard — a neutral judge summarizing the debate outcome.
You MUST respond with valid JSON in this exact format:
{"winning_arguments": ["point 1", "point 2", "point 3"], "loser_gap": "one sentence"}

RULES:
- winning_arguments: 2-3 bullet points summarizing the winner's strongest claims. State them as facts, not meta-commentary.
- loser_gap: one sentence identifying the biggest weakness or gap in the loser's case.
- Do NOT mention agent names, roles, or the judging process.
- No meta-commentary. Just the substance.`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const topic = req.body.topic
  if (!topic || topic.length < 3) return res.status(400).json({ error: 'Topic required' })

  const { history } = req.body

  try {
    const userMessage = `DEBATE TOPIC: "${topic}"

FULL DEBATE:
${formatHistory(history)}

Respond with JSON only. No markdown, no explanation.`

    const raw = await callAnthropic(VERDICT_SYSTEM_PROMPT, userMessage)
    res.status(200).json({ raw })
  } catch (err) {
    console.error('[verdict] error:', err.message)
    res.status(502).json({ error: err.message })
  }
}
