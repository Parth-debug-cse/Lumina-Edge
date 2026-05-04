// ============================================================
// Lumina Edge UI — utility: API / llama-server client
// ============================================================

const BASE_URL = 'http://127.0.0.1:8080/v1'

let _directPort = null;

export async function getActivePort() {
  try {
    const res = await fetch('/api/router/active-port');
    if (!res.ok) return null;
    const data = await res.json();
    _directPort = data.port;
    return data.port;
  } catch {
    return null;
  }
}

/**
 * Send a chat message to the llama-server OpenAI-compat API.
 * Calls onChunk(text) for each streamed token.
 */
export async function streamChat({ messages, model, temperature = 0.7, topP = 0.9, onChunk, signal }) {
  // Use cached direct port, or fetch it, or fall back to proxy
  const port = _directPort || await getActivePort();
  const endpoint = port
    ? `http://127.0.0.1:${port}/v1/chat/completions` 
    : `${BASE_URL}/chat/completions`;

  const res = await fetch(endpoint, {
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
  });

  if (!res.ok) {
    // If direct port failed, clear cache and throw so caller can retry via proxy
    _directPort = null;
    const err = await res.text();
    throw new Error(`Server error ${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    
    // Process all complete lines
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      
      if (!line || line === 'data: [DONE]') continue;
      if (!line.startsWith('data: ')) continue;
      
      try {
        const json = JSON.parse(line.slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
      } catch {}
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
    // Try direct port first (fastest)
    let modelName = 'none'
    try {
      const port = _directPort
      if (port) {
        const directRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          signal: AbortSignal.timeout(1000)
        })
        if (directRes.ok) {
          const data = await directRes.json()
          modelName = data.data?.[0]?.id || 'unknown'
          return { status: 'online', model: modelName }
        }
      }
    } catch {}

    // Fall back to router status
    try {
      const routerRes = await fetch('/api/router/active-port', {
        signal: AbortSignal.timeout(1000)
      })
      if (routerRes.ok) {
        const data = await routerRes.json()
        _directPort = data.port
        modelName = data.model || 'unknown'
        return { status: 'online', model: modelName }
      }
    } catch {}

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
export async function downloadModel(url, filename, autoConvert = false) {
  try {
    console.log('[API] Download request:', { url, filename, autoConvert })
    
    const res = await fetch('/api/download-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename, autoConvert }),
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

export async function getConvertibleModels() {
  try {
    const res = await fetch('/api/models/convertible')
    if (!res.ok) return { files: [] }
    return await res.json()
  } catch (err) {
    console.error('[API] getConvertibleModels error:', err)
    return { files: [] }
  }
}

export async function fetchConfig() {
  try {
    const res = await fetch('/api/config')
    if (!res.ok) return {}
    return await res.json()
  } catch (err) {
    console.error('[API] fetchConfig error:', err)
    return {}
  }
}

export async function saveConfig(config) {
  try {
    const res = await fetch('/api/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(errorText || `HTTP ${res.status}`)
    }
    return await res.json()
  } catch (err) {
    console.error('[API] saveConfig error:', err)
    return { error: err.message }
  }
}

/**
 * Convert a model from SafeTensor/FP16 to GGUF format.
 * Returns conversion status and output path.
 */
export async function convertModel(inputFilename, quantization = 'Q4_K_M', format = 'gguf') {
  try {
    const res = await fetch('/api/convert-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input_file: inputFilename,
        quantization: quantization,
        format: format,
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
 * Quantize a safetensors model using mlx-lm (macOS only).
 * Returns quantization status and output path.
 */
export async function quantizeModel(inputFilename, bits = 4) {
  try {
    const res = await fetch('/api/quantize-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input_file: inputFilename,
        bits: bits,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Quantization error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to quantize model: ${err.message}`)
  }
}

/**
 * Get quantization status for a model.
 * Returns status ('quantizing', 'complete', 'error') and progress info.
 */
