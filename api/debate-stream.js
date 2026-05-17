// Streaming companion to /api/debate. One request = one claim. Emits
// application/x-ndjson with three event types:
//   {type:"chunk_meta", seq, chunkText}        — before each TTS chunk
//   {type:"audio",      seq, audioBase64, alignment}  — EL output frames
//   {type:"claim_complete", fullText, rebuts, agrees_with}  — once
// On failure mid-stream: {type:"error", recoverable:false, message}.
//
// WIRE-PROTOCOL MIRROR: src/lib/audio.js startClaimStream consumes the
// same envelope. Vite bundle can't import from api/, so the event-type
// strings live in both files; any added/renamed event needs both sides
// updated.
//
// Cache layout (separate namespaces; see _shared.js):
//   - getCachedLlm(llmCacheKey): full raw LLM response, shared with the
//     legacy /api/debate path. A hit skips the LLM call entirely.
//   - getCachedTtsStream(ttsStreamCacheKey): full assembled NDJSON, only
//     readable by THIS endpoint. A hit replays it byte-for-byte.
//
// Legacy /api/debate + /api/tts stay in place for iOS (no MediaSource)
// clients and for the verdict path. Do not delete.

import {
  checkOrigin, validateTopic, validateHistory, checkRateLimit, markDebateStart,
  getIp, VALID_AGENT_IDS, normalizeMode, formatHistory,
  llmCacheKey, getCachedLlm, setCachedLlm,
  ttsStreamCacheKey, getCachedTtsStream, setCachedTtsStream,
  AGENT_CONFIG
} from './_shared.js'
import { MODES, buildSystemPrompt, buildUserMessage } from './_prompts.js'
import { SentenceChunker } from './_chunker.js'
import { createStateMachine, extractFromRawLlm, parseMetaTrailer } from './_streaming.js'
import { MODEL_ID, OUTPUT_FORMAT, VOICE_MAP, getElClient, getVoiceId } from './_tts.js'

