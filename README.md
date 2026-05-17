# ⚔ Debate Arena

Three AI models debate any topic in real time. A live D3 argument graph shows how claims connect, clash, and evolve across rounds. Each agent speaks with its own ElevenLabs voice, streamed with word-level timing so the transcript karaokes along. A neutral judge then declares the winner.

**[Try it live →](https://debate-arena-ten.vercel.app)**

## How It Works

1. **Enter a topic.** Any statement worth arguing about.
2. **Three AI agents debate** across 3 rounds:
   - 🟢 **Advocate** (Gemini 3.1 Pro) argues *for* the statement.
   - 🔴 **Critic** (GPT-5.5) argues *against* the statement.
   - 🟣 **Wildcard** (Claude Sonnet 4.6) challenges both sides, then judges each round.
3. **A force-directed graph builds in real time.** Nodes are claims, edges show the Wildcard's rebuttals and agreements. Advocate↔Critic attacks are omitted as predictable.
4. **Each claim is spoken** via ElevenLabs as the LLM is still writing it: prose tokens feed a sentence chunker, each sentence streams to ElevenLabs, audio frames pipe back through one NDJSON response with **word-level karaoke** alignment for the transcript.
5. **The Wildcard delivers a verdict** covering the strongest arguments and the loser's biggest gap, also spoken with per-word karaoke and a "is reading debate verdict" indicator.
6. **Already-debated topics replay instantly** from cache: same audio, same graph, same karaoke, no LLM or TTS calls.
7. **Aborted debates retain their work.** Per-call LLM responses and per-claim TTS streams are independently cached, so partial runs aren't wasted.

Two debate modes:
- **Fast.** 24-word headline-style claims, ~100 tokens per turn.
- **Deep.** 2 to 3 sentence arguments with evidence, ~800 tokens per turn.

## Models

Each agent is routed to a different provider so the debate is a cross-lab matchup. All three are env-overridable. Where the provider exposes a knob, reasoning effort is pegged to `low` for "fair fight" compute parity (Google `thinkingLevel: 'low'` and OpenAI `reasoning_effort: 'low'`). Anthropic Sonnet 4.6 has no equivalent parameter, so it runs at its default reasoning level.

| Role | Voice | Provider | Model (production) | Env var |
|------|-------|----------|--------------------|---------|
| Advocate | argues *for* | Google | `gemini-3.1-pro-preview` (thinkingLevel: `low`) | `GOOGLE_MODEL` |
| Critic | argues *against* | OpenAI | `gpt-5.5-turbo` (reasoning_effort: `low`) \* | `OPENAI_MODEL` |
| Wildcard | challenges + judges | Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_MODEL` |

\* Production value, set via the env var. The hard-coded fallback in `api/_shared.js` is `gpt-4o` (kept lower to avoid surprise costs on a fresh clone with no env override). Anthropic and Google code fallbacks match their production values.

The Wildcard pulls double duty: each round it picks one claim to rebut and one (from the other agent) to agree with. Those `agrees_with` picks tally into the live score, and the same model writes the final verdict via `/api/verdict`.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Frontend (React 19 + Vite 8, no TS, no state lib)                   │
│                                                                      │
│  TopicInput ──► runDebate() ──► cache-check                          │
│                       │            │                                 │
│                       │            ├─► replayCached()  (cache hit)   │
│                       │            │                                 │
│                       └─► hasMSE() branch (live path)                │
│                            │                                         │
│                            ├─► liveGenStreaming()  (MSE-capable)     │
│                            │     startClaimStream → /api/debate-stream│
│                            │     parses chunk_meta/audio/claim_complete│
│                            │                                         │
│                            └─► liveGenLegacy()  (iOS Safari)         │
│                                  callAgent → /api/debate (JSON)      │
│                                  speakClaim → /api/tts  (NDJSON)     │
│                                                                      │
│  audio.js: MSE buffering + cumulative alignment offset → onWords     │
└──────┬───────────────────────────────────────────────────────────────┘
       │  GET /api/debate-cache      POST /api/debate-stream  (MSE)
       │  POST /api/debate-cache     POST /api/debate, /api/tts (iOS)
       │                             POST /api/verdict + /api/tts
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Backend (Vercel Serverless Functions, Node.js)                      │
│                                                                      │
│  api/debate-stream.js  ─► LLM SSE → _streaming state machine →       │
│                           _chunker.SentenceChunker → serial EL       │
│                           streamWithTimestamps (previousText for     │
│                           prosody continuity). Emits NDJSON events:  │
│                           {chunk_meta, audio, claim_complete, error} │
│  api/debate.js         ─► non-streaming claim (legacy path, iOS)     │
│  api/tts.js            ─► non-streaming TTS  (legacy path + verdict) │
│  api/verdict.js        ─► wildcard final judgement (~150 tokens)     │
│  api/debate-cache.js   ─► GET (lookup) / POST (validated write)      │
│                                                                      │
│  api/_shared.js        ─► provider LLM clients (callX + streamX),    │
│                           rate limit, validation, cache helpers      │
│  api/_prompts.js       ─► templates + BEHAVIOR_HASH (cache key)      │
│  api/_chunker.js       ─► SentenceChunker (softMax 80, hardMax 200)  │
│  api/_streaming.js     ─► TEXT/META state machine, parseMetaTrailer  │
│  api/_tts.js           ─► EL client singleton, VOICE_MAP, voice IDs  │
└──────┬───────────────────────────────────────────────────────────────┘
       │  Upstash Redis (Vercel Marketplace)
       ▼
  Daily counters: debates (per-IP, global), TTS chars (per-IP, global)
  Locks:          per-IP debate cooldown
  Cache layer 1:  debate text       : full claims + verdict       (30d)
  Cache layer 2:  LLM responses     : raw provider output         (30d)
  Cache layer 3a: TTS audio (legacy): single-shot NDJSON blob     (30d)
  Cache layer 3b: TTS stream        : multi-chunk NDJSON blob     (30d)
```

### Data Flow

1. User submits a topic, and `runDebate()` first hits `GET /api/debate-cache?topic=…&mode=…`.
2. **Cache hit:** `replayCached()` dispatches the same UI callbacks the live path would (per-agent toasts, transcript appends, TTS playback through the legacy `/api/tts` endpoint). LLM calls are skipped entirely.
3. **Cache miss:** the orchestrator branches on `hasMSE()`.
4. **MSE-capable clients (`liveGenStreaming`):** for each claim, open `POST /api/debate-stream` with `{ topic, history, round, agent, mode }`. The server streams LLM tokens through a `TEXT/META` state machine into a `SentenceChunker`. Each sentence is fed to ElevenLabs `streamWithTimestamps` (with `previousText` for prosody), and audio frames are forwarded to the client as NDJSON `audio` events. After the last chunk, a `claim_complete` event carries `{ fullText, rebuts, agrees_with }`. The client demuxes, feeds bytes to `MediaSource`, and applies a cumulative time offset so multi-chunk alignment data lines up into one karaoke timeline.
5. **iOS Safari and other no-MSE clients (`liveGenLegacy`):** the original two-step path. `POST /api/debate` returns a structured claim, then `POST /api/tts` returns a single-shot NDJSON blob. Identical to the pre-refactor flow.
6. Either way, claims push into `allClaims` and `buildGraphData()` regenerates D3 nodes and links.
7. After 3 rounds, `POST /api/verdict` (pre-fetched during the last wildcard's audio) returns the Wildcard's summary. The verdict always speaks through the legacy `playAudioStream` + `/api/tts` path, so iOS and desktop share the same verdict code.
8. On clean completion (verdict plus all 9 claims), `POST /api/debate-cache` writes the debate for the next viewer (`keepalive: true` so a same-tab nav doesn't kill it).

### Claim ID Format

Each claim gets a deterministic ID: `{prefix}_r{round}_{index}`

- Prefixes: `adv` (Advocate), `crt` (Critic), `wld` (Wildcard).
- Example: `crt_r2_1` is the Critic's first claim in round 2.
- The streaming parser enforces a single claim per agent per turn, so the index is always `1` on that path; the legacy path supports indices 1+.
- Server validates claim IDs against `/^[a-z]{3}_r\d{1,2}_\d{1,2}$/` plus an expected-count check derived from `(round, agent)`.

### Agent Response Format

Agents emit a prose-first envelope rather than raw JSON:

```
TEXT:
<one paragraph of debate claim text>
---META---
{"rebuts": "adv_r1_1", "agrees_with": "crt_r1_1"}
```

The streaming server's state machine consumes `TEXT:` prose tokens and forwards them to the chunker the instant they arrive; the `---META---` trailer is parsed at the end of the stream for the `claim_complete` event. The legacy `agents.js` parser also accepts pure JSON (`{"claims":[{...}]}`) as a fallback for cached entries written pre-refactor.

## ElevenLabs TTS Streaming

A single endpoint produces interleaved TTS audio as the LLM is still writing the claim, so first-byte latency is bounded by *sentence one*, not *the full claim*. Two design choices make this work: prose is chunked on sentence boundaries before going to ElevenLabs, and `previousText` carries prosody across chunks so the voice doesn't reset mid-utterance.

### Server: `api/debate-stream.js` (streaming path)

```
   POST /api/debate-stream  { topic, agent, round, history, mode }
        │
        ├─ checkOrigin / validate agent + round + history
        ├─ rateLimit (cooldown only fires on round=1, advocate)
        ├─ resolve voiceId from VOICE_ID_<AGENT> env var
        │
        ├─ llmKey = sha256(provider, model, prompts, maxTokens)
        ├─ if getCachedLlm(llmKey):
        │     extract fullText + meta from cached prose
        │     ttsKey = sha256(text, model, voice, format, voiceSettings)
        │     if getCachedTtsStream(ttsKey):
        │          X-Cache: HIT → write blob → claim_complete → end
        │     else:
        │          X-Cache: PARTIAL (LLM hit, TTS miss) → feed cached
        │          fullText into chunker, skip the state machine
        │
        ▼  Live LLM stream (cache miss path)
   for await (token of streamAnthropic/OpenAI/Google):
     stateMachine.feed(token)
        │   ├─ TEXT mode  → onProse(text) → chunker.add(text)
        │   └─ META mode  → buffer for parseMetaTrailer at end
        ▼
   SentenceChunker (softMax: 80, hardMax: 200)
     onChunk(sentence) → enqueue into dispatcher queue
        │
        ▼  Serial TTS dispatcher (single producer/consumer)
   while queue:
     sentence = await dequeue()
     emitCacheable({ type: 'chunk_meta', seq, chunkText: sentence })
     for await (elChunk of textToSpeech.streamWithTimestamps(voiceId, {
       text: sentence,
       previousText: previousText || undefined,   // ← prosody continuity
       modelId: MODEL_ID,                          // from ELEVENLABS_TTS_MODEL env
       outputFormat: OUTPUT_FORMAT,
       voiceSettings: VOICE_MAP[agent].voiceSettings
     })):
       emitCacheable({ type: 'audio', seq, audioBase64, alignment })
     previousText = sentence; seq++
        │
        ▼  After dispatcher drains, before res.end():
   if !cachedLlm: await setCachedLlm(llmKey, rawText)
   await setCachedTtsStream(ttsKey, ndjsonBuffer.join(''))
   res.write({ type: 'claim_complete', fullText, rebuts, agrees_with })
   res.end()
```

**Why the chunker.** ElevenLabs `streamWithTimestamps` needs a complete chunk for prosody planning. Feeding it tokens one at a time produces robotic per-word delivery; feeding it the entire claim defeats the streaming. Sentence boundaries work well: the LLM is usually still writing sentence N+1 by the time sentence N's audio finishes generating, so end-to-end latency is bounded by the *first* sentence, not the full claim.

**`previousText` for prosody continuity.** ElevenLabs accepts a `previousText` parameter so the model can match cadence and intonation across chunks. Without it, every sentence would start cold and the debate would sound spliced. With it, multi-sentence claims sound like one continuous take.

**`chunk_meta` ↔ `audio` interleaving.** Each `chunk_meta` event signals "the alignment time origin has reset to zero for this chunk's audio." The client tracks `lastEndAbsolute` and shifts `timeOffset` on every `chunk_meta` so word timings stitch into one continuous karaoke timeline.

**`claim_complete` is never cached.** The cacheable NDJSON buffer holds only `chunk_meta` and `audio` events. `claim_complete` is appended fresh on every response (live or replay) so the cached blob can be reused verbatim.

**Why cache writes are awaited** (not fire-and-forget): on Vercel serverless, the function instance can be torn down once the response closes. A `set...Cache(...).catch(...)` after `res.end()` would silently never persist on cold-spawn workloads. The client has already buffered every byte by this point, so the extra latency is invisible.

### Server: `api/tts.js` (legacy / verdict path)

iOS Safari has no `MediaSource` API and can't play streamed MP3 chunks. The original single-shot endpoint stays in place for those clients and for the verdict (which is short enough that streaming buys nothing). It returns one big NDJSON blob: each line carries `{ audioBase64, alignment }`. Same cache shape, separate cache namespace.

**Per-agent `voiceSettings`** are baked into a `VOICE_MAP` (in `api/_tts.js`) so Advocate, Critic, and Wildcard get distinct deliveries. The Critic is more stable and less expressive, the Wildcard is the most "stylized." Voice IDs come from your ElevenLabs library via `VOICE_ID_*` env vars.

**Model choice** is wired via the **required** `ELEVENLABS_TTS_MODEL` env var — there is no in-code fallback (intentional: model choice is a deliberate cost/quality trade-off and should never silently default). In production this is set to `eleven_multilingual_v2`, picked over the faster `eleven_flash_v2_5` because it captures emotion and tone better. The debate sounds like three people arguing rather than three TTS voices reading. The trade-off is slightly higher TTFB, which the sentence chunker and warmup priming hide most of.

**Output format: `mp3_44100_128`.** Podcast-grade quality vs the older default `mp3_22050_32`, which sounded thin on desktop speakers. **Heads up:** 128 kbps requires ElevenLabs Creator tier or above. On Free/Starter the request 4xx's and the client's `audioDisabled` kill switch falls back to silent debate.

**`?fresh=1`** on the URL bypasses the cache read but still writes. Useful for hand-refreshing the cache after a model or voice swap without flushing Redis.

### Client: `src/lib/audio.js`

Two entry points share the file:

```
startClaimStream(responsePromise, opts)    ← MSE-capable (debate claims)
playAudioStream(text, opts)                ← legacy (verdict + iOS)
hasMSE()                                   ← capability check
```

For the streaming path, the orchestrator hands `startClaimStream` an in-flight `fetch` and a `gateBeforePlay` promise. The function returns `{ claim, playback }` immediately:

```
startClaimStream(fetchPromise, { agent, signal, getMuted, gateBeforePlay,
                                 onPlaybackStart, onPlaybackEnd, onWords })
  │
  ├─ response = await fetchPromise
  │
  ├─ MediaSource + new Audio(); audio.src = blob URL
  │
  ├─ for await (obj of parseNdjson(response.body)):
  │       if obj.type === 'chunk_meta':
  │            timeOffset = lastEndAbsolute  (resets per chunk)
  │       if obj.type === 'audio':
  │            sourceBuffer.appendBuffer(decoded bytes)
  │            push alignment into running word buffer
  │            if not started:
  │                 await gateBeforePlay   ← serialize playback
  │                 audio.play(); started = true
  │            onWords(...words)
  │       if obj.type === 'claim_complete':
  │            settleClaim({ fullText, rebuts, agrees_with })
  │
  └─ resolves: claim on claim_complete, playback on audio.ended
```

**`gateBeforePlay` keeps playback serial.** Claim N+1's stream can buffer bytes into its own `sourceBuffer` while claim N's audio is still playing, but it won't call `audio.play()` until N's playback promise resolves. Only one stream owns the module-level `currentAudio` / `currentResolve` singletons at any moment. Transitions stay instant and voices never overlap.

**Cumulative alignment offset.** Each ElevenLabs chunk's `characterStartTimesSeconds` restart at zero. The client tracks `lastEndAbsolute` per audio frame and bumps `timeOffset` on every `chunk_meta`. Word timings are emitted in absolute seconds so the Transcript component's `requestAnimationFrame` poll against `audio.currentTime` lines up cleanly across chunks.

**Legacy `playAudioStream`.** Same NDJSON shape, no `chunk_meta` events (single chunk), no gate plumbing. Used by the verdict and by iOS Safari's full debate flow.

### Orchestration & Lifecycle (`src/lib/debate.js`, `src/App.jsx`)

- **Three-path orchestrator.** `runDebate()` always checks the debate-text cache first. Hits trigger `replayCached()`. Misses route through `hasMSE()`: MSE-capable browsers run `liveGenStreaming()`, others run `liveGenLegacy()`. The verdict TTS always uses the legacy path so it works identically on iOS and desktop.
- **Streaming pipeline.** For each claim, `startClaim()` opens `/api/debate-stream` immediately, passing the *previous* claim's `playback` promise as `gateBeforePlay`. Claim N+1's network call, LLM streaming, TTS chunking, and byte buffering all happen while claim N's audio is still playing. Only the final `audio.play()` waits on the gate.
- **Legacy pipeline.** For each claim, `callAgent` (LLM) runs in parallel with the previous claim's TTS via `pendingLlm` / `pendingTts`. Same idea as streaming, but pipelined at the LLM-call level instead of the network-stream level.
- **Serialization.** `audio.js` uses module-level singletons (`currentAudio`, `currentResolve`). Both paths await each playback before starting the next visible play call; concurrent callers would orphan the previous promise. Pipelining doesn't violate this: LLM or network setup overlaps with audio, but only one audio element plays at a time.
- **Verdict karaoke.** The verdict TTS uses a synthetic `__verdict__` claim ID so per-word alignment data flows through the same `onSpeakingWords` → `claimWords` → `KaraokeText` pipeline as regular claims. The transcript shows a "is reading debate verdict" indicator plus the full verdict text karaoke-highlighted as the wildcard speaks.
- **Priming.** On topic submit, `TopicInput` fires two warmups:
  - `primeAudio()` plays a silent MP3 inside the click handler so the browser's autoplay policy is unlocked for the rest of the session.
  - `primeTTS()` sends a fire-and-forget **HEAD** request to `/api/tts` (the handler short-circuits with a 204). This pre-warms DNS/TCP/TLS and the cold-start function instance **without** triggering an ElevenLabs generation. (An earlier version POSTed a `.` and billed an EL call per debate start; HEAD removed that cost.)
- **Mute and abort.** The header mute button flips `mutedRef`, and `audio.js` checks `getMuted()` between chunks and pauses immediately. "Stop" and "New Debate" call the orchestrator's cancel function, which `AbortController.abort()`s every in-flight `fetch` and pauses any live `<audio>` element.
- **Per-turn timeout.** `TURN_TIMEOUT_MS = 60_000` is a safety net. If `onended`, `onerror`, or abort never fire, the orchestrator unblocks anyway after 60s.
- **Soft-fail.** On fetch, play, or appendBuffer failure, `audioDisabled` is set for the rest of the session and the debate continues silently. If the streaming endpoint fails partway, the orchestrator skips that agent's contribution and continues pipelining so a single blip doesn't kill the whole debate.
- **`?fresh=1`** on the page URL bypasses the debate-text cache (`/api/debate-cache`) and the legacy TTS cache (`/api/tts`). The streaming endpoint (`/api/debate-stream`) does not currently honor `?fresh=1`, so refreshing per-claim LLM or streaming-TTS entries requires deleting them in Redis directly.

## Caching

Four content-addressed namespaces, all Upstash Redis, all built on the shared `makeCacheStore` factory in `api/_shared.js`, all with `?fresh=1` bypass on the read path. **Keys do the invalidation work; TTL is just a storage backstop.** Any input change produces a new key, so the 30-day defaults can stay long without serving stale content.

### Layer 1: Debate text (`/api/debate-cache`)

```
GET  /api/debate-cache?topic=…&mode=…[&fresh=1]   → { cached, debate? }
POST /api/debate-cache  { topic, mode, claims, verdict }   → { stored: true }
```

- **Key**: `sha256(JSON.stringify({ topic.trim().toLowerCase(), mode, anthropic_model, openai_model, google_model, fast_tokens, deep_tokens, behavior_hash }))`. Any model, token-cap, or **prompt or sampling-setting edit** (via `BEHAVIOR_HASH` in `_prompts.js`) invalidates.
- **TTL**: `CACHE_TTL_SECONDS` (default 2,592,000 = 30d).
- **Write guard**: the client only POSTs on full completion (no abort, no agent errors, all 9 claims present, verdict present). Prevents broken-state debates from haunting the cache.
- **Write validation**: the POST handler revalidates `topic`, claim shapes, claim IDs, agent IDs, and verdict shape. Origin headers are forgeable from non-browser clients, so the cache can't be poisoned by a malicious POST.
- **Topic normalization**: `topic.trim().toLowerCase()` in the key so "Pineapple belongs on pizza" and "  pineapple belongs on pizza " hit the same entry.
- **`?fresh=1` proactively deletes** the existing entry so an aborted regen doesn't leave the stale one behind.

### Layer 2: LLM responses (`llmCacheKey` in `api/_shared.js`)

- **Key**: `sha256(JSON.stringify({ behavior, provider, model, maxTokens, systemPrompt, userMessage }))`. Identical inputs produce a cache hit and skip the LLM call entirely. Shared across the streaming path (`/api/debate-stream`) and the legacy path (`/api/debate`) so the same prompt cached on one path is reused by the other.
- **Value**: the raw response text the provider returned (prose-first `TEXT/META` envelope on current entries, JSON on legacy).
- **TTL**: `CACHE_TTL_SECONDS` (default 30d).
- **Why this matters**: aborted debates retain their per-claim text, so partial work isn't wasted. The Layer 1 (full-debate) cache only writes on clean completion; Layer 2 catches every individual successful LLM call.

### Layer 3a: Legacy TTS audio (`ttsCacheKey`, used by `/api/tts`)

- **Key**: `sha256(model | voice | format | voice_settings_json | text)`. Voice settings (stability, style, speed) are in the key so tweaks to `VOICE_MAP` auto-invalidate without manual cache wipes.
- **Value**: the full single-shot NDJSON body, so the karaoke pipeline replays identically from cache as from a live EL stream.
- **TTL**: `TTS_CACHE_TTL_SECONDS` (default 2,592,000 = 30d).
- Powers verdict audio and iOS Safari debate audio.

### Layer 3b: Streaming TTS (`ttsStreamCacheKey`, used by `/api/debate-stream`)

- **Key**: same shape as Layer 3a but namespaced separately. The cached value is the *multi-chunk* NDJSON blob (`chunk_meta` + `audio` events), so cumulative alignment offsets stay correct on replay.
- **Value**: the assembled NDJSON stream, sans the final `claim_complete` event (that's appended fresh on every replay).
- **TTL**: `TTS_CACHE_TTL_SECONDS` (default 30d).
- **Replay shape**: on cache hit, the server writes the cached blob byte-for-byte then appends a fresh `claim_complete` event built from the cached LLM response's parsed meta trailer.
- **Cache hits skip the char budget.** Replays cost the user nothing and don't consume EL quota.
- **`?fresh=1`** on the request URL proactively deletes the entry (mirrors Layer 1) so an aborted regen doesn't leave the stale one behind.

### Maintenance scripts

```bash
node scripts/cache-status.js              # read-only inspection: count + sample of each layer
node scripts/wipe-cache.js --dry-run      # list keys that would be deleted
node scripts/wipe-cache.js                # actually delete them (rate-limit counters preserved)
```

Both share `scripts/_redis.js` (env loader, client, `scanAll`, and `CACHE_PATTERNS`). `CACHE_PATTERNS` currently covers `debate:cache:*`, `llm:cache:*`, and `tts:cache:*`; the newer `ttsstream:cache:*` namespace (Layer 3b) is not yet listed there, so streaming-TTS entries don't get swept by these scripts. Wipe Redis directly or extend the patterns if you need to clear it.

### Storage wrapper note

The cache factory's `wrap` and `unwrap` indirection exists because Upstash's REST SDK auto-deserializes JSON. A single-chunk TTS NDJSON body is itself valid JSON, which `redis.get` would parse into an object, then `res.write(obj)` would stringify back as `[object Object]` and break the client. Wrapping in `{ body }` guarantees a string round-trip. LLM cache wraps in `{ text }` for the same reason, and debate cache stores objects directly.

## Key Files

| Path | Purpose |
|------|---------|
| `src/App.jsx` | Main app: state, layout, callback wiring, `?fresh=1` plumbing |
| `src/lib/agents.js` | Agent config (name/model/color/prefix). Parser for both `TEXT/META` prose-trailer and legacy JSON response formats |
| `src/lib/debate.js` | Async orchestrator. `hasMSE()` capability branch + `replayCached` / `liveGenStreaming` / `liveGenLegacy` / verdict |
| `src/lib/audio.js` | `startClaimStream` (streaming, gated playback for pipelining, cumulative alignment offset), `playAudioStream` (legacy single-shot, used by verdict + iOS), `hasMSE`, mute, timeout |
| `src/lib/graphUtils.js` | Graph data builder, Wildcard-only edge filtering, scoring logic |
| `src/lib/useMediaQuery.js` | `useMediaQuery` and `useIsMobile` (≤720px) for responsive layout |
| `src/components/DebateGraph.jsx` | D3 force-directed SVG graph (800×700, fixed agent anchors: Advocate top-center, Critic bottom-left, Wildcard bottom-right) |
| `src/components/Transcript.jsx` | Scrollable claim transcript with karaoke (rAF poll on `getCurrentPlaybackTime()`, re-renders only on active word index change) |
| `src/components/ProviderLogos.jsx` | Inline SVG brand marks (Google/OpenAI/Anthropic, `currentColor` so they tint with the agent color), rendered next to each claim in the transcript |
| `src/components/WildcardVerdict.jsx` | End-of-debate verdict card |
| `src/components/TopicInput.jsx` | Landing form: primes audio and TTS HEAD warmup on submit |
| `src/components/ThinkingIndicator.jsx` | Agent thinking animation |
| `src/components/RoundToasts.jsx` | Round winner notifications |
| `src/styles/theme.css` | Dark theme CSS variables |
| `api/debate-stream.js` | Per-claim streaming endpoint. LLM SSE → state machine → sentence chunker → serial EL `streamWithTimestamps` with `previousText` → NDJSON (`chunk_meta` / `audio` / `claim_complete` / `error`). Two cache namespaces: shared LLM + isolated TTS-stream |
| `api/debate.js` | Legacy non-streaming claim endpoint (iOS Safari + fallback). Returns one claim's structured response |
| `api/tts.js` | Legacy non-streaming TTS endpoint. Used by `/api/verdict` audio and iOS Safari claim audio. NDJSON stream + tee, sync cache-write |
| `api/verdict.js` | Wildcard final judgement, always non-streaming (~150 tokens) |
| `api/debate-cache.js` | Debate text cache: GET (lookup), POST (validated write), `?fresh=1` proactive delete |
| `api/_shared.js` | Provider LLM clients (`callX` + `streamX`), origin check, validation, KV rate-limit + TTS-budget + cache factory (LLM, legacy TTS, streaming TTS, debate text) |
| `api/_prompts.js` | All system prompts (`advocateTemplate`, `criticTemplate`, `wildcardTemplate`), mode styles, sampling settings + `BEHAVIOR_HASH` content fingerprint |
| `api/_chunker.js` | `SentenceChunker` (softMax 80, hardMax 200): splits an incoming token stream on sentence boundaries, fires `onChunk` per sentence |
| `api/_streaming.js` | TEXT/META state machine (`createStateMachine`) for parsing the prose-trailer format off a token stream + `parseMetaTrailer` + `extractFromRawLlm` (for cache replay) |
| `api/_tts.js` | ElevenLabs client singleton, `MODEL_ID`, `OUTPUT_FORMAT`, `VOICE_MAP` (per-agent voice settings), `getVoiceId` |
| `scripts/_redis.js` | Shared Upstash client + `scanAll` + `CACHE_PATTERNS` for maintenance scripts |
| `scripts/cache-status.js` | Read-only inspection of the four cache layers |
| `scripts/wipe-cache.js` | Delete all entries in the four cache namespaces (preserves rate-limit counters) |
| `scripts/generate-contours.ts` | Pre-build art generator: FBM-noise topographic contour SVG (run via `npm run contours`) |

## Getting Started

### Prerequisites

- Node.js 20+ (Vercel's current LTS default; Node 18 is deprecated).
- Vercel CLI (`npm i -g vercel`), needed for local dev so `/api/*` and the Vite frontend share an origin.
- API keys: Anthropic, OpenAI, Google, ElevenLabs.
- An Upstash Redis instance (provisioned via the Vercel Marketplace, or any Upstash account). Optional but recommended. Without it, rate limits, TTS budgets, and all four cache layers all fail open and provider spend caps become your only backstop.

### Installation

```bash
git clone https://github.com/franalli/debate-arena.git
cd debate-arena
npm install
```

### Environment Variables

Create `.env.local`:

```env
# ── LLM providers (required) ─────────────────────────
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...

# ── Model overrides (production values shown) ───────
ANTHROPIC_MODEL=claude-sonnet-4-6        # matches code fallback
OPENAI_MODEL=gpt-5.5-turbo               # code fallback is gpt-4o
GOOGLE_MODEL=gemini-3.1-pro-preview      # matches code fallback

# ── Token caps per mode (optional) ───────────────────
FAST_MAX_TOKENS=100
DEEP_MAX_TOKENS=800

# ── ElevenLabs TTS (required for audio) ──────────────
ELEVENLABS_API_KEY=...
VOICE_ID_ADVOCATE=...    # pick a voice ID from your EL library
VOICE_ID_CRITIC=...
VOICE_ID_WILDCARD=...
ELEVENLABS_TTS_MODEL=eleven_multilingual_v2  # required — no in-code fallback
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128       # requires EL Creator tier; code fallback matches

# ── Upstash Redis (optional; powers rate limits + cache) ──
KV_REST_API_URL=https://....upstash.io
KV_REST_API_TOKEN=...

# ── Debate rate limits (optional) ────────────────────
RATE_LIMIT_IP_DAILY=30          # max new debates per IP per day
RATE_LIMIT_GLOBAL_DAILY=300     # max new debates globally per day
DEBATE_COOLDOWN_MS=60000        # min ms between debates from same IP

# ── TTS budgets (optional) ───────────────────────────
TTS_MAX_CHARS_PER_REQUEST=1000  # per-call hard cap (cache hits skip this)
TTS_CHARS_IP_DAILY=20000        # per-IP daily char ceiling
TTS_CHARS_GLOBAL_DAILY=200000   # global daily char ceiling

# ── Cache TTLs (optional) ────────────────────────────
# Keys do invalidation work; TTL is just a storage floor.
CACHE_TTL_SECONDS=2592000       # debate text + LLM response cache (30d)
TTS_CACHE_TTL_SECONDS=2592000   # TTS audio cache (legacy + streaming, 30d)
```

### Development

Local dev uses the Vercel CLI so the Vite frontend and the `/api/*` serverless functions run on the same port:

```bash
vercel dev          # http://localhost:3000 (frontend + /api/* on one origin)
```

`npm run dev` runs Vite alone (`http://localhost:5173`) but `/api/*` will 404 since there's no proxy. Use it only for pure UI work.

Other scripts:

```bash
npm run build       # production build → dist/
npm run lint        # eslint
npm run preview     # vite preview of build output
npm run contours    # regenerate the topographic contour background art
```

### Deploy to Vercel

The repo is configured for Vercel out of the box:

- `api/` is auto-detected as serverless functions.
- Set all of the above env vars in your Vercel project settings (different values per environment if you like).
- If you provisioned Upstash via the Vercel Marketplace, `KV_REST_API_*` are wired automatically.
- Deployments happen on push.

## Rate Limiting & Budgets

All limits live in Upstash Redis so they're shared across serverless invocations. If `KV_REST_API_*` is unset, every limit fails open with a logged warning.

| Limit | Default | Env Var |
|-------|---------|---------|
| Per-IP daily debates | 30 | `RATE_LIMIT_IP_DAILY` |
| Global daily debates | 300 | `RATE_LIMIT_GLOBAL_DAILY` |
| Cooldown between debates | 60s | `DEBATE_COOLDOWN_MS` |
| Per-request TTS chars | 1,000 | `TTS_MAX_CHARS_PER_REQUEST` |
| Per-IP daily TTS chars | 20,000 | `TTS_CHARS_IP_DAILY` |
| Global daily TTS chars | 200,000 | `TTS_CHARS_GLOBAL_DAILY` |
| Debate text + LLM cache TTL | 30d | `CACHE_TTL_SECONDS` |
| TTS audio cache TTL | 30d | `TTS_CACHE_TTL_SECONDS` |

The cooldown is implemented as `SET NX EX` on `rl:cd:<ip>`. Only the *first* call of a new debate (round 1, advocate) acquires it; subsequent agent calls within the same debate skip the lock. Daily counters auto-expire 25h after creation so a slow day rolls over.

**Cache hits sidestep most limits.** A replayed debate makes zero LLM calls (no `/api/debate-stream` or `/api/debate` invocations, so no daily-debate counter bump), and cached legacy TTS audio skips the per-IP char budget. The cooldown still applies on the entry call if a live regen happens, but the GET on `/api/debate-cache` is unrestricted.

**TTS char budgets only apply on the legacy path.** `TTS_MAX_CHARS_PER_REQUEST`, `TTS_CHARS_IP_DAILY`, and `TTS_CHARS_GLOBAL_DAILY` are enforced inside `/api/tts` (the legacy + verdict path). `/api/debate-stream` does not count TTS characters today: a regen on MSE-capable clients consumes ElevenLabs quota without that cap. Use provider-side spend caps as the real cost backstop.

The frontend also prevents parallel debates structurally: while `status !== 'idle'`, the `TopicInput` view is unmounted entirely, so there's no Start button to click. Returning to it requires clicking **New Debate** in the header, which resets state.

> **Tip:** set spending caps on your LLM and ElevenLabs accounts as the most reliable cost control. The above limits are best-effort; provider-side caps are the last line of defense.

## Security

The API includes several hardening measures:

- **Origin check.** Rejects requests from anything not in the `ALLOWED_ORIGINS` list (prod URL plus localhost dev ports).
- **Input size caps.** Topic ≤ 500 chars, claim text ≤ 2,000 chars, TTS text ≤ 1,000 chars per request.
- **Structural history validation.** Claim IDs must match `^[a-z]{3}_r\d{1,2}_\d{1,2}$`, agent IDs are whitelisted, and the array length must not exceed what's expected at `(round, agent)`.
- **Cache POST validation.** `/api/debate-cache` POST revalidates topic plus every claim's shape plus verdict shape before writing. Origin headers are forgeable from non-browser clients; without this, an attacker could poison the cache with fabricated content keyed to a popular topic for the full 30-day TTL.
- **Prompt armoring.** System prompts instruct each model to treat the topic as a subject to debate, not an instruction to follow.
- **Generic error messages.** Provider details are logged server-side only; clients always get `"Service temporarily unavailable"`.

## Tech Stack

- **Frontend:** React 19, Vite 8, D3 (force, selection, zoom, drag, transition), Lucide icons. `useMediaQuery` hook for responsive layout.
- **Backend:** Vercel Serverless Functions (Node.js).
- **LLM Providers:** Anthropic (Claude, default reasoning), OpenAI (GPT, `reasoning_effort: low`), Google (Gemini, `thinkingLevel: low`). Each provider has both non-streaming (`callX`) and SSE-streaming (`streamX`) clients in `api/_shared.js`.
- **TTS:** ElevenLabs (`@elevenlabs/elevenlabs-js`), `streamWithTimestamps` over NDJSON. Streaming path uses sentence-chunked calls with `previousText` for prosody continuity. MP3 chunks fed to MediaSource on the client, word-level alignment drives karaoke with a cumulative time offset.
- **Storage / Cache:** Upstash Redis (Vercel Marketplace), powering rate limits, TTS char budgets, and a four-namespace content-addressed cache (debate text + per-call LLM + legacy TTS + streaming TTS, all 30d, all fingerprinted by `BEHAVIOR_HASH`).
- **Build assets:** topographic contour SVG generated at design time by `scripts/generate-contours.ts` (FBM noise + marching squares).
- **Styling:** CSS custom properties, dark theme, no CSS framework.
- **No TypeScript (except the build-time script), no state management library, no database.**

## License

MIT
