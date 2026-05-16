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
4. **Each claim is spoken** via ElevenLabs (streamed, mute + abort, **word-level karaoke** in the transcript).
5. **The Wildcard delivers a verdict** covering the strongest arguments and the loser's biggest gap, also spoken with per-word karaoke and a "is reading debate verdict" indicator.
6. **Already-debated topics replay instantly** from cache: same audio, same graph, same karaoke, no LLM or TTS calls.
7. **Aborted debates retain their work.** Per-call LLM responses and per-claim TTS audio are independently cached, so partial runs aren't wasted.

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
│  TopicInput ──► runDebate() → cache-check → live OR replay path      │
│       │              │                  │              │             │
│       ▼              ▼                  ▼              ▼             │
│   Transcript    DebateGraph (D3)    WildcardVerdict   karaoke poll   │
│   (karaoke ◄────────────────────────────────────── getCurrentTime()) │
│                                                                      │
│   audio.js: NDJSON parse, MSE-streamed MP3 + alignment → onWords     │
└──────┬───────────────────────────────────────────────────────────────┘
       │  GET /api/debate-cache    POST /api/debate    POST /api/verdict
       │  POST /api/debate-cache   POST /api/tts (NDJSON: audio+timing)
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Backend (Vercel Serverless Functions, Node.js)                      │
│                                                                      │
│  api/debate.js         ─► callGoogle (Advocate)                      │
│                           callOpenAI (Critic, reasoning_effort=low)  │
│                           callAnthropic (Wildcard)                   │
│  api/verdict.js        ─► callAnthropic (Wildcard judges)            │
│  api/tts.js            ─► cache-check → ElevenLabs                   │
│                           textToSpeech.streamWithTimestamps()        │
│                           ⇢ NDJSON {audioBase64, alignment} + tee    │
│  api/debate-cache.js   ─► GET (lookup) / POST (write, validated)     │
│  api/_shared.js        ─► LLM clients (per-call cache), validation,  │
│                           KV rate limits, TTS budget, cache factory  │
│  api/_prompts.js       ─► system prompts + sampling settings +       │
│                           BEHAVIOR_HASH (content-addressed cache key)│
└──────┬───────────────────────────────────────────────────────────────┘
       │  Upstash Redis (Vercel Marketplace)
       ▼
  Daily counters: debates (per-IP, global), TTS chars (per-IP, global)
  Locks:          per-IP debate cooldown
  Cache layer 1:  debate text   : full claims + verdict          (30d TTL)
  Cache layer 2:  LLM responses : per-call raw text              (30d TTL)
  Cache layer 3:  TTS audio     : NDJSON body per voice/settings (30d TTL)
```

### Data Flow

1. User submits a topic, and `runDebate()` first hits `GET /api/debate-cache?topic=…&mode=…`.
2. **Cache hit:** `replayCached()` dispatches the same UI callbacks the live path would (per-agent toasts, transcript appends, TTS playback). LLM calls are skipped entirely.
3. **Cache miss:** loop rounds × agents. `callAgent()` → `POST /api/debate` with `{ topic, history, round, agent, mode }`.
4. Server picks the LLM provider per the routing table and returns the raw JSON string.
5. Client parses it into a structured claim `{ id, text, rebuts, agrees_with }`, and `buildGraphData()` regenerates D3 nodes and links.
6. `runDebate()` then starts `playAudioStream()` and **simultaneously pre-fetches the next agent's LLM call**, so the next claim is usually ready by the time the current audio finishes. Transitions stay near-instant. `POST /api/tts` returns NDJSON (each line = `{ audioBase64, alignment }`). Audio bytes feed `MediaSource`, and alignment data drives word-level highlighting in the transcript.
7. After 3 rounds, `POST /api/verdict` (pre-fetched during the last wildcard's TTS) returns the Wildcard's summary. The verdict is spoken with per-word karaoke and a "Wildcard is reading debate verdict" indicator.
8. On clean completion (verdict plus all 9 claims), `POST /api/debate-cache` writes the debate for the next viewer (`keepalive: true` so a same-tab nav doesn't kill it).

### Claim ID Format

Each claim gets a deterministic ID: `{prefix}_r{round}_{index}`

- Prefixes: `adv` (Advocate), `crt` (Critic), `wld` (Wildcard).
- Example: `crt_r2_1` is the Critic's first claim in round 2.
- Server validates claim IDs against `/^[a-z]{3}_r\d{1,2}_\d{1,2}$/` plus an expected-count check derived from `(round, agent)`.

## ElevenLabs TTS Streaming

The voice layer is worth a closer look. Two things shape the design: the response carries **audio + word-level timing** together (so the transcript can karaoke), and **every utterance is cached** so repeat plays are zero-latency and zero-cost.

### Server: `api/tts.js`

```
   POST /api/tts  { agent, text }     HEAD /api/tts  → 204 (warmup; no EL call)
        │
        ├─ checkOrigin / validate agent + non-empty text
        ├─ resolve voiceId from VOICE_ID_<AGENT> env var
        │
        ├─ cacheKey = sha256(model | voice | format | text)
        ├─ if cached and not ?fresh=1 → return cached NDJSON
        │                               (X-Cache: HIT, skips char-budget)
        │
        ├─ checkCharBudget(ip, text.length)     ← only on cache MISS
        │    └─ Redis: INCRBY tts:chars:ip:<day>:<ip> + global
        │              (429 if cap exceeded, or text > per-req cap)
        │
        ▼
   ElevenLabsClient.textToSpeech.streamWithTimestamps(voiceId, {
     text,
     modelId:      eleven_multilingual_v2,   // ← ELEVENLABS_TTS_MODEL
     outputFormat: mp3_44100_128,            // ← ELEVENLABS_OUTPUT_FORMAT
     voiceSettings: { stability, similarityBoost, style,
                      useSpeakerBoost, speed }   // per-agent personality
   })
        │
        ▼  Content-Type: application/x-ndjson, X-Cache: MISS, no-store
   for await (chunk of stream):                  // tee pattern
     line = JSON.stringify({ audioBase64, alignment }) + '\n'
     chunks.push(line)        ← accumulate for cache write
     res.write(line)          ← stream to client (no buffering)
        │
        ├─ req.on('close') → clientGone → break (frees EL stream)
        │
        ▼
   await setCachedTts(cacheKey, chunks.join(''))    ← SYNC, before res.end()
   res.end()
