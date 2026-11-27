export function buildSessionSearchIndex(sessions) {
  return sessions.map(session => {
    const messages = Array.isArray(session.messages) ? session.messages : []
    const text = [session.title || '', ...messages.map(message => message?.content || '')]
      .map(value => String(value).toLowerCase())
      .join('\n')
    return { id: session.id, text }
  })
}

export function searchSessionIds(index, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!normalizedQuery) return index.map(session => session.id)
  return index
    .filter(session => session.text.includes(normalizedQuery))
    .map(session => session.id)
}
