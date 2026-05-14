import { useState, useEffect } from 'react'
import { getRouterStatus, unloadAllModels } from '../utils/api.js'

export default function MultiModelPanel({ toast }) {
  const [routerStatus, setRouterStatus] = useState(null)
  const [loading, setLoading] = useState(false)

  const refreshStatus = async () => {
    try {
      const status = await getRouterStatus()
      setRouterStatus(status)
    } catch (err) {
      console.error('[MultiModelPanel] Failed to get router status:', err)
    }
  }

  useEffect(() => {
    refreshStatus()
    const interval = setInterval(refreshStatus, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleUnloadAll = async () => {
    const models = routerStatus?.models?.filter(m => m.status === 'ready') || []
    if (models.length === 0) {
      toast('No models loaded', 'info')
      return
    }

    const confirmed = window.confirm(`Unload ${models.length} model(s)?`)
    if (!confirmed) return

    setLoading(true)
    try {
      const result = await unloadAllModels()
      if (result.status === 'success') {
        toast(`✓ Unloaded ${result.unloaded} model(s)`, 'success')
        refreshStatus()
      } else {
        toast(`Failed: ${result.error}`, 'error')
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const models = routerStatus?.models || []

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: 8 }}>Multi-Model Router</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          Manage multiple loaded models and route inference requests between them.
        </p>
      </div>

      {models.length === 0 ? (
        <div style={{ 
          padding: 40, 
          textAlign: 'center', 
          color: 'var(--text-muted)',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: 8
        }}>
          <div style={{ fontSize: '2rem', marginBottom: 12 }}>📦</div>
          <div>No models loaded</div>
          <div style={{ fontSize: '0.8rem', marginTop: 8 }}>
            Go to Models tab to load a model
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-secondary)' }}>
              {models.length} model(s) loaded
            </span>
            <button 
              className="btn btn-sm" 
              style={{ background: 'var(--red-dim)', borderColor: 'rgba(239,68,68,0.4)', color: 'var(--red)' }}
              onClick={handleUnloadAll}
              disabled={loading}
            >
              {loading ? 'Unloading...' : 'Unload All'}
            </button>
          </div>

          {models.map(m => (
            <div 
              key={m.id}
              style={{ 
                padding: 16, 
                background: 'rgba(255,255,255,0.03)', 
                borderRadius: 8,
                border: '1px solid var(--border)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 500 }}>{m.name || m.model_name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                    Port: {m.port} • Status: {m.status}
                  </div>
                </div>
                <span className={`badge ${m.status === 'ready' ? 'badge-green' : 'badge-muted'}`}>
                  {m.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 24, padding: 16, background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
          Routing Policy
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Current: {routerStatus?.routing_policy || 'round-robin'}
        </div>
      </div>
    </div>
  )
}