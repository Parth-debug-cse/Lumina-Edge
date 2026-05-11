import { useState, useEffect } from 'react'
import * as api from '../utils/api.js'

/**
 * Multi-Model Manager & Router
 * Manages parallel loading, routing policies, and shard detection
 */
export default function MultiModelPanel({ toast }) {
  const [routerData, setRouterData] = useState(null)
  const [routingPolicy, setRoutingPolicy] = useState('round-robin')
  const [isLoading, setIsLoading] = useState(false)
  const [modelPath, setModelPath] = useState('')
  const [shardInfo, setShardInfo] = useState(null)
  const [showShardDetails, setShowShardDetails] = useState(false)

  // Load router status
  useEffect(() => {
    refreshRouterStatus()
    const interval = setInterval(refreshRouterStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  // SSE listener for real-time model status updates
  useEffect(() => {
    const eventSource = new EventSource('/api/router/events')

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        console.log('[SSE] Model status update:', data)

        if (data.status === 'ready') {
          toast?.(`✓ Model loaded successfully on port ${data.port}!`, 'success')
          setIsLoading(false)
          refreshRouterStatus()
        } else if (data.status === 'error') {
          toast?.(`Model loading failed: ${data.error || 'Unknown error'}`, 'error')
          setIsLoading(false)
          refreshRouterStatus()
        }
      } catch (err) {
        console.error('[SSE] Parse error:', err)
      }
    }

    eventSource.onerror = () => {
      console.log('[SSE] Connection error, will retry...')
    }

    return () => {
      eventSource.close()
    }
  }, [])

  const refreshRouterStatus = async () => {
    // Don't poll while loading to avoid hammering the endpoint during critical time
    if (isLoading) return;
    
    try {
      const status = await api.getRouterStatus()
      if (status) {
        setRouterData(status)
        setRoutingPolicy(status.routing_policy || 'round-robin')
      }
    } catch (err) {
    }
  }

  const handleLoadModel = async () => {
    if (!modelPath.trim()) {
      toast?.('Please enter model path', 'error')
      return
    }

    setIsLoading(true)
    try {
      const result = await api.loadModel(modelPath)
      if (result.status === 'success') {
        toast?.(`Model loaded on port ${result.port}`, 'success')
        setModelPath('')
        refreshRouterStatus()
        // Prime the direct port cache for streaming
        await api.getActivePort()
      } else {
        toast?.(result.error || 'Failed to load model', 'error')
      }
    } catch (err) {
      toast?.(`Error: ${err.message}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const handleDetectShards = async () => {
    if (!modelPath.trim()) {
      toast?.('Please enter model path', 'error')
      return
    }

    try {
      const info = await api.detectModelShards(modelPath)
      if (info) {
        setShardInfo(info)
        setShowShardDetails(true)
        if (info.is_sharded) {
          toast?.(`Detected ${info.total_shards} shards (${info.format})`, 'success')
        } else {
          toast?.('Model is not sharded', 'info')
        }
      }
    } catch (err) {
      toast?.(`Error: ${err.message}`, 'error')
    }
  }

  const handleSetPolicy = async (policy) => {
    try {
      await api.setRoutingPolicy(policy)
      setRoutingPolicy(policy)
      toast?.(`Routing policy set to: ${policy}`, 'success')
      refreshRouterStatus()
    } catch (err) {
      toast?.(`Error: ${err.message}`, 'error')
    }
  }

  const handleUnloadModel = async (modelId) => {
    try {
      await api.unloadModel(modelId)
      toast?.('Model unloaded', 'success')
      refreshRouterStatus()
    } catch (err) {
      toast?.(`Error: ${err.message}`, 'error')
    }
  }

  return (
    <div className="multi-model-panel">
      <div className="panel-header">
        <h2>🔄 Multi-Model Router</h2>
        <p>Load, manage, and route between multiple models in parallel</p>
      </div>

      {/* Routing Policy Selection */}
      <div className="section">
        <h3>Routing Policy</h3>
        <div className="policy-buttons">
          {['round-robin', 'load-balanced', 'first-available'].map(policy => (
            <button
              key={policy}
              className={`btn ${routingPolicy === policy ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleSetPolicy(policy)}
              disabled={isLoading}
            >
              {policy === 'round-robin' && '↔️ Round-Robin'}
              {policy === 'load-balanced' && '⚖️ Load-Balanced'}
              {policy === 'first-available' && '⚡ First-Available'}
            </button>
          ))}
        </div>
        <p className="text-muted">
          {routingPolicy === 'round-robin' && 'Distribute requests evenly across models'}
          {routingPolicy === 'load-balanced' && 'Route to model with lowest inference count'}
          {routingPolicy === 'first-available' && 'Use fastest ready model'}
        </p>
      </div>

      {/* Model Loading */}
      <div className="section">
        <h3>Load Model</h3>
        <div className="input-group">
          <input
            type="text"
            placeholder="Enter model path or directory"
            value={modelPath}
            onChange={e => setModelPath(e.target.value)}
            disabled={isLoading}
            className="input"
          />
        </div>
        <div className="button-group">
          <button
            className="btn btn-primary"
            onClick={handleLoadModel}
            disabled={isLoading || !modelPath.trim()}
          >
            {isLoading ? '⏳ Loading...' : '➕ Load Model'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleDetectShards}
            disabled={isLoading || !modelPath.trim()}
          >
            🔍 Detect Shards
          </button>
        </div>
      </div>

      {/* Shard Information */}
      {showShardDetails && shardInfo && (
        <div className="section shard-info">
          <h3>Shard Detection Results</h3>
          <div className="info-box">
            <p><strong>Sharded:</strong> {shardInfo.is_sharded ? '✓ Yes' : '✗ No'}</p>
            {shardInfo.is_sharded && (
              <>
                <p><strong>Format:</strong> {shardInfo.format}</p>
                <p><strong>Total Shards:</strong> {shardInfo.total_shards}</p>
                <p><strong>Memory Estimate:</strong> {shardInfo.memory_estimate_str}</p>
                {shardInfo.shards && (
                  <details>
                    <summary>Show shard files</summary>
                    <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
                      {Object.entries(shardInfo.shards || {}).map(([id, path]) => (
                        <li key={id}>[{id}] {path}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowShardDetails(false)}
          >
            ✕ Close
          </button>
        </div>
      )}

      {/* Loaded Models */}
      <div className="section">
        <h3>Loaded Models</h3>
        {routerData?.models && routerData.models.length > 0 ? (
          <div className="model-list">
            {routerData.models.map(model => (
              <div key={model.id} className={`model-item status-${model.status}`}>
                <div className="model-info">
                  <p className="model-name">{model.name}</p>
                  <p className="model-port">Port: {model.port}</p>
                  <p className={`status-badge status-${model.status}`}>
                    {model.status === 'ready' && '✓ Ready'}
                    {model.status === 'loading' && '⏳ Loading...'}
                    {model.status === 'error' && '✗ Error'}
                    {model.status === 'idle' && '○ Idle'}
                  </p>
                </div>
                <div className="model-stats">
                  <p>Inferences: {model.inference_count}</p>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleUnloadModel(model.id)}
                    disabled={isLoading}
                  >
                    Unload
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted">No models loaded. Use the form above to load a model.</p>
        )}
      </div>

      {/* Router Statistics */}
      {routerData && (
        <div className="section stats">
          <h3>Statistics</h3>
          <div className="stats-grid">
            <div className="stat-box">
              <span className="stat-label">Total Models</span>
              <span className="stat-value">{routerData.total_models}</span>
            </div>
            <div className="stat-box">
              <span className="stat-label">Ready Models</span>
              <span className="stat-value">{routerData.ready_models}</span>
            </div>
            <div className="stat-box">
              <span className="stat-label">Total Inferences</span>
              <span className="stat-value">{routerData.total_inferences}</span>
            </div>
            <div className="stat-box">
              <span className="stat-label">Policy</span>
              <span className="stat-value">{routerData.routing_policy}</span>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .multi-model-panel {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          padding: 1.5rem;
          background: rgba(0, 0, 0, 0.2);
          border-radius: 8px;
          border: 1px solid var(--border);
          flex: 1;
          overflow-y: auto;
        }

        .panel-header {
          border-bottom: 2px solid var(--border);
          padding-bottom: 1rem;
        }

        .panel-header h2 {
          margin: 0 0 0.5rem 0;
          font-size: 1.3rem;
          color: var(--text-primary);
        }

        .panel-header p {
          margin: 0;
          font-size: 0.85rem;
          color: var(--text-muted);
        }

        .section {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          padding: 1rem;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border);
          border-radius: 6px;
        }

        .section h3 {
          margin: 0 0 0.5rem 0;
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-primary);
        }

        .policy-buttons {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }

        .policy-buttons .btn {
          flex: 1;
          min-width: 140px;
        }

        .input-group {
          display: flex;
          gap: 0.5rem;
        }

        .input {
          flex: 1;
          padding: 0.6rem 0.8rem;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid var(--border);
          border-radius: 4px;
          color: var(--text-primary);
          font: inherit;
        }

        .input:focus {
          outline: none;
          border-color: var(--accent);
          background: rgba(217, 119, 87, 0.1);
        }

        .button-group {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }

        .button-group .btn {
          flex: 1;
          min-width: 140px;
        }

        .shard-info {
          background: rgba(217, 119, 87, 0.05);
          border-color: var(--accent);
        }

        .info-box {
          background: rgba(0, 0, 0, 0.2);
          padding: 0.75rem;
          border-radius: 4px;
          margin: 0.5rem 0;
          font-size: 0.9rem;
        }

        .info-box p {
          margin: 0.4rem 0;
        }

        .info-box details {
          margin-top: 0.5rem;
        }

        .info-box summary {
          cursor: pointer;
          color: var(--accent);
          font-weight: 500;
        }

        .info-box ul {
          margin: 0.5rem 0 0;
          font-size: 0.85rem;
          list-style: none;
        }

        .info-box li {
          padding: 0.2rem 0;
          color: var(--text-muted);
          font-family: 'Monaco', monospace;
        }

        .model-list {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .model-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.75rem;
          background: rgba(0, 0, 0, 0.3);
          border-left: 3px solid var(--text-muted);
          border-radius: 4px;
        }

        .model-item.status-ready {
          border-left-color: var(--color-green);
        }

        .model-item.status-loading {
          border-left-color: var(--color-yellow);
        }

        .model-item.status-error {
          border-left-color: var(--color-red);
        }

        .model-info {
          flex: 1;
        }

        .model-name {
          margin: 0;
          font-weight: 500;
          color: var(--text-primary);
          font-size: 0.95rem;
        }

        .model-port {
          margin: 0.2rem 0 0;
          font-size: 0.8rem;
          color: var(--text-muted);
          font-family: 'Monaco', monospace;
        }

        .status-badge {
          display: inline-block;
          margin-top: 0.3rem;
          padding: 0.2rem 0.6rem;
          border-radius: 3px;
          font-size: 0.75rem;
          font-weight: 600;
          background: rgba(0, 200, 100, 0.2);
        }

        .status-badge.status-loading {
          background: rgba(255, 180, 0, 0.2);
        }

        .status-badge.status-error {
          background: rgba(255, 100, 100, 0.2);
        }

        .model-stats {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 0.4rem;
          margin-left: 1rem;
        }

        .model-stats p {
          margin: 0;
          font-size: 0.8rem;
          color: var(--text-muted);
        }

        .stats {
          background: linear-gradient(135deg, rgba(232, 196, 160, 0.05), rgba(217, 119, 87, 0.05));
          border-color: var(--color-purple);
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
          gap: 0.75rem;
        }

        .stat-box {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 0.75rem;
          background: rgba(0, 0, 0, 0.3);
          border-radius: 4px;
          border: 1px solid var(--border);
        }

        .stat-label {
          font-size: 0.75rem;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .stat-value {
          font-size: 1.4rem;
          font-weight: 700;
          color: var(--accent);
          margin-top: 0.3rem;
        }

        .text-muted {
          color: var(--text-muted);
          font-size: 0.9rem;
          margin: 0.5rem 0 0;
        }

        .btn-sm {
          padding: 0.4rem 0.8rem;
          font-size: 0.8rem;
        }

        .btn-danger {
          background: rgba(255, 100, 100, 0.2);
          color: var(--color-red);
          border: 1px solid var(--color-red);
        }

        .btn-danger:hover:not(:disabled) {
          background: rgba(255, 100, 100, 0.3);
        }

        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  )
}
