// Browser-side TTS playback. Streams MP3 chunks via MediaSource API on
// supporting browsers; falls back to Blob-then-play elsewhere.
//
// IMPORTANT: callers must serialize playAudioStream() invocations.
// currentAudio and currentResolve are module-level singletons; a concurrent
// second call would overwrite them and orphan the first call's Promise.
// The debate orchestrator awaits each call before issuing the next.

const MIME = 'audio/mpeg'

let audioDisabled = false
let currentAudio = null
let currentResolve = null
const useMSE = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported?.(MIME)

// 1-byte silent MP3 to unlock the autoplay policy after user gesture
const SILENT_MP3 = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//FJAhcAvWLQ4VBYRBRY7DkmKxk+kpQq3w8q9z2pZX1V3K28cVgxbm0XbWUcgmt2vGN1XbWgrt7T2VYju28t7zoxNQVHO9b6vmH9oVbA3GRdz0XBdo7uKgTAGqYsAd/4WCxVjW9D6Sd45cKn1Bp1V/L/3//+x9b//6Ohn5Lo'

// ── Public API ─────────────────────────────────────────────

export function primeAudio() {
  try {
    const a = new Audio(SILENT_MP3)
    a.play().catch(() => {})
  } catch { /* ignore */ }
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

export async function playAudioStream(text, opts) {
  const { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd } = opts

  if (audioDisabled) return
  if (getMuted?.()) return
  if (signal?.aborted) return

  let response
  try {
    response = await fetch('/api/tts', {
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

  const playerOpts = { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd }
  if (useMSE) {
    await playViaMSE(response.body, playerOpts)
  } else {
    await playViaBlob(response.body, playerOpts)
  }
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

// Returns a Promise that resolves on natural end, error, or signal abort.
// Also sets currentResolve so stopAudio() can unblock the await.
function setupPlaybackPromise(audio, signal) {
  return new Promise((resolve) => {
    currentResolve = resolve
    audio.onended = () => resolve()
    audio.onerror = () => resolve()
    signal?.addEventListener('abort', () => {
      try { audio.pause() } catch { /* ignore */ }
      resolve()
    }, { once: true })
  })
}

// ── MSE path ───────────────────────────────────────────────

async function playViaMSE(body, { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd }) {
  const fireEnd = makeEndFirer(onPlaybackEnd, agent)
  const mediaSource = new MediaSource()
  const audio = new Audio()
  audio.src = URL.createObjectURL(mediaSource)
  currentAudio = audio

  const reader = body.getReader()
  let started = false

  try {
    await new Promise((resolve) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true })
    })

    const sourceBuffer = mediaSource.addSourceBuffer(MIME)
    const playbackEnded = setupPlaybackPromise(audio, signal)

    try {
      while (true) {
        if (signal?.aborted || getMuted?.()) {
          try { audio.pause() } catch { /* ignore */ }
          break
        }
        const { done, value } = await reader.read()
        if (done) {
          if (mediaSource.readyState === 'open') {
            try { mediaSource.endOfStream() } catch { /* ignore */ }
          }
          break
        }
        if (sourceBuffer.updating) {
          await new Promise((r) => sourceBuffer.addEventListener('updateend', r, { once: true }))
        }
        try {
          sourceBuffer.appendBuffer(value)
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
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[audio] MSE stream error:', err.message)
        audioDisabled = true
      }
    }

    // If audio never actually started (play rejection, appendBuffer fail
    // on first chunk, or abort/mute before first chunk), neither onended
    // nor onerror will fire — resolve manually so the orchestrator unblocks.
    if (!started && currentResolve) currentResolve()

    await playbackEnded
  } finally {
    reader.cancel().catch(() => {})  // Free EL stream + serverless time
    fireEnd()
    try { URL.revokeObjectURL(audio.src) } catch { /* ignore */ }
    if (currentAudio === audio) currentAudio = null
    currentResolve = null
  }
}

// ── Blob fallback ──────────────────────────────────────────

async function playViaBlob(body, { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd }) {
  const fireEnd = makeEndFirer(onPlaybackEnd, agent)
  const reader = body.getReader()
  const chunks = []

  try {
    while (true) {
      if (signal?.aborted || getMuted?.()) {
        reader.cancel().catch(() => {})
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[audio] blob read error:', err.message)
      audioDisabled = true
    }
    return
  }

  if (signal?.aborted || getMuted?.()) return

  const blob = new Blob(chunks, { type: MIME })
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
