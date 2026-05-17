// Browser-side TTS playback with word-level timing (karaoke).
// Streams NDJSON from /api/tts where each line is
// { audioBase64, alignment: { characters, characterStartTimesSeconds, characterEndTimesSeconds } }.
// Audio bytes feed the MediaSource (or Blob fallback); alignment data is
// accumulated into word timings and emitted via onWords for the UI.
//
// IMPORTANT: callers must serialize playAudioStream() invocations.
// currentAudio and currentResolve are module-level singletons; a concurrent
// second call would overwrite them and orphan the first call's Promise.
// The debate orchestrator awaits each call before issuing the next.

const MIME = 'audio/mpeg'
// Per-turn timeout safety net. Higher-quality TTS models have long,
// sometimes-stalling generation; if onended/onerror/abort never fire,
// the orchestrator would hang forever.
const TURN_TIMEOUT_MS = 60_000

let audioDisabled = false
let currentAudio = null
let currentResolve = null
const useMSE = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported?.(MIME)

const SILENT_MP3 = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//FJAhcAvWLQ4VBYRBRY7DkmKxk+kpQq3w8q9z2pZX1V3K28cVgxbm0XbWUcgmt2vGN1XbWgrt7T2VYju28t7zoxNQVHO9b6vmH9oVbA3GRdz0XBdo7uKgTAGqYsAd/4WCxVjW9D6Sd45cKn1Bp1V/L/3//+x9b//6Ohn5Lo'

// ── Public API ─────────────────────────────────────────────

export function primeAudio() {
  try {
    const a = new Audio(SILENT_MP3)
    a.play().catch(() => {})
  } catch { /* ignore */ }
}

// Cheap warmup: opens a connection to /api/tts without invoking EL.
// Prior version POSTed a real 1-char request, which actually billed an
// EL generation per debate start. A HEAD request hits the same vercel
// function (cold-start warm) and our handler returns 405 fast — same
// DNS/TCP/TLS reuse benefit for the first real POST that follows.
export function primeTTS() {
  fetch('/api/tts', { method: 'HEAD' }).catch(() => {})
}

// Same idea for /api/debate-stream — the round-1-advocate POST that
// kicks off a fresh debate pays cold-start cost on the first hit; a
// preceding HEAD warms the function instance so the user-visible POST
// can reuse the TCP/TLS connection. Saves ~100-300ms on cold paths.
export function primeStream() {
  fetch('/api/debate-stream', { method: 'HEAD' }).catch(() => {})
}

export function resetAudio() {
  audioDisabled = false
  stopAudio()
}

export function stopAudio() {
  if (currentAudio) {
    try { currentAudio.pause() } catch { /* ignore */ }
  }
  if (currentResolve) {
    const r = currentResolve
    currentResolve = null
    r()
  }
}

// Karaoke driver: returns the current audio playback position in seconds,
// or 0 if no audio is active. Consumers (Transcript) poll this on rAF.
export function getCurrentPlaybackTime() {
  return currentAudio ? currentAudio.currentTime : 0
}

export async function playAudioStream(text, opts) {
  const { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd, onWords, fresh } = opts

  if (audioDisabled) return
  if (getMuted?.()) return
  if (signal?.aborted) return

  let response
  try {
    response = await fetch(fresh ? '/api/tts?fresh=1' : '/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ agent, text })
    })
  } catch (err) {
    if (err.name === 'AbortError') return
    console.error('[audio] fetch failed:', err.message)
    audioDisabled = true
    return
  }

  if (!response.ok) {
    console.error('[audio] tts endpoint returned', response.status)
    audioDisabled = true
    return
  }

  const playerOpts = { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd, onWords }
  if (useMSE) {
    await playViaMSE(response.body, playerOpts)
  } else {
    await playViaBlob(response.body, playerOpts)
  }
}

