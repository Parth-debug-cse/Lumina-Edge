import { buildSessionSearchIndex, searchSessionIds } from '../utils/session-search.js'

let sessionIndex = []

self.addEventListener('message', event => {
  const message = event.data || {}
  if (message.type === 'index') {
    sessionIndex = buildSessionSearchIndex(message.sessions || [])
    return
  }

  if (message.type === 'search') {
    self.postMessage({
      requestId: message.requestId,
      ids: searchSessionIds(sessionIndex, message.query),
    })
  }
})
