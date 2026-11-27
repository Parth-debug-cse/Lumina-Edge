import { buildSessionSearchIndex } from '../utils/session-search.js'

let sessionIndex = new Map()
let indexedCharacters = 0

function postIndexMetrics(type, startedAt) {
  self.postMessage({
    type,
    metrics: {
      durationMs: performance.now() - startedAt,
      sessionCount: sessionIndex.size,
      indexedCharacters,
    },
  })
}

function upsertSessions(sessions) {
  for (const entry of buildSessionSearchIndex(sessions)) {
    const previous = sessionIndex.get(entry.id)
    if (previous) indexedCharacters -= previous.text.length
    sessionIndex.set(entry.id, entry)
    indexedCharacters += entry.text.length
  }
}

self.addEventListener('message', event => {
  const message = event.data || {}
  if (message.type === 'index') {
    const startedAt = performance.now()
    sessionIndex = new Map()
    indexedCharacters = 0
    upsertSessions(message.sessions || [])
    postIndexMetrics('indexed', startedAt)
    return
  }

  if (message.type === 'upsert') {
    const startedAt = performance.now()
    upsertSessions(message.sessions || [])
    postIndexMetrics('updated', startedAt)
    return
  }

  if (message.type === 'remove') {
    const startedAt = performance.now()
    for (const id of message.ids || []) {
      const previous = sessionIndex.get(id)
      if (previous) indexedCharacters -= previous.text.length
      sessionIndex.delete(id)
    }
    postIndexMetrics('updated', startedAt)
    return
  }

  if (message.type === 'search') {
    const startedAt = performance.now()
    const query = String(message.query || '').trim().toLowerCase()
    const ids = []
    for (const session of sessionIndex.values()) {
      if (!query || session.text.includes(query)) ids.push(session.id)
    }
    self.postMessage({
      type: 'search-results',
      requestId: message.requestId,
      ids,
      metrics: {
        durationMs: performance.now() - startedAt,
        sessionCount: sessionIndex.size,
        indexedCharacters,
      },
    })
  }
})
