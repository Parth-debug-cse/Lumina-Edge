import { useState, useEffect, useCallback } from 'react'
import { MessageSquare, Cpu, Activity, ScanLine, Bot, Radar, Clock, Plug, SlidersHorizontal, HardDrive, Zap, BarChart3, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import ModelManager   from './components/ModelManager.jsx'
import SettingsPanel  from './components/SettingsPanel.jsx'
import SessionHistory from './components/SessionHistory.jsx'
import DiagnosticsPanel from './components/DiagnosticsPanel.jsx'
import LuminaScreenPanel from './components/LuminaScreenPanel.jsx'
import AgentPanel from './components/AgentPanel.jsx'
import ScoutPanel from './components/ScoutPanel.jsx'
import ApiDocs from './components/ApiDocs.jsx'
import SystemMonitor from './components/SystemMonitor.jsx'
import { checkServerHealth } from './utils/api.js'

// 9 nav items — each maps to a panel component with a lucide icon
const NAV = [
  { id: 'chat',       icon: MessageSquare,    label: 'Chat' },
  { id: 'models',     icon: Cpu,              label: 'Models' },
  { id: 'diagnostics',icon: Activity,         label: 'Diagnostics' },
  { id: 'screen',     icon: ScanLine,         label: 'Screen' },
  { id: 'agent',      icon: Bot,              label: 'Agent' },
  { id: 'scout',      icon: Radar,            label: 'Scout' },
  { id: 'history',    icon: Clock,            label: 'History' },
  { id: 'api',        icon: Plug,             label: 'API' },
  { id: 'settings',   icon: SlidersHorizontal,label: 'Settings' },
]

// Panel header metadata — title + subtitle for each nav item
const PANEL_TITLES = {
  chat:        { title: 'Chat',              sub: 'Chat with your local model' },
  models:      { title: 'Model Manager',     sub: 'Browse, tag, and download GGUF models' },
  diagnostics: { title: 'Diagnostics',       sub: 'Resources, profiling, memory optimization, GPU benchmarks' },
  screen:      { title: 'Lumina Screen',     sub: 'Resume screening pipeline — watch, parse, match, notify' },
  agent:       { title: 'Lumina Agent',      sub: 'Autonomous IT ops agent — reason, act, complete tasks' },
  scout:       { title: 'Lumina Scout',      sub: 'Hardware-aware model finder — scan, recommend, plan' },
  history:     { title: 'Session History',   sub: 'Browse and export past conversations' },
  api:         { title: 'API Documentation', sub: 'OpenAI-compatible endpoints reference' },
  settings:    { title: 'Settings',          sub: 'Configure hyperparameters and server options' },
}

// Incremental counter for unique toast IDs — avoids React key collisions
let _toastId = 0
// Custom hook: auto-dismiss toasts after 3.5s
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
  // Persist sidebar collapse state to localStorage — survives page reload
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('lumina-sidebar-collapsed') === 'true' } catch { return false }
  })
  const [chatUrl, setChatUrl] = useState('http://localhost:8000')
  const { toasts, addToast } = useToasts()

  // Open llama.cpp / OpenWebUI in the system browser via POST /api/open-chat
  const openChat = useCallback(async () => {
    try {
      const res = await fetch('/api/open-chat', { method: 'POST' })
      const data = await res.json()
      if (data.url) setChatUrl(data.url)
    } catch {}  // Silently fail — default URL fallback
  }, [])

  // Selecting Chat nav item triggers external browser launch
  const handleNavClick = useCallback((id) => {
    if (id === 'chat') openChat()
    setActivePanel(id)
  }, [openChat])

  // Fetch the list of available model files from the API
  const fetchLocalModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models/list')
      if (res.ok) {
        const data = await res.json()
        setLocalModels(data)
      }
    } catch {}  // Silently fail — models list stays empty
  }, [])

  // Check API gateway + llama-server reachability
  const pollHealth = useCallback(async () => {
    const result = await checkServerHealth()
    setServerStatus(result.status)
    if (result.model) setServerModel(result.model)
  }, [])

  // Health polling: rapid every 1s for 10 attempts (startup), then every 8s once server is up
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

  // Sync sidebar collapse state to localStorage on change
  useEffect(() => {
    try { localStorage.setItem('lumina-sidebar-collapsed', String(sidebarCollapsed)) } catch {}
  }, [sidebarCollapsed]);

  const pt = PANEL_TITLES[activePanel] || PANEL_TITLES.chat

  // Route activePanel ID to the correct panel component
  const renderPanel = () => {
    switch (activePanel) {
      case 'chat':        return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, padding: 40 }}>
          <div style={{ fontSize: '1.2rem', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            Opening llama.cpp interface in your browser...
          </div>
          <a
            href={chatUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 20px', background: 'var(--accent-dim)',
              border: '1px solid var(--border-accent)', borderRadius: 'var(--r-md)',
              color: 'var(--accent)', fontSize: '0.9rem', fontFamily: 'var(--font-mono)',
              textDecoration: 'none', cursor: 'pointer'
            }}
          >
            <ExternalLink size={16} /> {chatUrl}
          </a>
        </div>
      )
      case 'models':      return <ModelManager      localModels={localModels}   toast={addToast} onModelsRefresh={fetchLocalModels} />
      case 'diagnostics': return <DiagnosticsPanel   localModels={localModels} toast={addToast} />
      case 'screen':      return <LuminaScreenPanel                             toast={addToast} />
      case 'agent':       return <AgentPanel                                    toast={addToast} />
      case 'scout':       return <ScoutPanel                                    toast={addToast} />
      case 'history':     return <SessionHistory                                toast={addToast} />
      case 'api':         return <ApiDocs                                      toast={addToast} />
      case 'settings':    return <SettingsPanel                                 toast={addToast} />
      default:            return null
    }
  }

  return (
    <>
      <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-logo">
          <div className="logo-mark">
            <div className="logo-icon">{'>_'}</div>
            {!sidebarCollapsed && (
              <div className="logo-text">
                <span className="logo-name">Lumina Edge</span>
                <span className="logo-version">v1.2 · local AI</span>
              </div>
            )}
          </div>
        </div>

        <nav className="sidebar-nav">
          {!sidebarCollapsed && <div className="nav-section-label">Navigation</div>}
          {NAV.map(item => {
            const Icon = item.icon
            return (
              <div
                key={item.id}
                className={`nav-item${activePanel === item.id ? ' active' : ''}`}
                onClick={() => handleNavClick(item.id)}
                id={`nav-${item.id}`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="nav-item-lucide"><Icon size={16} /></span>
                {!sidebarCollapsed && item.label}
              </div>
            )
          })}
        </nav>

        <div className="sidebar-footer">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed(c => !c)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
          {!sidebarCollapsed && (
            <>
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
                  style={{ flex: 1, justifyContent: 'center', fontSize: '0.65rem' }}
                  onClick={() => { pollHealth(); fetchLocalModels(); }}
                >↺ Refresh</button>
              </div>
            </>
          )}
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
          <HardDrive size={12} /> {localModels.length > 0 ? `${(localModels.length * 1.5).toFixed(1)} GB` : '—'}
        </div>
        <div className="status-bar-divider" />
        <div className={`status-bar-item ${serverStatus === 'online' ? 'green' : serverStatus === 'offline' ? 'red' : ''}`}>
          <Zap size={12} /> {serverStatus === 'online' ? 'Online' : serverStatus === 'offline' ? 'Offline' : 'Connecting...'}
        </div>
        <div className="status-bar-divider" />
        <div className="status-bar-item" title="Context usage">
          <BarChart3 size={12} /> {serverModel && serverModel !== 'none' ? 'Model loaded' : 'No model'}
        </div>
        <div className="status-bar-spacer" />
        <div
          className="status-bar-item clickable"
          onClick={() => setShowMonitor(true)}
        >
          <Activity size={12} /> Monitor
        </div>
      </div>

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span style={{ fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}>
              {t.type === 'success' ? '>' : t.type === 'error' ? '!' : '>'}
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
