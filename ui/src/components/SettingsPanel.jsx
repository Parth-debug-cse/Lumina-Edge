import { useState } from 'react'
import { getConfig, saveConfig, DEFAULT_CONFIG } from '../utils/storage.js'

const SECTIONS = [
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
      { key: 'threads',       label: 'CPU Threads',    type: 'number', min: 1, max: 64, hint: 'Number of CPU threads for inference.' },
      { key: 'ctx_size',      label: 'Context Size',   type: 'select', options: [512,1024,2048,4096,8192,16384,32768], hint: 'Token context window length.' },
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
    ],
  },
  {
    id: 'prompt',
    title: 'Prompt',
    fields: [
      { key: 'system_prompt', label: 'System Prompt',  type: 'textarea', hint: 'Default system prompt for new chat sessions.' },
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

export default function SettingsPanel({ toast }) {
  const [cfg, setCfg] = useState(getConfig)
  const [saved, setSaved] = useState(false)

  const update = (key, value) => {
    setCfg(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const save = () => {
    saveConfig(cfg)
    toast('Settings saved to disk', 'success')
    setSaved(true)
  }

  const reset = () => {
    setCfg({ ...DEFAULT_CONFIG })
    saveConfig({ ...DEFAULT_CONFIG })
    toast('Settings reset to defaults', 'info')
    setSaved(true)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="settings-panel">
        {SECTIONS.map(section => (
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

        {/* Config preview */}
        <div>
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
        background: 'rgba(8,8,16,0.8)', backdropFilter: 'blur(12px)',
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
    return (
      <div className="settings-card">
        <div className="form-group">
          <label className="form-label">{field.label}</label>
          <select className="select" value={value} onChange={e => onChange(Number(e.target.value))}>
            {field.options.map(o => <option key={o} value={o}>{o.toLocaleString()} tokens</option>)}
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
      </div>
    </div>
  )
}
