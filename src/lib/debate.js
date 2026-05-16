import { AGENTS, AGENT_ORDER, callAgent, callVerdictAgent } from './agents.js'
import { playAudioStream, resetAudio } from './audio.js'

const MAX_TTS_CHARS = 1000

function buildVerdictTtsString(verdict) {
  const args = (verdict.winningArguments || []).join('. ')
  const gap = verdict.loserGap || ''
  return `Winning arguments: ${args}. The losing case fell short: ${gap}`
}

export function runDebate(topic, maxRounds, callbacks, mode = 'fast') {
  const {
    onAgentStart, onAgentComplete, onRoundComplete, onError, onComplete,
    onVerdictStart, onVerdict, onSpeakingStart, onSpeakingEnd,
    getMuted = () => false
  } = callbacks
  const abortController = new AbortController()
  const allClaims = []

  resetAudio()

  const speakClaim = async (agentId, text) => {
    const toSpeak = text.length > MAX_TTS_CHARS ? text.slice(0, MAX_TTS_CHARS) : text
    await playAudioStream(toSpeak, {
      agent: agentId,
      signal: abortController.signal,
      getMuted,
      onPlaybackStart: () => onSpeakingStart?.(agentId),
      onPlaybackEnd: () => onSpeakingEnd?.(agentId)
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

            const textToSpeak = newClaims.map(c => c.text).join(' ')
            await speakClaim(agentId, textToSpeak)
          } catch (err) {
            if (err.name === 'AbortError') return
            onError?.(err, agentId, round)
          }
        }

        onRoundComplete?.(round)

        // Brief pause between rounds so toast is visible before next round starts
        if (round < maxRounds && !abortController.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, 1000))
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
            await speakClaim('wildcard', verdictTts)
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