// Consume the new /api/debate-stream NDJSON envelope (chunk_meta / audio
// / claim_complete / error). Event-type strings mirror those emitted by
// api/debate-stream.js — keep them in sync. Returns { claim, playback }:
//   - claim:    Promise resolving to { fullText, rebuts, agrees_with }
//               as soon as the claim_complete event arrives. Null on
//               truncation, abort, or pre-completion error.
//   - playback: Promise resolving when audio playback ends (or aborts).
//
// Pipelining: pass `opts.gateBeforePlay` (a Promise) to defer audio
// playback until that promise resolves. The MSE source buffer still
// accumulates events during the wait, so when the gate opens playback
// starts immediately from the buffered audio. The orchestrator uses
// this to overlap claim N+1's network request + EL streaming with
// claim N's audio playback while keeping audio strictly serial.
//
// MSE-only. iOS Safari (no MediaSource) should NOT call this — the
// orchestrator must route it to playAudioStream + legacy endpoints.
export function startClaimStream(responsePromise, opts) {
  const {
    agent, signal, getMuted, gateBeforePlay,
    onPlaybackStart, onPlaybackEnd, onWords, onChunkText
  } = opts

  let claimResolve
  const claimPromise = new Promise(r => { claimResolve = r })
  let playbackResolve
  const playbackPromise = new Promise(r => { playbackResolve = r })

  const settleClaim = (data) => { if (claimResolve) { claimResolve(data); claimResolve = null } }
  const settlePlayback = () => { if (playbackResolve) { playbackResolve(); playbackResolve = null } }

  ;(async () => {
    if (audioDisabled || getMuted?.() || signal?.aborted) {
      settleClaim(null); settlePlayback(); return
    }

    let response
    try {
      response = await responsePromise
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[audio] stream fetch failed:', err.message)
        audioDisabled = true
      }
      settleClaim(null); settlePlayback(); return
    }
    if (!response.ok) {
      console.error('[audio] debate-stream endpoint returned', response.status)
      audioDisabled = true
      settleClaim(null); settlePlayback(); return
    }

    const fireEnd = makeEndFirer(onPlaybackEnd, agent)
    const mediaSource = new MediaSource()
    const audio = new Audio()
    audio.src = URL.createObjectURL(mediaSource)
    const pushAlignment = makeAlignmentSink(onWords)

    // Time-offset bookkeeping: each EL chunk's character timestamps
    // restart at 0. Cumulative offset = sum of prior chunks' last end
    // times. Updated when a new chunk_meta arrives; applied to every
    // audio event's alignment.
    let timeOffset = 0
    let lastEndAbsolute = 0
    let currentSeq = -1

    let started = false
    let playbackEndedPromise = null

    // Accumulated prose text from chunk_meta events. We surface this to
    // the orchestrator via onChunkText so the transcript can render the
    // claim's text BEFORE claim_complete arrives (which is the last
    // server event — for un-pipelined claims it lands well after audio
    // has already started). To avoid showing the new claim's text while
    // a prior claim's audio is still playing, we buffer chunk_meta
    // events until audio.play() resolves (which for gated claims is
    // when the prior audio ends).
    let accumulatedChunkText = ''

    try {
      await new Promise((resolve) => {
        mediaSource.addEventListener('sourceopen', resolve, { once: true })
      })

      const sourceBuffer = mediaSource.addSourceBuffer(MIME)

      for await (const obj of parseNdjson(response.body)) {
        if (signal?.aborted) break
        if (getMuted?.()) {
          try { audio.pause() } catch { /* ignore */ }
          break
        }

        if (obj.type === 'chunk_meta') {
          // New chunk: shift the alignment time origin to the end of
          // the prior chunk. seq=0's offset stays 0 (first chunk has
          // no predecessor).
          if (obj.seq !== currentSeq) {
            currentSeq = obj.seq
            if (obj.seq > 0) timeOffset = lastEndAbsolute
          }
          // Accumulate prose for the transcript. Surface immediately if
          // audio is already playing; otherwise buffer until audio.play()
          // resolves (so a pipelined claim's text doesn't appear while
          // the prior claim is still speaking).
          if (obj.chunkText) {
            accumulatedChunkText = accumulatedChunkText
              ? `${accumulatedChunkText} ${obj.chunkText}`
              : obj.chunkText
            if (started) onChunkText?.(accumulatedChunkText)
          }
          continue
        }

        if (obj.type === 'audio') {
          if (obj.audioBase64) {
            const bytes = base64ToBytes(obj.audioBase64)
            try {
              await safeAppend(sourceBuffer, bytes)
            } catch (err) {
              console.error('[audio] appendBuffer failed:', err.message)
              audioDisabled = true
              break
            }

            // Start playback once the gate opens (or immediately if
            // unset — the first claim of a debate). The gate-deferred
            // assignment of currentAudio + setupPlaybackPromise is the
            // load-bearing invariant of the pipelined pipeline: at most
            // ONE stream touches the module-level currentAudio /
            // currentResolve singletons at a time. The next claim's
            // stream may already be buffering bytes into its own
            // sourceBuffer, but until its gate opens it leaves the
            // singletons alone.
            //
            // gateBeforePlay is always either null or a playback Promise
            // from a prior startClaimStream — those only resolve, never
            // reject. The outer catch still handles propagation if that
            // ever changes.
            if (!started) {
              if (gateBeforePlay) await gateBeforePlay
              // Abort may have fired while we were waiting on the gate.
              if (signal?.aborted || getMuted?.()) break
              currentAudio = audio
              playbackEndedPromise = setupPlaybackPromise(audio, signal)
              try {
                await audio.play()
                started = true
                onPlaybackStart?.(agent)
                // Flush any chunk_meta text buffered during the gate
                // wait — surface NOW so the transcript renders this
                // claim's text right as its own audio begins.
                if (accumulatedChunkText) onChunkText?.(accumulatedChunkText)
              } catch (err) {
                console.error('[audio] play() rejected:', err.message)
                audioDisabled = true
                break
              }
            }
          }

          if (obj.alignment) {
            const ends = obj.alignment.characterEndTimesSeconds
            if (Array.isArray(ends) && ends.length > 0) {
              lastEndAbsolute = timeOffset + ends[ends.length - 1]
            }
            pushAlignment(obj.alignment, timeOffset)
          }
          continue
        }

        if (obj.type === 'claim_complete') {
          settleClaim({
            fullText: obj.fullText || '',
            rebuts: obj.rebuts || null,
            agrees_with: obj.agrees_with || null
          })
          continue
        }

        if (obj.type === 'error') {
          console.error('[audio] stream error event:', obj.message)
          break
        }
      }

      if (mediaSource.readyState === 'open') {
        try {
          await waitUntilIdle(sourceBuffer)
          mediaSource.endOfStream()
        } catch (err) {
          console.warn('[audio] endOfStream failed:', err.message)
        }
      }

      // If claim_complete never arrived (truncation, abort, error event),
      // null it so the orchestrator knows to skip this claim.
      settleClaim(null)

      // If we never started (gate never opened, no audio events, or
      // muted/aborted before play), playbackEndedPromise is null —
      // skip the wait and let finally settle our own playbackPromise.
      if (started && playbackEndedPromise) {
        await playbackEndedPromise
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[audio] startClaimStream error:', err.message)
        audioDisabled = true
      }
    } finally {
      fireEnd()
      try { URL.revokeObjectURL(audio.src) } catch { /* ignore */ }
      if (currentAudio === audio) currentAudio = null
      settleClaim(null)
      settlePlayback()
    }
  })()

  return { claim: claimPromise, playback: playbackPromise }
}

