# ⚔ Debate Arena

Three frontier AI models debate any topic in real time. A live D3 argument graph shows how claims connect, clash, and evolve across rounds. Each agent speaks with its own ElevenLabs voice — streamed with word-level timing so the transcript karaokes along — then a neutral judge declares the winner.

**[Try it live →](https://debate-arena-ten.vercel.app)**

## How It Works

1. **Enter a topic** — any statement worth arguing about.
2. **Three AI agents debate** across 3 rounds:
   - 🟢 **Advocate** (Gemini 3.1 Pro) — argues *for* the statement.
   - 🔴 **Critic** (GPT-5.5) — argues *against* the statement.
   - 🟣 **Wildcard** (Claude Sonnet 4.6) — challenges both sides, then judges each round.
3. **A force-directed graph** builds in real time — nodes are claims, edges show the Wildcard's rebuttals and agreements (Advocate↔Critic attacks are omitted as predictable).
4. **Each claim is spoken** via ElevenLabs (streamed, mute + abort, **word-level karaoke** in the transcript).
5. **The Wildcard delivers a verdict** — strongest arguments and the loser's biggest gap.
6. **Already-debated topics replay instantly** from cache — same audio, same graph, same karaoke; no LLM or TTS calls.

Two debate modes:
- **Fast** — 24-word headline-style claims, ~100 tokens per turn.
- **Deep** — 2–3 sentence arguments with evidence, ~800 tokens per turn.

## Models

Each agent is routed to a different provider so the debate is a genuine cross-lab matchup. All three are env-overridable. Where the provider exposes a knob, reasoning effort is pegged to `low` for "fair fight" compute parity — Google `thinkingLevel: 'low'` and OpenAI `reasoning_effort: 'low'`. Anthropic Sonnet 4.6 has no equivalent parameter, so it runs at its default reasoning level.

| Role | Voice | Provider | Model (production) | Env var |
|------|-------|----------|--------------------|---------|
| Advocate | argues *for* | Google | `gemini-3.1-pro-preview` (thinkingLevel: `low`) | `GOOGLE_MODEL` |
| Critic | argues *against* | OpenAI | `gpt-5.5-turbo` (reasoning_effort: `low`) \* | `OPENAI_MODEL` |
| Wildcard | challenges + judges | Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_MODEL` |

\* Production value, set via the env var. The hard-coded fallback in `api/_shared.js` is `gpt-4o` (kept lower to avoid surprise costs on a fresh clone with no env override). Anthropic + Google code fallbacks match their production values.

The Wildcard pulls double duty: each round it picks one claim to rebut and one (from the other agent) to agree with. Those `agrees_with` picks tally into the live score, and the same model writes the final verdict via `/api/verdict`.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Frontend (React 19 + Vite 8 — no TS, no state lib)                  │
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
│  api/_shared.js        ─► LLM clients, validation, KV rate limits,   │
│                           TTS budget, two-layer cache helpers        │
└──────┬───────────────────────────────────────────────────────────────┘
       │  Upstash Redis (Vercel Marketplace)
       ▼
  Daily counters: debates (per-IP, global), TTS chars (per-IP, global)
  Locks:          per-IP debate cooldown
  Cache layer 1:  debate text — claims + verdict (24h TTL)
  Cache layer 2:  TTS audio   — NDJSON body per (model,voice,format,text) (7d TTL)
```

### Data Flow

1. User submits a topic → `runDebate()` first hits `GET /api/debate-cache?topic=…&mode=…`.
2. **Cache hit** → `replayCached()` dispatches the same UI callbacks the live path would (per-agent toasts, transcript appends, TTS playback). LLM calls are skipped entirely.
3. **Cache miss** → loop rounds × agents: `callAgent()` → `POST /api/debate` with `{ topic, history, round, agent, mode }`.
4. Server picks the LLM provider per the routing table and returns the raw JSON string.
5. Client parses it into a structured claim `{ id, text, rebuts, agrees_with }`; `buildGraphData()` regenerates D3 nodes + links.
6. `runDebate()` then `await`s `playAudioStream()` — `POST /api/tts` returns NDJSON (each line = `{ audioBase64, alignment }`). Audio bytes feed `MediaSource`; alignment data drives word-level highlighting in the transcript.
7. After 3 rounds → `POST /api/verdict` → Wildcard summarizes; the verdict is also spoken.
8. On clean completion (verdict + all 9 claims) → `POST /api/debate-cache` writes the debate for next viewer (24h TTL, `keepalive: true` so a same-tab nav doesn't kill it).

### Claim ID Format

Each claim gets a deterministic ID: `{prefix}_r{round}_{index}`

- Prefixes: `adv` (Advocate), `crt` (Critic), `wld` (Wildcard).
- Example: `crt_r2_1` = Critic's first claim in round 2.
- Server validates claim IDs against `/^[a-z]{3}_r\d{1,2}_\d{1,2}$/` plus an expected-count check derived from `(round, agent)`.

## ElevenLabs TTS Streaming

The voice layer is the moving piece most worth understanding. Two notable things shape the design: the response carries **audio + word-level timing** together (so the transcript can karaoke), and **every utterance is cached** so repeat plays are zero-latency + zero-cost.

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

**Why the cache write is awaited** (not fire-and-forget). On Vercel serverless, the function instance can be torn down once the response closes. A `setCachedTts(...).catch(...)` after `res.end()` would silently never persist on cold-spawn workloads. The client has already buffered every byte by this point, so the extra ~10–30ms is invisible.

**Per-agent `voiceSettings`** are baked into a `VOICE_MAP` so Advocate/Critic/Wildcard get distinct deliveries (e.g. the Critic is more stable + less expressive; the Wildcard is the most "stylized"). Voice IDs come from your ElevenLabs library via `VOICE_ID_*` env vars.

**Model choice — `eleven_multilingual_v2`.** Chosen over the faster `eleven_flash_v2_5` (the code fallback in `api/tts.js`) because it carries emotion and tonal variation noticeably better — the debate sounds like three people arguing, not three TTS voices reading. The trade-off is slightly higher TTFB; streaming + warmup priming hide most of it.

**Output format — `mp3_44100_128`.** Podcast-grade vs the older default `mp3_22050_32` which sounded thin on desktop speakers. **Heads up:** 128 kbps requires ElevenLabs Creator tier or above. On Free/Starter the request 4xx's and the client's `audioDisabled` kill switch falls back to silent debate.

**`?fresh=1`** on the URL bypasses the cache read but still writes — useful for hand-refreshing the cache after a model/voice swap without flushing Redis.

### Client: `src/lib/audio.js`

The body is NDJSON, not raw MP3. The client demuxes: `audioBase64` bytes feed MediaSource; `alignment` data feeds the karaoke pipeline.

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

**Blob fallback** — for browsers without MSE/MP3 support: buffer all `audioBase64` chunks, then `new Audio(blob)`. Same `onWords` contract.

**Karaoke pipeline.** ElevenLabs returns character-level start/end timestamps per chunk. `charactersToWords()` groups them on whitespace boundaries into `{ word, start, end }` records, accumulated across chunks. Each delta fires `onWords(words)`. The `Transcript` component polls `getCurrentPlaybackTime()` on `requestAnimationFrame` and matches the current `audio.currentTime` against word boundaries to drive the highlight — zero re-renders of the audio loop.

### Orchestration & Lifecycle (`src/lib/debate.js`, `src/App.jsx`)

- **Two-path orchestrator.** `runDebate()` always checks the debate-text cache first. Hits trigger `replayCached()` which dispatches the same callback sequence the live path would; the UI doesn't know which it's watching. Misses run the live loop and write to cache on clean completion only.
- **Serialization.** `audio.js` uses module-level singletons (`currentAudio`, `currentResolve`). The orchestrator must `await` each `playAudioStream()` call before issuing the next; a concurrent caller would orphan the previous promise.
- **Priming.** On topic submit, `TopicInput` fires two warmups:
  - `primeAudio()` plays a silent MP3 inside the click handler so the browser's autoplay policy is unlocked for the rest of the session.
  - `primeTTS()` sends a fire-and-forget **HEAD** request to `/api/tts` (which returns 204) — pre-warms DNS/TCP/TLS and the cold-start function instance **without** triggering an ElevenLabs generation. (An earlier version POSTed a `.` and billed an EL call per debate start; HEAD removed that cost.)
- **Mute + abort.** The header mute button flips `mutedRef`; `audio.js` checks `getMuted()` between chunks and pauses immediately. "Stop" + "New Debate" call the orchestrator's cancel function, which `AbortController.abort()`s every in-flight `fetch` and pauses any live `<audio>` element.
- **Per-turn timeout.** `TURN_TIMEOUT_MS = 60_000` is a safety net — if `onended`/`onerror`/abort never fire, the orchestrator unblocks anyway after 60s.
- **Soft-fail.** On fetch/play/appendBuffer failure, `audioDisabled` is set for the rest of the session and the debate continues silently.
- **`?fresh=1`** on the page URL flows from `App.jsx` through every cache layer (debate text + per-utterance TTS) for hands-on cache refreshing.

## Caching

Two independent layers, both Upstash Redis, both content-addressed, both with `?fresh=1` bypass.

### Layer 1 — Debate text (`/api/debate-cache`)

```
GET  /api/debate-cache?topic=…&mode=…[&fresh=1]   → { cached, debate? }
POST /api/debate-cache  { topic, mode, claims, verdict }   → { stored: true }
```

- **Key**: `sha256(JSON.stringify({ topic.trim().toLowerCase(), mode, anthropic_model, openai_model, google_model, fast_tokens, deep_tokens }))`. Any model or token-cap env change naturally invalidates.
- **TTL**: `CACHE_TTL_SECONDS` (default 86,400 = 24h).
- **Write guard**: the client only POSTs on full completion (no abort, no agent errors, all 9 claims present, verdict present). Prevents broken-state debates from haunting the cache for 24h.
- **Write validation**: the POST handler revalidates `topic`, claim shapes, claim IDs, agent IDs, and verdict shape — origin headers are forgeable from non-browser clients, so the cache can't be poisoned by a malicious POST.
- **Topic normalization**: `topic.trim().toLowerCase()` in the key so "Pineapple belongs on pizza" and "  pineapple belongs on pizza " hit the same entry. LLMs don't care about case/whitespace; the cache shouldn't either.

### Layer 2 — TTS audio (in `/api/tts`)

- **Key**: `sha256(model | voice | format | text)`. Format is in the key because different mp3 bitrates produce different bytes; voice+model are obvious.
- **Value**: the full NDJSON body (audio + alignment), so the karaoke pipeline replays identically from cache as from a live EL stream.
- **TTL**: `TTS_CACHE_TTL_SECONDS` (default 604,800 = 7d).
- **Cache hits skip the char budget** — replays cost the user nothing and don't consume EL quota.
- **`?fresh=1`** on the request URL skips the read but still writes (re-warms the cache entry).

### Storage wrapper note

`setCachedTts` wraps NDJSON in `{ body }` because Upstash's REST SDK auto-deserializes — a single-chunk NDJSON body is itself valid JSON, which `redis.get` would parse into an object, then `res.write(obj)` would stringify back as `[object Object]` and break the client. Wrapping guarantees a `.body` string round-trip.

## Key Files

| Path | Purpose |
|------|---------|
| `src/App.jsx` | Main app — state, layout, callback wiring, `?fresh=1` plumbing |
| `src/lib/agents.js` | Agent config (name/model/color/prefix), response parsers |
| `src/lib/debate.js` | Async debate orchestrator — cache-check, live loop, replay path, TTS serialization |
| `src/lib/audio.js` | TTS client — NDJSON demux, MSE streaming, karaoke alignment, priming, mute, timeout |
| `src/lib/graphUtils.js` | Graph data builder, Wildcard-only edge filtering, scoring logic |
| `src/lib/useMediaQuery.js` | `useMediaQuery` + `useIsMobile` (≤720px) for responsive layout |
| `src/components/DebateGraph.jsx` | D3 force-directed SVG graph (800×700, fixed agent anchors: Advocate top-center, Critic bottom-left, Wildcard bottom-right) |
| `src/components/Transcript.jsx` | Scrollable claim transcript with karaoke (rAF poll on `getCurrentPlaybackTime()`, re-renders only on active word index change) |
| `src/components/ProviderLogos.jsx` | Inline SVG brand marks (Google/OpenAI/Anthropic, `currentColor` so they tint with the agent color) — rendered next to each claim in the transcript |
| `src/components/WildcardVerdict.jsx` | End-of-debate verdict card |
| `src/components/TopicInput.jsx` | Landing form — primes audio + TTS HEAD warmup on submit |
| `src/components/ThinkingIndicator.jsx` | Agent thinking animation |
| `src/components/RoundToasts.jsx` | Round winner notifications |
| `src/styles/theme.css` | Dark theme CSS variables |
| `api/debate.js` | Debate endpoint — routes agent → provider, builds system prompts |
| `api/verdict.js` | Verdict endpoint — Wildcard final judgment |
| `api/tts.js` | TTS endpoint — cache-check, NDJSON stream + tee, sync cache-write |
| `api/debate-cache.js` | Debate text cache — GET (lookup), POST (validated write) |
| `api/_shared.js` | LLM clients, origin check, validation, KV rate-limit + TTS-budget + two-layer cache helpers |
| `scripts/generate-contours.ts` | Pre-build art generator — FBM-noise topographic contour SVG (run via `npm run contours`) |

## Getting Started

### Prerequisites

- Node.js 20+ (Vercel's current LTS default; Node 18 is deprecated).
- Vercel CLI (`npm i -g vercel`) — needed for local dev so `/api/*` and the Vite frontend share an origin.
- API keys: Anthropic, OpenAI, Google, ElevenLabs.
- An Upstash Redis instance (provisioned via the Vercel Marketplace, or any Upstash account). Optional but recommended — without it, rate limits, TTS budgets, and both cache layers all fail open and provider spend caps become your only backstop.

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
CACHE_TTL_SECONDS=86400         # debate text cache (24h)
TTS_CACHE_TTL_SECONDS=604800    # TTS audio cache (7d)
```

### Development

Local dev uses the Vercel CLI so the Vite frontend and the `/api/*` serverless functions run on the same port:

```bash
vercel dev          # http://localhost:3000 (frontend + /api/* on one origin)
```

`npm run dev` runs Vite alone (`http://localhost:5173`) but `/api/*` will 404 — there's no proxy. Use it only for pure UI work.

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
| Debate text cache TTL | 24h | `CACHE_TTL_SECONDS` |
| TTS audio cache TTL | 7d | `TTS_CACHE_TTL_SECONDS` |

The cooldown is implemented as `SET NX EX` on `rl:cd:<ip>` — only the *first* call of a new debate (round 1, advocate) acquires it; subsequent agent calls within the same debate skip the lock. Daily counters auto-expire 25h after creation so a slow day naturally rolls over.

**Cache hits sidestep most limits.** A replayed debate makes zero LLM calls (no `/api/debate` invocations, so no daily-debate counter bump) and TTS audio served from cache skips the per-IP char budget. The cooldown still applies on the entry call to `/api/debate` if a live regen happens, but the GET on `/api/debate-cache` is unrestricted.

The frontend additionally prevents parallel debates structurally: while `status !== 'idle'`, the `TopicInput` view is unmounted entirely, so there's no Start button to click. Returning to it requires clicking **New Debate** in the header, which resets state.

> **Tip:** set spending caps on your LLM and ElevenLabs accounts as the most reliable cost control. The above limits are best-effort; provider-side caps are the last line of defense.

## Security

The API includes several hardening measures:

- **Origin check** — rejects requests from anything not in the `ALLOWED_ORIGINS` list (prod URL + localhost dev ports).
- **Input size caps** — topic ≤ 500 chars, claim text ≤ 2,000 chars, TTS text ≤ 1,000 chars per request.
- **Structural history validation** — claim IDs must match `^[a-z]{3}_r\d{1,2}_\d{1,2}$`, agent IDs are whitelisted, and the array length must not exceed what's expected at `(round, agent)`.
- **Cache POST validation** — `/api/debate-cache` POST revalidates topic + every claim's shape + verdict shape before writing. Origin headers are forgeable from non-browser clients; without this, an attacker could poison the cache with fabricated content keyed to a popular topic for 24h.
- **Prompt armoring** — system prompts instruct each model to treat the topic as a subject to debate, not an instruction to follow.
- **Generic error messages** — provider details are logged server-side only; clients always get `"Service temporarily unavailable"`.

## Tech Stack

- **Frontend:** React 19, Vite 8, D3 (force, selection, zoom, drag, transition), Lucide icons. `useMediaQuery` hook for responsive layout.
- **Backend:** Vercel Serverless Functions (Node.js).
- **LLM Providers:** Anthropic (Claude, default reasoning), OpenAI (GPT, `reasoning_effort: low`), Google (Gemini, `thinkingLevel: low`).
- **TTS:** ElevenLabs (`@elevenlabs/elevenlabs-js`), `streamWithTimestamps` over NDJSON; MP3 chunks fed to MediaSource on the client, word-level alignment drives karaoke.
- **Storage / Cache:** Upstash Redis (Vercel Marketplace) — rate limits, TTS char budgets, two-layer content-addressed cache (debate text 24h, TTS audio 7d).
- **Build assets:** topographic contour SVG generated at design time by `scripts/generate-contours.ts` (FBM noise + marching squares).
- **Styling:** CSS custom properties, dark theme, no CSS framework.
- **No TypeScript (except the build-time script), no state management library, no database.**

## License

MIT
