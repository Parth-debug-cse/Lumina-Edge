import { useState, useEffect } from 'react'
import { getLocalConfig, saveLocalConfig, DEFAULT_CONFIG } from '../utils/storage.js'

// Detect if running on macOS (Apple Silicon) - client-side fallback
const isMacOSClient = () => {
  if (typeof navigator === 'undefined') return false
  return navigator.platform?.toLowerCase().includes('mac') ||
         navigator.userAgent?.toLowerCase().includes('mac')
}

// Main settings sections (all platforms)
const MAIN_SECTIONS = [
  {
    id: 'inference',
    title: 'Inference',
    fields: [
      { key: 'temperature',    label: 'Temperature',    type: 'range', min: 0, max: 2, step: 0.05, hint: 'Controls randomness. 0 = deterministic, 2 = very creative.' },
      { key: 'top_p',         label: 'Top-P',           type: 'range', min: 0, max: 1, step: 0.01, hint: 'Nucleus sampling threshold. Lower = more focused.' },
      { key: 'repeat_penalty',label: 'Repeat Penalty',  type: 'range', min: 1, max: 2, step: 0.05, hint: 'Penalises repeated tokens. 1.0 = disabled.' },
    ],
  },
  {
    id: 'compute',
    title: 'Compute',
    fields: [
      { key: 'ctx_size',      label: 'Context Size',   type: 'select', options: [4096,8192,16384,32768], hint: 'Token context window length. Minimum 4096 tokens enforced.' },
      { key: 'batch_size',    label: 'Batch Size',     type: 'number', min: 1, max: 4096, hint: 'Prompt processing batch size.' },
      { key: 'ubatch_size',   label: 'Micro-Batch',    type: 'number', min: 1, max: 4096, hint: 'Physical micro-batch for memory efficiency.' },
      { key: 'n_gpu_layers',  label: 'GPU Layers',     type: 'text',   hint: '"auto" or an integer (e.g. 20). auto = VRAM-based detection.' },
    ],
  },
  {
    id: 'server',
    title: 'Server',
    fields: [
      { key: 'api_port',      label: 'API Port',       type: 'number', min: 1024, max: 65535, hint: 'Port for llama-server. Restart server to apply.' },
      { key: 'http_threads',  label: 'HTTP Threads',   type: 'range', min: 1, max: 16, step: 1, hint: 'Threads for HTTP request handling (llama.cpp only).' },
      { key: 'routing_policy', label: 'Routing Policy', type: 'select', options: ['round_robin', 'least_loaded', 'random'], hint: 'Load balancing policy for multi-model routing.' },
    ],
  },
  {
    id: 'output',
    title: 'Output Mode',
    fields: [
      { key: 'json_output',   label: 'JSON Output Mode', type: 'toggle', hint: 'Force structured JSON responses (llama-cli only).' },
    ],
  },
]

