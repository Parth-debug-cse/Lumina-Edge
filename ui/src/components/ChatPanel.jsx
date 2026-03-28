import { useState, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { streamChat, checkServerHealth } from '../utils/api.js'
import {
  getSessions, saveSession, deleteSession, createSession,
  getActiveSessionId, setActiveSessionId, generateTitle,
  getConfig,
} from '../utils/storage.js'

const ICON = {
  user: '👤',
  ai:   '⚡',
  send: '↑',
  new:  '+',
  del:  '×',
  copy: '⎘',
}

function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

export default function ChatPanel({ serverStatus, serverModel, toast }) {
  const cfg = getConfig()
  const [sessions, setSessions]       = useState(getSessions)
  const [activeId, setActiveId]       = useState(getActiveSessionId)
  const [input, setInput]             = useState('')
  const [streaming, setStreaming]     = useState(false)
  const [streamAbort, setStreamAbort] = useState(null)
  const messagesEndRef = useRef(null)
  const textareaRef    = useRef(null)

  const activeSession = sessions.find(s => s.id === activeId) || null
  const messages = activeSession?.messages || []

  // ---- Auto-scroll ----
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ---- Session helpers ----
  const refreshSessions = useCallback(() => setSessions(getSessions()), [])

  const newSession = useCallback(() => {
    const s = createSession()
    saveSession(s)
    setActiveSessionId(s.id)
    setActiveId(s.id)
    refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    if (!activeId || !sessions.find(s => s.id === activeId)) {
      if (sessions.length > 0) {
        setActiveId(sessions[0].id)
        setActiveSessionId(sessions[0].id)
      }
    }
  }, [sessions, activeId])

  const selectSession = (id) => {
    setActiveId(id)
    setActiveSessionId(id)
  }

  const removeSession = (e, id) => {
    e.stopPropagation()
    deleteSession(id)
    refreshSessions()
    if (activeId === id) {
      const remaining = getSessions()
      if (remaining.length > 0) selectSession(remaining[0].id)
      else { setActiveId(null); setActiveSessionId(null) }
    }
  }

  // ---- Send message ----
  const sendMessage = async () => {
    if (!input.trim() || streaming) return
    
    if (serverStatus === 'offline') {
      toast('❌ API server is offline. Please restart the app.', 'error')
      return
    }
    if (serverStatus === 'checking') {
      toast('⏳ Server is loading... Please wait.', 'info')
      return
    }
    
    // Check if model is loaded
    if (!serverModel || serverModel === 'none') {
      toast('📦 No model loaded. Go to Model Manager → Download or Load tab to load a model.', 'error')
      return
    }

    let session = activeSession
    if (!session) {
      session = createSession()
      saveSession(session)
      setActiveSessionId(session.id)
      setActiveId(session.id)
    }

    const userMsg = {
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    }

    const updatedMsgs = [...session.messages, userMsg]
    const isFirst = session.messages.length === 0

    const updatedSession = {
      ...session,
      messages: updatedMsgs,
      title: isFirst ? generateTitle(userMsg.content) : session.title,
      updatedAt: new Date().toISOString(),
    }
    saveSession(updatedSession)
    setSessions(getSessions())
    setInput('')
    setStreaming(true)

    // Add empty AI message
    const aiMsg = {
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    }
    const withAi = { ...updatedSession, messages: [...updatedMsgs, aiMsg] }
    saveSession(withAi)
    setSessions(getSessions())

    const controller = new AbortController()
    setStreamAbort(controller)

    try {
      const apiMsgs = updatedMsgs.map(({ role, content }) => ({ role, content }))
      // Prepend system prompt if not present
      if (apiMsgs[0]?.role !== 'system') {
        apiMsgs.unshift({ role: 'system', content: cfg.system_prompt || 'You are a precise, efficient AI assistant.' })
      }

      let accumulated = ''
      await streamChat({
        messages: apiMsgs,
        temperature: cfg.temperature,
        topP: cfg.top_p,
        onChunk: (text) => {
          accumulated += text
          const latestSession = getSessions().find(s => s.id === (activeId || session.id))
          if (latestSession) {
            const msgs = [...latestSession.messages]
            msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: accumulated }
            saveSession({ ...latestSession, messages: msgs, updatedAt: new Date().toISOString() })
            setSessions(getSessions())
          }
        },
        signal: controller.signal,
      })
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast(`Error: ${err.message}`, 'error')
        // Remove empty AI message
        const sess = getSessions().find(s => s.id === (activeId || session.id))
        if (sess && sess.messages.at(-1)?.content === '') {
          const msgs = sess.messages.slice(0, -1)
          saveSession({ ...sess, messages: msgs })
          setSessions(getSessions())
        }
      }
    } finally {
      setStreaming(false)
      setStreamAbort(null)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const copyMessage = (content) => {
    navigator.clipboard.writeText(content).then(() => toast('Copied!', 'success'))
  }

  const stopStream = () => { streamAbort?.abort(); setStreaming(false) }

  // ---- Auto-resize textarea ----
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
  }, [input])

  return (
    <div className="split-layout">
      {/* Sessions sidebar */}
      <div className="split-left">
        <div className="split-header">
          Conversations
          <button className="btn btn-ghost btn-sm btn-icon" onClick={newSession} title="New chat">
            {ICON.new}
          </button>
        </div>
        <div className="sessions-list" style={{ flex: 1, overflowY: 'auto' }}>
          {sessions.length === 0 && (
            <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '0.74rem', textAlign: 'center' }}>
              No conversations yet.<br />Press + to start.
            </div>
          )}
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item${s.id === activeId ? ' active' : ''}`}
              onClick={() => selectSession(s.id)}
            >
              <div className="session-title">{s.title}</div>
              <div className="session-meta" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{s.messages.length} msgs · {formatTime(s.updatedAt)}</span>
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  style={{ fontSize: '0.7rem', padding: '2px 5px', opacity: 0.5 }}
                  onClick={(e) => removeSession(e, s.id)}
                  title="Delete"
                >{ICON.del}</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Chat main */}
      <div className="split-main">
        {!activeSession ? (
          <div className="empty-state">
            <div className="empty-icon">⚡</div>
            <div className="empty-title">Start a conversation</div>
            <div className="empty-body">
              {serverStatus === 'online'
                ? 'Select a session or create a new one to begin chatting with your local LLM.'
                : 'Start lumina-api.sh to connect to your local model, then begin chatting.'}
            </div>
            <button className="btn btn-primary btn-lg" onClick={newSession} style={{ marginTop: 8 }}>
              New Conversation
            </button>
          </div>
        ) : (
          <div className="chat-panel">
            {/* Messages */}
            <div className="chat-messages">
              {messages.length === 0 && !streaming && (
                <div className="empty-state" style={{ flex: '0 0 auto', marginTop: 40 }}>
                  <div className="empty-icon">✦</div>
                  <div className="empty-title">Ask anything</div>
                  <div className="empty-body">Your local LLM is ready. Everything runs on your hardware — private and fast.</div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`chat-message${msg.role === 'user' ? ' user' : ''}`}>
                  <div className={`msg-avatar ${msg.role === 'user' ? 'user' : 'ai'}`}>
                    {msg.role === 'user' ? ICON.user : ICON.ai}
                  </div>
                  <div className="msg-body">
                    <div className="msg-meta">
                      <span className={`msg-role ${msg.role === 'user' ? 'user' : 'ai'}`}>
                        {msg.role === 'user' ? 'You' : 'Lumina'}
                      </span>
                      <span className="msg-time">{formatTime(msg.timestamp)}</span>
                      <div className="msg-actions">
                        <button className="btn btn-ghost btn-sm btn-icon" style={{ fontSize: '0.7rem' }}
                          onClick={() => copyMessage(msg.content)} title="Copy">
                          {ICON.copy}
                        </button>
                      </div>
                    </div>
                    <div className="msg-content">
                      {msg.content === '' && streaming && i === messages.length - 1 ? (
                        <div className="typing-indicator">
                          <div className="typing-dot" />
                          <div className="typing-dot" />
                          <div className="typing-dot" />
                        </div>
                      ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="chat-input-area">
              <div className="chat-input-row">
                <textarea
                  ref={textareaRef}
                  className="chat-textarea"
                  placeholder={serverStatus === 'online' ? 'Message Lumina… (Shift+Enter for new line)' : 'Start lumina-api.sh to connect…'}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={streaming || serverStatus !== 'online'}
                  rows={1}
                />
                {streaming ? (
                  <button className="send-btn" onClick={stopStream} title="Stop generation"
                    style={{ background: 'var(--red)' }}>
                    ◼
                  </button>
                ) : (
                  <button
                    className="send-btn"
                    onClick={sendMessage}
                    disabled={!input.trim() || serverStatus !== 'online'}
                    title="Send (Enter)"
                  >
                    {ICON.send}
                  </button>
                )}
              </div>
              <div className="chat-input-hints">
                <span>Enter to send · Shift+Enter for newline</span>
                {streaming && <span style={{ color: 'var(--cyan)' }}>● Generating…</span>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
