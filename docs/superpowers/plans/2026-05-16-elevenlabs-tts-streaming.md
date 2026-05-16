# ElevenLabs TTS Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-turn voice narration to Debate Arena via ElevenLabs `eleven_flash_v2_5`, with true byte-streaming playback (MSE) and a Blob fallback. Each agent speaks its claim; the Wildcard also speaks the final verdict. A speaker icon mutes mid-debate, and pulsing rings highlight the active speaker's anchor on the graph.

**Architecture:** A new serverless function `api/tts.js` streams MP3 bytes from ElevenLabs to the browser. A new `src/lib/audio.js` module handles MediaSource-API playback with a Blob fallback for browsers that can't stream `audio/mpeg`. The existing `runDebate()` orchestrator gains an `await playAudioStream(...)` step after each agent and after the verdict, making the audio the natural metronome of the debate. Mute/speaker UI lives in `App.jsx`. Speaker rings are drawn imperatively in `DebateGraph.jsx` via a dedicated D3 effect (separate from the main re-render).

**Tech Stack:** Vercel serverless (Node), React 19 + Vite, `@elevenlabs/elevenlabs-js` SDK (already installed), `@upstash/redis` for rate limiting (already wired), `lucide-react` icons (already installed), MediaSource API for streaming playback, D3 for SVG manipulation.

**Spec reference:** `docs/superpowers/specs/2026-05-16-elevenlabs-tts-streaming-design.md`

**Project note:** This repo has no test suite (`CLAUDE.md`: "No test suite is configured"). Verification at each task uses one of: `npm run build`, `npm run lint`, `curl` against `vercel dev`, or browser observation. Not TDD — instead "implement → verify with concrete checks → commit."

---

## File map

| Path | Action | What it owns after this plan |
|---|---|---|
| `.env.local` | edit | Rename `ELEVENLABS_API` → `ELEVENLABS_API_KEY`. Add three `VOICE_ID_*` vars. |
| `api/tts.js` | NEW | POST endpoint that streams MP3 chunks from ElevenLabs to the client. |
| `api/_shared.js` | no edits | Already exports `checkOrigin`, `getIp`, `checkCharBudget`. |
| `src/lib/audio.js` | NEW | Browser-side playback module. `playAudioStream`, `primeAudio`, `stopAudio`, `resetAudio`. MSE + Blob fallback. |
| `src/lib/debate.js` | edit | New `getMuted` arg; `await playAudioStream` after each agent + after verdict; new `onSpeakingStart`/`onSpeakingEnd` callbacks. |
| `src/App.jsx` | edit | `muted` state + ref; `speakingAgent` state; mute side-effect that calls `stopAudio`; speaker icon in header; `speakingAgent` prop passed to `DebateGraph`. |
| `src/components/TopicInput.jsx` | edit | Call `primeAudio()` in `handleSubmit` to unlock autoplay. |
| `src/components/DebateGraph.jsx` | edit | Accept `speakingAgent` prop. New dedicated `useEffect` that inserts `.speaker-rings` group before `.agent-anchors` in the SVG. |
| `src/styles/theme.css` | edit | `@keyframes speakerPulse` + `.speaker-ring` / `.speaker-ring-2` / `.speaker-ring-3` rules. |

---

## Pre-flight Check

- [ ] **Step 1: Confirm working tree state**

Run: `git status --short`

Expected: clean apart from the pre-existing staged deletions in `.claude/` and `.gitignore` (those are unrelated to this work and should stay untouched). The new branch is `11labs`.

- [ ] **Step 2: Confirm dev server runs**

Run: `vercel dev` in one terminal (leave running for the remainder of the plan).

Expected: Server listens on `http://localhost:3000`. Open it; the topic input screen renders. The dev server reloads on file edits.

- [ ] **Step 3: Confirm SDK is installed**

Run: `node -e "import('@elevenlabs/elevenlabs-js').then(m => console.log(typeof m.ElevenLabsClient))"`

Expected: prints `function`. (The SDK is already listed in `package.json` and installed in `node_modules`.)

---

## Task 1: Environment variable setup

**Files:**
- Modify: `.env.local`

The current `.env.local` has the API key under the non-standard name `ELEVENLABS_API`. We rename it to `ELEVENLABS_API_KEY` (matches SDK convention and the spec) and add three new voice ID vars.

