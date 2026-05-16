import { AGENTS, AGENT_ORDER, callAgent, callVerdictAgent } from './agents.js'
import { playAudioStream, resetAudio } from './audio.js'

function buildVerdictTtsString(verdict) {
  const args = (verdict.winningArguments || []).join('. ')
  const gap = verdict.loserGap || ''
  return `Winning arguments: ${args}. The losing case fell short: ${gap}`
}

export function runDebate(topic, maxRounds, callbacks, mode = 'fast') {
  const {
    onAgentStart, onAgentComplete, onRoundComplete, onError, onComplete,
    onVerdictStart, onVerdict, onSpeakingStart, onSpeakingEnd, onSpeakingWords,
    getMuted = () => false
  } = callbacks
  const abortController = new AbortController()
  const allClaims = []

  resetAudio()

  // claimId is the karaoke key (null for verdict — its renderer doesn't
  // do per-word highlight, so we skip alignment plumbing entirely there).
  const speakClaim = async (agentId, claimId, text) => {
    await playAudioStream(text, {
      agent: agentId,
      signal: abortController.signal,
      getMuted,
      onPlaybackStart: () => onSpeakingStart?.(agentId, claimId),
      onPlaybackEnd: () => onSpeakingEnd?.(agentId, claimId),
      onWords: claimId ? (words) => onSpeakingWords?.(claimId, words) : undefined
    })
  }

  const run = async () => {
    try {
      for (let round = 1; round <= maxRounds; round++) {
        for (const agentId of AGENT_ORDER) {
          if (abortController.signal.aborted) return

          onAgentStart?.(agentId, round)

          try {
            const rawClaims = await callAgent(agentId, topic, allClaims, round, abortController.signal, mode)

            const newClaims = rawClaims.map((c, i) => ({
              id: `${AGENTS[agentId].prefix}_r${round}_${i + 1}`,
              agentId,
              round,
              text: c.text,
              rebuts: c.rebuts,
              agrees_with: c.agrees_with || null,
            }))

            allClaims.push(...newClaims)
            onAgentComplete?.(agentId, round, newClaims)

            // Each round has exactly one claim per agent (parser enforces).
            // Use that claim's id as the speakingClaimId so the UI can match it.
            const speakingId = newClaims[0]?.id
            const textToSpeak = newClaims.map(c => c.text).join(' ')
            await speakClaim(agentId, speakingId, textToSpeak)
          } catch (err) {
            if (err.name === 'AbortError') return
            onError?.(err, agentId, round)
          }
        }

        onRoundComplete?.(round)

        // Brief pause between rounds so toast is visible before next round starts.
        // Kept short (200ms) because TTS TTFB already injects a natural gap
        // between turns; an extra second on top tends to feel dead.
        if (round < maxRounds && !abortController.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }

      // Verdict phase — Wildcard delivers final judgment
      if (!abortController.signal.aborted) {
        onVerdictStart?.()
        try {
          const verdict = await callVerdictAgent(topic, allClaims, abortController.signal)
          onVerdict?.(verdict)

          if (!abortController.signal.aborted) {
            const verdictTts = buildVerdictTtsString(verdict)
            await speakClaim('wildcard', null, verdictTts)
          }
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
