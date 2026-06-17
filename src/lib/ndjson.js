// NDJSON line iterator over a ReadableStream (e.g. fetch Response.body).
// Yields the parsed object for each non-empty line; skips malformed lines.
// Flushes the trailing buffer when the stream ends.
export async function* readNdjson(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const tryParse = (line) => {
    if (!line.trim()) return undefined
    try { return JSON.parse(line) } catch { return undefined }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const obj = tryParse(buffer)
        if (obj !== undefined) yield obj
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const obj = tryParse(line)
        if (obj !== undefined) yield obj
      }
    }
  } finally {
    try { reader.cancel() } catch { /* ignore */ }
  }
}
