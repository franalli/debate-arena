# ⚔ Debate Arena

Three frontier AI models debate any topic in real time. A visual argument graph shows how claims connect, clash, and evolve across rounds — then a neutral judge declares the winner.

**[Try it live →](https://debate-arena-ten.vercel.app)**

## How It Works

1. **Enter a topic** — any statement worth arguing about
2. **Three AI agents debate** across 3 rounds:
   - 🟢 **Advocate** (Gemini 3.1 Pro) — argues *for* the statement
   - 🔴 **Critic** (GPT-5.5) — argues *against* the statement
   - 🟣 **Wildcard** (Sonnet 4.6) — challenges both sides, then judges each round
3. **A force-directed graph** builds in real time — nodes are claims, edges show rebuttals and agreements
4. **The Wildcard delivers a verdict** — strongest arguments and the loser's biggest gap

Two debate modes:
- **Fast** — 12-word headline-style claims, ~100 tokens per turn
- **Deep** — 2–3 sentence arguments with evidence, ~800 tokens per turn

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React 19 + Vite 8)                           │
│                                                         │
│  TopicInput → runDebate() loops 3 rounds × 3 agents     │
│       ↓              ↓                  ↓               │
│  Transcript    DebateGraph (D3)    WildcardVerdict      │
└──────┬──────────────────────────────────────────────────┘
       │  POST /api/debate   POST /api/verdict
       ▼
┌─────────────────────────────────────────────────────────┐
│  Backend (Vercel Serverless Functions)                   │
│                                                         │
│  api/debate.js  → callGoogle() | callOpenAI()           │
│                   | callAnthropic()                     │
│  api/verdict.js → callAnthropic()                       │
│  api/_shared.js → LLM clients, validation, formatting   │
└─────────────────────────────────────────────────────────┘
```

### Key Files

| Path | Purpose |
|------|---------|
| `src/App.jsx` | Main app — all state, layout, callbacks |
| `src/lib/agents.js` | Agent config (names, colors, prefixes), response parsing |
| `src/lib/debate.js` | Async debate orchestrator with abort support |
| `src/lib/graphUtils.js` | Graph data builder, Wildcard scoring logic |
| `src/components/DebateGraph.jsx` | D3 force-directed SVG graph |
| `src/components/Transcript.jsx` | Scrollable claim transcript |
| `src/components/WildcardVerdict.jsx` | End-of-debate verdict card |
| `src/components/TopicInput.jsx` | Topic input + mode selector |
| `src/components/ThinkingIndicator.jsx` | Agent thinking animation |
| `src/components/RoundToasts.jsx` | Round winner notifications |
| `src/components/VoteBar.jsx` | Score visualization |
| `src/styles/theme.css` | Dark theme CSS variables |
| `api/_shared.js` | Shared LLM clients, origin check, input validation |
| `api/debate.js` | Debate endpoint — routes agents to providers |
| `api/verdict.js` | Verdict endpoint — Wildcard final judgment |

### Data Flow

1. User submits a topic → `runDebate()` starts looping rounds × agents
2. Each agent turn: `callAgent()` → `POST /api/debate` with topic, history, round, agent, mode
3. Server selects the LLM provider (Advocate → Google, Critic → OpenAI, Wildcard → Anthropic)
4. Raw LLM response is parsed client-side into structured claims (`{ id, text, rebuts, agrees_with }`)
5. Claims accumulate → `buildGraphData()` generates D3 nodes and links
6. After 3 rounds → `POST /api/verdict` → Wildcard summarizes strongest arguments + biggest gap
7. `computeWildcardScore()` tallies round wins from Wildcard's `agrees_with` picks

### Claim ID Format

Each claim gets a deterministic ID: `{prefix}_r{round}_{index}`

- Prefixes: `adv` (Advocate), `crt` (Critic), `wld` (Wildcard)
- Example: `crt_r2_1` = Critic's first claim in round 2

## Getting Started

### Prerequisites

- Node.js 18+
- API keys for all three providers

### Installation

```bash
git clone https://github.com/franalli/debate-arena.git
cd debate-arena
npm install
```

### Environment Variables

Create a `.env.local` file:

```env
# Required — one key per LLM provider
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...

# Optional — model overrides (defaults shown)
ANTHROPIC_MODEL=claude-sonnet-4-6
OPENAI_MODEL=gpt-4o
GOOGLE_MODEL=gemini-3.1-pro-preview

# Optional — token limits
FAST_MAX_TOKENS=100
DEEP_MAX_TOKENS=800

# Optional — rate limiting
RATE_LIMIT_IP_DAILY=30        # max new debates per IP per day
RATE_LIMIT_GLOBAL_DAILY=300   # max new debates globally per day
DEBATE_COOLDOWN_MS=60000      # min ms between debates from same IP
```

### Development

Run both the Vite dev server and the Express API server:

```bash
# Terminal 1 — frontend (http://localhost:5173)
npm run dev

# Terminal 2 — backend (http://localhost:3001)
node server.js
```

Vite proxies `/api/*` requests to the Express server in development.

### Production Build

```bash
npm run build      # outputs to dist/
npm start          # serves dist/ + API on one port
```

### Deploy to Vercel

The repo is configured for Vercel out of the box:

- `api/` directory contains serverless functions (auto-detected by Vercel)
- Set the three API key environment variables in your Vercel project settings
- Deployments happen automatically on push

## Rate Limiting

Server-side rate limiting is in-memory (best-effort on serverless — resets on cold starts):

| Limit | Default | Env Var |
|-------|---------|---------|
| Per-IP daily debates | 30 | `RATE_LIMIT_IP_DAILY` |
| Global daily debates | 300 | `RATE_LIMIT_GLOBAL_DAILY` |
| Cooldown between debates | 60s | `DEBATE_COOLDOWN_MS` |

The frontend also prevents parallel debates (start button disabled while running).

> **Tip:** Set spending caps on your LLM provider accounts as the most reliable cost control.

## Security

The API includes several hardening measures:

- **Origin check** — rejects requests from unknown origins
- **Input size caps** — topic (500 chars), history (capped per round), claim text (2,000 chars)
- **Structural history validation** — verifies claim IDs, agent IDs, and array sizes match the expected debate state
- **Prompt armoring** — system prompts instruct models to ignore instructions embedded in topics
- **Generic error messages** — provider details logged server-side only, never exposed to clients

## Tech Stack

- **Frontend:** React 19, Vite 8, D3 (force, selection, zoom, drag, transition), Lucide icons
- **Backend:** Vercel Serverless Functions (Node.js)
- **LLM Providers:** Anthropic (Claude), OpenAI (GPT), Google (Gemini)
- **Styling:** CSS custom properties, dark theme, no CSS framework
- **No TypeScript, no state management library, no database**

## License

MIT
