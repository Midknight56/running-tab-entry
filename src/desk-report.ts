// Bound the body while reading it, including requests without a length header.
export async function readReport(request: Request): Promise<string | null> {
  const limit = 100000
  if (Number(request.headers.get('Content-Length')) >= limit || !request.body) return null
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes >= limit) { await reader.cancel(); return null }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    const state: unknown = JSON.parse(text)
    return state && typeof state === 'object' && !Array.isArray(state) && 'pages' in state && Array.isArray(state.pages) ? JSON.stringify(state) : null
  } catch { return null }
  finally { reader.releaseLock() }
}
