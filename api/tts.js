// Single-shot ElevenLabs TTS for a full claim or verdict string. Returns
// NDJSON: { audioBase64, alignment } per EL frame.
//
// PERMANENT — do not delete in any future cleanup. /api/debate-stream
// supersedes this for per-claim audio on MSE-capable clients, but two
// callers still depend on it: (1) the verdict path (legacy /api/verdict
// + this endpoint, no chunking), and (2) the iOS Safari fallback path
// in src/lib/debate.js when hasMSE() returns false. The streaming
// endpoint maintains a SEPARATE cache namespace (ttsStreamCacheKey) so
// the two endpoints' cached blobs never collide.
import { checkOrigin, getIp, checkCharBudget, VALID_AGENT_IDS, ttsCacheKey, getCachedTts, setCachedTts, deleteCachedTts } from './_shared.js'
import { MODEL_ID, OUTPUT_FORMAT, VOICE_MAP, getElClient, getVoiceId } from './_tts.js'

export default async function handler(req, res) {
  // HEAD: cheap connection warmup (primeTTS on Start click). 204 = no body.
  if (req.method === 'HEAD') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!checkOrigin(req, res)) return

  const { agent, text } = req.body || {}

  if (!VALID_AGENT_IDS.has(agent)) {
    return res.status(400).json({ error: 'Invalid agent' })
  }
  if (typeof text !== 'string' || text.length === 0) {
    return res.status(400).json({ error: 'Text required' })
  }
  // Length is enforced by checkCharBudget below (TTS_MAX_CHARS_PER_REQUEST env-configurable).

  const voiceId = getVoiceId(agent)
  if (!voiceId) {
    console.error(`[tts] missing voice ID for ${agent}`)
    return res.status(500).json({ error: 'Voice not configured' })
  }

  // Cache check BEFORE billing char budget — cached hits cost the user
  // nothing and don't consume EL quota. ?fresh=1 → admin bypass.
  // Eagerly DELETE the stored entry so even if the live regen
  // aborts mid-stream (the write below is gated on !clientGone),
  // the next normal visitor MISSes and tries again instead of
  // being served the stale entry the user was trying to overwrite.
  const cacheKey = ttsCacheKey(text, MODEL_ID, voiceId, OUTPUT_FORMAT, VOICE_MAP[agent].voiceSettings)
  const fresh = req.query?.fresh === '1'
  if (fresh) await deleteCachedTts(cacheKey)
  const cached = fresh ? null : await getCachedTts(cacheKey)
  if (cached) {
    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Cache', 'HIT')
    res.write(cached)
    return res.end()
  }

  const ip = getIp(req)
  const budgetError = await checkCharBudget(ip, text.length)
  if (budgetError) {
    return res.status(429).json({ error: budgetError, code: 'tts_budget' })
  }

  try {
    let clientGone = false
    req.on('close', () => { clientGone = true })

    const audioStream = await getElClient().textToSpeech.streamWithTimestamps(voiceId, {
      text,
      modelId: MODEL_ID,
      outputFormat: OUTPUT_FORMAT,
      voiceSettings: VOICE_MAP[agent].voiceSettings
    })

    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Cache', fresh ? 'BYPASS' : 'MISS')

    // Tee: stream to client AND accumulate the full NDJSON for cache write
    // after the stream completes successfully.
    const chunks = []
    for await (const chunk of audioStream) {
      if (clientGone) break
      const line = JSON.stringify(chunk) + '\n'
      chunks.push(line)
      res.write(line)
    }
    // Await the cache write BEFORE res.end(). On Vercel serverless, the
    // function may be torn down once the response closes; a fire-and-forget
    // write could silently never persist. The client's already buffered
    // every byte by this point so the extra ~10-30ms is invisible.
    if (!clientGone) {
      await setCachedTts(cacheKey, chunks.join(''))
    }
    res.end()
  } catch (err) {
    console.error('[tts] error:', err.message)
    if (!res.headersSent) {
      res.status(502).json({ error: 'Service temporarily unavailable' })
    } else {
      res.destroy()
    }
  }
}
