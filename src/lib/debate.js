import { AGENTS, AGENT_ORDER, callAgent, callVerdictAgent } from './agents.js'
import { playAudioStream, resetAudio, startClaimStream, hasMSE } from './audio.js'

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

  // ── Streaming live generation (MSE-capable clients) ───────────
  // One unified /api/debate-stream call per claim handles LLM + TTS
  // together. Pipelining moves from the LLM level (legacy) to the
  // network level: claim N+1's stream starts the moment claim N's
  // claim_complete arrives, and its audio playback is gated behind
  // claim N's audio via gateBeforePlay so playback stays serial.
  const startClaim = (agentId, round, gateBeforePlay, signal = abortController.signal) => {
    // _1 suffix: parseAgentResponse enforces a single claim per agent
    // per turn (src/lib/agents.js parser), so the index is always 1.
    // The legacy path constructs the same id inside startLlm via
    // `${prefix}_r${round}_${i+1}` with i=0.
    // `signal` override lets the round-1-advocate speculative call use
    // a child AbortController so it can be cancelled independently of
    // the main debate (e.g., when the debate-cache check hits).
    const speakingId = `${AGENTS[agentId].prefix}_r${round}_1`
    const fetchPromise = fetch('/api/debate-stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ topic, mode, round, agent: agentId, history: allClaims })
    })
    return startClaimStream(fetchPromise, {
      agent: agentId,
      signal,
      getMuted,
      gateBeforePlay,
      onPlaybackStart: () => onSpeakingStart?.(agentId, speakingId),
      onPlaybackEnd: () => onSpeakingEnd?.(agentId, speakingId),
      onWords: (words) => onSpeakingWords?.(speakingId, words),
      // Surface incremental prose as chunk_meta events flush from the
      // streaming endpoint. Pushes a placeholder claim into UI state so
      // the transcript renders the text alongside karaoke instead of
      // staying empty until claim_complete arrives (which lands AFTER
      // the audio has been playing for several seconds for the first
      // claim — the un-pipelined one).
      onChunkText: (text) => {
        onAgentComplete?.(agentId, round, [{
          id: speakingId,
          agentId, round,
          text,
          rebuts: null,
          agrees_with: null
        }])
      }
    })
  }

  const liveGenStreaming = async (firstStream = null) => {
    // firstStream is the speculative round-1-advocate stream started in
    // parallel with the debate-cache check (see run()). If absent (e.g.,
    // !hasMSE() fallthrough, or future callers), start it here.
    let stream = firstStream || startClaim(AGENT_ORDER[0], 1, null)
    let prevPlayback = null
    let pendingVerdict = null

    outer:
    for (let round = 1; round <= maxRounds; round++) {
      for (let i = 0; i < AGENT_ORDER.length; i++) {
        // Wait for the previous claim's audio to finish before
        // yielding the floor. prevPlayback always resolves (the
        // audio module force-resolves on abort / error).
        if (prevPlayback) {
          await prevPlayback
          prevPlayback = null
        }
        if (abortController.signal.aborted) return null

        // Brief gap between agents within a round so audio doesn't
        // bleed straight into the next agent. Skipped at i=0 because
        // the between-rounds pause at the bottom of the outer loop
        // already covers the gap before the first agent of each round.
        if (i > 0 && !abortController.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }

        const agentId = AGENT_ORDER[i]
        onAgentStart?.(agentId, round)

        // Save THIS stream's playback ref before we reassign `stream`
        // to the next claim below; otherwise we'd wait on the WRONG
        // playback (the next claim's instead of this one's).
        const currentPlayback = stream.playback
        const claim = await stream.claim

        if (!claim) {
          // Stream failed before claim_complete. Skip this agent's
          // contribution and continue pipelining so a single blip
          // doesn't kill the whole debate.
          if (abortController.signal.aborted) return null
          onError?.(new Error('Stream incomplete'), agentId, round)
          // Re-check — onError can synchronously trigger
          // abortController.abort() via App.jsx's no-claims-yet branch.
          if (abortController.signal.aborted) return null
          prevPlayback = currentPlayback
          const next = nextTarget(round, i)
          if (next.kind === 'claim') {
            stream = startClaim(next.agentId, next.round, currentPlayback)
          } else {
            stream = null
            pendingVerdict = startVerdict()
          }
          continue
        }

        const speakingId = `${AGENTS[agentId].prefix}_r${round}_1`
        const claimObj = {
          id: speakingId,
          agentId, round,
          text: claim.fullText,
          rebuts: claim.rebuts || null,
          agrees_with: claim.agrees_with || null
        }
        allClaims.push(claimObj)
        onAgentComplete?.(agentId, round, [claimObj])

        // Pipeline: start next claim's network NOW, gate its audio
        // behind this claim's playback. claim N+1's LLM+EL streaming
        // overlaps with N's audio so its first chunk is usually ready
        // by the time N's audio ends.
        const next = nextTarget(round, i)
        if (next.kind === 'claim') {
          stream = startClaim(next.agentId, next.round, currentPlayback)
        } else {
          stream = null
          pendingVerdict = startVerdict()
        }

        prevPlayback = currentPlayback
        if (abortController.signal.aborted) break outer
      }

      // Drain last audio before round-complete toast so the toast
      // appears after the round-deciding claim's audio, not over it.
      if (prevPlayback) {
        await prevPlayback
        prevPlayback = null
      }
      if (abortController.signal.aborted) return null

      onRoundComplete?.(round)
      if (round < maxRounds && !abortController.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    return pendingVerdict
  }

  // ── Legacy live generation (iOS Safari / no-MSE clients) ──────
  // Two-step per claim: callAgent (/api/debate, JSON) then speakClaim
  // (/api/tts, single-shot NDJSON). Pipelining at the LLM level —
  // next agent's LLM call runs in parallel with current agent's TTS.
  const liveGenLegacy = async () => {
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

        if (pendingTts) {
          await pendingTts
          pendingTts = null
        }
        if (abortController.signal.aborted) return null

        // Brief gap between agents within a round so audio doesn't
        // bleed straight into the next agent. Skipped at i=0 because
        // the between-rounds pause already covers the round transition.
        if (i > 0 && !abortController.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }

        onAgentStart?.(agentId, round)
        const result = await pendingLlm

        if (result.error) {
          if (result.error.name === 'AbortError') return null
          onError?.(result.error, agentId, round)
          launchNext(round, i)
          continue
        }

        allClaims.push(...result.claims)
        onAgentComplete?.(agentId, round, result.claims)

        const speakingId = result.claims[0]?.id
        const textToSpeak = result.claims.map(c => c.text).join(' ')
        pendingTts = speakClaim(agentId, speakingId, textToSpeak)
        launchNext(round, i)

        if (abortController.signal.aborted) break outer
      }

      if (pendingTts) {
        await pendingTts
        pendingTts = null
      }
      if (abortController.signal.aborted) return null

      onRoundComplete?.(round)
      if (round < maxRounds && !abortController.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    return pendingVerdict
  }

  const run = async () => {
    try {
      // Speculatively fire round-1-advocate's stream in parallel with
      // the debate-cache check. On cache hit, we abort the speculative
      // call (wastes ~50-200ms of upstream LLM work — the cache check
      // window — but saves the same on every cache miss, which is the
      // dominant case for fresh topics). The child AbortController
      // inherits from the main signal so user-driven aborts still kill
      // the speculative call.
      let speculativeStream = null
      let speculativeAbort = null
      if (hasMSE()) {
        speculativeAbort = new AbortController()
        const onParentAbort = () => speculativeAbort.abort()
        abortController.signal.addEventListener('abort', onParentAbort, { once: true })
        speculativeStream = startClaim(AGENT_ORDER[0], 1, null, speculativeAbort.signal)
      }

      const cached = await fetchCachedDebate(topic, mode, abortController.signal, fresh)
      if (cached?.claims?.length) {
        if (speculativeAbort) speculativeAbort.abort()
        await replayCached(cached)
        return
      }

      const pendingVerdict = hasMSE() ? await liveGenStreaming(speculativeStream) : await liveGenLegacy()

      // Verdict: pendingVerdict was started during the last wildcard's TTS
      // (set by launchNext / streaming equivalent on every path that
      // reaches the last claim), so this await is usually instant. Null
      // when the loop aborted before reaching the last claim — skip the
      // whole verdict block in that case.
      let finalVerdict = null
      if (!abortController.signal.aborted && pendingVerdict) {
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
