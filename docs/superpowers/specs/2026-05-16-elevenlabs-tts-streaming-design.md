# ElevenLabs TTS Streaming — Design

**Date:** 2026-05-16
**Branch:** `11labs`
**Status:** Approved for implementation planning

## Goal

Add per-turn voice narration to Debate Arena. Each of the three agents (Advocate, Critic, Wildcard) speaks its claim out loud as soon as the LLM response renders. The Wildcard also speaks the final verdict. Audio streams from the ElevenLabs API (`eleven_flash_v2_5`, the fastest available model) and plays in the browser as bytes arrive — not after full download.

The pacing constraint: **each turn's audio must finish playing before the next turn's LLM call starts.** Audio is the metronome of the debate.

## Key product decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Verdict spoken? | Yes — Wildcard speaks the final `winning_arguments` + `loser_gap` after rendering text. |
| 2 | TTS failure mode | Silent fallback: log error, set kill switch, debate continues text-only for the rest of the run. No user-visible banner. |
| 3 | Voice selection | I pick three ElevenLabs default-library voices as env-var defaults; user can override per agent. |
| 4 | Mute control | Speaker icon in the header (Volume2 / VolumeX from lucide-react). Mid-speech mute stops current audio immediately and clears the queue. |
| 5 | Speaker indicator | Pulsing concentric SVG rings at the speaking agent's anchor node on the debate graph during playback. |
| 6 | Browser support | MSE for true streaming (Chrome / Brave / modern Safari Desktop / Firefox); Blob-buffer fallback for iOS Safari and older browsers. |

## Architecture

### File layout

```
api/
  _shared.js        [no edits — char-budget + cache helpers already exist]
  tts.js            [NEW] POST /api/tts → streams MP3 from EL → client
  debate.js         [no edits]
  verdict.js        [no edits]

src/
  App.jsx           [edit] mute state, speaker icon, speakingAgent state, primes audio on Start
  components/
    TopicInput.jsx  [edit] call primeAudio() before delegating to onStart
    DebateGraph.jsx [edit] accept speakingAgent prop, render pulsing rings at its anchor
  lib/
    audio.js        [NEW] playAudioStream, primeAudio, stopAudio, resetAudio
                    Feature-detect MSE; Blob fallback
                    Module-level kill switch after first failure
    debate.js       [edit] await playAudioStream after each callAgent + after verdict
                    New onSpeakingStart / onSpeakingEnd callbacks
    agents.js       [no edits — voice IDs live in env, not in AGENTS map]
  styles/
    theme.css       [edit] add @keyframes speakerPulse + .speaker-ring rules
                    (alongside the existing thinking-dot / node-pulse / agree-pulse keyframes)

.env.local          [edit] rename ELEVENLABS_API → ELEVENLABS_API_KEY
                    add VOICE_ID_ADVOCATE / VOICE_ID_CRITIC / VOICE_ID_WILDCARD
```

### Component boundaries

- **`api/tts.js`** owns: auth, validation, char-budget enforcement, EL SDK call, byte forwarding. Knows nothing about debate semantics.
- **`src/lib/audio.js`** owns: MSE/Blob playback, mute checks, abort handling, fail-then-disable kill switch. Pure browser; no React.
- **`src/lib/debate.js`** owns: serial orchestration. Awaits `playAudioStream` like another step in the loop. No new state.
- **`src/App.jsx`** owns: `muted` and `speakingAgent` state; passes getters/callbacks into `runDebate`.
- **`src/components/DebateGraph.jsx`** owns: rendering the speaker rings at the right anchor.

## Backend: `api/tts.js`

### Endpoint contract

- **`POST /api/tts`**
- **Request body:** `{ agent: 'advocate' | 'critic' | 'wildcard', text: string }`
- **Success response:** `200`, `Content-Type: audio/mpeg`, `Transfer-Encoding: chunked`, body = raw MP3 bytes streamed from ElevenLabs
- **Error response:** `4xx/5xx` with JSON `{ error, code? }` — same shape as `/api/debate`

### Handler flow

1. Reject non-POST → 405.
2. `checkOrigin(req, res)` → 403 on mismatch (reuses helper).
3. Parse body. Validate:
   - `agent` ∈ `{advocate, critic, wildcard}` → 400 if not.
   - `text` is non-empty string ≤ `TTS_MAX_CHARS_PER_REQUEST` (1000, defined in `_shared.js`) → 400 if not.
