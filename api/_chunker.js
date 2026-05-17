// Sentence-boundary chunker for streaming LLM output. Feeds tokens via
// add(), emits chunks via the onChunk callback at sentence ends (with
// abbreviation guard), at clause breaks past the soft cap, or at any
// whitespace past the hard cap. Caller drains the residual buffer via
// flush() at end-of-stream.
//
// Prefixed with _ so Vercel doesn't expose this as an endpoint.

// Common English abbreviations whose trailing period must NOT trigger a
// sentence boundary. Compared lowercased to absorb casing variation.
const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.',
  'vs.', 'etc.', 'e.g.', 'i.e.', 'u.s.', 'u.k.', 'inc.', 'ltd.',
  'corp.', 'cf.', 'al.', 'vol.'
])

export class SentenceChunker {
  constructor({ softMax = 80, hardMax = 200 } = {}) {
    this.buf = ''
    this.softMax = softMax
    this.hardMax = hardMax
    this.onChunk = null
  }

  add(text) {
    if (!text) return
    this.buf += text
    while (this._tryFlush()) { /* keep flushing while boundaries remain */ }
  }

  // Emit whatever's left, unconditionally. Caller invokes at end-of-stream.
  flush() {
    const remaining = this.buf.trim()
    if (remaining && this.onChunk) this.onChunk(remaining)
    this.buf = ''
  }

  _tryFlush() {
    const sentence = this._findSentenceEnd()
    if (sentence !== -1) { this._emit(sentence); return true }

    if (this.buf.length > this.softMax) {
      const clause = this._findClauseEnd()
      if (clause !== -1) { this._emit(clause); return true }
    }

    if (this.buf.length > this.hardMax) {
      const ws = this._findWhitespaceBeforeHardMax()
      if (ws !== -1) { this._emit(ws); return true }
    }

    return false
  }

  // Find the FIRST sentence-end punctuation followed by whitespace, with
  // an abbreviation guard. Returns the cut position (exclusive end of the
  // chunk) or -1. Refuses to flush on terminal punctuation that lacks a
  // trailing whitespace — that's a partial sentence; flush() handles the
  // end-of-stream case.
  _findSentenceEnd() {
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i]
      if (c !== '.' && c !== '!' && c !== '?') continue
      const next = this.buf[i + 1]
      if (!next || !/\s/.test(next)) continue
      if (this._endsWithAbbrev(i)) continue
      return i + 1
    }
    return -1
  }

  // Walk backward from a terminator position to the prior whitespace (or
  // start of buf), then check whether the resulting word — including the
  // trailing period — is a known abbreviation.
  _endsWithAbbrev(terminatorIdx) {
    let start = terminatorIdx
    while (start > 0 && !/\s/.test(this.buf[start - 1])) start--
    const word = this.buf.slice(start, terminatorIdx + 1).toLowerCase()
    return ABBREVIATIONS.has(word)
  }

  // Find the LATEST clause break at or before hardMax. Symmetric with
  // _findWhitespaceBeforeHardMax: when multiple breaks exist, prefer the
  // longest chunk that still fits under the cap. Prevents tiny "Lorem,"
  // emissions when later commas would give a more prosody-friendly chunk.
  _findClauseEnd() {
    const limit = Math.min(this.buf.length, this.hardMax + 1)
    for (let i = limit - 2; i >= 0; i--) {
      const c = this.buf[i]
      if (c !== ',' && c !== ';' && c !== ':') continue
      if (/\s/.test(this.buf[i + 1])) return i + 1
    }
    return -1
  }

  // Find the LATEST whitespace at or before hardMax — maximizes chunk
  // length up to the cap. If no whitespace exists in that window (rare:
  // a single 200+ char run-on word), returns -1 and the chunker waits
  // for more tokens or for flush().
  _findWhitespaceBeforeHardMax() {
    const limit = Math.min(this.buf.length, this.hardMax + 1)
    for (let i = limit - 1; i >= 0; i--) {
      if (/\s/.test(this.buf[i])) return i + 1
    }
    return -1
  }

  _emit(cut) {
    const chunk = this.buf.slice(0, cut).trim()
    this.buf = this.buf.slice(cut).trimStart()
    if (chunk && this.onChunk) this.onChunk(chunk)
  }
}