```

**Why the cache write is awaited** (not fire-and-forget): on Vercel serverless, the function instance can be torn down once the response closes. A `setCachedTts(...).catch(...)` after `res.end()` would silently never persist on cold-spawn workloads. The client has already buffered every byte by this point, so the extra 10 to 30ms is invisible.

**Per-agent `voiceSettings`** are baked into a `VOICE_MAP` so Advocate, Critic, and Wildcard get distinct deliveries (e.g. the Critic is more stable and less expressive, the Wildcard is the most "stylized"). Voice IDs come from your ElevenLabs library via `VOICE_ID_*` env vars.

**Model choice: `eleven_multilingual_v2`.** Picked over the faster `eleven_flash_v2_5` (the code fallback in `api/tts.js`) because it captures emotion and tone better. The debate sounds like three people arguing rather than three TTS voices reading. The trade-off is slightly higher TTFB, which streaming and warmup priming hide most of.

**Output format: `mp3_44100_128`.** Podcast-grade quality vs the older default `mp3_22050_32`, which sounded thin on desktop speakers. **Heads up:** 128 kbps requires ElevenLabs Creator tier or above. On Free/Starter the request 4xx's and the client's `audioDisabled` kill switch falls back to silent debate.

**`?fresh=1`** on the URL bypasses the cache read but still writes. Useful for hand-refreshing the cache after a model or voice swap without flushing Redis.

### Client: `src/lib/audio.js`

The body is NDJSON, not raw MP3. The client demuxes: `audioBase64` bytes feed MediaSource, and `alignment` data feeds the karaoke pipeline.

```
playAudioStream(text, { agent, signal, getMuted, fresh,
                        onPlaybackStart/End, onWords })
  │
  ├─ fetch('/api/tts' + (fresh ? '?fresh=1' : ''), { signal, body: { agent, text } })
  │      → ReadableStream of NDJSON lines
  │
  ├─ for await (obj of parseNdjson(body)):
  │       if obj.audioBase64:
  │            bytes = atob(obj.audioBase64) → Uint8Array
  │            sourceBuffer.appendBuffer(bytes)   ← MSE path
  │            if first chunk → audio.play()      ← TTFB-bounded
  │       if obj.alignment:
  │            push characters/start/end into running buffers
  │            onWords(charactersToWords(...))    ← karaoke callback
  │
  └─ resolves on: onended | onerror | signal abort | 60s timeout
