import { useState, useEffect, useCallback } from 'react'
import * as api from '../utils/api.js'

const SECTION_STYLE = {
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
}

const STAT_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
  gap: 12,
  marginTop: 12,
}

const STAT_CARD = {
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '12px 14px',
}

const BAR_BG = {
  width: '100%',
  height: 6,
  background: 'var(--surface-3)',
  borderRadius: 3,
  marginTop: 6,
  overflow: 'hidden',
}

function ProgressBar({ pct, color = 'var(--accent)' }) {
  return (
    <div style={BAR_BG}>
      <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.5s' }} />
    </div>
  )
}

function StatCard({ label, value, unit, pct, color }) {
  return (
    <div style={STAT_CARD}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
        {value}<span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: 4 }}>{unit}</span>
      </div>
      {pct !== undefined && <ProgressBar pct={pct} color={color || (pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : 'var(--accent)')} />}
    </div>
  )
}

function ActionButton({ label, icon, onClick, loading, disabled, variant = 'primary' }) {
  const base = {
    padding: '8px 16px',
    borderRadius: 8,
    border: 'none',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    fontSize: '0.8rem',
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    opacity: disabled || loading ? 0.6 : 1,
    transition: 'all 0.15s',
  }
  const variants = {
    primary: { ...base, background: 'var(--accent)', color: '#1C1917' },
    secondary: { ...base, background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)' },
    danger: { ...base, background: 'var(--red)', color: '#1C1917' },
  }
  return (
    <button style={variants[variant]} onClick={onClick} disabled={disabled || loading}>
      {loading ? '⏳' : icon} {label}
    </button>
  )
}

function OutputBlock({ title, output }) {
  if (!output) return null
  return (
    <div style={{ marginTop: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, maxHeight: 300, overflow: 'auto' }}>
      {title && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 6 }}>{title}</div>}
      <pre style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>{typeof output === 'string' ? output : JSON.stringify(output, null, 2)}</pre>
    </div>
  )
}

