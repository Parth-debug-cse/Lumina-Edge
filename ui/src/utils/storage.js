// ============================================================
// Lumina Edge UI — session storage utilities
// All sessions stored in localStorage for browser-based UI
// ============================================================

const SESSIONS_KEY = 'lumina_sessions'
const ACTIVE_KEY   = 'lumina_active_session'

export function getSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveSession(session) {
  const sessions = getSessions()
  const idx = sessions.findIndex(s => s.id === session.id)
  if (idx >= 0) sessions[idx] = session
  else sessions.unshift(session)
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

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

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
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
  threads: 4,
  ctx_size: 4096,
  batch_size: 512,
  ubatch_size: 256,
  n_gpu_layers: 'auto',
  temperature: 0.7,
  top_p: 0.9,
  repeat_penalty: 1.1,
  json_output: false,
  api_port: 1234,
  system_prompt: 'You are a precise, efficient AI assistant.',
}

export function getConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')
    return { ...DEFAULT_CONFIG, ...stored }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
}

// ============================================================
// Benchmark results
// ============================================================

const BENCH_KEY = 'lumina_benchmark_results'

export function getBenchmarkResults() {
  try {
    return JSON.parse(localStorage.getItem(BENCH_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveBenchmarkResult(result) {
  const results = getBenchmarkResults()
  results.unshift(result)
  localStorage.setItem(BENCH_KEY, JSON.stringify(results.slice(0, 50)))
}