- [ ] **Step 1: Edit `.env.local`**

Open `.env.local`. Find the line:

```
ELEVENLABS_API="sk_2a0e5fbfe7d38287d6f35c78074f4e17028b1747e8692043"
```

Replace it with:

```
ELEVENLABS_API_KEY="sk_2a0e5fbfe7d38287d6f35c78074f4e17028b1747e8692043"
VOICE_ID_ADVOCATE="pNInz6obpgDQGcFmaJgB"
VOICE_ID_CRITIC="21m00Tcm4TlvDq8ikWAM"
VOICE_ID_WILDCARD="ErXwobaYiN019PkySvjV"
```

(Keep the original API key value — only the variable name changes.)

- [ ] **Step 2: Restart `vercel dev`**

In the terminal running `vercel dev`, press Ctrl+C and run `vercel dev` again. Env-var changes don't hot-reload — a restart is required.

Expected: Server restarts without errors.

- [ ] **Step 3: Verify env vars are loaded**

Run in a separate terminal:

```bash
curl -s -X POST -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"topic":"test","history":[],"agent":"advocate","round":1,"mode":"fast"}' \
  http://localhost:3000/api/debate | head -c 100
```

Expected: A JSON response containing `"raw":"..."`. (This confirms existing endpoints still work after env rename — `ELEVENLABS_API_KEY` is unused by `/api/debate` but if anything else broke we'd see an error.)

- [ ] **Step 4: No commit needed**

`.env.local` is gitignored (`.gitignore` line: `.env*.local`). Move on.

---

## Task 2: Backend endpoint `api/tts.js`

**Files:**
- Create: `api/tts.js`

This file owns origin/method/body validation, char-budget enforcement (reusing the existing `checkCharBudget` helper), the ElevenLabs SDK call, and byte forwarding.

- [ ] **Step 1: Create `api/tts.js` with the full implementation**

Create file `api/tts.js` with this exact content:

```javascript
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
import { checkOrigin, getIp, checkCharBudget } from './_shared.js'

const MODEL_ID = 'eleven_flash_v2_5'
const OUTPUT_FORMAT = 'mp3_22050_32'
const MAX_TEXT_LENGTH = 1000

const VOICE_MAP = {
  advocate: {
    voiceSettings: { stability: 0.4, similarityBoost: 0.75, style: 0.3, useSpeakerBoost: true }
  },
  critic: {
    voiceSettings: { stability: 0.6, similarityBoost: 0.75, style: 0.2, useSpeakerBoost: true }
  },
  wildcard: {
    voiceSettings: { stability: 0.5, similarityBoost: 0.75, style: 0.4, useSpeakerBoost: true }
  }
}

let _client = null
function getClient() {
  if (_client) return _client
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured')
  _client = new ElevenLabsClient({ apiKey })
  return _client
}

function getVoiceId(agent) {
  const envKey = `VOICE_ID_${agent.toUpperCase()}`
  return process.env[envKey]
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!checkOrigin(req, res)) return

  const { agent, text } = req.body || {}

  if (!['advocate', 'critic', 'wildcard'].includes(agent)) {
    return res.status(400).json({ error: 'Invalid agent' })
  }
  if (typeof text !== 'string' || text.length === 0) {
    return res.status(400).json({ error: 'Text required' })
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` })
  }

  const ip = getIp(req)
  const budgetError = await checkCharBudget(ip, text.length)
  if (budgetError) {
    return res.status(429).json({ error: budgetError, code: 'tts_budget' })
  }

  const voiceId = getVoiceId(agent)
  if (!voiceId) {
    console.error(`[tts] missing voice ID for ${agent}`)
    return res.status(500).json({ error: 'Voice not configured' })
  }

  let headersSent = false
  try {
    const audioStream = await getClient().textToSpeech.stream(voiceId, {
      text,
      modelId: MODEL_ID,
      outputFormat: OUTPUT_FORMAT,
      voiceSettings: VOICE_MAP[agent].voiceSettings
    })

    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'no-store')
    headersSent = true

    let clientGone = false
    req.on('close', () => { clientGone = true })

    for await (const chunk of audioStream) {
      if (clientGone) break
      res.write(chunk)
    }
    res.end()
  } catch (err) {
    console.error('[tts] error:', err.message)
    if (!headersSent) {
      res.status(502).json({ error: 'AI service temporarily unavailable' })
    } else {
      res.destroy()
    }
  }
}
```

- [ ] **Step 2: Verify the endpoint responds with MP3 bytes**

With `vercel dev` running, run from another terminal:

```bash
curl -s -X POST -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"agent":"advocate","text":"Testing one two three"}' \
  http://localhost:3000/api/tts -o /tmp/tts-test.mp3