// ── Internal helpers ───────────────────────────────────────

function makeEndFirer(onPlaybackEnd, agent) {
  let called = false
  return () => {
    if (called) return
    called = true
    onPlaybackEnd?.(agent)
  }
}

// Accumulates per-chunk character alignment into cumulative word timings,
// emitting via onWords each time new alignment arrives. Returns the
// per-chunk push function. timeOffset (default 0) is added to every
// character timestamp before accumulation — needed by playClaimStream
// where each EL chunk's timestamps restart at 0 within its own NDJSON
// frame but must be presented as absolute times against the start of
// the whole claim. The legacy single-shot path passes no offset (one
// chunk, no shift) and is unaffected.
function makeAlignmentSink(onWords) {
  const chars = []
  const starts = []
  const ends = []
  return (alignment, timeOffset = 0) => {
    if (!alignment || !onWords) return
    chars.push(...alignment.characters)
    if (timeOffset) {
      starts.push(...alignment.characterStartTimesSeconds.map(t => t + timeOffset))
      ends.push(...alignment.characterEndTimesSeconds.map(t => t + timeOffset))
    } else {
      starts.push(...alignment.characterStartTimesSeconds)
      ends.push(...alignment.characterEndTimesSeconds)
    }
    onWords(charactersToWords(chars, starts, ends))
  }
}