4. Get IP via `getIp(req)`.
5. `checkCharBudget(ip, text.length)` → 429 if rate-limited (returns existing message).
6. Look up voice config by agent in module-local `VOICE_MAP`:
   - `voiceId` = `process.env.VOICE_ID_<AGENT>`
   - `voiceSettings` = hardcoded per agent (table below)
7. Lazy-init `ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })` at module scope.
8. Call `client.textToSpeech.stream(voiceId, { text, modelId: 'eleven_flash_v2_5', outputFormat: 'mp3_22050_32', voiceSettings })`.
9. Set headers: `Content-Type: audio/mpeg`, `Cache-Control: no-store`.
10. Async-iterate chunks: `for await (const chunk of audioStream) { if (req.aborted) break; res.write(chunk) }`.
11. `res.end()`.
12. On caught error before headers sent: `res.status(502).json({ error: 'AI service temporarily unavailable' })` and log. If headers already sent (mid-stream failure): just `res.destroy()`, client sees a truncated stream and treats it like a failure.

### Voice settings (hardcoded per agent in `tts.js`)

| Agent | stability | similarityBoost | style | speakerBoost |
|---|---|---|---|---|
| Advocate | 0.4 | 0.75 | 0.3 | true |
| Critic | 0.6 | 0.75 | 0.2 | true |
| Wildcard | 0.5 | 0.75 | 0.4 | true |

### Voice IDs (defaults — set in `.env.local`)

| Agent | Voice | ID |
|---|---|---|
| Advocate | Adam (deep, confident) | `pNInz6obpgDQGcFmaJgB` |
| Critic | Rachel (clear, articulate) | `21m00Tcm4TlvDq8ikWAM` |
| Wildcard | Antoni (warm, measured) | `ErXwobaYiN019PkySvjV` |

*Caveat:* if any return 404 from the user's ElevenLabs account, swap via env without code change.

### Env var migration

`.env.local` currently has `ELEVENLABS_API="sk_..."`. Rename to `ELEVENLABS_API_KEY` (matches SDK convention). Single-pass rename, no backward-compat shim needed (one-developer project).

### Billing & cache (v1 deferred decisions)

- **Up-front char billing:** `checkCharBudget` deducts full text length before streaming starts. If user mutes mid-stream, we've still billed all chars. Trade-off acceptable for v1 — refund logic is fragile and per-debate cost is tiny.
- **No cache writes:** The existing `setCachedTts` helper is *not* called in v1. The scaffolding stays for a future "replay last debate" feature.

## Frontend: `src/lib/audio.js`

### Public API

```js
// Plays the given text as the named agent. Resolves when audio finishes,
// is aborted, is muted, or the kill switch was already set.
// Never throws — failures resolve silently and arm the kill switch.
playAudioStream(text, {
  agent,            // 'advocate' | 'critic' | 'wildcard'
  signal,           // AbortSignal — wired to the debate's abortController
  getMuted,         // () => boolean — read current mute state lazily
  onPlaybackStart,  // (agent) => void — fires once when audio is actually audible
  onPlaybackEnd     // (agent) => void — fires once on end/abort/mute. Idempotent.
}): Promise<void>

// Play a 1-byte silent MP3 data-URL to unlock the autoplay policy.
// Call this from the user-gesture handler (Start click).
primeAudio(): void

// Immediately stops the currently-playing audio element, if any.
// Used by App.jsx when mute toggles on mid-playback.
stopAudio(): void

// Clears the module-level kill switch and any stale state.
// Called at the top of each runDebate invocation.
resetAudio(): void
```

### Internal flow

```
playAudioStream(text, opts):
  if audioDisabled || opts.getMuted():
    return  // resolves immediately, no playback callbacks fired

  try:
    response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({ agent: opts.agent, text })
    })
    if !response.ok:
      audioDisabled = true
      return  // silent

    if MediaSource.isTypeSupported('audio/mpeg'):
      await playViaMSE(response.body, opts)
    else:
      await playViaBlob(response.body, opts)
  catch (err):
    if err.name === 'AbortError': return  // expected
    audioDisabled = true  // silent kill
```

### MSE path (Chrome / Brave / Safari Desktop 17+ / Firefox)

