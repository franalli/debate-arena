// Shared ElevenLabs client + voice configuration. Used by both
// /api/tts (legacy, single-shot per claim) and /api/debate-stream
// (chunked per-sentence within a claim).
//
// Prefixed with _ so Vercel doesn't expose this as an endpoint.

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'

export const MODEL_ID = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5'
export const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128'

export const VOICE_MAP = {
  advocate: {
    voiceSettings: { stability: 0.4, similarityBoost: 0.75, style: 0.3, useSpeakerBoost: true, speed: 1.0 }
  },
  critic: {
    voiceSettings: { stability: 0.6, similarityBoost: 0.75, style: 0.2, useSpeakerBoost: true, speed: 1.0 }
  },
  wildcard: {
    voiceSettings: { stability: 0.5, similarityBoost: 0.75, style: 0.4, useSpeakerBoost: true, speed: 1.0 }
  }
}

let _client = null
export function getElClient() {
  if (_client) return _client
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured')
  _client = new ElevenLabsClient({ apiKey })
  return _client
}

export function getVoiceId(agent) {
  const envKey = `VOICE_ID_${agent.toUpperCase()}`
  return process.env[envKey]
}
