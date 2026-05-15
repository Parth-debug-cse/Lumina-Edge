import { useState, useEffect, useCallback } from 'react'
import { X, RotateCw, Zap } from 'lucide-react'
import { getSystemResources } from '../utils/api.js'

function Sparkline({ data, color = '#10b981' }) {
  if (!data || data.length < 2) return null
  const w = 280; const h = 24
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * h
    return `${x},${y}`
  }).join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={points} />
    </svg>
  )
}

function getColor(pct) {
  if (pct > 85) return 'red'
  if (pct > 70) return 'amber'
  return ''
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

export default function SystemMonitor({ onClose, toast }) {
  const [resources, setResources] = useState(null)
  const [loading, setLoading] = useState(false)
  const [cpuHistory, setCpuHistory] = useState([])

  const fetchResources = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getSystemResources()
      setResources(data)
      if (data.cpu?.usage_pct !== undefined) {
        setCpuHistory(prev => [...prev.slice(-59), data.cpu.usage_pct])
      }
    } catch (err) {
      toast?.(`Resource fetch failed: ${err.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchResources()
    const interval = setInterval(fetchResources, 3000)
    return () => clearInterval(interval)
  }, [fetchResources])

  const cpuPct = resources?.cpu?.usage_pct ?? 0
  const ramUsed = resources?.memory?.used_gb ?? 0
  const ramTotal = resources?.memory?.total_gb ?? 0
  const ramPct = ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0
  const ramAvailable = resources?.memory?.available_gb ?? 0

  const gpuPct = resources?.igpu?.util_pct ?? resources?.nvidia_gpu?.gpus?.[0]?.gpu_util_pct ?? 0
  const gpuAvailable = resources?.igpu?.available ?? false
  const nvidiaAvailable = resources?.nvidia_gpu?.available ?? false
  const gpuName = nvidiaAvailable
    ? resources?.nvidia_gpu?.gpus?.[0]?.name
    : gpuAvailable
      ? resources?.igpu?.type
      : null
  const gpuVramUsed = resources?.igpu?.vram_used_mb ?? resources?.nvidia_gpu?.gpus?.[0]?.vram_used_mb ?? 0
  const gpuVramTotal = resources?.igpu?.vram_total_mb ?? resources?.nvidia_gpu?.gpus?.[0]?.vram_total_mb ?? 0

  const handleOptimize = async () => {
    try {
      const res = await fetch('/api/optimize-system', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast?.('System optimized', 'success')
        fetchResources()
      } else {
        toast?.(`Optimization: ${data.error || 'partial'}`, 'info')
      }
    } catch (err) {
      toast?.(`Error: ${err.message}`, 'error')
    }
  }

  return (
    <>
      <div className="monitor-backdrop" onClick={onClose} />
      <div className="monitor-overlay">
        <div className="monitor-header">
          <span className="monitor-title">{'> System Monitor'}</span>
          <button className="monitor-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="monitor-body">
          {/* CPU */}
          <div className="monitor-section">
            <div className="monitor-section-label">CPU</div>
            <div className="monitor-bar-row">
              <span className="monitor-bar-label">CPU</span>
              <div className="monitor-bar-track">
                <div className={`monitor-bar-fill ${getColor(cpuPct)}`} style={{ width: `${Math.min(cpuPct, 100)}%` }} />
              </div>
              <span className="monitor-bar-value">{cpuPct.toFixed(1)}%</span>
            </div>
            <div className="monitor-detail">
              {resources?.cpu?.model || ''} · {resources?.cpu?.cores || '?'} threads
            </div>
            {cpuHistory.length > 1 && (
              <div className="monitor-sparkline">
                <Sparkline data={cpuHistory} />
              </div>
            )}
          </div>

          {/* RAM */}
          <div className="monitor-section">
            <div className="monitor-section-label">Memory</div>
            <div className="monitor-bar-row">
              <span className="monitor-bar-label">RAM</span>
              <div className="monitor-bar-track">
                <div className={`monitor-bar-fill ${getColor(ramPct)}`} style={{ width: `${Math.min(ramPct, 100)}%` }} />
              </div>
              <span className="monitor-bar-value">{ramUsed.toFixed(1)} / {ramTotal.toFixed(1)} GB</span>
            </div>
            <div className="monitor-detail">
              System: {(ramTotal - ramAvailable).toFixed(1)} GB · Available: {ramAvailable.toFixed(1)} GB
            </div>
          </div>

          {/* GPU */}
          {(gpuAvailable || nvidiaAvailable) && (
            <div className="monitor-section">
              <div className="monitor-section-label">GPU {gpuName ? `(${gpuName})` : ''}</div>
              <div className="monitor-bar-row">
                <span className="monitor-bar-label">GPU</span>
                <div className="monitor-bar-track">
                  <div className={`monitor-bar-fill ${getColor(gpuPct)}`} style={{ width: `${Math.min(gpuPct, 100)}%` }} />
                </div>
                <span className="monitor-bar-value">{gpuPct.toFixed(1)}%</span>
              </div>
              {gpuVramTotal > 0 && (
                <div className="monitor-detail">
                  VRAM: {(gpuVramUsed / 1024).toFixed(1)} / {(gpuVramTotal / 1024).toFixed(1)} GB ({(gpuVramUsed / gpuVramTotal * 100).toFixed(1)}%)
                </div>
              )}
            </div>
          )}

          {/* Model Info */}
          {resources?.model_processes?.length > 0 && (
            <div className="monitor-section">
              <div className="monitor-section-label">Model Process</div>
              {resources.model_processes.map((p, i) => (
                <div key={i} className="monitor-detail" style={{ padding: '4px 0' }}>
                  PID {p.pid} · {p.command?.substring(0, 40)} · CPU {p.cpu_pct}% · MEM {(p.rss_mb / 1024).toFixed(1)} GB
                </div>
              ))}
            </div>
          )}

          {/* Stats summary */}
          <div className="monitor-section">
            <div className="monitor-section-label">Performance</div>
            <div className="monitor-detail">
              {resources?.model_processes?.length > 0
                ? `${resources.model_processes.length} model(s) running · Uptime varies by model`
                : 'No models currently loaded'}
            </div>
          </div>

          {/* Actions */}
          <div className="monitor-actions" style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button className="btn btn-secondary btn-sm" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={handleOptimize}>
              <Zap size={12} /> Run Optimization
            </button>
            <button className="btn btn-secondary btn-sm" onClick={fetchResources} disabled={loading}>
              <RotateCw size={12} /> Refresh
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