// llama.cpp-only advanced settings (hidden on macOS)
const LLAMA_CPP_SECTIONS = [
  {
    id: 'sampling',
    title: 'Sampling (llama.cpp)',
    fields: [
      { key: 'top_k',         label: 'Top-K',          type: 'range', min: 1, max: 100, step: 1, hint: 'Limits vocabulary to top K tokens. Lower = more focused (llama.cpp only).' },
      { key: 'min_p',         label: 'Min-P',          type: 'range', min: 0, max: 0.3, step: 0.01, hint: 'Minimum probability threshold for token selection (llama.cpp only).' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory & Cache (llama.cpp)',
    fields: [
      { key: 'flash_attn',    label: 'Flash Attention', type: 'toggle', hint: 'Enable Flash Attention for faster inference and lower memory (llama.cpp only).' },
      { key: 'kv_cache_quant', label: 'KV Cache Quant', type: 'select', options: ['f16', 'q8_0', 'q4_0'], hint: 'KV cache quantization type. Lower = less memory, slightly slower (llama.cpp only).' },
      { key: 'split_mode',    label: 'Split Mode',     type: 'select', options: ['auto', 'layer', 'row', 'none'], hint: 'GPU tensor split mode. Auto = detected by GPU type (llama.cpp only).' },
      { key: 'use_mlock',     label: 'Memory Lock (mlock)', type: 'toggle', hint: 'Lock pages in RAM to prevent swapping. Skip on macOS (llama.cpp only).' },
      { key: 'numa_mode',     label: 'NUMA Mode',      type: 'toggle', hint: 'Enable NUMA memory distribution for multi-socket systems (llama.cpp only).' },
    ],
  },
  {
    id: 'batching',
    title: 'Batching (llama.cpp)',
    fields: [
      { key: 'cont_batching', label: 'Continuous Batching', type: 'toggle', hint: 'Enable continuous batching for parallel request processing (llama.cpp only).' },
    ],
  },
]

// MLX-specific settings (macOS only)
const MLX_SECTIONS = [
  {
    id: 'mlx_server',
    title: 'MLX Server',
    fields: [
      { key: 'api_port',      label: 'API Port',       type: 'number', min: 1024, max: 65535, hint: 'Port for MLX API server. Restart server to apply.' },
    ],
  },
  {
    id: 'mlx_sampling',
    title: 'MLX Sampling',
    fields: [
      { key: 'temperature',   label: 'Temperature',    type: 'range', min: 0, max: 2, step: 0.05, hint: 'Controls randomness. 0 = deterministic, 2 = very creative.' },
      { key: 'top_p',         label: 'Top-P',          type: 'range', min: 0, max: 1, step: 0.01, hint: 'Nucleus sampling threshold. Lower = more focused.' },
      { key: 'repeat_penalty',label: 'Repeat Penalty', type: 'range', min: 1, max: 2, step: 0.05, hint: 'Penalises repeated tokens. 1.0 = disabled.' },
      { key: 'mlx_seed',      label: 'Seed',           type: 'text', hint: 'Random seed for reproducible outputs. Leave empty for random.' },
    ],
  },
  {
    id: 'mlx_generation',
    title: 'MLX Generation',
    fields: [
      { key: 'mlx_max_tokens', label: 'Max Tokens',    type: 'number', min: 1, max: 8192, hint: 'Maximum tokens to generate per response.' },
      { key: 'mlx_stop_tokens', label: 'Stop Tokens',    type: 'text', hint: 'Comma-separated list of tokens to stop generation (e.g., "</s>,User:").' },
    ],
  },
  {
    id: 'mlx_advanced',
    title: 'MLX Advanced',
    fields: [
      { key: 'mlx_adapter_path', label: 'LoRA Adapter Path', type: 'text', hint: 'Optional path to LoRA adapter (e.g., /path/to/adapter.safetensors). Leave empty for base model only.' },
      { key: 'trust_remote_code', label: 'Trust Remote Code', type: 'toggle', hint: 'WARNING: Enable only for custom model architectures. Security risk if enabled.' },
    ],
  },
]

export default function SettingsPanel({ toast }) {
  const [cfg, setCfg] = useState(getLocalConfig)
  const [saved, setSaved] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [macPlatform, setMacPlatform] = useState(false)
  const [platformInfo, setPlatformInfo] = useState({ platform: 'unknown', arch: 'unknown', backend: 'unknown' })

  // Detect platform on mount - prefer server-side detection, fallback to client-side
  useEffect(() => {
    // Try server-side detection first (authoritative)
    fetch('/api/system-info')
      .then(res => res.ok ? res.json() : null)
      .then(info => {
        if (info && info.platform) {
          setPlatformInfo(info)
          // Server says it's macOS + arm64 = MLX backend
          const isMacServer = info.platform === 'darwin' && info.arch === 'arm64'
          setMacPlatform(isMacServer)
          console.log('[Settings] Platform detected from server:', info)
        } else {
          // Fallback to client-side detection
          const isMacClient = isMacOSClient()
          setMacPlatform(isMacClient)
          setPlatformInfo({
            platform: isMacClient ? 'darwin' : 'unknown',
            arch: isMacClient ? 'arm64' : 'unknown',
            backend: isMacClient ? 'mlx' : 'llama.cpp'
          })
          console.log('[Settings] Platform detected from client-side:', isMacClient)
        }
      })
      .catch(err => {
        // Fallback to client-side on error
        const isMacClient = isMacOSClient()
        setMacPlatform(isMacClient)
        setPlatformInfo({
          platform: isMacClient ? 'darwin' : 'unknown',
          arch: isMacClient ? 'arm64' : 'unknown',
          backend: isMacClient ? 'mlx' : 'llama.cpp'
        })
        console.log('[Settings] Platform detected from client-side (API error):', isMacClient)
      })
  }, [])

  const update = (key, value) => {
    setCfg(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  // Filter sections based on platform
  const getFilteredSections = () => {
    if (!macPlatform) return MAIN_SECTIONS

    // On macOS, hide llama.cpp-only compute fields
    const filtered = MAIN_SECTIONS.map(section => {
      if (section.id === 'compute') {
        // P2-12: Hide ctx_size on macOS (MLX models have fixed context from training)
        return {
          ...section,
          fields: []  // Hide entire compute section on macOS - not applicable to MLX
        }
      }
      if (section.id === 'server') {
        // On macOS, hide http_threads and routing_policy (llama.cpp only)
        return {
          ...section,
          fields: section.fields.filter(field =>
            field.key === 'api_port'
          )
        }
      }
      return section
    })
    // Filter out sections with no fields (like compute on macOS)
    return filtered.filter(section => section.fields.length > 0)
  }

  const save = async () => {
    saveLocalConfig(cfg)
    try {
      const res = await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
      })
      if (res.ok) {
        toast('Settings saved to disk', 'success')
        setSaved(true)
      } else {
        toast('Failed to save to config.json', 'error')
      }
    } catch (err) {
      toast(`Save error: ${err.message}`, 'error')
    }
  }

  const reset = () => {
    setCfg({ ...DEFAULT_CONFIG })
    saveLocalConfig({ ...DEFAULT_CONFIG })
    toast('Settings reset to defaults', 'info')
    setSaved(true)
  }

  // Platform indicator text
  const getPlatformIndicator = () => {
    if (platformInfo.platform === 'darwin' && platformInfo.arch === 'arm64') {
      return '🖥️ macOS (Apple Silicon) — MLX Backend'
    } else if (platformInfo.platform === 'darwin') {
      return '🖥️ macOS (Intel) — Not Supported'
    } else if (platformInfo.platform === 'linux') {
      return '🖥️ Linux — llama.cpp + Vulkan'
    } else if (platformInfo.platform === 'win32') {
      return '🖥️ Windows — llama.cpp'
    }
    return '🖥️ Platform Detecting...'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="settings-panel" style={{ overflowY: 'auto' }}>
        {/* Platform / Backend Indicator */}
        <div style={{
          padding: '10px 14px',
          marginBottom: '16px',
          background: 'rgba(100, 149, 237, 0.15)',
          border: '1px solid rgba(100, 149, 237, 0.3)',
          borderRadius: 'var(--r-sm)',
          fontSize: '0.85rem',
          fontWeight: 500,
          color: 'var(--text)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          {getPlatformIndicator()}
        </div>

        {getFilteredSections().map(section => (
          <div key={section.id}>
            <div className="settings-section-title">{section.title}</div>
            <div className="settings-grid" style={{ marginTop: 12 }}>
              {section.fields.map(field => (
                <SettingField
                  key={field.key}
                  field={field}
                  value={cfg[field.key]}
                  onChange={v => update(field.key, v)}
                />
              ))}
            </div>
          </div>
        ))}

        {/* macOS / MLX section - only shown on macOS */}
        {macPlatform && (
          <div style={{ marginTop: 24 }}>
            <div style={{
              padding: '10px 14px',
              marginBottom: '12px',
              background: 'rgba(255, 193, 7, 0.1)',
              border: '1px solid rgba(255, 193, 7, 0.3)',
              borderRadius: 'var(--r-sm)',
              fontSize: '0.8rem',
              color: 'var(--text)'
            }}>
              ℹ️ <strong>Context size</strong> is determined by the model's training configuration and cannot be changed at runtime on MLX.
            </div>
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              style={{
                width: '100%',
                padding: '12px 16px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                color: 'var(--text)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '0.9rem',
              }}
            >
              <span>macOS / MLX Settings</span>
              <span style={{ transform: advancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {advancedOpen && (
              <div style={{ marginTop: 12 }}>
                {MLX_SECTIONS.map(section => (
                  <div key={section.id} style={{ marginBottom: 16 }}>
                    <div className="settings-section-title" style={{ fontSize: '0.8rem', opacity: 0.8 }}>{section.title}</div>
                    <div className="settings-grid" style={{ marginTop: 8 }}>
                      {section.fields.map(field => (
                        <SettingField
                          key={field.key}
                          field={field}
                          value={cfg[field.key]}
                          onChange={v => update(field.key, v)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Advanced / llama.cpp section - hidden on macOS */}
        {!macPlatform && (
          <div style={{ marginTop: 24 }}>
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              style={{
                width: '100%',
                padding: '12px 16px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                color: 'var(--text)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '0.9rem',
              }}
            >
              <span>Advanced / llama.cpp Settings</span>
              <span style={{ transform: advancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {advancedOpen && (
              <div style={{ marginTop: 12 }}>
                {LLAMA_CPP_SECTIONS.map(section => (
                  <div key={section.id} style={{ marginBottom: 16 }}>
                    <div className="settings-section-title" style={{ fontSize: '0.8rem', opacity: 0.8 }}>{section.title}</div>
                    <div className="settings-grid" style={{ marginTop: 8 }}>
                      {section.fields.map(field => (
                        <SettingField
                          key={field.key}
                          field={field}
                          value={cfg[field.key]}
                          onChange={v => update(field.key, v)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Config preview */}
        <div style={{ marginTop: 24 }}>
          <div className="settings-section-title">config.json Preview</div>
          <div style={{
            background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)', padding: '16px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: '0.72rem',
            color: 'var(--text-secondary)', whiteSpace: 'pre', overflowX: 'auto',
            marginTop: 12,
          }}>
            {JSON.stringify(cfg, null, 2)}
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div style={{
        padding: '14px 24px', borderTop: '1px solid var(--border)',
        display: 'flex', gap: 10, alignItems: 'center',
        background: 'rgba(28,25,23,0.8)', backdropFilter: 'blur(12px)',
        flexShrink: 0,
      }}>
        <button className="btn btn-primary btn-lg" onClick={save}>
          Save Settings
        </button>
        <button className="btn btn-ghost" onClick={reset}>
          Reset to Defaults
        </button>
        {saved && (
          <span style={{ fontSize: '0.75rem', color: 'var(--green)', marginLeft: 4 }}>
            ✓ Saved
          </span>
        )}
        <div style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-muted) ', maxWidth: 280, textAlign: 'right', lineHeight: 1.4 }}>
          Settings are saved in browser storage and used by the UI.<br />
          To apply to shell scripts, edit <span className="font-mono">config.json</span> directly or copy the preview above.
        </div>
      </div>
    </div>
  )
}

function SettingField({ field, value, onChange }) {
  // Read-only display for auto-detected values
  if (field.type === 'readonly') {
    return (
      <div className="settings-card">
        <div className="form-group">
          <label className="form-label">{field.label}</label>
          <div style={{
            padding: '8px 12px',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
            color: 'var(--text-secondary)',
            fontSize: '0.85rem',
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {value || 'Auto-detected on launch'} <span style={{ opacity: 0.6 }}>(auto)</span>
          </div>
          {field.hint && <div className="form-hint">{field.hint}</div>}
        </div>
      </div>
    )
  }

  if (field.type === 'range') {
    const pct = ((value - field.min) / (field.max - field.min)) * 100
    return (
      <div className="settings-card">
        <div className="form-group">
          <label className="form-label">{field.label}</label>
          <div className="range-row">
            <input
              type="range"
              min={field.min} max={field.max} step={field.step}
              value={value}
              style={{ '--pct': `${pct}%` }}
              onChange={e => onChange(parseFloat(e.target.value))}
            />
            <span className="range-value">{Number(value).toFixed(2)}</span>
          </div>
          {field.hint && <div className="form-hint">{field.hint}</div>}
        </div>
      </div>
    )
  }

  if (field.type === 'toggle') {
    return (
      <div className="settings-card">
        <div className="setting-row">
          <div>
            <div className="form-label">{field.label}</div>
            {field.hint && <div className="form-hint" style={{ marginTop: 3 }}>{field.hint}</div>}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    )
  }

  if (field.type === 'select') {
    const isStringOption = typeof field.options[0] === 'string'
    return (
      <div className="settings-card">
        <div className="form-group">
          <label className="form-label">{field.label}</label>
          <select
            className="select"
            value={value}
            onChange={e => onChange(isStringOption ? e.target.value : Number(e.target.value))}
          >
            {field.options.map(o => (
              <option key={o} value={o}>
                {typeof o === 'number' ? `${o.toLocaleString()} tokens` : o.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          {field.hint && <div className="form-hint">{field.hint}</div>}
        </div>
      </div>
    )
  }

  if (field.type === 'textarea') {
    return (
      <div className="settings-card" style={{ gridColumn: '1 / -1' }}>
        <div className="form-group">
          <label className="form-label">{field.label}</label>
          <textarea
            className="textarea"
            value={value || ''}
            rows={3}
            onChange={e => onChange(e.target.value)}
          />
          {field.hint && <div className="form-hint">{field.hint}</div>}
        </div>
      </div>
    )
  }

  // number / text
  const isStopTokens = field.key === 'mlx_stop_tokens'
  const parseStopTokens = (str) => {
    if (!str) return []
    return str.split(',').map(t => t.trim()).filter(t => t.length > 0)
  }
  const parsedTokens = isStopTokens ? parseStopTokens(value) : []

  return (
    <div className="settings-card">
      <div className="form-group">
        <label className="form-label">{field.label}</label>
        <input
          className="input"
          type={field.type === 'number' ? 'number' : 'text'}
          min={field.min} max={field.max}
          value={value ?? ''}
          onChange={e => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
        />
        {field.hint && <div className="form-hint">{field.hint}</div>}
        {isStopTokens && (
          <div style={{ fontSize: '0.8em', color: '#888', marginTop: 4 }}>
            {parsedTokens.length > 0
              ? `Parsed stop tokens: [${parsedTokens.join('], [')}]`
              : 'No stop tokens set'}
          </div>
        )}
      </div>
    </div>
  )
}
