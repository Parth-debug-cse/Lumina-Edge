import { useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler,
} from 'chart.js'
import { Bar, Line } from 'react-chartjs-2'
import { getBenchmarkResults, saveBenchmarkResult } from '../utils/storage.js'
import { checkServerHealth } from '../utils/api.js'

ChartJS.register(
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler
)

const CHART_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: '#9898c0', font: { family: 'Inter', size: 11 } } },
    tooltip: {
      backgroundColor: '#121220',
      borderColor: 'rgba(124,58,237,0.4)',
      borderWidth: 1,
      titleColor: '#f0f0ff',
      bodyColor: '#9898c0',
    },
  },
  scales: {
    x: { ticks: { color: '#5a5a7a', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
    y: { ticks: { color: '#5a5a7a', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
  },
}

export default function BenchmarkPanel({ serverStatus, toast }) {
  const [results, setResults]   = useState(getBenchmarkResults)
  const [running, setRunning]   = useState(false)
  const [simResult, setSimResult] = useState(null)

  const refreshResults = () => setResults(getBenchmarkResults())

  /**
   * "Run Benchmark" — in the browser we can't directly invoke llama-bench,
   * so we (1) ping the server to measure response latency,
   * (2) do a real streaming timing test if the server is online,
   * (3) store and display the result.
   */
  const runBenchmark = async () => {
    if (serverStatus !== 'online') {
      toast('Server must be running to benchmark', 'error'); return
    }
    setRunning(true)
    setSimResult(null)
    toast('Benchmarking… this will take ~15 seconds', 'info')

    try {
      const startTs = Date.now()

      // 1) Measure TTFT (time-to-first-token)
      let ttft = 0
      let totalTokens = 0
      let totalTime = 0

      const testPrompt = 'Write a comprehensive explanation of how neural networks learn through backpropagation, covering forward pass, loss computation, gradient descent, and weight updates. Be thorough and detailed.'

      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user',   content: testPrompt },
          ],
          max_tokens: 200,
          stream: true,
        }),
      })

      if (!res.ok) throw new Error('Server returned error')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let firstToken = true
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          const t = line.trim()
          if (!t || t === 'data: [DONE]') continue
          if (!t.startsWith('data: ')) continue
          try {
            const d = JSON.parse(t.slice(6))
            const chunk = d.choices?.[0]?.delta?.content
            if (chunk) {
              if (firstToken) { ttft = Date.now() - startTs; firstToken = false }
              totalTokens++
            }
          } catch {}
        }
      }

      totalTime = (Date.now() - startTs) / 1000
      const tps = totalTime > 0 ? (totalTokens / totalTime).toFixed(1) : '0'

      const entry = {
        timestamp: new Date().toISOString(),
        model: 'loaded model',
        backend: 'llama-server',
        ttft_ms: ttft,
        token_generation_tps: parseFloat(tps),
        total_tokens: totalTokens,
        total_time_s: totalTime.toFixed(2),
      }

      saveBenchmarkResult(entry)
      setSimResult(entry)
      refreshResults()
      toast(`Benchmark complete: ${tps} tok/sec`, 'success')
    } catch (err) {
      toast(`Benchmark failed: ${err.message}`, 'error')
    } finally {
      setRunning(false)
    }
  }

  const clearResults = () => {
    localStorage.removeItem('lumina_benchmark_results')
    setResults([])
    setSimResult(null)
    toast('Results cleared', 'info')
  }

  // ---- Chart data ----
  const chartLabels = results.slice(0, 12).reverse().map((_, i) => `Run ${i + 1}`)
  const tpsData = results.slice(0, 12).reverse().map(r => r.token_generation_tps || r.prompt_processing_tps || 0)
  const ttftData = results.slice(0, 12).reverse().map(r => r.ttft_ms || 0)

  const tpsChartData = {
    labels: chartLabels,
    datasets: [{
      label: 'Tokens / sec',
      data: tpsData,
      backgroundColor: 'rgba(124,58,237,0.6)',
      borderColor: '#7c3aed',
      borderWidth: 1.5,
      borderRadius: 6,
    }],
  }

  const ttftChartData = {
    labels: chartLabels,
    datasets: [{
      label: 'Time-to-First-Token (ms)',
      data: ttftData,
      borderColor: '#06b6d4',
      backgroundColor: 'rgba(6,182,212,0.12)',
      borderWidth: 2,
      fill: true,
      tension: 0.4,
      pointBackgroundColor: '#06b6d4',
      pointRadius: 4,
    }],
  }

  const latest = simResult || results[0]

  return (
    <div className="benchmark-panel">
      {/* Header actions */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          className="btn btn-primary btn-lg"
          onClick={runBenchmark}
          disabled={running || serverStatus !== 'online'}
        >
          {running ? (
            <><span className="spinner" style={{ width: 14, height: 14 }} /> Running…</>
          ) : '⚡ Run Benchmark'}
        </button>
        {results.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={clearResults}>Clear Results</button>
        )}
        {serverStatus !== 'online' && (
          <span style={{ fontSize: '0.75rem', color: 'var(--yellow)' }}>
            ⚠ Start lumina-api.sh to benchmark
          </span>
        )}
        {running && (
          <div style={{ flex: 1 }}>
            <div className="progress-bar progress-indeterminate"><div className="progress-fill" /></div>
          </div>
        )}
      </div>

      {/* Latest stats */}
      {latest && (
        <div className="benchmark-stats">
          <div className="stat-card">
            <div className="stat-value">{latest.token_generation_tps || latest.prompt_processing_tps || '—'}</div>
            <div className="stat-label">Tokens / sec</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{latest.ttft_ms ? `${latest.ttft_ms}ms` : '—'}</div>
            <div className="stat-label">Time to First Token</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{latest.total_tokens || '—'}</div>
            <div className="stat-label">Tokens Generated</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{latest.total_time_s ? `${latest.total_time_s}s` : '—'}</div>
            <div className="stat-label">Total Time</div>
          </div>
          {latest.ram_used_mb && (
            <div className="stat-card">
              <div className="stat-value">{latest.ram_used_mb}MB</div>
              <div className="stat-label">RAM Used</div>
            </div>
          )}
          {latest.vram_total_mb && (
            <div className="stat-card">
              <div className="stat-value">{latest.vram_used_mb || '?'}/{latest.vram_total_mb}MB</div>
              <div className="stat-label">VRAM Used</div>
            </div>
          )}
        </div>
      )}

      {/* Charts */}
      {results.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="chart-container">
            <div className="chart-title">Token Generation Speed (tok/sec)</div>
            <div style={{ height: 210 }}>
              <Bar data={tpsChartData} options={CHART_OPTS} />
            </div>
          </div>
          <div className="chart-container">
            <div className="chart-title">Time to First Token (ms)</div>
            <div style={{ height: 210 }}>
              <Line data={ttftChartData} options={CHART_OPTS} />
            </div>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-icon">📊</div>
          <div className="empty-title">No benchmark data yet</div>
          <div className="empty-body">Run a benchmark to see performance charts. Results are stored locally and accumulate over time.</div>
        </div>
      )}

      {/* Results table */}
      {results.length > 0 && (
        <div>
          <div className="settings-section-title" style={{ marginBottom: 12 }}>Run History</div>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)', overflow: 'hidden',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                  {['Timestamp', 'Model', 'Backend', 'Tok/sec', 'TTFT', 'Tokens'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.slice(0, 20).map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 14px', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.68rem' }}>
                      {new Date(r.timestamp).toLocaleString()}
                    </td>
                    <td style={{ padding: '9px 14px', color: 'var(--text-secondary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.model}
                    </td>
                    <td style={{ padding: '9px 14px' }}>
                      <span className={`badge ${r.backend?.includes('CUDA') ? 'badge-green' : 'badge-cyan'}`}>
                        {r.backend}
                      </span>
                    </td>
                    <td style={{ padding: '9px 14px', color: 'var(--text-accent)', fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>
                      {r.token_generation_tps || r.prompt_processing_tps || '—'}
                    </td>
                    <td style={{ padding: '9px 14px', color: 'var(--cyan)', fontFamily: "'JetBrains Mono',monospace" }}>
                      {r.ttft_ms ? `${r.ttft_ms}ms` : '—'}
                    </td>
                    <td style={{ padding: '9px 14px', color: 'var(--text-secondary)' }}>
                      {r.total_tokens || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Note about llama-bench */}
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)', padding: '14px 18px',
        fontSize: '0.73rem', color: 'var(--text-muted)', lineHeight: 1.6,
      }}>
        <strong style={{ color: 'var(--text-secondary)' }}>💡 Note:</strong> Browser benchmarks measure token throughput via the API.
        For hardware-level profiling (prompt-processing vs token-generation, memory bandwidth), run the shell scripts with the <code style={{ fontFamily: "'JetBrains Mono',monospace", background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 4, color: 'var(--cyan)' }}>--benchmark</code> flag,
        which invokes <code style={{ fontFamily: "'JetBrains Mono',monospace", background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 4, color: 'var(--cyan)' }}>llama-bench</code> directly and writes results to <code style={{ fontFamily: "'JetBrains Mono',monospace", background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 4, color: 'var(--cyan)' }}>benchmark_results.json</code>.
      </div>
    </div>
  )
}