```
mediaSource = new MediaSource()
audio = new Audio()
audio.src = URL.createObjectURL(mediaSource)
currentAudio = audio                  // module-level ref for stopAudio()
await sourceopen event
sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')
reader = response.body.getReader()
started = false

playbackEnded = new Promise((resolve) => {
  audio.onended = resolve
  signal.addEventListener('abort', () => { audio.pause(); resolve() })
})

try:
  loop:
    if signal.aborted || getMuted():
      audio.pause()
      break
    { done, value } = await reader.read()
    if done:
      mediaSource.endOfStream()
      break
    while sourceBuffer.updating:
      await updateend event
    sourceBuffer.appendBuffer(value)
    if !started:
      started = true
      onPlaybackStart?.(agent)
      audio.play().catch(() => { audioDisabled = true })
finally:
  await playbackEnded
  onPlaybackEnd?.(agent)        // idempotent guard inside the function
  URL.revokeObjectURL(audio.src)
  currentAudio = null
```

### Blob fallback (iOS Safari < 17, very old browsers)

```
reader = response.body.getReader()
chunks = []

loop:
  if signal.aborted || getMuted(): return
  { done, value } = await reader.read()
  if done: break
  chunks.push(value)

blob = new Blob(chunks, { type: 'audio/mpeg' })
audio = new Audio(URL.createObjectURL(blob))
currentAudio = audio

await new Promise((resolve) => {
  audio.onended = resolve
  signal.addEventListener('abort', () => { audio.pause(); resolve() })
  onPlaybackStart?.(agent)
  audio.play().catch(() => { audioDisabled = true; resolve() })
})
onPlaybackEnd?.(agent)
URL.revokeObjectURL(audio.src)
currentAudio = null
```

### Module state

```js
let audioDisabled = false         // kill switch — true after first failure
let currentAudio = null           // active <audio> element (or null) — used by stopAudio
let currentResolve = null         // resolver for the active playback Promise — used by stopAudio
```

### How stopAudio() unblocks the orchestrator

The orchestrator `await`s a `playbackEnded` Promise that normally resolves on `audio.onended`. But `audio.pause()` does NOT fire `onended` — so calling `stopAudio()` (which just pauses) would leave the orchestrator hanging.

Solution: keep a module-level `currentResolve` ref pointing at the active Promise's resolver. `stopAudio()` pauses the audio AND calls `currentResolve()` directly:

```js
export function stopAudio() {
  if (currentAudio) { currentAudio.pause() }
  if (currentResolve) { currentResolve(); currentResolve = null }
}
```

Inside `playAudioStream`:

```js
const playbackEnded = new Promise((resolve) => {
  currentResolve = resolve
  audio.onended = () => resolve()
  audio.onerror = () => resolve()        // safety net for codec/network errors
  signal.addEventListener('abort', () => { audio.pause(); resolve() })
})
```

All three paths (natural end, abort, stopAudio) feed the same resolver. `onPlaybackEnd` is guarded by a `called` flag so it fires exactly once regardless of which path resolved first.

### Callback contract

- `onPlaybackStart(agent)` fires **exactly once** when audio first becomes audible (after `audio.play()` resolves successfully). It does **not** fire if muted/disabled at call start, if fetch fails, or if abort happens before first chunk.
- `onPlaybackEnd(agent)` fires **exactly once** at end-of-life (natural end, abort, or mute). Idempotent — wrapped in a `called` flag to prevent double-fire from racing `onended` and `signal.abort`.
- If `onPlaybackStart` never fires, `onPlaybackEnd` also never fires (paired lifecycle).

## Orchestrator: `src/lib/debate.js`

### Signature change

```js
runDebate(topic, maxRounds, callbacks, mode = 'fast', getMuted = () => false)
```

### Callback bag additions

```js
{
  // ...existing callbacks
  onSpeakingStart: (agentId) => void,
  onSpeakingEnd:   (agentId) => void
}
```

### Loop body additions

At the top of `runDebate`, call `resetAudio()`.

After each `callAgent` (inside the inner `for` loop, after `onAgentComplete`):