```

Then:

```bash
file /tmp/tts-test.mp3
```

Expected: `MPEG ADTS, layer III, ...` (or similar — confirms it's a valid MP3).

- [ ] **Step 3: Listen to the output (optional, macOS)**

Run: `afplay /tmp/tts-test.mp3`

Expected: a voice reads "Testing one two three". If silent or garbled, the EL API key or voice ID is wrong — fix `.env.local` and retry.

- [ ] **Step 4: Verify validation rejects bad input**

```bash
# Bad agent
curl -s -X POST -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"agent":"bogus","text":"hi"}' http://localhost:3000/api/tts
```
Expected: `{"error":"Invalid agent"}`.

```bash
# Empty text
curl -s -X POST -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"agent":"advocate","text":""}' http://localhost:3000/api/tts
```
Expected: `{"error":"Text required"}`.

```bash
# Bad origin
curl -s -X POST -H "Content-Type: application/json" -H "Origin: http://evil.example.com" \
  -d '{"agent":"advocate","text":"hi"}' http://localhost:3000/api/tts
```
Expected: `{"error":"Forbidden"}`.

- [ ] **Step 5: Commit**

```bash
git add api/tts.js
git commit -m "feat: add /api/tts streaming endpoint via ElevenLabs SDK

Streams eleven_flash_v2_5 MP3 output (mp3_22050_32) chunk-by-chunk
to clients. Reuses checkOrigin / checkCharBudget from _shared.js.
Per-agent voice settings hardcoded; voice IDs read from VOICE_ID_*
env vars."
```

---

## Task 3: Frontend audio module `src/lib/audio.js`

**Files:**
- Create: `src/lib/audio.js`

Browser-side module. Pure JavaScript, no React. Owns MSE detection, Blob fallback, mute/abort handling, and the kill-switch behavior on failure.

- [ ] **Step 1: Create `src/lib/audio.js` with the full implementation**

Create file `src/lib/audio.js` with this exact content:

```javascript
// Browser-side TTS playback. Streams MP3 chunks via MediaSource API on
// supporting browsers; falls back to Blob-then-play elsewhere.

const MIME = 'audio/mpeg'

// Module state
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

  if (useMSE) {
    await playViaMSE(response.body, { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd })
  } else {
    await playViaBlob(response.body, { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd })
  }
}

// ── MSE path ───────────────────────────────────────────────

async function playViaMSE(body, { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd }) {
  let endCalled = false
  const fireEnd = () => {
    if (endCalled) return
    endCalled = true
    onPlaybackEnd?.(agent)
  }

  const mediaSource = new MediaSource()
  const audio = new Audio()
  audio.src = URL.createObjectURL(mediaSource)
  currentAudio = audio

  try {
    await new Promise((resolve) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true })
    })

    const sourceBuffer = mediaSource.addSourceBuffer(MIME)
    const reader = body.getReader()
    let started = false

    const playbackEnded = new Promise((resolve) => {
      currentResolve = resolve
      audio.onended = () => resolve()
      audio.onerror = () => resolve()
      if (signal) {
        signal.addEventListener('abort', () => {
          try { audio.pause() } catch { /* ignore */ }
          resolve()
        })
      }
    })

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
          started = true
          try {
            await audio.play()
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

    await playbackEnded
  } finally {
    fireEnd()
    try { URL.revokeObjectURL(audio.src) } catch { /* ignore */ }
    if (currentAudio === audio) currentAudio = null
    currentResolve = null
  }
}

// ── Blob fallback ──────────────────────────────────────────

