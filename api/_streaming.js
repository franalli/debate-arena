// Streaming-pipeline helpers used by /api/debate-stream:
//   - createStateMachine: incremental TEXT:/---META--- prose-trailer parser
//     for LLM tokens as they arrive.
//   - extractFromRawLlm: same parse, but applied to a complete cached
//     response string (used on the LLM-cache fast path).
//   - parseMetaTrailer: lenient JSON parser for the META block.
//
// CROSS-BOUNDARY MIRROR: src/lib/agents.js has its own client-side parser
// (tryProseFormat + extractJsonObjectSpan) for the same wire format. They
// can't share code (Vite bundle can't import from api/), so any change to
// the format must be applied to BOTH files.
//
// Prefixed with _ so Vercel doesn't expose this as an endpoint.

// Separator pattern: trailing \n is optional so the meta block can begin
// either on the next line or immediately. We don't tolerate dash-count
// drift here — the prompt is explicit; the offline parser in
// src/lib/agents.js is the safety net for malformed responses.
const SEP_RE = /\n---META---\n?/

// Must exceed the separator length, otherwise a partial separator at the
// tail of pendingText could be flushed to the chunker before we recognize
// it as a separator boundary.
const LOOKBACK = 20

export function parseMetaTrailer(metaRaw) {
  if (!metaRaw) return { rebuts: null, agrees_with: null }
  const trimmed = metaRaw.trim()
  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s)
      return { rebuts: obj.rebuts || null, agrees_with: obj.agrees_with || null }
    } catch {
      return null
    }
  }
  const direct = tryParse(trimmed)
  if (direct) return direct
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) {
    const sliced = tryParse(trimmed.slice(first, last + 1))
    if (sliced) return sliced
  }
  return { rebuts: null, agrees_with: null }
}

// Apply the TEXT:/---META--- protocol to a complete raw LLM response.
// Used when the LLM cache returns a fully-buffered response — we still
// need to split prose body from meta trailer for the streaming endpoint
// to dispatch chunks and report claim_complete with the right fields.
export function extractFromRawLlm(raw) {
  if (!raw) return { fullText: '', meta: { rebuts: null, agrees_with: null } }
  const m = raw.match(/^\s*TEXT:\s*\n?/i)
  if (!m) {
    // No prefix — treat the whole response as prose. parseAgentResponse
    // in src/lib/agents.js does the same fallback.
    return { fullText: raw.trim(), meta: { rebuts: null, agrees_with: null } }
  }
  const afterPrefix = raw.slice(m[0].length)
  const sepMatch = afterPrefix.match(SEP_RE)
  if (!sepMatch) {
    return { fullText: afterPrefix.trim(), meta: { rebuts: null, agrees_with: null } }
  }
  const fullText = afterPrefix.slice(0, sepMatch.index).trim()
  const metaRaw = afterPrefix.slice(sepMatch.index + sepMatch[0].length)
  return { fullText, meta: parseMetaTrailer(metaRaw) }
}

// Incremental parser for a live LLM token stream. Feed each token via
// feed(); the onProse callback fires with prose text safe to pass to the
// chunker (with a LOOKBACK-char tail held back to detect cross-token
// separators). At end-of-stream, call finalize() to flush any residual
// prose; then read rawText (full LLM output, for LLM cache write) and
// metaBuf (raw meta JSON, for parseMetaTrailer).
export function createStateMachine({ onProse }) {
  const state = {
    mode: 'IGNORE',     // 'IGNORE' | 'STREAMING' | 'META'
    prefixBuf: '',
    pendingText: '',
    metaBuf: '',
    rawText: ''
  }

  function feed(token) {
    if (!token) return
    state.rawText += token

    if (state.mode === 'IGNORE') {
      state.prefixBuf += token
      const m = state.prefixBuf.match(/^\s*TEXT:\s*\n?/i)
      if (!m) return
      const remaining = state.prefixBuf.slice(m[0].length)
      state.prefixBuf = ''
      state.mode = 'STREAMING'
      if (remaining) feedStreaming(remaining)
      return
    }

    if (state.mode === 'STREAMING') {
      feedStreaming(token)
      return
    }

    // META
    state.metaBuf += token
  }

  function feedStreaming(token) {
    state.pendingText += token
    const sepMatch = state.pendingText.match(SEP_RE)
    if (sepMatch) {
      const before = state.pendingText.slice(0, sepMatch.index)
      const after = state.pendingText.slice(sepMatch.index + sepMatch[0].length)
      if (before) onProse(before)
      state.pendingText = ''
      state.mode = 'META'
      if (after) state.metaBuf += after
      return
    }
    const safeEnd = state.pendingText.length - LOOKBACK
    if (safeEnd > 0) {
      const safe = state.pendingText.slice(0, safeEnd)
      onProse(safe)
      state.pendingText = state.pendingText.slice(safeEnd)
    }
  }

  function finalize() {
    // No separator was ever seen — treat remaining pending as prose.
    if (state.pendingText) {
      onProse(state.pendingText)
      state.pendingText = ''
    }
    // If we were still in IGNORE mode, the LLM never emitted a TEXT:
    // prefix. Flush prefixBuf as prose so the response isn't silently
    // dropped — parseAgentResponse on the cached raw text will fall back
    // to plain-text rendering, but at least the user gets audio.
    if (state.mode === 'IGNORE' && state.prefixBuf.trim()) {
      onProse(state.prefixBuf)
      state.prefixBuf = ''
    }
  }

  return {
    feed,
    finalize,
    get mode() { return state.mode },
    get metaBuf() { return state.metaBuf },
    get rawText() { return state.rawText }
  }
}
