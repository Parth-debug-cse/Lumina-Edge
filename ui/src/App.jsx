import { useState, useEffect, useCallback } from 'react'
import ChatPanel      from './components/ChatPanel.jsx'
import ModelManager   from './components/ModelManager.jsx'
import SettingsPanel  from './components/SettingsPanel.jsx'
import SessionHistory from './components/SessionHistory.jsx'
import MultiModelPanel from './components/MultiModelPanel.jsx'
import DiagnosticsPanel from './components/DiagnosticsPanel.jsx'
import { checkServerHealth } from './utils/api.js'

// ============================================================
// Navigation items
// ============================================================
const NAV = [
  { id: 'chat',       icon: '💬', label: 'Chat' },
  { id: 'models',     icon: '📦', label: 'Models' },
  { id: 'diagnostics',icon: '📊', label: 'Diagnostics' },
  { id: 'router',     icon: '🔄', label: 'Router' },
  { id: 'history',    icon: '📋', label: 'History' },
  { id: 'settings',   icon: '⚙',  label: 'Settings' },
]

const PANEL_TITLES = {
  chat:        { title: 'Chat',              sub: 'Local LLM conversation' },
  models:      { title: 'Model Manager',     sub: 'Browse, tag, and download GGUF models' },
  diagnostics: { title: 'Diagnostics',       sub: 'Resources, profiling, memory optimization, GPU benchmarks' },
  router:      { title: 'Multi-Model Router',sub: 'Load and route between multiple models' },
  history:     { title: 'Session History',   sub: 'Browse and export past conversations' },
  settings:    { title: 'Settings',          sub: 'Configure hyperparameters and server options' },
}

// ============================================================
// Toast system
// ============================================================
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

// ============================================================
// App root
// ============================================================
export default function App() {
  const [activePanel, setActivePanel] = useState('chat')
  const [serverStatus, setServerStatus] = useState('checking') // 'online' | 'offline' | 'checking'
  const [serverModel, setServerModel]   = useState('')
  const [localModels, setLocalModels]   = useState([]) // populated from server models list
  const { toasts, addToast } = useToasts()

  // ---- Fetch local models ----
  const fetchLocalModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models/list')
      if (res.ok) {
        const data = await res.json()
        setLocalModels(data)
      }
    } catch (err) {
      // Silently handle fetch error
    }
  }, [])

  // ---- Server health polling ----
  const pollHealth = useCallback(async () => {
    const result = await checkServerHealth()
    setServerStatus(result.status)
    if (result.model) setServerModel(result.model)
    // Do NOT call fetchLocalModels here
  }, [])

  useEffect(() => {
    pollHealth(); // immediate check on mount
    fetchLocalModels(); // fetch once on mount

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

  // ---- Panel title ----
  const pt = PANEL_TITLES[activePanel] || PANEL_TITLES.chat

  // ---- Render current panel ----
  const renderPanel = () => {
    switch (activePanel) {
      case 'chat':      return <ChatPanel      serverStatus={serverStatus} serverModel={serverModel} toast={addToast} />
      case 'models':    return <ModelManager   localModels={localModels}   toast={addToast} />
      case 'diagnostics': return <DiagnosticsPanel localModels={localModels} toast={addToast} />
      case 'router':    return <MultiModelPanel                            toast={addToast} />
      case 'history':   return <SessionHistory                             toast={addToast} />
      case 'settings':  return <SettingsPanel                              toast={addToast} />
      default:          return null
    }
  }

  return (
    <>
      <div className="bg-noise" />

      {/* Sidebar */}
      <aside className="sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <div className="logo-mark">
            <div className="logo-icon">✦</div>
            <div className="logo-text">
              <span className="logo-name">Lumina Edge</span>
              <span className="logo-version">v1.2  ·  Local AI</span>
            </div>
          </div>
        </div>

        {/* Nav */}
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

        {/* Footer — server status */}
        <div className="sidebar-footer">
          <div className="server-status">
            <div className={`status-dot ${serverStatus}`} />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                {serverStatus === 'offline' ? '🔴 Offline' :
                 serverStatus === 'checking' ? '🟠 Starting...' :
                 serverModel && serverModel !== 'none' ? '🟢 Model Loaded' : '🟡 API Ready'}
              </div>
              {serverStatus === 'offline' && (
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Restart the app
                </div>
              )}
              {serverStatus === 'checking' && (
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Initializing...
                </div>
              )}
              {serverStatus === 'online' && serverModel && serverModel !== 'none' && (
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: 2, fontFamily: "'JetBrains Mono', monospace", maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {serverModel}
                </div>
              )}
              {serverStatus === 'online' && (!serverModel || serverModel === 'none') && (
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Load a model to chat
                </div>
              )}
            </div>
          </div>

          {/* Quick links */}
          <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ flex: 1, justifyContent: 'center', fontSize: '0.65rem' }}
              onClick={pollHealth}
            >↺ Refresh</button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="main-area">
        <div className="panel-header">
          <div>
            <h1>{pt.title}</h1>
            <div className="panel-header-sub">{pt.sub}</div>
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

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {renderPanel()}
        </div>
      </div>

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span style={{ fontSize: '1rem' }}>
              {t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}
            </span>
            {t.message}
          </div>
        ))}
      </div>
    </>
  )
}
