import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Square, Copy, Plus, ExternalLink } from 'lucide-react'
import { apiFetch, streamChat } from '../utils/api.js'

// Relative timestamp formatting (e.g. "3m ago")
function formatTime(date) {
  const d = date || new Date()
  const now = new Date()
  const diff = now - d
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

// Rough token counter: ~4 chars per token (OpenAI-compatible heuristic)
function countTokens(text) {
  return Math.ceil(text.length / 4)
}

const EMOJI_PREFIX = {
  system: '>',
  user: '>',
  assistant: '>',
}

export default function ChatInterface({ serverModel, routerStatus, toast }) {
  // Messages array with system prompt; each msg: { role, content, timestamp, streaming?, tokens? }
  const [messages, setMessages] = useState([{ role: 'system', content: 'You are a helpful AI assistant running on Lumina Edge.' }])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)  // True while SSE stream is active
  const [selectedModel, setSelectedModel] = useState('')
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)
  const activeAbortController = useRef(null)

  useEffect(() => {
    if (serverModel && !selectedModel) {
      setSelectedModel(serverModel)
    }
  }, [serverModel])

  const loadedModels = routerStatus?.models?.filter(model => model.status === 'ready') || []

  useEffect(() => {
    if (!loadedModels.length) return
    setSelectedModel(current => loadedModels.some(model =>
      [model.id, model.name, model.model_name].includes(current)
    ) ? current : (loadedModels[0].id || loadedModels[0].name || loadedModels[0].model_name || ''))
  }, [routerStatus])

  useEffect(() => () => activeAbortController.current?.abort(), [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  // Core send handler: appends user msg, starts SSE stream, streams chunks into last assistant msg
  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || generating) return

    const userMsg = { role: 'user', content: text, timestamp: new Date() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setGenerating(true)

    // Insert placeholder assistant msg — streamChat fills it incrementally
    const assistantMsg = { role: 'assistant', content: '', timestamp: new Date(), streaming: true }
    setMessages(prev => [...prev, assistantMsg])

    let fullContent = ''
    const controller = new AbortController()
    activeAbortController.current = controller

    try {
      // streamChat handles the fetch + ReadableStream reader internally
      await streamChat({
        messages: [...messages, userMsg].filter(m => m.role !== 'system' || m.content).map(m => ({
          role: m.role,
          content: m.content
        })),
        model: selectedModel || undefined,
        signal: controller.signal,
        onChunk: (chunk) => {
          fullContent += chunk
          // Mutate last message in-place via setter spread to avoid stale closures
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last && last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, content: fullContent }
            }
            return updated
          })
        }
      })

      // Stream finished — mark as complete with token count
      setMessages(prev => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last && last.role === 'assistant') {
          updated[updated.length - 1] = {
            ...last,
            streaming: false,
            timestamp: new Date(),
            tokens: countTokens(fullContent),
          }
        }
        return updated
      })
    } catch (err) {
      const aborted = err.name === 'AbortError'
      if (!aborted) toast?.(`Generation error: ${err.message}`, 'error')
      setMessages(prev => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last && last.role === 'assistant') {
          updated[updated.length - 1] = {
            ...last,
            content: fullContent || (aborted ? '' : (err.message || 'An error occurred during generation.')),
            streaming: false,
            error: !aborted,
          }
        }
        return updated
      })
    } finally {
      if (activeAbortController.current === controller) activeAbortController.current = null
      setGenerating(false)
    }
  }, [input, messages, generating, selectedModel, toast])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleStop = () => activeAbortController.current?.abort()

  const handleOpenWebUI = useCallback(async () => {
    try {
      const res = await apiFetch('/api/open-chat', { method: 'POST' })
      const data = await res.json()
      if (data.error) {
        toast?.(data.error, 'error')
      } else {
        window.open(data.url, '_blank')
        if (data.hint) toast?.(data.hint, 'info')
      }
    } catch (err) {
      toast?.(`Failed to open chat: ${err.message}`, 'error')
    }
  }, [toast])

  const copyMessage = (content) => {
    navigator.clipboard.writeText(content)
    toast?.('Copied to clipboard', 'success')
  }


  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="model-selector">
          <select
            value={selectedModel}
            onChange={e => setSelectedModel(e.target.value)}
          >
            <option value="">
              {serverModel || 'Select a model...'}
            </option>
            {loadedModels.map(model => {
              const id = model.id || model.name || model.model_name
              return <option key={id} value={id}>{model.name || model.model_name || id}</option>
            })}
          </select>
        </div>

        <div className="chat-actions">
          <button className="chat-action-btn" title="Open llama.cpp Web UI" onClick={handleOpenWebUI}>
            <ExternalLink size={16} />
          </button>
          <button className="chat-action-btn" title="New chat" onClick={() => setMessages([{ role: 'system', content: 'You are a helpful AI assistant running on Lumina Edge.' }])}>
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            {msg.role === 'system' ? (
              <div className="msg-bubble">{msg.content}</div>
            ) : (
              <>
                <div className="msg-bubble">
                  {msg.content || (msg.streaming ? <span className="streaming-cursor" /> : '')}
                  {msg.streaming && msg.content && <span className="streaming-cursor" />}
                </div>
                <div className="msg-meta">
                  <span className="msg-time">
                    {msg.streaming
                      ? `${countTokens(msg.content)} tokens · streaming...`
                      : msg.tokens
                        ? `${msg.tokens} tokens · ${formatTime(msg.timestamp)}`
                        : formatTime(msg.timestamp)
                    }
                  </span>
                  <div className="msg-actions">
                    {msg.content && !msg.streaming && (
                      <button className="msg-action-btn" onClick={() => copyMessage(msg.content)}>
                        <Copy size={10} /> copy
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
        {generating && (
          <button className="stop-btn" onClick={handleStop}>
            <Square size={12} /> Stop
          </button>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder="> Type a message..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={generating}
          />
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!input.trim() || generating}
          >
            <Send size={16} />
          </button>
        </div>
        <div className="chat-input-hints">
          <span>Ctrl+Enter to send</span>
          <span>Shift+Enter for new line</span>
        </div>
      </div>
    </div>
  )
}