async function playViaBlob(body, { agent, signal, getMuted, onPlaybackStart, onPlaybackEnd }) {
  let endCalled = false
  const fireEnd = () => {
    if (endCalled) return
    endCalled = true
    onPlaybackEnd?.(agent)
  }

  const reader = body.getReader()
  const chunks = []

  try {
    while (true) {
      if (signal?.aborted || getMuted?.()) return
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
    await new Promise((resolve) => {
      currentResolve = resolve
      audio.onended = () => resolve()
      audio.onerror = () => resolve()
      if (signal) {
        signal.addEventListener('abort', () => {
          try { audio.pause() } catch { /* ignore */ }
          resolve()
        })
      }
      audio.play().then(() => {
        onPlaybackStart?.(agent)
      }).catch((err) => {
        console.error('[audio] blob play rejected:', err.message)
        audioDisabled = true
        resolve()
      })
    })
  } finally {
    fireEnd()
    try { URL.revokeObjectURL(url) } catch { /* ignore */ }
    if (currentAudio === audio) currentAudio = null
    currentResolve = null
  }
}
```

- [ ] **Step 2: Verify build is clean**

Run: `npm run build`

Expected: Build succeeds. No errors. (Warnings about `process.env` in browser code would be a red flag — there shouldn't be any since `audio.js` doesn't use it.)

- [ ] **Step 3: Verify lint is clean**

Run: `npm run lint`

Expected: No new lint errors in `src/lib/audio.js`. (If existing lint baseline has other issues, only verify no NEW ones for the new file.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/audio.js
git commit -m "feat: add src/lib/audio.js for streaming TTS playback

Public API: playAudioStream, primeAudio, stopAudio, resetAudio.
Feature-detects MediaSource API for true byte-streaming; falls back
to Blob-buffer-then-play on iOS Safari and older browsers. Kill
switch arms on first failure to fail silently for the rest of the
debate session."
```

---

## Task 4: Orchestrator integration `src/lib/debate.js`

**Files:**
- Modify: `src/lib/debate.js`

Add `getMuted` argument, call `resetAudio()` at start, await `playAudioStream` after each agent and after the verdict. Pass new callbacks `onSpeakingStart` / `onSpeakingEnd` to App.

- [ ] **Step 1: Read the current file**

Run: `cat src/lib/debate.js`

Confirm content matches what was read at planning time (68 lines, with `runDebate(topic, maxRounds, callbacks, mode = 'fast')`).

- [ ] **Step 2: Replace the entire file**

Open `src/lib/debate.js` and replace its content with:

```javascript
import { AGENTS, AGENT_ORDER, callAgent, callVerdictAgent } from './agents.js'
import { playAudioStream, resetAudio } from './audio.js'

const MAX_TTS_CHARS = 1000

function buildVerdictTtsString(verdict) {
  const args = (verdict.winningArguments || []).join('. ')
  const gap = verdict.loserGap || ''
  const combined = `Winning arguments: ${args}. The losing case fell short: ${gap}`
  return combined.length > MAX_TTS_CHARS ? combined.slice(0, MAX_TTS_CHARS) : combined
}

export function runDebate(topic, maxRounds, callbacks, mode = 'fast', getMuted = () => false) {
  const {
    onAgentStart, onAgentComplete, onRoundComplete, onError, onComplete,
    onVerdictStart, onVerdict, onSpeakingStart, onSpeakingEnd
  } = callbacks
  const abortController = new AbortController()
  const allClaims = []

  resetAudio()

  const speakClaim = async (agentId, text) => {
    let toSpeak = text
    if (toSpeak.length > MAX_TTS_CHARS) toSpeak = toSpeak.slice(0, MAX_TTS_CHARS)
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
```

- [ ] **Step 3: Verify build is clean**

Run: `npm run build`

Expected: Build succeeds. The new import from `./audio.js` resolves.

- [ ] **Step 4: Verify lint is clean**

Run: `npm run lint`

Expected: No new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/debate.js
git commit -m "feat: await TTS playback after each agent and the verdict

runDebate now serializes audio with LLM calls: each agent's claim is
spoken in full before the next LLM call starts. Verdict is also
spoken (Wildcard voice) using a winning_arguments + loser_gap
template. New onSpeakingStart/onSpeakingEnd callbacks let the UI
highlight the active speaker. getMuted is read lazily on each turn."
```

---

## Task 5: App.jsx — mute state, speaker icon, speakingAgent wiring

**Files:**
- Modify: `src/App.jsx`

Several distinct edits in one file. Each step touches a specific section.

- [ ] **Step 1: Add new imports**

In `src/App.jsx`, find the existing import block at the top (lines 1-10). Change line 1 from:

```jsx
import { useState, useCallback, useRef, useMemo } from 'react'
```

to:

```jsx
import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { stopAudio } from './lib/audio.js'
```

(Adds `useEffect` to the React import, adds the lucide icons, adds `stopAudio`.)

- [ ] **Step 2: Add `muted` and `speakingAgent` state plus mutedRef**

Find the `verdictRef` declaration (currently around line 33: `const verdictRef = useRef(null)`).

After that line, add:

```jsx
  const cooldownTimerRef = useRef(null)
  const [muted, setMuted] = useState(false)
  const mutedRef = useRef(false)
  const [speakingAgent, setSpeakingAgent] = useState(null)
```

**Watch out:** the line `const cooldownTimerRef = useRef(null)` already exists right below `verdictRef` (line 34). You're inserting AFTER `cooldownTimerRef`, before the next block. Verify by reading lines 30-40 first.

- [ ] **Step 3: Add the mute side effect**

Below the new state declarations from Step 2 (and below `cooldownTimerRef`), add:

```jsx
  useEffect(() => {
    mutedRef.current = muted
    if (muted) stopAudio()
  }, [muted])
```

This both mirrors `muted` into the ref (so the orchestrator's `getMuted` getter reads the latest value) AND calls `stopAudio()` when mute toggles ON to cut in-progress speech.

- [ ] **Step 4: Update the runDebate call with new callbacks and `getMuted`**

Find the existing `runDebate` invocation inside `startDebate` (currently around line 51). The current call ends with:

```jsx
    }, activeMode)

    cancelRef.current = cancel
  }, [mode, maxRounds])