// Capability check exported so the orchestrator can route MSE-capable
// clients (desktop / Android) to /api/debate-stream and Blob-fallback
// clients (iOS Safari) to the legacy /api/debate + /api/tts pipeline.
export function hasMSE() { return useMSE }

function setupPlaybackPromise(audio, signal) {
  return new Promise((resolve) => {
    let timerId
    // Clear the timer on every resolve path so the 60s closure isn't
    // retained when the audio ends/aborts in the first 5s like usual.
    const settle = () => { if (timerId) clearTimeout(timerId); resolve() }
    currentResolve = settle
    if (signal?.aborted) { settle(); return }
    audio.onended = settle
    audio.onerror = settle
    signal?.addEventListener('abort', () => {
      try { audio.pause() } catch { /* ignore */ }
      settle()
    }, { once: true })
    timerId = setTimeout(() => {
      console.warn('[audio] turn timeout reached, force-resolving')
      try { audio.pause() } catch { /* ignore */ }
      settle()
    }, TURN_TIMEOUT_MS)
  })
}

// Drain any in-flight sourceBuffer operation (appendBuffer or remove).
// while, not if: Chrome can spawn an internal remove for buffer eviction
// between two updateend events, so we re-check after each fire until
// updating is truly false.
async function waitUntilIdle(sourceBuffer) {
  while (sourceBuffer.updating) {
    await new Promise((r) => sourceBuffer.addEventListener('updateend', r, { once: true }))
  }
}

// Defensive appendBuffer: drain, attempt, and retry on InvalidStateError.
// The retry covers the case where an internal remove kicks in during the
// micro-window between exiting waitUntilIdle and reaching appendBuffer —
// catchable only after the fact via the synchronous throw, not preventable.
async function safeAppend(sourceBuffer, bytes) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitUntilIdle(sourceBuffer)
    try {
      sourceBuffer.appendBuffer(bytes)
      return
    } catch (err) {
      if (err.name === 'InvalidStateError' && attempt < 2) continue
      throw err
    }
  }
}

// atob() → Uint8Array. MediaSource needs raw bytes, not base64.
function base64ToBytes(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Walk EL's character-level alignment and group into words.
// Treats whitespace as word boundaries; punctuation stays with the word.
function charactersToWords(chars, starts, ends) {
  const words = []
  let buf = []
  let bufStart = 0
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (/\s/.test(c)) {
      if (buf.length > 0) {
        words.push({ word: buf.join(''), start: bufStart, end: ends[i - 1] })
        buf = []
      }
    } else {
      if (buf.length === 0) bufStart = starts[i]
      buf.push(c)
    }
  }
  if (buf.length > 0) {
    words.push({ word: buf.join(''), start: bufStart, end: ends[chars.length - 1] })
  }
  return words
}