export default async function handler(req, res) {
  // HEAD: cheap connection + function-instance warmup. Called from
  // TopicInput on Start click via primeStream() so the actual POST
  // doesn't pay cold-start cost. 204 = no body. Mirrors api/tts.js.
  if (req.method === 'HEAD') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!checkOrigin(req, res)) return

  // ── Validate + rate limit ─────────────────────────────────────
  const ip = getIp(req)
  const round = Number(req.body?.round)
  const { agent, history } = req.body || {}
  const isNewDebate = Number.isInteger(round) && round === 1 && agent === 'advocate'

  const rateLimit = await checkRateLimit(ip, isNewDebate)
  if (rateLimit) {
    if (rateLimit.retryAfter) res.setHeader('Retry-After', String(rateLimit.retryAfter))
    return res.status(429).json({ error: rateLimit.message, code: rateLimit.code, retryAfter: rateLimit.retryAfter })
  }

  const topic = req.body?.topic
  if (!validateTopic(topic, res)) return
  const mode = normalizeMode(req.body?.mode)
  const cfg = MODES[mode]

  if (!VALID_AGENT_IDS.has(agent)) return res.status(400).json({ error: 'Invalid agent' })
  if (!Number.isInteger(round) || round < 1 || round > cfg.maxRounds) {
    return res.status(400).json({ error: 'Invalid round' })
  }
  if (!validateHistory(history, round, agent, res)) return

  const voiceId = getVoiceId(agent)
  if (!voiceId) {
    console.error(`[debate-stream] missing voice ID for ${agent}`)
    return res.status(500).json({ error: 'Voice not configured' })
  }
  const voiceSettings = VOICE_MAP[agent].voiceSettings

  // ── Compose prompts + cache keys ──────────────────────────────
  const agentCfg     = AGENT_CONFIG[agent]
  const systemPrompt = buildSystemPrompt(agent, mode)
  const userMessage  = buildUserMessage(topic, round, agent, formatHistory(history))
  const model        = process.env[agentCfg.modelEnv] || agentCfg.modelDefault
  const llmKey       = llmCacheKey(agentCfg.provider, model, systemPrompt, userMessage, cfg.maxTokens)

  // ── Abort plumbing ────────────────────────────────────────────
  let clientGone = false
  const upstreamAbort = new AbortController()
  req.on('close', () => {
    clientGone = true
    upstreamAbort.abort()
  })

  // ── Set headers ───────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-store')

  // Assigned once the dispatcher is running so the catch block can drain
  // it cleanly (`const` declarations inside try are not visible in catch).
  let cleanupDispatcher = null

  try {
    // ── LLM cache check + full-cache replay (Path A) ────────────
    const cachedLlm = await getCachedLlm(llmKey)
    let cachedFullText = null
    let cachedMeta = null

    if (cachedLlm) {
      const extracted = extractFromRawLlm(cachedLlm)
      cachedFullText = extracted.fullText
      cachedMeta = extracted.meta

      const ttsKey = ttsStreamCacheKey(cachedFullText, MODEL_ID, voiceId, OUTPUT_FORMAT, voiceSettings)
      const cachedTtsStream = await getCachedTtsStream(ttsKey)
      if (cachedTtsStream) {
        res.setHeader('X-Cache', 'HIT')
        res.write(cachedTtsStream)
        res.write(JSON.stringify({ type: 'claim_complete', fullText: cachedFullText, ...cachedMeta }) + '\n')
        return res.end()
      }
      res.setHeader('X-Cache', 'PARTIAL')   // LLM hit, TTS miss
    } else {
      res.setHeader('X-Cache', 'MISS')
    }

    // ── Set up chunker → TTS dispatcher queue ───────────────────
    // Single-producer / single-consumer queue. Second consumer would
    // race on queue.shift().
    const chunker = new SentenceChunker({ softMax: 80, hardMax: 200 })
    const queue = []
    const waiters = []
    const DONE = Symbol('done')

    function enqueue(item) {
      queue.push(item)
      if (waiters.length > 0) waiters.shift()()
    }
    async function dequeue() {
      if (queue.length === 0) await new Promise(r => waiters.push(r))
      return queue.shift()
    }
    chunker.onChunk = (text) => enqueue(text)

    // Buffer the chunk_meta + audio NDJSON so we can persist it to the
    // TTS-stream cache on full success. claim_complete is intentionally
    // NOT buffered — it's appended fresh on every response (live or
    // cache replay) so the cached blob can be reused verbatim.
    const ndjsonBuffer = []
    function emitCacheable(obj) {
      const line = JSON.stringify(obj) + '\n'
      res.write(line)
      ndjsonBuffer.push(line)
    }

    // Serial TTS dispatcher: pull a chunk → emit chunk_meta → stream
    // EL → forward audio events → repeat. `previousText` carries the
    // prior chunk's text into the next EL call for prosody continuity.
    const dispatcherPromise = (async () => {
      let previousText = ''
      let seq = 0
      while (true) {
        const item = await dequeue()
        if (item === DONE) return
        // Client disconnect: keep draining the queue (so the producer
        // can finish and we can release resources) but don't burn EL
        // calls. The for-await on elStream below also checks clientGone
        // so the active EL stream is cut short on the next frame.
        if (clientGone) continue

        emitCacheable({ type: 'chunk_meta', seq, chunkText: item })

        // EL SDK doesn't accept an AbortSignal here; a client disconnect
        // while we're awaiting streamWithTimestamps() lags by one EL
        // frame at most before the for-await breaks. Acceptable.
        const elStream = await getElClient().textToSpeech.streamWithTimestamps(voiceId, {
          text: item,
          previousText: previousText || undefined,
          modelId: MODEL_ID,
          outputFormat: OUTPUT_FORMAT,
          voiceSettings
        })
        for await (const elChunk of elStream) {
          if (clientGone) break
          emitCacheable({ type: 'audio', seq, ...elChunk })
        }
        previousText = item
        seq++
      }
    })()
    cleanupDispatcher = async () => {
      enqueue(DONE)
      try { await dispatcherPromise } catch { /* swallow — already errored */ }
    }

    // ── Producer: feed prose into chunker ───────────────────────
    // Two paths converge here. Both end with chunker.flush() + DONE.
    let rawText, fullText, meta

    if (cachedFullText !== null) {
      // LLM cache hit: feed cached prose directly. Skip the state
      // machine — we already have fullText and meta.
      rawText = cachedLlm
      fullText = cachedFullText
      meta = cachedMeta
      chunker.add(fullText)
      chunker.flush()
      enqueue(DONE)
    } else {
      // Live LLM stream → state machine → chunker.
      let proseAcc = ''
      const sm = createStateMachine({
        onProse: (text) => {
          proseAcc += text
          chunker.add(text)
        }
      })

      const llmStream = agentCfg.streamer(systemPrompt, userMessage, cfg.maxTokens, { signal: upstreamAbort.signal })
      let firstToken = true
      try {
        for await (const token of llmStream) {
          if (clientGone) break
          // First token = upstream LLM accepted the call. Lock in the
          // per-IP cooldown only after this point so a 404/auth-fail
          // doesn't strand the user in a 15s wait for a debate that
          // never started.
          if (firstToken) {
            firstToken = false
            if (isNewDebate) markDebateStart(ip).catch(() => {})
          }
          sm.feed(token)
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          // Client disconnected mid-stream. Drain the queue and bail
          // without cache writes.
          enqueue(DONE)
          await dispatcherPromise
          return
        }
        throw err
      }

      sm.finalize()
      chunker.flush()
      enqueue(DONE)

      rawText = sm.rawText
      fullText = proseAcc.trim()
      meta = parseMetaTrailer(sm.metaBuf)
    }

    // ── Wait for dispatcher to drain ────────────────────────────
    await dispatcherPromise

    if (clientGone) return  // no claim_complete, no cache writes

    // ── Cache writes BEFORE res.end() ───────────────────────────
    // On Vercel serverless, the function may tear down once the
    // response closes — fire-and-forget writes after res.end() can
    // silently never persist. Mirrors api/tts.js:107.
    if (fullText) {
      if (!cachedLlm) await setCachedLlm(llmKey, rawText)
      const ttsKey = ttsStreamCacheKey(fullText, MODEL_ID, voiceId, OUTPUT_FORMAT, voiceSettings)
      await setCachedTtsStream(ttsKey, ndjsonBuffer.join(''))
    }

    // ── claim_complete: written to the wire only, never cached ──
    res.write(JSON.stringify({ type: 'claim_complete', fullText, rebuts: meta.rebuts, agrees_with: meta.agrees_with }) + '\n')
    res.end()
  } catch (err) {
    console.error('[debate-stream] error:', err.message)
    if (cleanupDispatcher) await cleanupDispatcher()

    // Surface real error details to the client in non-production so a
    // developer doesn't have to dig into the vercel-dev terminal to
    // diagnose. In production, keep the generic message so internal
    // paths / env var names / upstream provider details don't leak.
    const wireMessage = process.env.NODE_ENV === 'production'
      ? 'Service temporarily unavailable'
      : (err.message || 'Service temporarily unavailable')

    if (!res.headersSent) {
      res.status(502).json({ error: wireMessage })
    } else {
      try {
        res.write(JSON.stringify({ type: 'error', recoverable: false, message: wireMessage }) + '\n')
      } catch { /* connection already torn down */ }
      try { res.end() } catch { /* ignore */ }
    }
  }
}