```

Locate the `onComplete` callback inside the callbacks object (currently around line 108-111):

```jsx
      onComplete: () => {
        setThinkingAgent(null)
        setStatus('complete')
      }
    }, activeMode)
```

Replace those lines with:

```jsx
      onComplete: () => {
        setThinkingAgent(null)
        setSpeakingAgent(null)
        setStatus('complete')
      },
      onSpeakingStart: (agentId) => {
        setSpeakingAgent(agentId)
      },
      onSpeakingEnd: () => {
        setSpeakingAgent(null)
      }
    }, activeMode, () => mutedRef.current)
```

Two changes: (a) the `onComplete` body now also clears `speakingAgent` defensively, (b) two new callbacks added, (c) `runDebate` gets a fifth argument `() => mutedRef.current`.

- [ ] **Step 5: Add the speaker icon button to the header**

Find the header buttons area. The Stop button currently lives around lines 265-289. Just above it (before the conditional `{status === 'running' && (...Stop button...)}` block), add:

```jsx
          <button
            onClick={() => setMuted(m => !m)}
            aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute' : 'Mute'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0.35rem',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
              cursor: 'pointer',
              transition: 'all var(--transition)'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--text-primary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
```

**Watch out:** insert this inside the existing `<div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>` that wraps the Stop / New Debate buttons (line 254). The mute button should appear before the Stop button. Confirm by reading lines 253-290.

- [ ] **Step 6: Pass `speakingAgent` to DebateGraph**

Find the `<DebateGraph ... />` element (around line 383). The current props are:

```jsx
            <DebateGraph
              graphData={graphData}
              thinkingAgent={thinkingAgent}
              onNodeClick={handleClaimClick}
              selectedNode={selectedNode}
              status={status}
              claims={allClaims}
            />
```

Add a `speakingAgent` prop:

```jsx
            <DebateGraph
              graphData={graphData}
              thinkingAgent={thinkingAgent}
              speakingAgent={speakingAgent}
              onNodeClick={handleClaimClick}
              selectedNode={selectedNode}
              status={status}
              claims={allClaims}
            />
```

- [ ] **Step 7: Also clear speakingAgent in handleStop / handleNewDebate**

Find `handleStop` (around line 117):

```jsx
  const handleStop = () => {
    if (cancelRef.current) cancelRef.current()
    cancelRef.current = null
    setThinkingAgent(null)
    setStatus('complete')
  }
```

Replace with:

```jsx
  const handleStop = () => {
    if (cancelRef.current) cancelRef.current()
    cancelRef.current = null
    setThinkingAgent(null)
    setSpeakingAgent(null)
    setStatus('complete')
  }