```js
// Concatenate claims (current parser returns exactly one, but defensive).
// Truncate to TTS endpoint max (1000 chars) — silent truncate, deep-mode
// claims rarely exceed 600 chars in practice.
let textToSpeak = newClaims.map(c => c.text).join(' ')
if (textToSpeak.length > 1000) textToSpeak = textToSpeak.slice(0, 1000)

await playAudioStream(textToSpeak, {
  agent: agentId,
  signal: abortController.signal,
  getMuted,
  onPlaybackStart: () => onSpeakingStart?.(agentId),
  onPlaybackEnd:   () => onSpeakingEnd?.(agentId)
})
```

After verdict (between `onVerdict(verdict)` and `onComplete()`):

**Important:** `callVerdictAgent` returns a parsed *object* `{ winningArguments: string[], loserGap: string }`, NOT a raw string. The existing variable name `verdictText` in `debate.js` line 48 is misleading. The orchestrator should rename it to `verdict` for clarity OR build the TTS string from the object properties directly.

```js
if (!abortController.signal.aborted) {
  const verdictForTts = buildVerdictTtsString(verdict)  // verdict is the object
  await playAudioStream(verdictForTts, {
    agent: 'wildcard',
    signal: abortController.signal,
    getMuted,
    onPlaybackStart: () => onSpeakingStart?.('wildcard'),
    onPlaybackEnd:   () => onSpeakingEnd?.('wildcard')
  })
}
```

### Verdict TTS string template

```js
function buildVerdictTtsString(verdict) {
  const args = (verdict.winningArguments || []).join('. ')
  const gap = verdict.loserGap || ''
  const combined = `Winning arguments: ${args}. The losing case fell short: ${gap}`
  return combined.length > 1000 ? combined.slice(0, 1000) : combined
}
```

### Cancellation

The existing `abortController` is reused. Passing its signal to `playAudioStream` means Stop / New Debate cancels audio cleanly — fetch aborts mid-stream, `playbackEnded` resolves via the abort listener, the loop exits.

## App.jsx changes

### New state

```js
const [muted, setMuted] = useState(false)
const mutedRef = useRef(muted)
useEffect(() => { mutedRef.current = muted }, [muted])

const [speakingAgent, setSpeakingAgent] = useState(null)
```

### runDebate invocation

Pass `() => mutedRef.current` as the new `getMuted` argument:

```js
const cancel = runDebate(debateTopic, maxRounds, {
  // ...existing callbacks
  onSpeakingStart: (agentId) => setSpeakingAgent(agentId),
  onSpeakingEnd:   () => setSpeakingAgent(null),
  // ...
}, activeMode, () => mutedRef.current)
```

### Mute side effect

```js
useEffect(() => {
  if (muted) stopAudio()
}, [muted])
```

This kills active playback the instant mute toggles on. `playAudioStream`'s abort listener fires, the loop proceeds to the next turn.

### Header button

Placed next to the existing Stop / New Debate buttons (around line 265 of App.jsx). Visible during `status ∈ {running, complete}`.

```jsx
import { Volume2, VolumeX } from 'lucide-react'

<button
  onClick={() => setMuted(m => !m)}
  aria-label={muted ? 'Unmute' : 'Mute'}
  title={muted ? 'Unmute' : 'Mute'}
  style={{ ...iconButtonStyle }}
>
  {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
</button>
```

Default state: `false` (unmuted). The demo is "AI debates out loud" — defaulting muted defeats the purpose.

### DebateGraph prop

Pass `speakingAgent` to the existing `<DebateGraph>` element:

```jsx
<DebateGraph
  graphData={graphData}
  thinkingAgent={thinkingAgent}
  speakingAgent={speakingAgent}
  // ...existing props
/>
```

## TopicInput.jsx changes

In the Start handler, call `primeAudio()` before delegating to `onStart`:

```js
import { primeAudio } from '../lib/audio.js'

function handleStart() {
  primeAudio()
  onStart(topic, mode)
}
```

This satisfies the browser's autoplay policy by playing a silent buffer during the user gesture, so the first turn's audio can start automatically.

## DebateGraph.jsx changes

### Important: DebateGraph is D3-imperative

`DebateGraph.jsx` renders via D3, not JSX. The SVG element is self-closing (`<svg ref={svgRef} />`), and all children are created in a `useEffect` that clears the SVG (`svg.selectAll('*').remove()`) and re-creates everything. Adding `speakingAgent` to that effect's dependency array would trigger a full re-render every time audio starts/ends — expensive.

