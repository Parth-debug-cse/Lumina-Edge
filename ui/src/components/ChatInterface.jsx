import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Square, Copy, Plus, ExternalLink } from 'lucide-react'
import { streamChat } from '../utils/api.js'

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

export default function ChatInterface({ serverModel, routerStatus, localModels, toast }) {
  // Messages array with system prompt; each msg: { role, content, timestamp, streaming?, tokens? }
  const [messages, setMessages] = useState([{ role: 'system', content: 'You are a helpful AI assistant running on Lumina Edge.' }])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)  // True while SSE stream is active
  const [selectedModel, setSelectedModel] = useState('')
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    if (serverModel && !selectedModel) {
      setSelectedModel(serverModel)
    }
  }, [serverModel])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
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

    try {
      // streamChat handles the fetch + ReadableStream reader internally
      await streamChat({
        messages: [...messages, userMsg].filter(m => m.role !== 'system' || m.content).map(m => ({
          role: m.role,
          content: m.content
        })),
        model: selectedModel || undefined,
        onChunk: (chunk) => {
          fullContent += chunk
          // Mutate last message in-place via setter spread to avoid stale closures
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last && last.role === 'assistant') {
              last.content = fullContent
            }
            return [...updated]
          })
        }
      })

      // Stream finished — mark as complete with token count
      setMessages(prev => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last && last.role === 'assistant') {
          last.streaming = false
          last.timestamp = new Date()
          last.tokens = countTokens(fullContent)
        }
        return [...updated]
      })
    } catch (err) {
      toast?.(`Generation error: ${err.message}`, 'error')
      setMessages(prev => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last && last.role === 'assistant') {
          last.content = fullContent || (err.message || 'An error occurred during generation.')
          last.streaming = false
          last.error = true
        }
        return [...updated]
      })
    } finally {
      setGenerating(false)
    }
  }, [input, messages, generating, selectedModel, toast])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleStop = () => setGenerating(false)

  const handleOpenWebUI = useCallback(async () => {
    try {
      const res = await fetch('/api/open-chat', { method: 'POST' })
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

  const loadedModels = routerStatus?.models?.filter(m => m.status === 'ready' || m.status === 'loading').map(m => m.name || m.model_name) || []

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
            {loadedModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
            {localModels.filter(lm => !loadedModels.includes(lm.name)).map(m => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
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
