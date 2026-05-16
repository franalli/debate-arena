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
  const { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd, onWords } = opts

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

  const playerOpts = { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd, onWords }
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

// Accumulates per-chunk character alignment into cumulative word timings,
// emitting via onWords each time new alignment arrives. Returns the
// per-chunk push function. Same object used by both MSE and Blob paths.
function makeAlignmentSink(onWords) {
  const chars = []
  const starts = []
  const ends = []
  return (alignment) => {
    if (!alignment || !onWords) return
    chars.push(...alignment.characters)
    starts.push(...alignment.characterStartTimesSeconds)
    ends.push(...alignment.characterEndTimesSeconds)
    onWords(charactersToWords(chars, starts, ends))
  }
}

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
          if (sourceBuffer.updating) {
            await new Promise((r) => sourceBuffer.addEventListener('updateend', r, { once: true }))
          }
          try {
            sourceBuffer.appendBuffer(bytes)
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
        try { mediaSource.endOfStream() } catch { /* ignore */ }
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
