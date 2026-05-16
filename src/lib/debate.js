import { AGENTS, AGENT_ORDER, callAgent, callVerdictAgent } from './agents.js'
import { playAudioStream, resetAudio } from './audio.js'

function buildVerdictTtsString(verdict) {
  const args = (verdict.winningArguments || []).join('. ')
  const gap = verdict.loserGap || ''
  return `Winning arguments: ${args}. The losing case fell short: ${gap}`
}

// Check the debate-text cache. Returns { claims, verdict } on hit, null
// otherwise. With fresh=true, the server skips the read but still allows
// the write path — so this run regenerates and refreshes the cache.
async function fetchCachedDebate(topic, mode, signal, fresh) {
  try {
    const params = new URLSearchParams({ topic, mode })
    if (fresh) params.set('fresh', '1')
    const res = await fetch(`/api/debate-cache?${params}`, { signal })
    if (!res.ok) return null
    const data = await res.json()
    return data.cached ? data.debate : null
  } catch { return null }
}

// Fire-and-forget cache write after a successful live debate. keepalive:
// true survives a same-tab navigation (user clicking "new debate" right
// after onComplete), which otherwise cancels the in-flight request.
function persistDebateCache(topic, mode, claims, verdict) {
  fetch('/api/debate-cache', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({ topic, mode, claims, verdict })
  }).catch(() => {})
}

export function runDebate(topic, maxRounds, callbacks, mode = 'fast') {
  const {
    onAgentStart, onAgentComplete, onRoundComplete, onError, onComplete,
    onVerdictStart, onVerdict, onSpeakingStart, onSpeakingEnd, onSpeakingWords,
    getMuted = () => false,
    fresh = false
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
      fresh,
      onPlaybackStart: () => onSpeakingStart?.(agentId, claimId),
      onPlaybackEnd: () => onSpeakingEnd?.(agentId, claimId),
      onWords: claimId ? (words) => onSpeakingWords?.(claimId, words) : undefined
    })
  }

  // Replay a cached debate: dispatch the same callbacks the live path would,
  // grouping claims by round. Audio still streams from /api/tts (which hits
  // the per-claim TTS cache on suggested topics) so the karaoke layer works
  // identically; only the LLM calls are skipped.
  const replayCached = async (cached) => {
    const claimsByRound = new Map()
    for (const c of cached.claims) {
      if (!claimsByRound.has(c.round)) claimsByRound.set(c.round, [])
      claimsByRound.get(c.round).push(c)
    }
    for (let round = 1; round <= maxRounds; round++) {
      const inRound = claimsByRound.get(round) || []
      // Preserve agent order within a round to match the live cadence.
      inRound.sort((a, b) => AGENT_ORDER.indexOf(a.agentId) - AGENT_ORDER.indexOf(b.agentId))
      for (const c of inRound) {
        if (abortController.signal.aborted) return
        onAgentStart?.(c.agentId, round)
        onAgentComplete?.(c.agentId, round, [c])
        await speakClaim(c.agentId, c.id, c.text)
      }
      onRoundComplete?.(round)
      if (round < maxRounds && !abortController.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    if (!abortController.signal.aborted) {
      // Fire onVerdictStart unconditionally to match the live path's UI
      // contract — the loading state should appear even if (somehow) the
      // cached debate has no verdict, so the UI doesn't get stuck.
      onVerdictStart?.()
      if (cached.verdict) {
        onVerdict?.(cached.verdict)
        if (!abortController.signal.aborted) {
          await speakClaim('wildcard', null, buildVerdictTtsString(cached.verdict))
        }
      }
    }
    onComplete?.()
  }

  const run = async () => {
    try {
      // Cache check before any LLM call. On hit, skip live generation entirely.
      const cached = await fetchCachedDebate(topic, mode, abortController.signal)
      if (cached?.claims?.length) {
        await replayCached(cached)
        return
      }

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

      let finalVerdict = null
      if (!abortController.signal.aborted) {
        onVerdictStart?.()
        try {
          finalVerdict = await callVerdictAgent(topic, allClaims, abortController.signal)
          onVerdict?.(finalVerdict)

          if (!abortController.signal.aborted) {
            await speakClaim('wildcard', null, buildVerdictTtsString(finalVerdict))
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            onError?.(err, 'wildcard', null)
          }
        }
      }

      // Persist on full completion only — partial debates (abort, agent
      // error, verdict throw) would bake in broken states and surface them
      // to every later viewer for 24h. Require a verdict + all 9 claims.
      if (
        !abortController.signal.aborted &&
        allClaims.length === maxRounds * AGENT_ORDER.length &&
        finalVerdict
      ) {
        persistDebateCache(topic, mode, allClaims, finalVerdict)
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