export default function DiagnosticsPanel({ localModels = [], toast }) {
  // -- Resource monitoring state --
  const [resources, setResources] = useState(null)
  const [resLoading, setResLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)

  // -- Inference profiling state --
  const [profileResult, setProfileResult] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileModel, setProfileModel] = useState('')
  const [profileRuns, setProfileRuns] = useState(3)

  // -- Diagnostics state --
  const [diagResult, setDiagResult] = useState(null)
  const [diagLoading, setDiagLoading] = useState(false)

  // -- Memory estimation state --
  const [memModel, setMemModel] = useState('')
  const [memCtx, setMemCtx] = useState(4096)
  const [memKvQuant, setMemKvQuant] = useState('q8_0')
  const [memResult, setMemResult] = useState(null)
  const [memLoading, setMemLoading] = useState(false)
  const [ctxRecResult, setCtxRecResult] = useState(null)
  const [ctxRecLoading, setCtxRecLoading] = useState(false)
  const [kvCompareResult, setKvCompareResult] = useState(null)
  const [kvCompareLoading, setKvCompareLoading] = useState(false)

  // -- GPU benchmark state --
  const [benchModel, setBenchModel] = useState('')
  const [benchLoading, setBenchLoading] = useState(false)
  const [benchResult, setBenchResult] = useState(null)

  // -- Auto-refresh resources --
  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(() => fetchResources(), 2000)
    return () => clearInterval(interval)
  }, [autoRefresh])

  const fetchResources = useCallback(async () => {
    setResLoading(true)
    try {
      const data = await api.getSystemResources()
      setResources(data)
    } catch (err) {
      toast?.(`Resource fetch failed: ${err.message}`, 'error')
    } finally {
      setResLoading(false)
    }
  }, [])

  const handleProfile = async () => {
    setProfileLoading(true)
    setProfileResult(null)
    try {
      const result = await api.profileInference({
        model_id: profileModel || null,
        max_tokens: 64,
        runs: profileRuns,
      })
      setProfileResult(result)
      toast?.(`Profiled: ${result.avg_tokens_per_sec} tok/s average`, 'success')
    } catch (err) {
      toast?.(`Profile failed: ${err.message}`, 'error')
    } finally {
      setProfileLoading(false)
    }
  }

  const handleDiagnose = async () => {
    setDiagLoading(true)
    setDiagResult(null)
    try {
      const result = await api.diagnoseInference()
      setDiagResult(result)
      toast?.('Diagnostics complete', 'success')
    } catch (err) {
      toast?.(`Diagnostics failed: ${err.message}`, 'error')
    } finally {
      setDiagLoading(false)
    }
  }

  const handleEstimate = async () => {
    if (!memModel) { toast?.('Select a model first', 'error'); return }
    setMemLoading(true)
    setMemResult(null)
    try {
      const result = await api.estimateMemory(memModel, memCtx, memKvQuant)
      setMemResult(result)
      toast?.(`Estimated: ${result.total_estimated_gb} GB total`, 'success')
    } catch (err) {
      toast?.(`Estimate failed: ${err.message}`, 'error')
    } finally {
      setMemLoading(false)
    }
  }

  const handleRecommendCtx = async () => {
    if (!memModel) { toast?.('Select a model first', 'error'); return }
    setCtxRecLoading(true)
    setCtxRecResult(null)
    try {
      const result = await api.recommendCtxSize(memModel, null, memKvQuant)
      setCtxRecResult(result)
      toast?.(`Recommended ctx: ${result.recommended_ctx_size}`, 'success')
    } catch (err) {
      toast?.(`Recommend failed: ${err.message}`, 'error')
    } finally {
      setCtxRecLoading(false)
    }
  }

  const handleCompareKv = async () => {
    if (!memModel) { toast?.('Select a model first', 'error'); return }
    setKvCompareLoading(true)
    setKvCompareResult(null)
    try {
      const result = await api.compareKvQuant(memModel, memCtx)
      setKvCompareResult(result)
      toast?.('KV comparison complete', 'success')
    } catch (err) {
      toast?.(`Compare failed: ${err.message}`, 'error')
    } finally {
      setKvCompareLoading(false)
    }
  }

  const handleQuickBench = async () => {
    if (!benchModel) { toast?.('Select a model first', 'error'); return }
    setBenchLoading(true)
    setBenchResult(null)
    toast?.('Running CPU vs GPU benchmark… this takes a few minutes', 'info')
    try {
      const result = await api.quickGpuBenchmark(benchModel)
      setBenchResult(result)
      toast?.(`Benchmark done: ${result.speedup_vs_cpu}x speedup`, 'success')
    } catch (err) {
      toast?.(`Benchmark failed: ${err.message}`, 'error')
    } finally {
      setBenchLoading(false)
    }
  }

  const modelOptions = localModels.map(m => m.name || m.filename || m).filter(Boolean)

  return (
    <div style={{ padding: '0 8px 24px', overflow: 'auto', flex: 1 }}>

      {/* ===== RESOURCE MONITORING ===== */}
      <div style={SECTION_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>📊 Resource Monitor</h3>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>CPU, RAM, iGPU, VRAM — live system utilization</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} /> Auto-refresh
            </label>
            <ActionButton label="Refresh" icon="↺" onClick={fetchResources} loading={resLoading} variant="secondary" />
          </div>
        </div>

        {resources ? (
          <>
            <div style={STAT_GRID}>
              <StatCard label="CPU Usage" value={resources.cpu?.usage_pct?.toFixed(1) || '—'} unit="%" pct={resources.cpu?.usage_pct} />
              <StatCard label="CPU Freq" value={resources.cpu?.freq_mhz || '—'} unit="MHz" />
              <StatCard label="CPU Cores" value={resources.cpu?.cores || '—'} unit="cores" />
              <StatCard label="RAM Used" value={resources.memory?.used_gb?.toFixed(1) || '—'} unit={`/ ${resources.memory?.total_gb?.toFixed(1) || '?'} GB`} pct={resources.memory?.usage_pct} />
              <StatCard label="RAM Available" value={resources.memory?.available_gb?.toFixed(1) || '—'} unit="GB" />
              <StatCard label="Swap Used" value={resources.memory?.swap_used_gb?.toFixed(2) || '0'} unit="GB" pct={resources.memory?.swap_total_gb > 0 ? resources.memory.swap_usage_pct : 0} />
            </div>

            {resources.igpu?.available && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 6 }}>
                  iGPU ({resources.igpu.type})
                </div>
                <div style={STAT_GRID}>
                  <StatCard label="iGPU Util" value={resources.igpu.util_pct?.toFixed(1) || '—'} unit="%" pct={resources.igpu.util_pct} color="#D97757" />
                  <StatCard label="iGPU Freq" value={resources.igpu.freq_mhz || '—'} unit="MHz" />
                  <StatCard label="VRAM Used" value={resources.igpu.vram_used_mb || '—'} unit={`/ ${resources.igpu.vram_total_mb || '?'} MB`} />
                </div>
              </div>
            )}

            {resources.nvidia_gpu?.available && resources.nvidia_gpu.gpus?.map((gpu, i) => (
              <div key={i} style={{ marginTop: 14 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 6 }}>
                  NVIDIA GPU: {gpu.name}
                </div>
                <div style={STAT_GRID}>
                  <StatCard label="GPU Util" value={gpu.gpu_util_pct?.toFixed(1)} unit="%" pct={gpu.gpu_util_pct} color="#76B900" />
                  <StatCard label="VRAM Used" value={gpu.vram_used_mb?.toFixed(0)} unit={`/ ${gpu.vram_total_mb?.toFixed(0)} MB`} pct={gpu.vram_total_mb > 0 ? (gpu.vram_used_mb / gpu.vram_total_mb * 100) : 0} />
                  <StatCard label="Temperature" value={gpu.temp_c?.toFixed(0)} unit="°C" pct={gpu.temp_c} color={gpu.temp_c > 80 ? '#ef4444' : gpu.temp_c > 65 ? '#f59e0b' : '#76B900'} />
                  <StatCard label="Power" value={gpu.power_w?.toFixed(1)} unit="W" />
                </div>
              </div>
            ))}

            {resources.model_processes?.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 6 }}>Model Processes</div>
                {resources.model_processes.map((p, i) => (
                  <div key={i} style={{ ...STAT_CARD, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontSize: '0.72rem', fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)' }}>PID {p.pid}</span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: 8 }}>{p.command?.substring(0, 50)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 12, fontSize: '0.72rem' }}>
                      <span style={{ color: 'var(--accent)' }}>CPU {p.cpu_pct}%</span>
                      <span style={{ color: '#f59e0b' }}>MEM {p.mem_pct}% ({p.rss_mb} MB)</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 8 }}>Click Refresh to load system resources</div>
        )}
      </div>

      {/* ===== INFERENCE PROFILING ===== */}
      <div style={SECTION_STYLE}>
        <div style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>🔬 Inference Profiler</h3>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>Measure tokens/sec, latency, and time-per-token for loaded models</div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={profileModel} onChange={e => setProfileModel(e.target.value)} style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: '0.8rem' }}>
            <option value="">First available model</option>
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Runs:
            <input type="number" min={1} max={10} value={profileRuns} onChange={e => setProfileRuns(parseInt(e.target.value) || 3)} style={{ width: 50, marginLeft: 4, background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: '0.8rem' }} />
          </label>
          <ActionButton label="Profile Inference" icon="🔬" onClick={handleProfile} loading={profileLoading} variant="primary" />
          <ActionButton label="Run Diagnostics" icon="🔍" onClick={handleDiagnose} loading={diagLoading} variant="secondary" />
        </div>

        {profileResult && !profileResult.error && (
          <div style={{ marginTop: 14 }}>
            <div style={STAT_GRID}>
              <StatCard label="Avg Speed" value={profileResult.avg_tokens_per_sec} unit="tok/s" />
              <StatCard label="Avg Latency" value={profileResult.avg_total_latency_s} unit="s" />
              <StatCard label="Avg ms/token" value={profileResult.avg_ms_per_token} unit="ms" />
            </div>
            <div style={{ marginTop: 10, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              Per-run breakdown:
            </div>
            {profileResult.runs?.map((r, i) => (
              <div key={i} style={{ ...STAT_CARD, marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
                {r.error ? (
                  <span style={{ color: 'red' }}>Run {r.run}: {r.error}</span>
                ) : (
                  <>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Run {r.run}</span>
                    <span style={{ color: 'var(--text-primary)', fontSize: '0.75rem' }}>{r.completion_tokens} tokens in {r.total_time_s}s = <strong style={{ color: 'var(--accent)' }}>{r.tokens_per_sec} tok/s</strong></span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <OutputBlock title="System Diagnostics" output={diagResult?.output} />
      </div>

      {/* ===== MEMORY & CONTEXT OPTIMIZATION ===== */}
      <div style={SECTION_STYLE}>
        <div style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>🧠 Memory & Context Optimizer</h3>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>Estimate memory usage, auto-size context window, compare KV cache quantizations</div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <select value={memModel} onChange={e => setMemModel(e.target.value)} style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: '0.8rem' }}>
            <option value="">Select model…</option>
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Ctx size:
            <input type="number" min={4096} max={131072} step={512} value={memCtx} onChange={e => setMemCtx(parseInt(e.target.value) || 4096)} style={{ width: 80, marginLeft: 4, background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: '0.8rem' }} />
          </label>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>KV quant:
            <select value={memKvQuant} onChange={e => setMemKvQuant(e.target.value)} style={{ marginLeft: 4, background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: '0.8rem' }}>
              <option value="f16">f16 (2 bytes)</option>
              <option value="q8_0">q8_0 (1 byte)</option>
              <option value="q5_0">q5_0 (0.625 bytes)</option>
              <option value="q4_0">q4_0 (0.5 bytes)</option>
            </select>
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ActionButton label="Estimate Memory" icon="📏" onClick={handleEstimate} loading={memLoading} disabled={!memModel} variant="primary" />
          <ActionButton label="Recommend Ctx Size" icon="📐" onClick={handleRecommendCtx} loading={ctxRecLoading} disabled={!memModel} variant="secondary" />
          <ActionButton label="Compare KV Quants" icon="⚖" onClick={handleCompareKv} loading={kvCompareLoading} disabled={!memModel} variant="secondary" />
        </div>

        {memResult && !memResult.error && (
          <div style={{ marginTop: 14 }}>
            <div style={STAT_GRID}>
              <StatCard label="Model Weights" value={memResult.weight_memory_gb?.toFixed(2)} unit="GB" />
              <StatCard label="KV Cache" value={memResult.kv_cache_memory_gb?.toFixed(3)} unit="GB" />
              <StatCard label="Overhead" value={memResult.overhead_gb?.toFixed(3)} unit="GB" />
              <StatCard label="Total Estimated" value={memResult.total_estimated_gb?.toFixed(2)} unit="GB" />
            </div>
          </div>
        )}

        {ctxRecResult && !ctxRecResult.error && (
          <div style={{ marginTop: 14, background: 'var(--surface-2)', border: '1px solid var(--accent)', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>Recommended Context Size</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)' }}>{ctxRecResult.recommended_ctx_size?.toLocaleString()} <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>tokens</span></div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>Max possible: {ctxRecResult.max_possible_ctx?.toLocaleString()} tokens | Memory at recommended: {ctxRecResult.total_at_recommended_gb?.toFixed(2)} GB</div>
          </div>
        )}

        <OutputBlock title="KV Cache Quantization Comparison" output={kvCompareResult?.output} />
      </div>

      {/* ===== GPU BENCHMARK ===== */}
      <div style={SECTION_STYLE}>
        <div style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>🏎 CPU vs GPU Benchmark</h3>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>Load model with different GPU layer counts, measure tokens/sec for each — finds the optimal GPU offload strategy</div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={benchModel} onChange={e => setBenchModel(e.target.value)} style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: '0.8rem' }}>
            <option value="">Select model…</option>
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <ActionButton label="Quick CPU vs GPU" icon="⚡" onClick={handleQuickBench} loading={benchLoading} disabled={!benchModel} variant="primary" />
        </div>

        {benchResult && !benchResult.error && (
          <div style={{ marginTop: 14 }}>
            {benchResult.speedup_vs_cpu && (
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--accent)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent)', marginBottom: 4 }}>Best Configuration</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {benchResult.best_config?.label} — {benchResult.best_config?.avg_tokens_per_sec} tok/s
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                  {benchResult.speedup_vs_cpu}x faster than CPU-only
                </div>
              </div>
            )}
            {benchResult.results?.map((r, i) => (
              <div key={i} style={{ ...STAT_CARD, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{r.label}</span>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: 8 }}>n_gpu_layers={r.gpu_layers}</span>
                </div>
                {r.avg_tokens_per_sec ? (
                  <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--accent)' }}>{r.avg_tokens_per_sec} tok/s</span>
                ) : (
                  <span style={{ fontSize: '0.75rem', color: '#ef4444' }}>{r.error}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}