**Solution: a separate, dedicated useEffect for the speaker rings only.** This effect appends/removes a single `<g class="speaker-rings">` element without touching the rest of the SVG.

### New prop

```js
export default function DebateGraph({
  graphData, thinkingAgent, speakingAgent,
  onNodeClick, selectedNode, status, claims
}) { ... }
```

### Speaker rings effect

Added near the other useEffects, separate from the main re-render:

```js
const ANCHOR_RADIUS = 40   // matches the existing anchor radius (line ~366 in current code)

useEffect(() => {
  const svg = select(svgRef.current)
  // Remove any previous rings
  svg.select('.speaker-rings').remove()

  if (!speakingAgent || !LAYOUT[speakingAgent]) return

  const anchor = LAYOUT[speakingAgent].anchor
  const color = AGENTS[speakingAgent].color

  // Insert BEFORE the agent-anchors group so rings render UNDER the anchor node
  // (creates the "emanating from behind" effect)
  const ringsGroup = svg.select('.agent-anchors').empty()
    ? svg.append('g').attr('class', 'speaker-rings')
    : svg.insert('g', '.agent-anchors').attr('class', 'speaker-rings')

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
}, [speakingAgent])
```

**Layering note:** the rings are inserted *before* `.agent-anchors` in the SVG DOM order, so the anchor node draws on top. The rings appear to emanate from behind the anchor — which is the desired effect (the anchor stays clearly visible as the source, rings expand outward).

**Re-render protection:** the main `useEffect` (which rebuilds the whole SVG) does NOT depend on `speakingAgent`. Each time the main effect runs, it wipes `.speaker-rings` too (because of `svg.selectAll('*').remove()`). The speaker effect re-adds them on the next render via the dependency on `speakingAgent`. To avoid the flicker window, the speaker effect should also re-fire when `graphData` changes (so the rings get re-added after the main effect clears them).

```js
}, [speakingAgent, graphData])  // re-add after main effect wipes the SVG
```

### CSS additions (in the existing stylesheet)

```css
@keyframes speakerPulse {
  from { transform: scale(1);   opacity: 0.8; }
  to   { transform: scale(2.6); opacity: 0;   }
}

.speaker-ring {
  animation: speakerPulse 1.6s ease-out infinite;
  transform-origin: center center;
  transform-box: fill-box;        /* SVG: scale around element center */
}
.speaker-ring-2 { animation-delay: 0.55s; }
.speaker-ring-3 { animation-delay: 1.10s; }
```

`transform-box: fill-box` makes `transform-origin: center` work for SVG elements that don't have an inherent CSS box.

## Env vars

### `.env.local` changes

```bash
# Rename (single pass — no shim)
- ELEVENLABS_API="sk_..."
+ ELEVENLABS_API_KEY="sk_..."

# New
+ VOICE_ID_ADVOCATE="pNInz6obpgDQGcFmaJgB"   # Adam
+ VOICE_ID_CRITIC="21m00Tcm4TlvDq8ikWAM"     # Rachel
+ VOICE_ID_WILDCARD="ErXwobaYiN019PkySvjV"   # Antoni
```

Production: add the same four to Vercel project env via dashboard or `vercel env add`.

### Existing TTS env (no changes — already set in `_shared.js`)

- `TTS_CHARS_IP_DAILY` (default 20_000)
- `TTS_CHARS_GLOBAL_DAILY` (default 200_000)
- `TTS_MAX_CHARS_PER_REQUEST` (default 1000)
- `TTS_CACHE_TTL_SECONDS` (default 604_800, unused in v1)

## Edge cases

