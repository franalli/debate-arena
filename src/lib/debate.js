import { AGENTS, AGENT_ORDER, callAgent, callVerdictAgent } from './agents.js'
import { playAudioStream, resetAudio } from './audio.js'

// Synthetic claim ID for the verdict TTS. The real claim ID format is
// `{prefix}_r{N}_{i}` so '__verdict__' can't collide; using a non-null
// value lets onSpeakingWords fire and the App layer key per-word timings
// into the same claimWords map that powers regular karaoke.
export const VERDICT_SPEAKING_ID = '__verdict__'

export function buildVerdictTtsString(verdict) {
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
          await speakClaim('wildcard', VERDICT_SPEAKING_ID, buildVerdictTtsString(cached.verdict))
        }
      }
    }
    onComplete?.()
  }

  // Kick off an LLM call for (agentId, round) and return a tagged-result
  // promise. allClaims is read at call time (synchronously inside callAgent
  // via JSON.stringify), so pre-fetching agent N+1 immediately after pushing
  // agent N's claims sees the up-to-date history.
  const startLlm = (agentId, round) =>
    callAgent(agentId, topic, allClaims, round, abortController.signal, mode)
      .then(rawClaims => ({
        agentId, round,
        claims: rawClaims.map((c, i) => ({
          id: `${AGENTS[agentId].prefix}_r${round}_${i + 1}`,
          agentId, round,
          text: c.text,
          rebuts: c.rebuts,
          agrees_with: c.agrees_with || null
        }))
      }))
      .catch(err => ({ agentId, round, error: err }))

  // What to pre-fetch after agent (round, i) emits its claim. Pipelining
  // hides each LLM call behind the previous agent's TTS playback.
  //   within-round  → next agent in the round
  //   round boundary → first agent of next round (history already has all
  //                    of this round's claims since we push before pre-fetch)
  //   last claim   → verdict (uses the full 9-claim history)
  const nextTarget = (round, i) => {
    if (i + 1 < AGENT_ORDER.length) return { kind: 'claim', agentId: AGENT_ORDER[i + 1], round }
    if (round < maxRounds) return { kind: 'claim', agentId: AGENT_ORDER[0], round: round + 1 }
    return { kind: 'verdict' }
  }

  const startVerdict = () =>
    callVerdictAgent(topic, allClaims, abortController.signal)
      .then(verdict => ({ verdict }))
      .catch(err => ({ error: err }))

  const run = async () => {
    try {
      // Cache check before any LLM call. On hit, skip live generation entirely.
      const cached = await fetchCachedDebate(topic, mode, abortController.signal, fresh)
      if (cached?.claims?.length) {
        await replayCached(cached)
        return
      }

      // Pipelined live generation: each agent's LLM call runs in parallel with
      // the previous agent's TTS playback. The "thinking" indicator is still
      // gated on audio transitions, so the pre-fetch is invisible — when audio
      // ends, the next claim is usually already there (instant transition).
      let pendingLlm = startLlm(AGENT_ORDER[0], 1)
      let pendingVerdict = null
      let pendingTts = null

      const launchNext = (round, i) => {
        const next = nextTarget(round, i)
        if (next.kind === 'claim') {
          pendingLlm = startLlm(next.agentId, next.round)
        } else {
          pendingLlm = null
          pendingVerdict = startVerdict()
        }
      }

      outer:
      for (let round = 1; round <= maxRounds; round++) {
        for (let i = 0; i < AGENT_ORDER.length; i++) {
          const agentId = AGENT_ORDER[i]

          // Wait for previous TTS to finish before yielding the floor.
          // pendingTts always resolves (audio.js absorbs errors silently
          // and the abort path force-resolves via the signal listener).
          if (pendingTts) {
            await pendingTts
            pendingTts = null
          }
          if (abortController.signal.aborted) return

          onAgentStart?.(agentId, round)
          const result = await pendingLlm

          if (result.error) {
            if (result.error.name === 'AbortError') return
            onError?.(result.error, agentId, round)
            // Keep the pipeline going so a single provider blip doesn't kill
            // the whole debate. Skip this agent's TTS, pre-fetch the next.
            launchNext(round, i)
            continue
          }

          allClaims.push(...result.claims)
          onAgentComplete?.(agentId, round, result.claims)

          // Each round has exactly one claim per agent (parser enforces).
          // Use that claim's id as the speakingClaimId so the UI can match it.
          const speakingId = result.claims[0]?.id
          const textToSpeak = result.claims.map(c => c.text).join(' ')
          pendingTts = speakClaim(agentId, speakingId, textToSpeak)
          launchNext(round, i)

          if (abortController.signal.aborted) break outer
        }

        // Drain the last TTS of the round before firing onRoundComplete so the
        // toast appears AFTER the audio for the round-deciding claim, not over it.
        if (pendingTts) {
          await pendingTts
          pendingTts = null
        }
        if (abortController.signal.aborted) return

        onRoundComplete?.(round)

        // Brief pause between rounds so the toast is visible before next round
        // starts. 200ms is enough for visual register without feeling dead.
        if (round < maxRounds && !abortController.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }

      // Verdict: pendingVerdict was started during the last wildcard's TTS
      // (set by launchNext on every path that reaches the last claim),
      // so this await is usually instant.
      let finalVerdict = null
      if (!abortController.signal.aborted) {
        onVerdictStart?.()
        try {
          const result = await pendingVerdict

          if (result.error) {
            if (result.error.name !== 'AbortError') {
              onError?.(result.error, 'wildcard', null)
            }
          } else {
            finalVerdict = result.verdict
            onVerdict?.(finalVerdict)
            if (!abortController.signal.aborted) {
              await speakClaim('wildcard', VERDICT_SPEAKING_ID, buildVerdictTtsString(finalVerdict))
            }
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
