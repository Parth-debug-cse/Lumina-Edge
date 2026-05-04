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
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const sessions = raw ? JSON.parse(raw) : [];
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.unshift(session);
    }
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // If parse fails, just store this session alone
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
  }
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
  threads: 'auto',  // Will be dynamically detected
  ctx_size: 'auto',  // Will be dynamically detected based on memory
  batch_size: 'auto',  // Will be dynamically detected based on memory
  ubatch_size: 'auto',  // Will be dynamically detected based on memory
  n_gpu_layers: 'auto',
  temperature: 0.7,
  top_p: 0.9,
  repeat_penalty: 1.1,
  json_output: false,
  api_port: 8080,
}

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
