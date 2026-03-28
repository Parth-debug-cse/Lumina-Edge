// ============================================================
// Lumina Edge UI — utility: API / llama-server client
// ============================================================

const BASE_URL = '/v1'

/**
 * Test if the API server is accessible
 */
export async function testAPI() {
  try {
    const res = await fetch('/api/test')
    const data = await res.json()
    console.log('[API Test] Success:', data)
    return { ok: true, data }
  } catch (err) {
    console.error('[API Test] Failed:', err)
    return { ok: false, error: err.message }
  }
}

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
 * Check if the API gateway and Llama server are reachable.
 */
export async function checkServerHealth() {
  try {
    // Check if API gateway is alive
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    
    const apiRes = await fetch('/api/health', { signal: controller.signal })
    clearTimeout(timeout)
    
    if (!apiRes.ok) return { status: 'offline' }
    
    // API gateway is alive - check if a model is loaded
    let modelName = 'none'
    try {
      const llmController = new AbortController()
      const llmTimeout = setTimeout(() => llmController.abort(), 1000)
      const llmRes = await fetch(`${BASE_URL}/models`, { signal: llmController.signal })
      clearTimeout(llmTimeout)
      
      if (llmRes.ok) {
        const data = await llmRes.json()
        modelName = data.data?.[0]?.id || 'unknown'
        return { status: 'online', model: modelName }
      }
    } catch {
      // Model server not responding - that's fine, just means no model loaded
    }
    
    // API is alive, just no model loaded
    return { status: 'online', model: modelName }
  } catch (err) {
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
 * Download a model from HuggingFace to the models/ folder.
 */
export async function downloadModel(url, filename) {
  try {
    console.log('[API] Download request:', { url, filename })
    
    const res = await fetch('/api/download-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename }),
    })
    
    console.log('[API] Download response status:', res.status)
    
    if (!res.ok) {
      const errorText = await res.text()
      console.error('[API] Download endpoint error:', errorText)
      return { error: `Server error: ${res.status}` }
    }
    
    const result = await res.json()
    console.log('[API] Download response:', result)
    return result
  } catch (err) {
    console.error('[API] Download exception:', err)
    return { error: err.message }
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

// ============================================================
// MULTI-MODEL ROUTING & PARALLEL LOADING
// ============================================================

/**
 * Get multi-model router status
 */
export async function getRouterStatus() {
  try {
    const res = await fetch('/api/router/status')
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Get all registered models in router
 */
export async function getRegisteredModels() {
  try {
    const res = await fetch('/api/router/models')
    if (!res.ok) return []
    const data = await res.json()
    return data.models || []
  } catch {
    return []
  }
}

/**
 * Get model routes (endpoints) for available models
 */
export async function getModelRoutes() {
  try {
    const res = await fetch('/api/router/routes')
    if (!res.ok) return []
    const data = await res.json()
    return data.routes || []
  } catch {
    return []
  }
}

/**
 * Load a model via router (parallel loading)
 * @param {string} modelPath - Path to model file
 * @param {number} portOffset - Port offset from base (for parallel instances)
 * @returns {Promise<Object>} - Instance info
 */
export async function loadModel(modelPath, portOffset = 0) {
  try {
    const res = await fetch('/api/router/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_path: modelPath,
        port_offset: portOffset,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Load error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to load model: ${err.message}`)
  }
}

/**
 * Unload a model via router
 * @param {string} modelId - Model instance ID
 * @returns {Promise<Object>} - Confirmation
 */
export async function unloadModel(modelId) {
  try {
    const res = await fetch(`/api/router/unload/${modelId}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Unload error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to unload model: ${err.message}`)
  }
}

/**
 * Set routing policy for multi-model requests
 * @param {string} policy - 'round-robin', 'load-balanced', or 'first-available'
 */
export async function setRoutingPolicy(policy) {
  try {
    const res = await fetch('/api/router/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy }),
    })
    if (!res.ok) throw new Error(`Policy error ${res.status}`)
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to set routing policy: ${err.message}`)
  }
}

/**
 * Stream chat with model selection (router picks best model)
 */
export async function streamChatWithRouting({ messages, routerSelection = 'auto', temperature = 0.7, topP = 0.9, onChunk, signal }) {
  try {
    // If auto, let router decide. Otherwise, specify model endpoint
    const endpoint = routerSelection === 'auto' ? `${BASE_URL}/chat/completions` : routerSelection
    
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: 'local',
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
      buffer = lines.pop()

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
  } catch (err) {
    throw new Error(`Streaming failed: ${err.message}`)
  }
}

// ============================================================
// SHARDED MODEL DETECTION & CONVERSION
// ============================================================

/**
 * Detect if a model is sharded
 * @param {string} modelPath - Path to model directory or file
 */
export async function detectModelShards(modelPath) {
  try {
    const res = await fetch('/api/convert/detect-shards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_path: modelPath }),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Convert sharded model to GGUF
 * @param {string} modelPath - Path to sharded model directory
 * @param {string} outputPath - Output GGUF file path
 * @param {string} quantization - Quantization method
 */
export async function convertShardedModel(modelPath, outputPath, quantization = 'Q4_K_M') {
  try {
    const res = await fetch('/api/convert/sharded', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_path: modelPath,
        output_path: outputPath,
        quantization,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Conversion error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to convert sharded model: ${err.message}`)
  }
}

/**
 * Get memory estimate for sharded model
 */
export async function getShardedModelMemory(modelPath) {
  try {
    const res = await fetch('/api/convert/memory-estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_path: modelPath }),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
