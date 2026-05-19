import { useState, useEffect, useRef } from 'react'
import * as api from '../utils/api.js'

const SECTION_STYLE = {
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
}

const POLL_INTERVAL_OPTIONS = [250, 300, 400]

export default function LuminaScreenPanel({ toast }) {
  const [pipelineStatus, setPipelineStatus] = useState('idle')
  const [hits, setHits] = useState([])
  const [config, setConfig] = useState({
    resume_folder: './resumes',
    poll_interval_ms: 300,
    match_threshold: 0.25,
  })
  const [jdText, setJdText] = useState('')
  const [saving, setSaving] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  const [clearingHits, setClearingHits] = useState(false)
  const [loadingStatus, setLoadingStatus] = useState(false)
  // BUG LS-H1 FIX: Add error state to track connection failures
  const [connectionError, setConnectionError] = useState(null)
  const pollingRef = useRef(null)

  useEffect(() => {
    fetchStatus(true)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [])

  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current)
    if (pipelineStatus === 'running') {
      pollingRef.current = setInterval(fetchStatus, 2000)
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [pipelineStatus])

  const fetchStatus = async (isInitialLoad = false) => {
    setLoadingStatus(true)
    try {
      const data = await api.getLuminaScreenStatus()
      setPipelineStatus(data.status || 'idle')
      if (data.hits) setHits(data.hits)
      if (isInitialLoad && data.config) setConfig(prev => ({ ...prev, ...data.config }))
      if (isInitialLoad && data.jd_text !== undefined && data.jd_text !== null) {
        setJdText(data.jd_text)
      }
      // BUG LS-H1 FIX: Clear connection error on successful fetch
      setConnectionError(null)
    } catch (err) {
      // BUG LS-H1 FIX: Set connection error state so UI can render error banner
      setConnectionError(err.message || 'Connection failed')
      console.error('[LuminaScreen] Status fetch error:', err)
    } finally {
      setLoadingStatus(false)
    }
  }

  const handleStart = async () => {
    const result = await api.startLuminaScreen()
    if (result.error) {
      toast(`Failed to start: ${result.error}`, 'error')
    } else {
      setPipelineStatus('running')
      toast('Lumina Screen pipeline started', 'success')
    }
  }

  const handleStop = async () => {
    const result = await api.stopLuminaScreen()
    if (result.error) {
      toast(`Failed to stop: ${result.error}`, 'error')
    } else {
      setPipelineStatus('stopped')
      toast('Lumina Screen pipeline stopped', 'info')
    }
  }

  const handleSaveConfig = async () => {
    setSaving(true)
    try {
      const result = await api.saveLuminaScreenConfig({
        resume_folder: config.resume_folder,
        poll_interval_ms: config.poll_interval_ms,
        match_threshold: config.match_threshold,
        jd_text: jdText,
      })
      if (result.error) {
        toast(`Failed to save: ${result.error}`, 'error')
      } else {
        toast('Configuration saved', 'success')
      }
    } catch (err) {
      toast(`Save error: ${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleClearResults = async () => {
    // FIXED: call backend to clear page_hit.txt on disk, not just in-memory state
    setClearingHits(true);
    try {
      const res = await fetch('/api/lumina-screen/clear-hits', { method: 'POST' });
      if (res.ok) {
        setHits([]);
        toast('Results cleared', 'info');
      } else {
        const errData = await res.json().catch(() => ({}));
        toast(`Failed to clear results: ${errData.error || 'Unknown error'}`, 'error');
      }
    } catch (e) {
      toast(`Clear error: ${e.message}`, 'error');
    } finally {
      setClearingHits(false);
    }
  };

  const handleRescan = async () => {
    setRescanning(true)
    try {
      const result = await api.rescanLuminaScreen()
      if (result.error) {
        toast(`Rescan failed: ${result.error}`, 'error')
      } else {
        toast('Dedup state cleared — restart the pipeline to re-process all existing resumes', 'success')
      }
    } catch (err) {
      toast(`Rescan error: ${err.message}`, 'error')
    } finally {
      setRescanning(false)
    }
  }

  const statusBadge = () => {
    if (pipelineStatus === 'running') return <span className="badge badge-green">● Running</span>
    if (pipelineStatus === 'stopped') return <span className="badge badge-muted">● Stopped</span>
    return <span className="badge badge-muted">○ Idle</span>
  }

  return (
    <div style={{ padding: '0 8px 24px', overflow: 'auto', flex: 1 }}>

      {/* ===== CONNECTION ERROR BANNER (BUG LS-H1 FIX) ===== */}
      {connectionError && (
        <div style={{
          background: '#fee',
          border: '1px solid #faa',
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 1 }}>
            <span style={{ fontSize: '1rem' }}>⚠️</span>
            <div style={{ fontSize: '0.85rem', color: '#c33' }}>
              <strong>Connection Lost:</strong> {connectionError}
              {pipelineStatus === 'running' && (
                <div style={{ fontSize: '0.75rem', marginTop: 4, opacity: 0.8 }}>
                  The backend may have crashed or the network connection was lost. Check your API server and refresh manually.
                </div>
              )}
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => fetchStatus()}
            title="Try to reconnect"
          >
            🔄 Retry
          </button>
        </div>
      )}

      {/* ===== CONFIGURATION PANEL ===== */}
      <div style={SECTION_STYLE}>
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>Configuration</h3>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>Resume folder, job description, matching threshold</div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div className="form-group">
            <label className="form-label">Resume Folder Path</label>
            <input
              className="input"
              type="text"
              value={config.resume_folder || ''}
              onChange={e => setConfig(prev => ({ ...prev, resume_folder: e.target.value }))}
              placeholder="./resumes"
            />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div className="form-group">
            <label className="form-label">Job Description</label>
            <textarea
              className="textarea"
              value={jdText}
              onChange={e => setJdText(e.target.value)}
              rows={6}
              placeholder="Paste the job description here..."
              style={{ minHeight: 120 }}
            />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div className="form-group">
            <label className="form-label">
              Similarity Threshold: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--accent)' }}>{(config.match_threshold * 100).toFixed(0)}%</span>
            </label>
            <div className="range-row">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={config.match_threshold ?? 0.65}
                style={{ '--pct': `${((config.match_threshold ?? 0.65) * 100)}%` }}
                onChange={e => setConfig(prev => ({ ...prev, match_threshold: parseFloat(e.target.value) }))}
              />
              <span className="range-value">{((config.match_threshold ?? 0.65) * 100).toFixed(0)}%</span>
            </div>
            <div className="form-hint">Minimum cosine similarity score for shortlisting. Higher = stricter.</div>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div className="form-group">
            <label className="form-label">Poll Interval</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {POLL_INTERVAL_OPTIONS.map(ms => (
                <button
                  key={ms}
                  className={`btn btn-sm ${config.poll_interval_ms === ms ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setConfig(prev => ({ ...prev, poll_interval_ms: ms }))}
                >
                  {ms}ms
                </button>
              ))}
            </div>
            <div className="form-hint">How often the watcher checks for new resume files.</div>
          </div>
        </div>

        <div>
          <button className="btn btn-primary" onClick={handleSaveConfig} disabled={saving}>
            {saving ? 'Saving...' : 'Save Config'}
          </button>
        </div>
      </div>

      {/* ===== PIPELINE CONTROLS ===== */}
      <div style={SECTION_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>Pipeline Controls</h3>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>Start or stop the resume screening pipeline</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {statusBadge()}
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {pipelineStatus === 'running' ? 'Watching for resumes...' : ''}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={handleStart}
            disabled={pipelineStatus === 'running' || loadingStatus}
          >
            {loadingStatus && pipelineStatus === 'idle' ? '⏳' : '▶'} Start Lumina Screen
          </button>
          <button
            className="btn btn-danger"
            onClick={handleStop}
            disabled={pipelineStatus !== 'running'}
          >
            ■ Stop
          </button>
          <button
            className="btn btn-secondary"
            onClick={fetchStatus}
            disabled={loadingStatus}
          >
            {loadingStatus ? '⏳' : '↺'} Refresh
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleRescan}
            disabled={rescanning || pipelineStatus === 'running'}
            title="Clear the dedup state so all existing resumes in the folder are re-evaluated on next start"
          >
            {rescanning ? '⏳' : '🔄'} Re-scan Existing
          </button>
        </div>
        <div className="form-hint" style={{ marginTop: 8 }}>
          Drop PDF resumes into: <code style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-accent)', fontSize: '0.72rem' }}>lumina_screen/resumes/</code>
          {' '}· Use <strong>Re-scan Existing</strong> if the folder already has files before the pipeline starts.
        </div>
      </div>

      {/* ===== LIVE RESULTS PANEL ===== */}
      <div style={SECTION_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>
              {pipelineStatus === 'running' ? '◉ Live Results' : 'Results'}
              {hits.length > 0 && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
                  ({hits.length} shortlisted)
                </span>
              )}
            </h3>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Shortlisted candidates from page_hit.txt — {pipelineStatus === 'running' ? 'auto-refreshing every 2s' : 'static view'}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={handleClearResults} disabled={clearingHits}>
            {clearingHits ? '⏳' : ''} Clear Results
          </button>
        </div>

        {hits.length === 0 ? (
          <div style={{
            padding: 40,
            textAlign: 'center',
            color: 'var(--text-muted)',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: 8,
          }}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>📄</div>
            <div style={{ fontSize: '0.85rem', marginBottom: 4 }}>No shortlisted candidates yet</div>
            <div style={{ fontSize: '0.75rem' }}>
              {pipelineStatus === 'running'
                ? 'Drop PDF resumes into the watched folder. Shortlisted candidates will appear here automatically.'
                : 'Start the pipeline and drop PDF resumes into the watched folder.'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {hits.slice().reverse().map((hit, i) => (
              <div
                key={i}
                style={{
                  padding: 14,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
                      {hit.name || hit.filename}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      {hit.filename}
                      {hit.timestamp && <span style={{ marginLeft: 12, color: 'var(--text-muted)' }}>{hit.timestamp}</span>}
                    </div>
                  </div>
                  <div style={{
                    padding: '4px 10px',
                    borderRadius: 99,
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    background: hit.score >= 0.8 ? 'var(--green-dim)' : hit.score >= 0.65 ? 'var(--accent-dim)' : 'rgba(255,255,255,0.05)',
                    color: hit.score >= 0.8 ? 'var(--green)' : hit.score >= 0.65 ? 'var(--text-accent)' : 'var(--text-muted)',
                    border: `1px solid ${
                      hit.score >= 0.8 ? 'rgba(74,222,128,0.3)' : hit.score >= 0.65 ? 'var(--border-accent)' : 'var(--border)'
                    }`,
                  }}>
                    {(hit.score * 100).toFixed(1)}%
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {hit.email && (
                    <span>
                      <span style={{ color: 'var(--text-secondary)' }}>Email:</span> {hit.email}
                    </span>
                  )}
                  {hit.phone && (
                    <span>
                      <span style={{ color: 'var(--text-secondary)' }}>Phone:</span> {hit.phone}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}