| Case | Behavior |
|---|---|
| User clicks Stop mid-audio | abortController signal fires → audio pauses, promise resolves, loop exits cleanly. |
| User clicks New Debate mid-audio | Stop path + `resetAudio()` called at next `runDebate` start. |
| Mute toggled during turn 2's audio | `stopAudio()` pauses current `<audio>`. The MSE/Blob path's getMuted check exits the chunk loop. Promise resolves; loop proceeds to turn 3 (which checks getMuted → no audio). |
| Mute toggled then unmuted same debate | Audio resumes for turn N+1 onward; the just-muted turn's audio is gone (no rewind). |
| TTS returns 429 (char budget hit) | `audioDisabled = true`. Debate finishes silently. No banner — failure mode #1. |
| TTS API key invalid | Same — 502 or auth error → silent disable. Server logs it. |
| Browser refuses autoplay | First `play()` rejection → `audioDisabled = true`. Next Start click re-primes; the new debate's `resetAudio()` clears the flag and tries again. |
| Two debates back-to-back | `resetAudio()` clears the kill switch at top of `runDebate`. |
| `mode === 'deep'` claim > 1000 chars | TTS endpoint returns 400. `playAudioStream` arms the kill switch. **Mitigation in client:** truncate text to 1000 chars at the orchestrator before calling `playAudioStream`. (Loud "deep" claims rarely exceed 600 chars in practice; truncate is silent and v1-appropriate.) |
| MSE rejects `appendBuffer` (rare codec issue) | Caught; kill switch armed; current audio stops. |
| Multiple agents in same round (current code: 1 each) | Current architecture has exactly one agent speaking at a time, sequenced by the outer loop. No concurrency risk. |

## Browser support

| Browser | MSE path | Fallback path |
|---|---|---|
| Chrome (desktop & Android) | ✅ MSE — true streaming | n/a |
| Brave | ✅ MSE | n/a |
| Firefox | ✅ MSE | n/a |
| Safari Desktop 17+ | ✅ MSE (95% confidence — feature-detect catches if not) | Blob if MSE rejects `audio/mpeg` |
| Safari Desktop < 17 | Unlikely to support `audio/mpeg` in MSE | Blob fallback |
| Safari iOS 17.1+ | No (regular MSE not exposed; would need ManagedMediaSource) | Blob fallback |
| Safari iOS < 17.1 | No MSE | Blob fallback |

The feature-detect (`MediaSource.isTypeSupported('audio/mpeg')`) determines path at module load. No runtime branching cost.

## Testing plan (manual — no test suite exists)

1. **Golden path (Chrome):** Start a debate. Hear 3 voices in order across 3 rounds. Hear verdict spoken. Confirm rings pulse at the correct agent anchor during each turn.
2. **Mute mid-turn:** Click mute during round 2 advocate. Audio stops immediately. Round 2 critic plays nothing (silent until unmute). Unmute during round 2 wildcard → wildcard speaks.
3. **Stop button:** Click Stop during audio. Audio cuts, debate ends.
4. **New Debate during audio:** Click New Debate. Audio cuts, idle screen appears, next debate starts with audio working.
5. **TTS failure simulation:** Temporarily set `VOICE_ID_ADVOCATE=invalid`. First agent's TTS fails. Debate continues silently. No banner.
6. **Char budget overflow simulation:** Set `TTS_CHARS_IP_DAILY=1` in env. First TTS call gets 429. Debate finishes silently.
7. **Safari Desktop:** Run end-to-end in Safari. If MSE works, verify true streaming. If not, verify Blob fallback plays audio.
8. **Forced Blob path:** Comment out the MSE branch in `audio.js` temporarily; verify Blob path works on Chrome. Restore.
9. **Backgrounded tab:** Switch tabs during audio. Verify audio continues playing (browser default).
10. **Speaker ring positions:** Visually verify each ring sits on the correct anchor (Advocate top-center, Critic bottom-left, Wildcard bottom-right).

## Out of scope (v1)

- Server-side cache writes (the `_shared.js` scaffolding stays for v2).
- Replay buttons / per-claim playback.
- Volume slider (mute is binary).
- Visual "speaking" indicator beyond the graph rings (no second indicator in transcript).
- iOS Safari `ManagedMediaSource` dedicated path (Blob fallback covers it).
- Per-claim voice customization beyond agent.
- Tunable voice settings via UI.

## Implementation order (rough)

1. Backend: `api/tts.js` + env-var rename + voice IDs.
2. Frontend: `src/lib/audio.js` with MSE + Blob paths.
3. Orchestrator: `src/lib/debate.js` integration.
4. UI: `src/App.jsx` mute state + speakerAgent state + header icon.
5. UI: `src/components/TopicInput.jsx` primeAudio call.
6. UI: `src/components/DebateGraph.jsx` speaker rings.
7. CSS: keyframes + ring styles.
8. End-to-end manual testing.

Detailed step-by-step plan to be produced by the writing-plans skill from this design.