// Pull NDJSON chunks from the response body, demuxing audio bytes
// (for MediaSource) from alignment data (for the karaoke callback).
async function* parseNdjson(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) {
          try { yield JSON.parse(buffer) } catch { /* skip malformed */ }
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        try { yield JSON.parse(line) } catch { /* skip malformed */ }
      }
    }
  } finally {
    try { reader.cancel() } catch { /* ignore */ }
  }
}

// ── MSE path ───────────────────────────────────────────────

async function playViaMSE(body, { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd, onWords }) {
  const fireEnd = makeEndFirer(onPlaybackEnd, agent)
  const mediaSource = new MediaSource()
  const audio = new Audio()
  audio.src = URL.createObjectURL(mediaSource)
  currentAudio = audio

  let started = false
  const pushAlignment = makeAlignmentSink(onWords)

  try {
    await new Promise((resolve) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true })
    })

    const sourceBuffer = mediaSource.addSourceBuffer(MIME)
    const playbackEnded = setupPlaybackPromise(audio, signal)

    try {
      for await (const obj of parseNdjson(body)) {
        if (signal?.aborted || getMuted?.()) {
          try { audio.pause() } catch { /* ignore */ }
          break
        }

        if (obj.audioBase64) {
          const bytes = base64ToBytes(obj.audioBase64)
          try {
            await safeAppend(sourceBuffer, bytes)
          } catch (err) {
            console.error('[audio] appendBuffer failed:', err.message)
            audioDisabled = true
            break
          }
          if (!started) {
            try {
              await audio.play()
              started = true
              onPlaybackStart?.(agent)
            } catch (err) {
              console.error('[audio] play() rejected:', err.message)
              audioDisabled = true
              break
            }
          }
        }

        pushAlignment(obj.alignment)
      }

      if (mediaSource.readyState === 'open') {
        // Wait for all pending appendBuffer/remove ops to clear before
        // signaling end-of-stream — calling endOfStream() while the
        // sourceBuffer is updating throws InvalidStateError, MSE stays
        // "open", and `ended` never fires on the audio element.
        try {
          await waitUntilIdle(sourceBuffer)
          mediaSource.endOfStream()
        } catch (err) {
          console.warn('[audio] endOfStream failed:', err.message)
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[audio] MSE stream error:', err.message)
        audioDisabled = true
      }
    }

    if (!started && currentResolve) currentResolve()
    await playbackEnded
  } finally {
    fireEnd()
    try { URL.revokeObjectURL(audio.src) } catch { /* ignore */ }
    if (currentAudio === audio) currentAudio = null
    currentResolve = null
  }
}

// ── Blob fallback ──────────────────────────────────────────

async function playViaBlob(body, { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd, onWords }) {
  const fireEnd = makeEndFirer(onPlaybackEnd, agent)
  const audioParts = []
  const pushAlignment = makeAlignmentSink(onWords)

  try {
    for await (const obj of parseNdjson(body)) {
      if (signal?.aborted || getMuted?.()) return
      if (obj.audioBase64) audioParts.push(base64ToBytes(obj.audioBase64))
      pushAlignment(obj.alignment)
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[audio] blob read error:', err.message)
      audioDisabled = true
    }
    return
  }

  if (signal?.aborted || getMuted?.()) return
  if (audioParts.length === 0) return

  const blob = new Blob(audioParts, { type: MIME })
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  currentAudio = audio

  try {
    const playbackEnded = setupPlaybackPromise(audio, signal)
    let started = false
    try {
      await audio.play()
      started = true
      onPlaybackStart?.(agent)
    } catch (err) {
      console.error('[audio] blob play rejected:', err.message)
      audioDisabled = true
    }
    if (!started && currentResolve) currentResolve()
    await playbackEnded
  } finally {
    fireEnd()
    try { URL.revokeObjectURL(url) } catch { /* ignore */ }
    if (currentAudio === audio) currentAudio = null
    currentResolve = null
  }
}