```

Find `handleNewDebate` (around line 124):

```jsx
  const handleNewDebate = () => {
    if (cancelRef.current) cancelRef.current()
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
    setStatus('idle')
    setTopic('')
    setAllClaims([])
    setGraphData({ nodes: [], links: [] })
    setThinkingAgent(null)
    setVerdictText(null)
    setRoundResults([])
    setError(null)
  }
```

Add `setSpeakingAgent(null)` near the other `set*(null)` lines:

```jsx
  const handleNewDebate = () => {
    if (cancelRef.current) cancelRef.current()
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
    setStatus('idle')
    setTopic('')
    setAllClaims([])
    setGraphData({ nodes: [], links: [] })
    setThinkingAgent(null)
    setSpeakingAgent(null)
    setVerdictText(null)
    setRoundResults([])
    setError(null)
  }
```

- [ ] **Step 8: Verify build is clean**

Run: `npm run build`

Expected: Build succeeds. No errors about unused imports or undefined identifiers.

- [ ] **Step 9: Verify lint is clean**

Run: `npm run lint`

Expected: No new errors.

- [ ] **Step 10: Commit**

```bash
git add src/App.jsx
git commit -m "feat: mute toggle + speaker indicator wiring in App

Header speaker icon (lucide Volume2/VolumeX) toggles muted state.
Mute via useEffect calls stopAudio() to cut in-progress speech.
speakingAgent state tracks active TTS via new orchestrator callbacks
and is passed down to DebateGraph for the ring animation."
```

---

## Task 6: TopicInput primeAudio

**Files:**
- Modify: `src/components/TopicInput.jsx`

Tiny change — call `primeAudio()` inside the form submit handler so the silent MP3 plays during the user gesture and unlocks autoplay for the rest of the session.

- [ ] **Step 1: Add the import**

In `src/components/TopicInput.jsx`, change the top of the file:

```jsx
import { useState } from 'react'
```

to:

```jsx
import { useState } from 'react'
import { primeAudio } from '../lib/audio.js'
```

- [ ] **Step 2: Call `primeAudio()` in `handleSubmit`**

Find the existing `handleSubmit` (line 55-58):

```jsx
  const handleSubmit = (e) => {
    e.preventDefault()
    if (topic.trim()) onStart(topic.trim(), mode)
  }
```

Replace with:

```jsx
  const handleSubmit = (e) => {
    e.preventDefault()
    if (topic.trim()) {
      primeAudio()
      onStart(topic.trim(), mode)
    }
  }
```

- [ ] **Step 3: Verify build is clean**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/TopicInput.jsx
git commit -m "feat: prime audio context on Start click

Plays a silent MP3 during the user gesture so the first turn's TTS
playback isn't blocked by the browser's autoplay policy."
```

---

## Task 7: DebateGraph speaker rings

**Files:**
- Modify: `src/components/DebateGraph.jsx`

Add `speakingAgent` prop and a dedicated `useEffect` that inserts pulsing rings before `.agent-anchors` in the SVG (so anchors render on top, rings appear to emanate from behind).

- [ ] **Step 1: Add `speakingAgent` to the prop list**

Find line 36 in `src/components/DebateGraph.jsx`:

```jsx
export default function DebateGraph({ graphData, thinkingAgent, onNodeClick, selectedNode, status, claims }) {
```

Replace with:

```jsx
export default function DebateGraph({ graphData, thinkingAgent, speakingAgent, onNodeClick, selectedNode, status, claims }) {
```

- [ ] **Step 2: Add the dedicated speaker-rings effect**

