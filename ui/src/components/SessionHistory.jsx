import { useState } from 'react'
import {
  getSessions, deleteSession,
  exportAsJSON, exportAsMarkdown,
} from '../utils/storage.js'

function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

export default function SessionHistory({ toast }) {
  const [sessions, setSessions] = useState(getSessions)
  const [search, setSearch]     = useState('')
  const [selected, setSelected] = useState(null)

  const refresh = () => setSessions(getSessions())

  const filtered = sessions.filter(s =>
    !search || s.title.toLowerCase().includes(search.toLowerCase()) ||
    s.messages.some(m => m.content.toLowerCase().includes(search.toLowerCase()))
  )

  const del = (id) => {
    deleteSession(id)
    if (selected?.id === id) setSelected(null)
    refresh()
    toast('Session deleted', 'info')
  }

  return (
    <div className="history-panel">
      {/* Toolbar */}
      <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 10 }}>
        <div className="search-box" style={{ maxWidth: '100%', flex: 1 }}>
          <span className="search-icon">⌕</span>
          <input
            placeholder="Search sessions and messages…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {sessions.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => { sessions.forEach(s => exportAsJSON(s)); toast(`Exported ${sessions.length} sessions as JSON`, 'success') }}>
              Export All JSON
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { sessions.forEach(s => exportAsMarkdown(s)); toast(`Exported ${sessions.length} sessions as Markdown`, 'success') }}>
              Export All MD
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* List */}
        <div style={{ width: 360, minWidth: 320, borderRight: '1px solid var(--border)', overflowY: 'auto' }}>
          <div className="history-list">
            {filtered.length === 0 && (
              <div className="empty-state">
                <div className="empty-icon">📋</div>
                <div className="empty-title">{sessions.length === 0 ? 'No sessions yet' : 'No matches'}</div>
                <div className="empty-body">
                  {sessions.length === 0
                    ? 'Your chat sessions will appear here.'
                    : 'Try a different search term.'}
                </div>
              </div>
            )}
            {filtered.map(s => {
              const preview = s.messages.find(m => m.role === 'assistant')?.content || ''
              return (
                <div
                  key={s.id}
                  className={`history-card${selected?.id === s.id ? ' active' : ''}`}
                  onClick={() => setSelected(s)}
                  style={selected?.id === s.id ? { borderColor: 'var(--accent)' } : {}}
                >
                  <div style={{ fontSize: '1.2rem', flex: '0 0 auto' }}>💬</div>
                  <div className="history-info">
                    <div className="history-title">{s.title}</div>
                    <div className="history-meta">
                      <span className="badge badge-muted" style={{ fontSize: '0.6rem', marginRight: 5 }}>{s.model}</span>
                      {s.messages.length} messages · {formatDate(s.updatedAt)}
                    </div>
                    {preview && <div className="history-preview">{preview}</div>}
                  </div>
                  <div className="history-actions" style={{ flexDirection: 'column', gap: 4 }}>
                    <button className="btn btn-ghost btn-sm btn-icon" title="Export JSON"
                      onClick={e => { e.stopPropagation(); exportAsJSON(s); toast('Exported JSON', 'success') }}>
                      {}
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" title="Export Markdown"
                      onClick={e => { e.stopPropagation(); exportAsMarkdown(s); toast('Exported Markdown', 'success') }}>
                      M↓
                    </button>
                    <button className="btn btn-danger btn-sm btn-icon" title="Delete"
                      onClick={e => { e.stopPropagation(); del(s.id) }}>
                      ×
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Detail view */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 20px' }}>
          {!selected ? (
            <div className="empty-state">
              <div className="empty-icon">📂</div>
              <div className="empty-title">Select a session</div>
              <div className="empty-body">Click a session to preview its messages here.</div>
            </div>
          ) : (
            <div>
              {/* Session header */}
              <div style={{
                padding: '20px 24px', borderBottom: '1px solid var(--border)',
                display: 'flex', alignItems: 'flex-start', gap: 16,
                background: 'rgba(8,8,16,0.6)', position: 'sticky', top: 0,
                backdropFilter: 'blur(12px)',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)', marginBottom: 4 }}>{selected.title}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className="badge badge-purple">{selected.model}</span>
                    <span className="badge badge-muted">{selected.messages.length} messages</span>
                    <span className="badge badge-muted">{formatDate(selected.createdAt)}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => { exportAsJSON(selected); toast('Exported JSON', 'success') }}>
                    Export JSON
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { exportAsMarkdown(selected); toast('Exported Markdown', 'success') }}>
                    Export MD
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => del(selected.id)}>Delete</button>
                </div>
              </div>

              {/* Messages */}
              <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {selected.messages.map((msg, i) => (
                  <div key={i} style={{
                    background: msg.role === 'user' ? 'var(--accent-dim)' : 'var(--bg-card)',
                    border: `1px solid ${msg.role === 'user' ? 'var(--border-accent)' : 'var(--border)'}`,
                    borderRadius: 'var(--r-md)', padding: '12px 16px',
                  }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <span style={{
                        fontSize: '0.68rem', fontWeight: 700,
                        color: msg.role === 'user' ? 'var(--text-accent)' : 'var(--cyan)',
                        textTransform: 'uppercase', letterSpacing: '0.06em',
                      }}>
                        {msg.role === 'user' ? 'You' : 'Lumina'}
                      </span>
                      {msg.timestamp && (
                        <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                          {formatDate(msg.timestamp)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                      {msg.content}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
