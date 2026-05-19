import { useState } from 'react'
import { Scan, Search, Ruler, Loader2, AlertCircle } from 'lucide-react'

const API = '/api'

export default function ScoutPanel({ toast }) {
  const [hardware, setHardware] = useState(null)
  const [hwLoading, setHwLoading] = useState(false)

  const [recs, setRecs] = useState([])
  const [recLoading, setRecLoading] = useState(false)
  const [recTop, setRecTop] = useState(10)
  const [recProfile, setRecProfile] = useState('general')
  const [recQuant, setRecQuant] = useState('')
  const [recMinSpeed, setRecMinSpeed] = useState('')
  const [recRefresh, setRecRefresh] = useState(false)

  const [planModel, setPlanModel] = useState('')
  const [planQuant, setPlanQuant] = useState('')
  const [planCtx, setPlanCtx] = useState('4096')
  const [planResult, setPlanResult] = useState(null)
  const [planLoading, setPlanLoading] = useState(false)

  const scanHardware = async () => {
    setHwLoading(true)
    try {
      const res = await fetch(`${API}/lumina-scout/hardware`)
      const data = await res.json()
      if (res.ok) {
        setHardware(data)
        toast('Hardware scan complete', 'success')
      } else {
        toast(data.error || 'Hardware scan failed', 'error')
      }
    } catch (e) {
      toast('Hardware scan failed: ' + e.message, 'error')
    }
    setHwLoading(false)
  }

  const getRecommendations = async () => {
    setRecLoading(true)
    setRecs([])
    const params = new URLSearchParams({
      top: recTop,
      profile: recProfile,
    })
    if (recQuant) params.set('quant', recQuant)
    if (recMinSpeed) params.set('min_speed', recMinSpeed)
    if (recRefresh) params.set('refresh', 'true')
    try {
      const res = await fetch(`${API}/lumina-scout/recommend?${params}`)
      const data = await res.json()
      if (res.ok) {
        setRecs(data)
        toast(`Found ${data.length} recommendations`, 'success')
      } else {
        toast(data.error || 'Recommendation failed', 'error')
      }
    } catch (e) {
      toast('Recommendation failed: ' + e.message, 'error')
    }
    setRecLoading(false)
  }

  const getPlan = async () => {
    if (!planModel.trim()) {
      toast('Enter a model name', 'error')
      return
    }
    setPlanLoading(true)
    setPlanResult(null)
    const params = new URLSearchParams({ model: planModel.trim() })
    if (planQuant) params.set('quant', planQuant)
    params.set('context_length', planCtx)
    try {
      const res = await fetch(`${API}/lumina-scout/plan?${params}`)
      const data = await res.json()
      if (res.ok) {
        setPlanResult(data)
        toast('Plan generated', 'success')
      } else {
        toast(data.error || 'Plan lookup failed', 'error')
      }
    } catch (e) {
      toast('Plan lookup failed: ' + e.message, 'error')
    }
    setPlanLoading(false)
  }

  const fitBadge = (fit) => {
    if (fit === 'full_gpu') return { label: 'Full GPU', cls: 'badge-green' }
    if (fit === 'partial_offload') return { label: 'Partial', cls: 'badge-yellow' }
    if (fit === 'too_small') return { label: 'Too small', cls: 'badge-red' }
    return { label: 'CPU only', cls: 'badge-red' }
  }

  return (
    <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', overflowY: 'auto' }}>

      {/* Hardware Scan */}
      <div className="card">
        <div className="card-header">
          <h3><Scan size={16} /> Scan Hardware</h3>
        </div>
        <div className="card-body">
          <button className="btn btn-primary" onClick={scanHardware} disabled={hwLoading} style={{ marginBottom: '1rem' }}>
            {hwLoading ? <><Loader2 size={14} className="spin" /> Scanning...</> : 'Scan Hardware'}
          </button>
          {hardware && (
            <div className="info-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
              <div className="info-item">
                <div className="info-label">GPU</div>
                <div className="info-value">{hardware.gpu_name}</div>
              </div>
              <div className="info-item">
                <div className="info-label">VRAM</div>
                <div className="info-value">{hardware.vram_gb} GB</div>
              </div>
              <div className="info-item">
                <div className="info-label">RAM</div>
                <div className="info-value">{hardware.ram_gb} GB</div>
              </div>
              <div className="info-item">
                <div className="info-label">CPU</div>
                <div className="info-value">{hardware.cpu_name}</div>
              </div>
              <div className="info-item">
                <div className="info-label">Backend</div>
                <div className="info-value">{hardware.backend}</div>
              </div>
              <div className="info-item">
                <div className="info-label">Platform</div>
                <div className="info-value">{hardware.platform}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Find Best Models */}
      <div className="card">
        <div className="card-header">
          <h3><Search size={16} /> Find Best Models</h3>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
            <div>
              <label className="form-label">Results</label>
              <input type="number" className="input" value={recTop} onChange={e => setRecTop(parseInt(e.target.value) || 10)} min={1} max={50} style={{ width: 70 }} />
            </div>
            <div>
              <label className="form-label">Profile</label>
              <select className="input" value={recProfile} onChange={e => setRecProfile(e.target.value)}>
                <option value="general">General</option>
                <option value="coding">Coding</option>
                <option value="vision">Vision</option>
                <option value="math">Math</option>
              </select>
            </div>
            <div>
              <label className="form-label">Quant (optional)</label>
              <input className="input" placeholder="e.g. Q4_K_M" value={recQuant} onChange={e => setRecQuant(e.target.value)} style={{ width: 120 }} />
            </div>
            <div>
              <label className="form-label">Min Speed (tok/s)</label>
              <input type="number" className="input" placeholder="optional" value={recMinSpeed} onChange={e => setRecMinSpeed(e.target.value)} style={{ width: 100 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" id="scout-refresh" checked={recRefresh} onChange={e => setRecRefresh(e.target.checked)} />
              <label htmlFor="scout-refresh" className="form-label" style={{ margin: 0 }}>Force Refresh</label>
            </div>
            <button className="btn btn-primary" onClick={getRecommendations} disabled={recLoading}>
              {recLoading ? <><Loader2 size={14} className="spin" /> Searching...</> : 'Recommend'}
            </button>
          </div>

          {recs.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Model ID</th>
                    <th>Score</th>
                    <th>Fit</th>
                    <th>VRAM (GB)</th>
                    <th>Speed (tok/s)</th>
                    <th>Quant</th>
                    <th>Benchmark</th>
                  </tr>
                </thead>
                <tbody>
                  {recs.map(r => {
                    const fb = fitBadge(r.fit_type)
                    return (
                      <tr key={r.rank}>
                        <td>{r.rank}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{r.model_id}</td>
                        <td>{r.score}</td>
                        <td><span className={`badge ${fb.cls}`}>{fb.label}</span></td>
                        <td>{r.vram_required_gb}</td>
                        <td>{r.speed_tps}</td>
                        <td>{r.quant}</td>
                        <td>{r.benchmark_source}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {recs.length === 0 && !recLoading && (
            <div style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem' }}>
              Click Recommend to find models for your hardware
            </div>
          )}
        </div>
      </div>

      {/* Plan Hardware */}
      <div className="card">
        <div className="card-header">
          <h3><Ruler size={16} /> Plan Hardware</h3>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
            <div>
              <label className="form-label">Model Name</label>
              <input className="input" placeholder="e.g. llama 3 70b" value={planModel} onChange={e => setPlanModel(e.target.value)} style={{ width: 220 }} />
            </div>
            <div>
              <label className="form-label">Quant (optional)</label>
              <input className="input" placeholder="e.g. Q4_K_M" value={planQuant} onChange={e => setPlanQuant(e.target.value)} style={{ width: 120 }} />
            </div>
            <div>
              <label className="form-label">Context Length</label>
              <input type="number" className="input" value={planCtx} onChange={e => setPlanCtx(e.target.value)} style={{ width: 100 }} />
            </div>
            <button className="btn btn-primary" onClick={getPlan} disabled={planLoading}>
              {planLoading ? <><Loader2 size={14} className="spin" /> Planning...</> : 'Plan'}
            </button>
          </div>

          {planResult && !planResult.error && (
            <div>
              <div style={{ marginBottom: '1rem' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {planResult.model.id}
                </span>
                {planResult.min_full_gpu && (
                  <span className="badge badge-green" style={{ marginLeft: 8 }}>
                    Min GPU: {planResult.min_full_gpu}
                  </span>
                )}
              </div>

              <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>VRAM by Quantization</h4>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
                {Object.entries(planResult.vram_by_quant).map(([q, v]) => (
                  <div key={q} className={`badge ${q === planResult.target_quant ? 'badge-green' : 'badge-muted'}`} style={{ fontFamily: 'var(--font-mono)' }}>
                    {q}: {v} GB
                  </div>
                ))}
              </div>

              <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>GPU Compatibility</h4>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>GPU</th>
                      <th>VRAM</th>
                      <th>Fit</th>
                      <th>Est. Speed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planResult.gpu_compatibility.map(g => {
                      const fb = fitBadge(g.fit_type)
                      return (
                        <tr key={g.name}>
                          <td>{g.name}</td>
                          <td>{g.vram_gb} GB</td>
                          <td><span className={`badge ${fb.cls}`}>{fb.label}</span></td>
                          <td>{g.estimated_tok_per_sec ? `${g.estimated_tok_per_sec} tok/s` : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {planResult && planResult.error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-error)', padding: '1rem' }}>
              <AlertCircle size={16} />
              {planResult.error}
            </div>
          )}
          {!planResult && !planLoading && (
            <div style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem' }}>
              Enter a model name and click Plan
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