The file already has a main `useEffect` block that uses `select(svgRef.current)`. Find the END of that main effect (it's the largest useEffect in the file — ends roughly before the JSX `return` statement around line 433).

Just before the `return` statement (and after all existing useEffects), add this new effect:

```jsx
  // Speaker rings — emanate from the active speaker's anchor.
  // Lives in its own effect to avoid triggering the main re-render on every audio start/end.
  useEffect(() => {
    const svg = select(svgRef.current)
    svg.select('.speaker-rings').remove()

    if (!speakingAgent || !LAYOUT[speakingAgent]) return

    const anchor = LAYOUT[speakingAgent].anchor
    const color = AGENTS[speakingAgent].color
    const ANCHOR_RADIUS = 40

    const anchorGroupExists = !svg.select('.agent-anchors').empty()
    const ringsGroup = anchorGroupExists
      ? svg.insert('g', '.agent-anchors').attr('class', 'speaker-rings')
      : svg.append('g').attr('class', 'speaker-rings')

    ringsGroup
      .attr('transform', `translate(${anchor.x},${anchor.y})`)
      .attr('pointer-events', 'none')

    for (let i = 0; i < 3; i++) {
      ringsGroup.append('circle')
        .attr('r', ANCHOR_RADIUS)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('class', `speaker-ring speaker-ring-${i + 1}`)
    }

    return () => { svg.select('.speaker-rings').remove() }
  }, [speakingAgent, graphData])
```

**Why `graphData` in the dependency array:** the main effect wipes the whole SVG (`svg.selectAll('*').remove()`) and re-creates it whenever `graphData` changes. Re-firing on `graphData` re-adds the rings after the wipe so they don't disappear when a new claim arrives mid-speech.

- [ ] **Step 3: Verify build is clean**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 4: Visual verification deferred**

Visual verification requires the CSS keyframes (Task 8). Skip browser test until both are in.

- [ ] **Step 5: Commit**

```bash
git add src/components/DebateGraph.jsx
git commit -m "feat: speaker rings effect on DebateGraph

Dedicated D3 useEffect inserts a .speaker-rings group before
.agent-anchors so anchor nodes draw over the rings. Three concentric
circles per active agent get CSS-animated by theme.css rules
(added in next commit)."
```

---

## Task 8: theme.css speaker-pulse keyframes

**Files:**
- Modify: `src/styles/theme.css`

Add the keyframes and ring rules next to the existing animation rules.

- [ ] **Step 1: Find the existing keyframes**

Run: `grep -n "@keyframes" src/styles/theme.css`

Expected lines: `thinking-dot`, `node-pulse`, `agree-pulse`, `border-shimmer`. Note their positions.

- [ ] **Step 2: Append the new keyframes and rules to the end of the file**

At the end of `src/styles/theme.css`, append:

```css

/* ── TTS speaker pulse rings (used by DebateGraph) ───────────── */
@keyframes speakerPulse {
  from { transform: scale(1);   opacity: 0.8; }
  to   { transform: scale(2.6); opacity: 0;   }
}

.speaker-ring {
  animation: speakerPulse 1.6s ease-out infinite;
  transform-origin: center center;
  transform-box: fill-box;
}

.speaker-ring-2 { animation-delay: 0.55s; }
.speaker-ring-3 { animation-delay: 1.10s; }
```

- [ ] **Step 3: Commit**

```bash
git add src/styles/theme.css
git commit -m "feat: speakerPulse keyframes for active-speaker rings

Three staggered animations (0s / 0.55s / 1.10s delays) on a 1.6s
loop produce a continuous emanation effect. transform-box: fill-box
lets transform-origin: center resolve correctly inside SVG."
```

---

## Task 9: End-to-end smoke test

**Files:** none (verification only)

Manual verification with `vercel dev` running and a browser open at `http://localhost:3000`.

- [ ] **Step 1: Restart `vercel dev`**

Stop and restart `vercel dev` to make sure the latest builds are picked up cleanly.

- [ ] **Step 2: Golden-path test in Chrome (or Brave)**

Open `http://localhost:3000`. Pick any topic (e.g. "Pineapple belongs on pizza"). Click Start.

Expected:
- Round 1: Advocate text appears in left transcript. Voice plays. Green rings pulse around the top-center (Advocate) anchor.
- Voice finishes, then Critic text appears. Voice plays. Red rings pulse around the bottom-left (Critic) anchor.
- Voice finishes, then Wildcard text appears. Voice plays. Purple rings pulse around the bottom-right (Wildcard) anchor.
- Round transitions: brief pause (the existing 1s gap), then Round 2 starts.
- After Round 3, verdict text appears, then Wildcard voice speaks the verdict ("Winning arguments: …. The losing case fell short: …").
- Rings stop pulsing at end of last speech.

Common failures and fixes:
- No audio at all: check `.env.local` has `ELEVENLABS_API_KEY` (not `ELEVENLABS_API`); restart `vercel dev`.
- 4xx in Network tab on `/api/tts`: check voice IDs are correct in `.env.local`; verify request body shape in DevTools.
- Audio is choppy or doesn't start until end: MSE may have fallen back to Blob path silently. Open DevTools and `console.log(MediaSource.isTypeSupported('audio/mpeg'))` — should be `true` in Chrome/Brave.

- [ ] **Step 3: Mute mid-turn**

Start a fresh debate. During Round 2 Advocate's speech, click the speaker icon in the header.

Expected:
- Audio cuts immediately.
- Green rings disappear.
- Text continues to appear for subsequent turns; no audio plays.
- Critic's text appears as usual. Wildcard's text appears as usual.
- Verdict text appears; no verdict audio.

- [ ] **Step 4: Unmute mid-debate**

Start a fresh debate. After Round 1 Advocate finishes speaking, click mute. Wait for Critic text to appear (silent). Click mute again to unmute.

Expected:
- Round 1 Critic's speech is gone (lost), but…
- Round 1 Wildcard speaks normally.
- Subsequent turns speak normally.

- [ ] **Step 5: Stop button**

Start a fresh debate. During Round 2 audio, click the red Stop button in the header.

Expected:
- Audio cuts.
- Rings disappear.
- Debate ends gracefully ("complete" state).

- [ ] **Step 6: New Debate during audio**

Start a debate. During audio, click New Debate.

Expected:
- Audio cuts.
- Returns to topic input screen.
- Starting a new debate works with audio (kill switch was reset).

- [ ] **Step 7: TTS failure simulation**

Stop `vercel dev`. Temporarily edit `.env.local`:

```
VOICE_ID_ADVOCATE="bogus_value"
```

Restart `vercel dev`. Start a debate.

Expected:
- Advocate's first `/api/tts` call returns an error (500 from EL or similar — check server logs).
- Debate continues silently for the rest of the run.
- No rings pulse.
- No error banner appears.
- Console logs show `[audio] tts endpoint returned 500` or similar.

After confirming, restore the original `VOICE_ID_ADVOCATE` in `.env.local` and restart `vercel dev`.

- [ ] **Step 8: Forced Blob-fallback path (Chrome)**

In DevTools console while a debate is running:

```js
console.log(MediaSource.isTypeSupported('audio/mpeg'))
```

Expected: `true`. We're using MSE.

To exercise the Blob path manually on Chrome (optional): temporarily edit `src/lib/audio.js`, change:

```js
const useMSE = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported?.(MIME)
```

to:

```js
const useMSE = false
```

Reload. Start a debate.

Expected: voices still play, but each turn has a small (~500ms) lag before audio starts compared to MSE. After verifying, revert the edit.

- [ ] **Step 9: Safari Desktop (if available)**

Open `http://localhost:3000` in Safari (macOS only). Start a debate.

Expected: audio plays. May use MSE (modern Safari) or Blob fallback (older Safari) — either is acceptable.

- [ ] **Step 10: Final state check**

Run: `git status` and `git log --oneline -12`

Expected: working tree clean (apart from pre-existing untracked items in `.claude/`). Last ~7 commits should be the feature commits from Tasks 1-8 plus the design doc.

---

## Post-Implementation Checklist

- [ ] `vercel dev` runs cleanly
- [ ] First debate plays all 9 claims + verdict with voices
- [ ] Three distinct voices match the agent personas
- [ ] Pulsing rings appear at the correct anchor for each speaker
- [ ] Mute button stops audio mid-stream
- [ ] Stop button stops audio + ends debate cleanly
- [ ] Failure simulation falls back silently
- [ ] Production env vars (Vercel dashboard): `ELEVENLABS_API_KEY` + three `VOICE_ID_*` are set before merging to main

---

## Notes for the implementer

- **Do not skip the `vercel dev` restart after editing `.env.local`.** It's the #1 source of "why isn't it working" frustration.
- **`afplay /tmp/tts-test.mp3` only works on macOS.** On Linux: `mpg123` or `mpv`. On Windows: open in any media player.
- **If MSE behaves oddly, check browser DevTools → Network → the `/api/tts` request.** It should show "(pending)" while streaming, then "200 OK" with Content-Type `audio/mpeg`. The Size column shows accumulating bytes.
- **The kill switch is intentional.** A failed TTS call disables audio for the rest of the session — by design (decision #2 in the spec). Don't add retry logic.
- **Don't add unit tests.** The repo has no test framework, and the spec deliberately uses manual verification. Adding tests is scope creep.
