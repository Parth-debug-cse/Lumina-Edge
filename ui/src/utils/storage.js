// ============================================================
// Lumina Edge UI — session storage utilities
// All sessions stored in localStorage for browser-based UI
// ============================================================

// localStorage keys for session persistence
const SESSIONS_KEY = 'lumina_sessions'
const ACTIVE_KEY   = 'lumina_active_session'

// Returns all saved sessions, or [] if none / corrupt
export function getSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')
  } catch {
    return []  // Config is corrupted — reset to empty
  }
}

// Upsert: updates existing session or inserts at front
export function saveSession(session) {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const sessions = raw ? JSON.parse(raw) : [];
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;  // Update existing in-place
    } else {
      sessions.unshift(session);  // New sessions pushed to front
    }
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // localStorage full or parse failed — store this session alone
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
  }
}

// Removes session by ID — silent no-op if not found
export function deleteSession(id) {
  const sessions = getSessions().filter(s => s.id !== id)
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

export function getActiveSessionId() {
  return localStorage.getItem(ACTIVE_KEY) || null
}

export function setActiveSessionId(id) {
  localStorage.setItem(ACTIVE_KEY, id)
}

// Creates a new session object with a timestamp-based unique ID
export function createSession(model = 'local') {
  return {
    id: `session_${Date.now()}`,
    title: 'New Conversation',
    model,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// Derives a short title from the first user message (first 7 words)
export function generateTitle(firstUserMsg) {
  if (!firstUserMsg) return 'New Conversation'
  const words = firstUserMsg.trim().split(/\s+/).slice(0, 7).join(' ')
  return words.length < firstUserMsg.trim().length ? `${words}…` : words
}

// ============================================================
// Export utilities
// ============================================================

export function exportAsJSON(session) {
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' })
  triggerDownload(blob, `lumina-${session.id}.json`)
}

export function exportAsMarkdown(session) {
  let md = `# ${session.title}\n\n`
  md += `**Model:** ${session.model}  \n`
  md += `**Date:** ${new Date(session.createdAt).toLocaleString()}  \n`
  md += `**Messages:** ${session.messages.length}\n\n---\n\n`
  for (const msg of session.messages) {
    const role = msg.role === 'user' ? '**You**' : '**Lumina**'
    const time = msg.timestamp ? `*${new Date(msg.timestamp).toLocaleTimeString()}*` : ''
    md += `### ${role} ${time}\n\n${msg.content}\n\n---\n\n`
  }
  const blob = new Blob([md], { type: 'text/markdown' })
  triggerDownload(blob, `lumina-${session.id}.md`)
}

// Creates a temp <a>, clicks it, then removes it — avoids DOM leaks
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)  // Release the object URL from memory
}

// ============================================================
// Model tag storage
// ============================================================

const TAGS_KEY = 'lumina_model_tags'

export function getModelTags() {
  try {
    return JSON.parse(localStorage.getItem(TAGS_KEY) || '{}')
  } catch {
    return {}
  }
}

export function setModelTags(tags) {
  localStorage.setItem(TAGS_KEY, JSON.stringify(tags))
}

// ============================================================
// Config (mirror of config.json — displayed in Settings)
// We store last-known config in localStorage for the UI
// ============================================================

const CONFIG_KEY = 'lumina_config'

export const DEFAULT_CONFIG = {
  // Core inference parameters (all platforms)
  ctx_size: 16384,
  batch_size: 256,
  ubatch_size: 256,
  n_gpu_layers: 'auto',
  temperature: 0.7,
  top_p: 0.9,
  repeat_penalty: 1.1,

  // Sampling parameters (llama.cpp only)
  top_k: 40,
  min_p: 0.05,

  // llama.cpp advanced parameters (Windows/Linux only)
  flash_attn: true,
  kv_cache_quant: 'q4_0',
  kv_cache_type_k: 'q4_0',
  kv_cache_type_v: 'q4_0',
  split_mode: 'auto',
  use_mlock: true,
  numa_mode: false,
  cont_batching: true,
  http_threads: 2,

  // MLX-specific parameters (macOS only)
  mlx_max_tokens: 2048,
  kv_bits: 4,
  kv_group_size: 64,
  mlx_seed: '',  // Empty = random seed
  mlx_stop_tokens: '',  // Comma-separated list
  mlx_adapter_path: '',  // Optional LoRA adapter path
  trust_remote_code: false,

  // Routing
  routing_policy: 'round_robin',

  // UI/output
  json_output: false,
  api_port: 8090,
}

// Merge stored config with defaults — undefined keys fall back to DEFAULT_CONFIG
export function getLocalConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')
    return { ...DEFAULT_CONFIG, ...stored }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveLocalConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
}

// ============================================================
