// ============================================================
// Lumina Edge UI — utility: API / llama-server client
// ============================================================

const BASE_URL = '/v1'

/**
 * Send a chat message to the llama-server OpenAI-compat API.
 * Calls onChunk(text) for each streamed token.
 */
export async function streamChat({ messages, model, temperature = 0.7, topP = 0.9, onChunk, signal }) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: model || 'local',
      messages,
      temperature,
      top_p: topP,
      stream: true,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Server error ${res.status}: ${err}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (!trimmed.startsWith('data: ')) continue
      try {
        const json = JSON.parse(trimmed.slice(6))
        const delta = json.choices?.[0]?.delta?.content
        if (delta) onChunk(delta)
      } catch {
        // skip malformed
      }
    }
  }
}

/**
 * Check if llama-server is reachable.
 */
export async function checkServerHealth() {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`${BASE_URL}/models`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return { status: 'offline' }
    const data = await res.json()
    const model = data.data?.[0]?.id || 'unknown'
    return { status: 'online', model }
  } catch {
    return { status: 'offline' }
  }
}

/**
 * Get loaded model info.
 */
export async function getModels() {
  try {
    const res = await fetch(`${BASE_URL}/models`)
    if (!res.ok) return []
    const data = await res.json()
    return data.data || []
  } catch {
    return []
  }
}

/**
 * Convert a model from SafeTensor/FP16 to GGUF format.
 * Returns conversion status and output path.
 */
export async function convertModel(inputFilename, quantization = 'Q4_K_M') {
  try {
    const res = await fetch('/api/convert-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input_file: inputFilename,
        quantization: quantization,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Conversion error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to convert model: ${err.message}`)
  }
}

/**
 * Get conversion status for a model.
 * Returns status ('pending', 'converting', 'complete', 'failed') and progress info.
 */
export async function getConversionStatus(inputFilename) {
  try {
    const res = await fetch(`/api/conversion-status?input=${encodeURIComponent(inputFilename)}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Get list of supported input formats for conversion.
 */
export async function getSupportedFormats() {
  try {
    const res = await fetch('/api/supported-formats')
    if (!res.ok) return { formats: ['gguf', 'safetensors', 'bin', 'pt'], converter_available: false }
    return await res.json()
  } catch {
    return { formats: ['gguf', 'safetensors', 'bin', 'pt'], converter_available: false }
  }
}