```

**Blob fallback.** For browsers without MSE or MP3 support: buffer all `audioBase64` chunks, then `new Audio(blob)`. Same `onWords` contract.

**Karaoke pipeline.** ElevenLabs returns character-level start and end timestamps per chunk. `charactersToWords()` groups them on whitespace boundaries into `{ word, start, end }` records, accumulated across chunks. Each delta fires `onWords(words)`. The `Transcript` component polls `getCurrentPlaybackTime()` on `requestAnimationFrame` and matches the current `audio.currentTime` against word boundaries to drive the highlight. The audio loop never re-renders.

### Orchestration & Lifecycle (`src/lib/debate.js`, `src/App.jsx`)

- **Two-path orchestrator.** `runDebate()` always checks the debate-text cache first. Hits trigger `replayCached()`, which dispatches the same callback sequence the live path would, so the UI doesn't know which it's watching. Misses run the live loop and write to cache on clean completion only.
- **Pipelined live path.** Each agent's LLM call is **pre-fetched while the previous agent's TTS is playing**, so `pendingLlm` runs in parallel with `pendingTts`. The "thinking" indicator stays gated on audio transitions, so the pre-fetch is invisible: when audio ends, the next claim is usually already there. The same pre-fetch applies across rounds and to the final verdict (kicked off during the last wildcard's TTS).
- **Serialization.** `audio.js` uses module-level singletons (`currentAudio`, `currentResolve`). The orchestrator awaits each `playAudioStream()` before issuing the next; a concurrent caller would orphan the previous promise. (Pipelining doesn't violate this: only the LLM calls overlap with TTS, never two TTS streams.)
- **Verdict karaoke.** The verdict TTS uses a synthetic `__verdict__` claim ID so per-word alignment data flows through the same `onSpeakingWords` → `claimWords` → `KaraokeText` pipeline as regular claims. The transcript shows a "is reading debate verdict" indicator plus the full verdict text karaoke-highlighted as the wildcard speaks.
- **Priming.** On topic submit, `TopicInput` fires two warmups:
  - `primeAudio()` plays a silent MP3 inside the click handler so the browser's autoplay policy is unlocked for the rest of the session.
  - `primeTTS()` sends a fire-and-forget **HEAD** request to `/api/tts` (which returns 204). This pre-warms DNS/TCP/TLS and the cold-start function instance **without** triggering an ElevenLabs generation. (An earlier version POSTed a `.` and billed an EL call per debate start; HEAD removed that cost.)
- **Mute and abort.** The header mute button flips `mutedRef`, and `audio.js` checks `getMuted()` between chunks and pauses immediately. "Stop" and "New Debate" call the orchestrator's cancel function, which `AbortController.abort()`s every in-flight `fetch` and pauses any live `<audio>` element.
- **Per-turn timeout.** `TURN_TIMEOUT_MS = 60_000` is a safety net. If `onended`, `onerror`, or abort never fire, the orchestrator unblocks anyway after 60s.
- **Soft-fail.** On fetch, play, or appendBuffer failure, `audioDisabled` is set for the rest of the session and the debate continues silently.
- **`?fresh=1`** on the page URL flows from `App.jsx` through every cache layer (debate text plus per-utterance TTS) for hands-on cache refreshing.

## Caching

Three independent layers, all Upstash Redis, all content-addressed via the shared `makeCacheStore` factory in `api/_shared.js`, all with `?fresh=1` bypass on the read path. **Keys do the invalidation work; TTL is just a storage backstop.** Any input change produces a new key, so the 30-day defaults can stay long without serving stale content.

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

### Layer 2: LLM responses (in `callAnthropic` / `callOpenAI` / `callGoogle`)

- **Key**: `sha256(JSON.stringify({ behavior, provider, model, maxTokens, systemPrompt, userMessage }))`. Identical inputs produce a cache hit and skip the LLM call entirely.
- **Value**: the raw response text the provider returned.
- **TTL**: `CACHE_TTL_SECONDS` (default 30d).
- **Why this matters**: aborted debates retain their per-claim text, so partial work isn't wasted. The Layer 1 (full-debate) cache only writes on clean completion; Layer 2 catches every individual successful LLM call.
- **Coverage**: applied across all three providers and the verdict path. `BEHAVIOR_HASH` is folded into every key so any prompt or sampling-setting edit invalidates symmetrically.

### Layer 3: TTS audio (in `/api/tts`)

- **Key**: `sha256(model | voice | format | voice_settings_json | text)`. Voice settings (stability, style, speed) are in the key so tweaks to `VOICE_MAP` auto-invalidate without manual cache wipes.
- **Value**: the full NDJSON body (audio plus alignment), so the karaoke pipeline replays identically from cache as from a live EL stream.
- **TTL**: `TTS_CACHE_TTL_SECONDS` (default 2,592,000 = 30d).
- **Cache hits skip the char budget.** Replays cost the user nothing and don't consume EL quota.
- **`?fresh=1`** on the request URL proactively deletes the entry (mirrors Layer 1) so an aborted regen doesn't leave the stale one behind.

### Maintenance scripts

```bash
node scripts/cache-status.js              # read-only inspection: count + sample of each layer
node scripts/wipe-cache.js --dry-run      # list keys that would be deleted (all three layers)
node scripts/wipe-cache.js                # actually delete them (rate-limit counters preserved)
```

Both share `scripts/_redis.js` (env loader, client, `scanAll`, and `CACHE_PATTERNS`).

### Storage wrapper note

The cache factory's `wrap` and `unwrap` indirection exists because Upstash's REST SDK auto-deserializes JSON. A single-chunk TTS NDJSON body is itself valid JSON, which `redis.get` would parse into an object, then `res.write(obj)` would stringify back as `[object Object]` and break the client. Wrapping in `{ body }` guarantees a string round-trip. LLM cache wraps in `{ text }` for the same reason, and debate cache stores objects directly.

## Key Files

| Path | Purpose |
|------|---------|
| `src/App.jsx` | Main app: state, layout, callback wiring, `?fresh=1` plumbing |
| `src/lib/agents.js` | Agent config (name/model/color/prefix), response parsers |
| `src/lib/debate.js` | Async debate orchestrator: cache-check, live loop, replay path, TTS serialization |
| `src/lib/audio.js` | TTS client: NDJSON demux, MSE streaming, karaoke alignment, priming, mute, timeout |
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
| `api/debate.js` | Debate endpoint: routes agent to provider, builds system prompts |
| `api/verdict.js` | Verdict endpoint: Wildcard final judgment |
| `api/tts.js` | TTS endpoint: cache-check, NDJSON stream + tee, sync cache-write |
| `api/debate-cache.js` | Debate text cache: GET (lookup), POST (validated write), `?fresh=1` proactive delete |
| `api/_shared.js` | LLM clients (per-call cached), origin check, validation, KV rate-limit + TTS-budget + `makeCacheStore` factory |
| `api/_prompts.js` | All system prompts, mode styles, sampling settings + `BEHAVIOR_HASH` content fingerprint |
| `scripts/_redis.js` | Shared Upstash client + `scanAll` + `CACHE_PATTERNS` for maintenance scripts |
| `scripts/cache-status.js` | Read-only inspection of the three cache layers |
| `scripts/wipe-cache.js` | Delete all entries in the three cache namespaces (preserves rate-limit counters) |
| `scripts/generate-contours.ts` | Pre-build art generator: FBM-noise topographic contour SVG (run via `npm run contours`) |

## Getting Started

### Prerequisites

- Node.js 20+ (Vercel's current LTS default; Node 18 is deprecated).
- Vercel CLI (`npm i -g vercel`), needed for local dev so `/api/*` and the Vite frontend share an origin.
- API keys: Anthropic, OpenAI, Google, ElevenLabs.
- An Upstash Redis instance (provisioned via the Vercel Marketplace, or any Upstash account). Optional but recommended. Without it, rate limits, TTS budgets, and both cache layers all fail open and provider spend caps become your only backstop.

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
ELEVENLABS_TTS_MODEL=eleven_multilingual_v2  # better emotion; code fallback is eleven_flash_v2_5
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
TTS_CACHE_TTL_SECONDS=2592000   # TTS audio cache (30d)
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

**Cache hits sidestep most limits.** A replayed debate makes zero LLM calls (no `/api/debate` invocations, so no daily-debate counter bump), and TTS audio served from cache skips the per-IP char budget. The cooldown still applies on the entry call to `/api/debate` if a live regen happens, but the GET on `/api/debate-cache` is unrestricted.

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
- **LLM Providers:** Anthropic (Claude, default reasoning), OpenAI (GPT, `reasoning_effort: low`), Google (Gemini, `thinkingLevel: low`).
- **TTS:** ElevenLabs (`@elevenlabs/elevenlabs-js`), `streamWithTimestamps` over NDJSON. MP3 chunks fed to MediaSource on the client, word-level alignment drives karaoke.
- **Storage / Cache:** Upstash Redis (Vercel Marketplace), powering rate limits, TTS char budgets, and a three-layer content-addressed cache (debate text + per-call LLM + TTS audio, all 30d, all fingerprinted by `BEHAVIOR_HASH`).
- **Build assets:** topographic contour SVG generated at design time by `scripts/generate-contours.ts` (FBM noise + marching squares).
- **Styling:** CSS custom properties, dark theme, no CSS framework.
- **No TypeScript (except the build-time script), no state management library, no database.**

## License

MIT
