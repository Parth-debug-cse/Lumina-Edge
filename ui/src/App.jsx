import { useState, useEffect, useCallback } from 'react'
import ModelManager   from './components/ModelManager.jsx'
import SettingsPanel  from './components/SettingsPanel.jsx'
import SessionHistory from './components/SessionHistory.jsx'
import MultiModelPanel from './components/MultiModelPanel.jsx'
import DiagnosticsPanel from './components/DiagnosticsPanel.jsx'
import ChatInterface from './components/ChatInterface.jsx'
import ApiDocs from './components/ApiDocs.jsx'
import SystemMonitor from './components/SystemMonitor.jsx'
import { checkServerHealth } from './utils/api.js'

const NAV = [
  { id: 'chat',       icon: '💬', label: 'Chat' },
  { id: 'models',     icon: '📦', label: 'Models' },
  { id: 'diagnostics',icon: '📊', label: 'Diagnostics' },
  { id: 'router',     icon: '🔄', label: 'Router' },
  { id: 'history',    icon: '📋', label: 'History' },
  { id: 'api',        icon: '📡', label: 'API' },
  { id: 'settings',   icon: '⚙',  label: 'Settings' },
]

const PANEL_TITLES = {
  chat:        { title: 'Chat',              sub: 'Chat with loaded models' },
  models:      { title: 'Model Manager',     sub: 'Browse, tag, and download GGUF models' },
  diagnostics: { title: 'Diagnostics',       sub: 'Resources, profiling, memory optimization, GPU benchmarks' },
  router:      { title: 'Multi-Model Router',sub: 'Load and route between multiple models' },
  history:     { title: 'Session History',   sub: 'Browse and export past conversations' },
  api:         { title: 'API Documentation', sub: 'OpenAI-compatible endpoints reference' },
  settings:    { title: 'Settings',          sub: 'Configure hyperparameters and server options' },
}

let _toastId = 0
function useToasts() {
  const [toasts, setToasts] = useState([])
  const addToast = useCallback((message, type = 'info', duration = 3500) => {
    const id = ++_toastId
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), duration)
  }, [])
  return { toasts, addToast }
}

export default function App() {
  const [activePanel, setActivePanel] = useState('chat')
  const [serverStatus, setServerStatus] = useState('checking')
  const [serverModel, setServerModel]   = useState('')
  const [localModels, setLocalModels]   = useState([])
  const [showMonitor, setShowMonitor]   = useState(false)
  const { toasts, addToast } = useToasts()

  const fetchLocalModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models/list')
      if (res.ok) {
        const data = await res.json()
        setLocalModels(data)
      }
    } catch {}
  }, [])

  const pollHealth = useCallback(async () => {
    const result = await checkServerHealth()
    setServerStatus(result.status)
    if (result.model) setServerModel(result.model)
  }, [])

  useEffect(() => {
    pollHealth()
    fetchLocalModels()

    let rapidCount = 0;
    let slowInterval = null;
    const rapidInterval = setInterval(() => {
      rapidCount++;
      pollHealth();
      if (rapidCount >= 10) {
        clearInterval(rapidInterval);
        slowInterval = setInterval(pollHealth, 8000);
      }
    }, 1000);

    return () => {
      clearInterval(rapidInterval);
      if (slowInterval) clearInterval(slowInterval);
    };
  }, [pollHealth, fetchLocalModels]);

  const pt = PANEL_TITLES[activePanel] || PANEL_TITLES.chat

  const renderPanel = () => {
    switch (activePanel) {
      case 'chat':        return <ChatInterface serverModel={serverModel} routerStatus={null} localModels={localModels} toast={addToast} />
      case 'models':      return <ModelManager   localModels={localModels}   toast={addToast} />
      case 'diagnostics': return <DiagnosticsPanel localModels={localModels} toast={addToast} />
      case 'router':      return <MultiModelPanel                            toast={addToast} />
      case 'history':     return <SessionHistory                             toast={addToast} />
      case 'api':         return <ApiDocs                                    toast={addToast} />
      case 'settings':    return <SettingsPanel                              toast={addToast} />
      default:            return null
    }
  }

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark">
            <div className="logo-icon">{'>_'}</div>
            <div className="logo-text">
              <span className="logo-name">Lumina Edge</span>
              <span className="logo-version">v1.2 · local AI</span>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">Navigation</div>
          {NAV.map(item => (
            <div
              key={item.id}
              className={`nav-item${activePanel === item.id ? ' active' : ''}`}
              onClick={() => setActivePanel(item.id)}
              id={`nav-${item.id}`}
            >
              <span className="nav-item-icon">{item.icon}</span>
              {item.label}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="server-status">
            <div className={`status-dot ${serverStatus}`} />
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                {serverStatus === 'offline' ? 'Offline' :
                 serverStatus === 'checking' ? 'Starting...' :
                 serverModel && serverModel !== 'none' ? 'Model Loaded' : 'API Ready'}
              </div>
              {serverStatus === 'offline' && (
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: 1 }}>
                  Restart the app
                </div>
              )}
              {serverStatus === 'checking' && (
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: 1 }}>
                  Initializing...
                </div>
              )}
              {serverStatus === 'online' && serverModel && serverModel !== 'none' && (
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: 1, fontFamily: 'var(--font-mono)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {serverModel}
                </div>
              )}
              {serverStatus === 'online' && (!serverModel || serverModel === 'none') && (
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: 1 }}>
                  Load a model to chat
                </div>
              )}
            </div>
          </div>

          <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ flex: 1, justifyContent: 'center', fontSize: '0.6rem' }}
              onClick={pollHealth}
            >↺ Refresh</button>
          </div>
        </div>
      </aside>

      <div className="main-area">
        <div className="panel-header">
          <div>
            <h1>{'> '}{pt.title}</h1>
            <div className="panel-header-sub">{'> '}{pt.sub}</div>
          </div>
          <div className="panel-header-actions">
            {serverStatus === 'online' && (
              <span className="badge badge-green">● Online</span>
            )}
            {serverStatus === 'offline' && (
              <span className="badge badge-muted">○ Offline</span>
            )}
            {serverStatus === 'checking' && (
              <span className="badge badge-muted">○ Checking…</span>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {renderPanel()}
        </div>
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <div className="status-bar-item" title="RAM Usage">
          💾 {localModels.length > 0 ? `${(localModels.length * 1.5).toFixed(1)} GB` : '—'}
        </div>
        <div className="status-bar-divider" />
        <div className={`status-bar-item ${serverStatus === 'online' ? 'green' : serverStatus === 'offline' ? 'red' : ''}`}>
          ⚡ {serverStatus === 'online' ? 'Online' : serverStatus === 'offline' ? 'Offline' : 'Connecting...'}
        </div>
        <div className="status-bar-divider" />
        <div className="status-bar-item" title="Context usage">
          📊 {serverModel && serverModel !== 'none' ? 'Model loaded' : 'No model'}
        </div>
        <div className="status-bar-spacer" />
        <div
          className="status-bar-item clickable"
          onClick={() => setShowMonitor(true)}
        >
          📈 Monitor
        </div>
      </div>

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span style={{ fontSize: '0.9rem' }}>
              {t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : '>'}
            </span>
            {t.message}
          </div>
        ))}
      </div>

      {/* System Monitor Overlay */}
      {showMonitor && (
        <SystemMonitor
          onClose={() => setShowMonitor(false)}
          toast={addToast}
        />
      )}
    </>
  )
}
