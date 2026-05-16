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
