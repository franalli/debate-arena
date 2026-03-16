import { AGENTS, AGENT_ORDER, callAgent, callVerdictAgent } from './agents.js'

export function runDebate(topic, maxRounds, callbacks) {
  const { onAgentStart, onAgentComplete, onRoundComplete, onError, onComplete, onVerdictStart, onVerdict } = callbacks
  const abortController = new AbortController()
  const allClaims = []
  let claimCounter = 0

  const run = async () => {
    try {
      for (let round = 1; round <= maxRounds; round++) {
        for (const agentId of AGENT_ORDER) {
          if (abortController.signal.aborted) return

          onAgentStart?.(agentId, round)

          try {
            const rawClaims = await callAgent(agentId, topic, allClaims, round, abortController.signal)

            const newClaims = rawClaims.map((c, i) => {
              claimCounter++
              return {
                id: `${AGENTS[agentId].prefix}_r${round}_${i + 1}`,
                agentId,
                round,
                text: c.text,
                rebuts: c.rebuts,
                agrees_with: c.agrees_with || null,
                index: claimCounter
              }
            })

            allClaims.push(...newClaims)
            onAgentComplete?.(agentId, round, newClaims)
          } catch (err) {
            if (err.name === 'AbortError') return
            onError?.(err, agentId, round)
          }
        }

        onRoundComplete?.(round)
      }

      // Verdict phase — Wildcard delivers final judgment
      if (!abortController.signal.aborted) {
        onVerdictStart?.()
        try {
          const verdictText = await callVerdictAgent(topic, allClaims, abortController.signal)
          onVerdict?.(verdictText)
        } catch (err) {
          if (err.name !== 'AbortError') {
            onError?.(err, 'wildcard', null)
          }
        }
      }

      onComplete?.()
    } catch (err) {
      if (err.name !== 'AbortError') {
        onError?.(err, null, null)
      }
    }
  }

  run()

  return () => abortController.abort()
}