export async function getQuantizationStatus(inputFilename, bits) {
  try {
    const res = await fetch(`/api/conversion-status?input=${encodeURIComponent(`quantize_${inputFilename}_${bits}`)}`)
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

/**
 * Get system info (platform, architecture, etc.)
 */
export async function getSystemInfo() {
  try {
    const res = await fetch('/api/system-info')
    if (!res.ok) return { platform: 'unknown', arch: 'unknown', isMacAppleSilicon: false }
    return await res.json()
  } catch {
    return { platform: 'unknown', arch: 'unknown', isMacAppleSilicon: false }
  }
}

/**
 * Fetch available model files from a HuggingFace repository.
 * @param {string} repo - Repository ID (e.g., "mlx-community/TinyLlama-1.1B-Chat-v1.0-mlx" or full URL)
 * @returns {Promise<Object>} - { repo, totalFiles, files: [{name, size, type}] }
 */
export async function fetchHFFiles(repo) {
  try {
    const encoded = encodeURIComponent(repo)
    const res = await fetch(`/api/hf-files?repo=${encoded}`)
    
    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}`
      try {
        const errorData = await res.json()
        errorMsg = errorData.error || errorMsg
      } catch {
        // Response wasn't JSON, use HTTP status as error
      }
      return { error: errorMsg }
    }
    
    const data = await res.json()
    return data
  } catch (err) {
    console.error('[API] fetchHFFiles error:', err)
    return { error: err.message || 'Unknown error fetching files' }
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
    // Ensure we're treating this as a local path, not a HuggingFace repo ID
    // If the modelPath looks like a repo ID (contains /), but it's actually a local file,
    // we need to make sure it's treated as a local path
    const cleanModelPath = modelPath.trim()
    
    console.log('[API] Loading model:', cleanModelPath)
    
    const res = await fetch('/api/router/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_path: cleanModelPath,
        port_offset: portOffset,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('[API] Load model error:', err)
      throw new Error(`Load error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    console.error('[API] Load model exception:', err)
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
    // If auto, use direct port or fallback to proxy. Otherwise, specify model endpoint
    let endpoint;
    if (routerSelection === 'auto') {
      const port = _directPort || await getActivePort();
      endpoint = port ? `http://127.0.0.1:${port}/v1/chat/completions` : `${BASE_URL}/chat/completions`;
    } else {
      endpoint = routerSelection;
    }
    
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
      
      // Process all complete lines
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        
        if (!line || line === 'data: [DONE]') continue
        if (!line.startsWith('data: ')) continue
        
        try {
          const json = JSON.parse(line.slice(6))
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
/**
 * Trigger system optimization (frees RAM, stops background services)
 */
export async function optimizeSystem() {
  try {
    const res = await fetch('/api/system/optimize', { method: 'POST' })
    if (!res.ok) throw new Error(`Optimization error ${res.status}`)
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to optimize system: ${err.message}`)
  }
}

// ============================================================
// INFERENCE DIAGNOSTICS & PROFILING
// ============================================================

/**
 * Profile inference speed for a loaded model
 * @param {Object} opts - { model_id?, prompt?, max_tokens?, runs? }
 * @returns {Promise<Object>} - { avg_tokens_per_sec, avg_ms_per_token, runs: [...] }
 */
export async function profileInference({ model_id, prompt, max_tokens, runs } = {}) {
  try {
    const res = await fetch('/api/inference/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: model_id || null, prompt: prompt || 'Write a short poem about the sea.', max_tokens: max_tokens || 64, runs: runs || 3 }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Profile error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to profile inference: ${err.message}`)
  }
}

/**
 * Run system-level inference diagnostics
 * @returns {Promise<Object>} - { success, output }
 */
export async function diagnoseInference() {
  try {
    const res = await fetch('/api/inference/diagnose')
    if (!res.ok) throw new Error(`Diagnose error ${res.status}`)
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to run diagnostics: ${err.message}`)
  }
}

/**
 * Get full inference diagnostics + profiling report
 * @param {number} port - Model server port
 * @param {number} maxTokens - Max tokens for profiling
 * @returns {Promise<Object>} - { success, output }
 */
export async function getInferenceReport(port, maxTokens) {
  try {
    const params = new URLSearchParams()
    if (port) params.set('port', port)
    if (maxTokens) params.set('max_tokens', maxTokens)
    const res = await fetch(`/api/inference/report?${params}`)
    if (!res.ok) throw new Error(`Report error ${res.status}`)
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to get inference report: ${err.message}`)
  }
}

// ============================================================
// RESOURCE MONITORING
// ============================================================

/**
 * Get system resource snapshot (CPU, RAM, iGPU, GPU, model processes)
 * @returns {Promise<Object>} - { cpu, memory, nvidia_gpu, igpu, model_processes }
 */
export async function getSystemResources() {
  try {
    const res = await fetch('/api/system/resources')
    if (!res.ok) throw new Error(`Resources error ${res.status}`)
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to get system resources: ${err.message}`)
  }
}

// ============================================================
// CONTEXT & MEMORY OPTIMIZATION
// ============================================================

/**
 * Estimate memory for a model at given context size
 * @param {string} modelPath - Model file path
 * @param {number} ctxSize - Context size
 * @param {string} kvQuant - KV cache quantization (q8_0, q4_0, f16, q5_0)
 * @returns {Promise<Object>} - { weight_memory_gb, kv_cache_memory_gb, total_estimated_gb, ... }
 */
export async function estimateMemory(modelPath, ctxSize = 4096, kvQuant = 'q8_0') {
  try {
    const res = await fetch('/api/memory/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_path: modelPath, ctx_size: ctxSize, kv_quant: kvQuant }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Estimate error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to estimate memory: ${err.message}`)
  }
}

/**
 * Auto-recommend optimal context size based on available memory
 * @param {string} modelPath - Model file path
 * @param {number} availableMem - Available memory in GB (null = auto-detect)
 * @param {string} kvQuant - KV cache quantization
 * @param {number} headroom - Headroom percentage
 * @returns {Promise<Object>} - { recommended_ctx_size, max_possible_ctx, ... }
 */
export async function recommendCtxSize(modelPath, availableMem = null, kvQuant = 'q8_0', headroom = 15) {
  try {
    const body = { model_path: modelPath, kv_quant: kvQuant, headroom }
    if (availableMem) body.available_mem = availableMem
    const res = await fetch('/api/memory/recommend-ctx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Recommend error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to recommend ctx size: ${err.message}`)
  }
}

/**
 * Compare KV cache quantizations for a model
 * @param {string} modelPath - Model file path
 * @param {number} ctxSize - Context size
 * @returns {Promise<Object>} - { output: string with comparison table }
 */
export async function compareKvQuant(modelPath, ctxSize = 4096) {
  try {
    const res = await fetch('/api/memory/compare-kv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_path: modelPath, ctx_size: ctxSize }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Compare error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to compare KV quantizations: ${err.message}`)
  }
}

// ============================================================
// GPU BENCHMARK
// ============================================================

/**
 * Run full CPU vs GPU benchmark
 * @param {string} modelPath - Model file path
 * @param {number[]} gpuLayers - GPU layer configs to test (e.g. [0, 10, 20, 99])
 * @param {number} ctxSize - Context size
 * @param {number} threads - CPU threads
 * @param {number} maxTokens - Max tokens per run
 * @param {number} runs - Number of benchmark runs per config
 * @returns {Promise<Object>} - { best_config, speedup_vs_cpu, results: [...] }
 */
export async function runGpuBenchmark(modelPath, gpuLayers = [0, 10, 20, 30, 50, 99], ctxSize = 2048, threads = 4, maxTokens = 64, runs = 3) {
  try {
    const res = await fetch('/api/benchmark/gpu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_path: modelPath, gpu_layers: gpuLayers, ctx_size: ctxSize, threads, max_tokens: maxTokens, runs }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Benchmark error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to run GPU benchmark: ${err.message}`)
  }
}

/**
 * Quick CPU vs GPU comparison (only 2 configs: CPU-only vs all-GPU)
 * @param {string} modelPath - Model file path
 * @param {number} ctxSize - Context size
 * @param {number} threads - CPU threads
 * @returns {Promise<Object>} - { best_config, speedup_vs_cpu, results: [...] }
 */
export async function quickGpuBenchmark(modelPath, ctxSize = 2048, threads = 4) {
  try {
    const res = await fetch('/api/benchmark/quick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_path: modelPath, ctx_size: ctxSize, threads }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Quick benchmark error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to run quick benchmark: ${err.message}`)
  }
}

/**
 * Unload all models from the router
 * @returns {Promise<Object>} - { status, unloaded }
 */
export async function unloadAllModels() {
  try {
    const res = await fetch('/api/router/unload-all', { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Unload-all error ${res.status}: ${err}`)
    }
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to unload all models: ${err.message}`)
  }
}
