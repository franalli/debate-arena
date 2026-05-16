# ⚔ Debate Arena

Three frontier AI models debate any topic in real time. A live D3 argument graph shows how claims connect, clash, and evolve across rounds. ElevenLabs gives each agent a distinct voice that streams as they speak — then a neutral judge declares the winner.

**[Try it live →](https://debate-arena-ten.vercel.app)**

## How It Works

1. **Enter a topic** — any statement worth arguing about.
2. **Three AI agents debate** across 3 rounds:
   - 🟢 **Advocate** (Gemini 3.1 Pro) — argues *for* the statement.
   - 🔴 **Critic** (GPT-5.5) — argues *against* the statement.
   - 🟣 **Wildcard** (Claude Sonnet 4.6) — challenges both sides, then judges each round.
3. **A force-directed graph** builds in real time — nodes are claims, edges show rebuttals and agreements.
4. **Each claim is spoken** by its agent's voice via ElevenLabs (streamed, with mute + abort).
5. **The Wildcard delivers a verdict** — strongest arguments and the loser's biggest gap.

Two debate modes:
- **Fast** — 12-word headline-style claims, ~100 tokens per turn.
- **Deep** — 2–3 sentence arguments with evidence, ~800 tokens per turn.

## Models

Each agent is routed to a different provider so the debate is a genuine cross-lab matchup. All three are env-overridable.

| Role | Voice | Provider | Model (production) | Env var |
|------|-------|----------|--------------------|---------|
| Advocate | argues *for* | Google | `gemini-3.1-pro-preview` (thinkingLevel: `low`) | `GOOGLE_MODEL` |
| Critic | argues *against* | OpenAI | `gpt-5.5-turbo` \* | `OPENAI_MODEL` |
| Wildcard | challenges + judges | Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_MODEL` |

\* Production value, set via the env var. The hard-coded fallback in `api/_shared.js` is `gpt-4o` (kept lower to avoid surprise costs on a fresh clone with no env override). Anthropic + Google code fallbacks match their production values.

The Wildcard pulls double duty: each round it picks one claim to rebut and one (from the other agent) to agree with. Those `agrees_with` picks tally into the live score, and the same model writes the final verdict via `/api/verdict`.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Frontend (React 19 + Vite 8 — no TS, no state lib)                  │
│                                                                      │
│  TopicInput ──► runDebate() loops 3 rounds × 3 agents                │
│       │              │                  │                            │
│       ▼              ▼                  ▼                            │
│   Transcript    DebateGraph (D3)    WildcardVerdict                  │
│                                                                      │
│   audio.js: MSE-streamed MP3 playback, mute + AbortSignal threaded   │
└──────┬───────────────────────────────────────────────────────────────┘
       │  POST /api/debate    POST /api/verdict    POST /api/tts ⇢ mp3
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Backend (Vercel Serverless Functions, Node.js)                      │
│                                                                      │
│  api/debate.js   ─► callGoogle (Advocate) │ callOpenAI (Critic)      │
│                     │ callAnthropic (Wildcard)                       │
│  api/verdict.js  ─► callAnthropic (Wildcard judges)                  │
│  api/tts.js      ─► ElevenLabs textToSpeech.stream() ⇢ chunked mp3   │
│  api/_shared.js  ─► LLM clients, origin/input validation,            │
│                     KV-backed rate limits, TTS budget + cache        │
└──────┬───────────────────────────────────────────────────────────────┘
       │  Upstash Redis (provisioned via Vercel Marketplace)
       ▼
  Daily counters: debates (per-IP, global), TTS chars (per-IP, global)
  Locks: per-IP debate cooldown
  Cache: content-addressed TTS audio scaffold (helpers ready, not yet wired)
```

### Data Flow

1. User submits a topic → `runDebate()` loops rounds × agents.
2. Each turn: `callAgent()` → `POST /api/debate` with `{ topic, history, round, agent, mode }`.
3. The server picks the LLM provider per the routing table above and returns the raw JSON string.
4. Client-side parsing turns the raw response into a structured claim `{ id, text, rebuts, agrees_with }`.
5. The claim is appended to `allClaims`; `buildGraphData()` regenerates D3 nodes + links.
6. `runDebate()` then `await`s `playAudioStream()` — `POST /api/tts` streams MP3 chunks back; playback starts on the first chunk.
7. After 3 rounds → `POST /api/verdict` → Wildcard summarizes strongest arguments + biggest gap, which is then also spoken.
8. `computeWildcardScore()` tallies round wins from the Wildcard's `agrees_with` picks for the header score.

### Claim ID Format

Each claim gets a deterministic ID: `{prefix}_r{round}_{index}`

- Prefixes: `adv` (Advocate), `crt` (Critic), `wld` (Wildcard).
- Example: `crt_r2_1` = Critic's first claim in round 2.
- Server validates claim IDs in `history` against `/^[a-z]{3}_r\d{1,2}_\d{1,2}$/` plus an expected-count check derived from `(round, agent)`.

## ElevenLabs TTS Streaming

The voice layer is the moving piece most worth understanding — both halves of the stream are tuned for "speak as soon as bytes arrive", not "render then play".

### Server: `api/tts.js`

```
   POST /api/tts  { agent, text }
        │
        ├─ checkOrigin / validate agent + non-empty text
        ├─ resolve voiceId from VOICE_ID_<AGENT> env var
        ├─ checkCharBudget(ip, text.length)
        │    └─ Redis pipeline: INCRBY tts:chars:ip:<day>:<ip>
        │                       INCRBY tts:chars:global:<day>
        │       (429 if either daily cap exceeded, or text > per-req cap)
        │
        ▼
   ElevenLabsClient.textToSpeech.stream(voiceId, {
     text,
     modelId:      eleven_multilingual_v2,   // ← ELEVENLABS_TTS_MODEL
     outputFormat: mp3_44100_128,            // ← ELEVENLABS_OUTPUT_FORMAT
     voiceSettings: {                        // per-agent personality
       stability, similarityBoost, style, useSpeakerBoost, speed
     }
   })
        │
        ▼  Content-Type: audio/mpeg, Cache-Control: no-store
   for await (chunk of stream) → res.write(chunk)
        │
        └─ req.on('close') sets clientGone → break loop
           (closes upstream EL stream, stops billing extra chars)
```

Per-agent `voiceSettings` are baked into a `VOICE_MAP` so Advocate/Critic/Wildcard get distinct deliveries (e.g. the Critic is more stable + less expressive; the Wildcard is the most "stylized"). Voice IDs themselves come from your ElevenLabs library via the `VOICE_ID_*` env vars — pick whichever voices fit the roles.

**Model choice — `eleven_multilingual_v2`.** Chosen over the faster `eleven_flash_v2_5` (the code fallback in `api/tts.js`) because it carries emotion and tonal variation noticeably better — the debate sounds like three people arguing, not three TTS voices reading. The trade-off is slightly higher TTFB; streaming + warmup priming (below) hide most of it.

**Output format — `mp3_44100_128`.** Podcast-grade vs the older default `mp3_22050_32` which sounded thin on desktop speakers. **Heads up:** 128 kbps requires ElevenLabs Creator tier or above. On Free/Starter the request 4xx's and the client's `audioDisabled` kill switch falls back to silent debate.

The function also disables Vercel's response cache (`no-store`) because the body is chunked binary; a downstream cache layer would buffer the whole stream before forwarding, which would erase the streaming win.

### Client: `src/lib/audio.js`

Two playback paths, picked at module load:

```
useMSE = MediaSource.isTypeSupported('audio/mpeg')
```

**1. MSE path (Chrome, Edge, Firefox desktop)** — true streaming playback:

```
playAudioStream(text, { agent, signal, getMuted, onPlaybackStart/End })
  │
  ├─ fetch('/api/tts', { signal, body: { agent, text } })
  │      → ReadableStream<Uint8Array> of MP3 bytes
  │
  ├─ new MediaSource() + new Audio(blob:URL → MediaSource)
  │
  └─ loop:
       reader.read() → sourceBuffer.appendBuffer(chunk)
       on FIRST chunk → audio.play()    ← TTFB-bounded latency
       on stream end  → mediaSource.endOfStream()
       resolves on: onended | onerror | signal abort | 60s timeout
```

**2. Blob fallback** — buffer-then-play for browsers without MSE/MP3 support:

```
fetch → drain whole stream into Uint8Array[] → new Blob → audio.play()
```

Either way, the same callback contract fires `onPlaybackStart(agent)` / `onPlaybackEnd(agent)` so the UI can pulse the speaking agent's node in the graph.

### Orchestration & Lifecycle (`src/lib/debate.js`, `src/App.jsx`)

- **Serialization.** `audio.js` uses module-level singletons (`currentAudio`, `currentResolve`). The orchestrator must `await` each `playAudioStream()` call before issuing the next; a concurrent caller would orphan the previous promise. The debate loop respects this by design — one turn speaks at a time.
- **Priming.** On topic submit, `TopicInput` fires two warmups before navigating into the debate view:
  - `primeAudio()` plays a 1-byte silent MP3 inside the form's click handler so the browser's autoplay policy is unlocked for the rest of the session.
  - `primeTTS()` sends a fire-and-forget 1-char request to `/api/tts` and drains the response, pre-warming the EL stream + DNS + Vercel function cold-start so the first real turn doesn't pay that cost.
- **Mute + abort.** The header mute button flips `mutedRef`; `audio.js` checks `getMuted()` between chunks and pauses immediately. "Stop" + "New Debate" call the orchestrator's cancel function, which `AbortController.abort()`s both the LLM `fetch` and the TTS `fetch`, plus pauses any in-flight `<audio>` element.
- **Per-turn timeout.** `TURN_TIMEOUT_MS = 60_000` is a safety net for stalled streams — if `onended`/`onerror`/abort never fire, the orchestrator unblocks anyway after 60s rather than hanging the debate.
- **Soft-fail.** If anything goes wrong (fetch fails, `appendBuffer` rejects, autoplay blocked), `audioDisabled` is set for the rest of the session and the debate continues silently — no UI error, just no audio.
- **Char cap.** `runDebate` clips each utterance to 1000 chars before sending — matches the server's `TTS_MAX_CHARS_PER_REQUEST` so a "deep" mode rant can't blow the budget.

### Cache Hooks (scaffolded)

`api/_shared.js` exposes `ttsCacheKey(text, model, voice)`, `getCachedTts(key)`, `setCachedTts(key, audioBase64)` — content-addressed by `sha256(model|voice|text)`, 7-day Redis TTL. `api/tts.js` doesn't currently consult them (streaming mode is preferred for first-utterance latency), but they're ready for a future hot-cache short-circuit path on common repeated phrases (e.g. canned verdict scaffolding).

## Key Files

| Path | Purpose |
|------|---------|
| `src/App.jsx` | Main app — state, layout, callback wiring |
| `src/lib/agents.js` | Agent config (name/model/color/prefix), response parsers |
| `src/lib/debate.js` | Async debate orchestrator — calls agents, serializes TTS playback, handles abort |
| `src/lib/audio.js` | TTS client — MSE streaming + Blob fallback, priming, mute, timeout safety net |
| `src/lib/graphUtils.js` | Graph data builder, Wildcard scoring logic |
| `src/components/DebateGraph.jsx` | D3 force-directed SVG graph (800×700, fixed agent anchors) |
| `src/components/Transcript.jsx` | Scrollable claim transcript |
| `src/components/WildcardVerdict.jsx` | End-of-debate verdict card |
| `src/components/TopicInput.jsx` | Landing form — primes audio + TTS on submit |
| `src/components/ThinkingIndicator.jsx` | Agent thinking animation |
| `src/components/RoundToasts.jsx` | Round winner notifications |
| `src/styles/theme.css` | Dark theme CSS variables |
| `api/debate.js` | Debate endpoint — routes agent → provider, builds system prompts |
| `api/verdict.js` | Verdict endpoint — Wildcard final judgment |
| `api/tts.js` | TTS endpoint — streams ElevenLabs MP3 chunks back to the client |
| `api/_shared.js` | LLM clients, origin check, validation, KV rate-limit + TTS-budget + cache helpers |

## Getting Started

### Prerequisites

- Node.js 20+ (Vercel's current LTS default; Node 18 is deprecated).
- Vercel CLI (`npm i -g vercel`) — needed for local dev so `/api/*` and the Vite frontend share an origin.
- API keys: Anthropic, OpenAI, Google, ElevenLabs.
- An Upstash Redis instance (provisioned via the Vercel Marketplace, or any Upstash account). Optional but recommended — without it, rate limits and TTS budgets fail open and provider spend caps become your only backstop.

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

# ── Upstash Redis (optional; KV-backed rate limits) ──
KV_REST_API_URL=https://....upstash.io
KV_REST_API_TOKEN=...

# ── Debate rate limits (optional) ────────────────────
RATE_LIMIT_IP_DAILY=30          # max new debates per IP per day
RATE_LIMIT_GLOBAL_DAILY=300     # max new debates globally per day
DEBATE_COOLDOWN_MS=60000        # min ms between debates from same IP

# ── TTS budgets + cache (optional) ───────────────────
TTS_MAX_CHARS_PER_REQUEST=1000  # per-call hard cap
TTS_CHARS_IP_DAILY=20000        # per-IP daily char ceiling
TTS_CHARS_GLOBAL_DAILY=200000   # global daily char ceiling
TTS_CACHE_TTL_SECONDS=604800    # 7d default for cached audio
```

### Development

Local dev uses the Vercel CLI so the Vite frontend and the `/api/*` serverless functions run on the same port:

```bash
vercel dev          # http://localhost:3000 (frontend + /api/* on one origin)
```

`npm run dev` runs Vite alone (`http://localhost:5173`) but `/api/*` will 404 — there's no proxy and no separate backend process. Use it only if you're working on pure UI changes.

### Production Build

```bash
npm run build       # outputs to dist/
```

### Deploy to Vercel

The repo is configured for Vercel out of the box:

- `api/` directory is auto-detected as serverless functions.
- Set all of the above env vars in your Vercel project settings (different values per environment if you like).
- If you provisioned Upstash via the Vercel Marketplace, `KV_REST_API_*` are wired automatically.
- Deployments happen on push.

## Rate Limiting & Budgets

All limits live in Upstash Redis so they're shared across serverless invocations (not per-instance like an in-memory counter would be). If `KV_REST_API_*` is unset, every limit fails open with a logged warning.

| Limit | Default | Env Var |
|-------|---------|---------|
| Per-IP daily debates | 30 | `RATE_LIMIT_IP_DAILY` |
| Global daily debates | 300 | `RATE_LIMIT_GLOBAL_DAILY` |
| Cooldown between debates | 60s | `DEBATE_COOLDOWN_MS` |
| Per-request TTS chars | 1,000 | `TTS_MAX_CHARS_PER_REQUEST` |
| Per-IP daily TTS chars | 20,000 | `TTS_CHARS_IP_DAILY` |
| Global daily TTS chars | 200,000 | `TTS_CHARS_GLOBAL_DAILY` |
| TTS cache TTL | 7d | `TTS_CACHE_TTL_SECONDS` |

The cooldown is implemented as `SET NX EX` on `rl:cd:<ip>` — only the *first* call of a new debate (round 1, advocate) tries to acquire it; subsequent agent calls within the same debate skip the lock. Daily counters auto-expire 25h after creation so a slow day naturally rolls over.

The frontend additionally prevents parallel debates structurally: while `status !== 'idle'`, the `TopicInput` view is unmounted entirely, so there's no Start button to click. Returning to it requires clicking **New Debate** in the header, which resets state.

> **Tip:** set spending caps on your LLM and ElevenLabs accounts as the most reliable cost control. The above limits are best-effort; provider-side caps are the last line of defense.

## Security

The API includes several hardening measures:

- **Origin check** — rejects requests from anything not in the `ALLOWED_ORIGINS` list (prod URL + localhost dev ports).
- **Input size caps** — topic ≤ 500 chars, claim text ≤ 2,000 chars, TTS text ≤ 1,000 chars per request.
- **Structural history validation** — claim IDs must match `^[a-z]{3}_r\d{1,2}_\d{1,2}$`, agent IDs are whitelisted, and the array length must not exceed what's expected at `(round, agent)`.
- **Prompt armoring** — system prompts instruct each model to treat the topic as a subject to debate, not an instruction to follow.
- **Generic error messages** — provider details are logged server-side only; clients always get `"Service temporarily unavailable"`.

## Tech Stack

- **Frontend:** React 19, Vite 8, D3 (force, selection, zoom, drag, transition), Lucide icons.
- **Backend:** Vercel Serverless Functions (Node.js).
- **LLM Providers:** Anthropic (Claude), OpenAI (GPT), Google (Gemini).
- **TTS:** ElevenLabs (`@elevenlabs/elevenlabs-js`), MP3 streamed via MSE on the client.
- **State / Cache:** Upstash Redis (Vercel Marketplace) for rate limits, TTS char budgets, and TTS audio cache.
- **Styling:** CSS custom properties, dark theme, no CSS framework.
- **No TypeScript, no state management library, no database.**

## License

MIT
