import { useState, useEffect, useMemo } from 'react'
import {
  getModelTags, setModelTags,
  getSessions, exportAsJSON, exportAsMarkdown,
  deleteSession,
} from '../utils/storage.js'
import { downloadModel, optimizeSystem, loadModel as apiLoadModel } from '../utils/api.js'

// Helper to detect model format
function getModelFormat(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  switch (ext) {
    case 'gguf': return { type: 'GGUF', label: 'GGUF', color: 'var(--color-green)' }
    case 'safetensors': return { type: 'SafeTensor', label: 'SafeTensor', color: 'var(--color-purple)' }
    case 'bin': return { type: 'FP16', label: 'FP16', color: 'var(--color-blue)' }
    case 'pt': return { type: 'FP16', label: 'FP16/.pt', color: 'var(--color-blue)' }
    default: return { type: 'unknown', label: 'Unknown', color: 'var(--text-muted)' }
  }
}

// ---------------------------------------------------------------
// Predefined downloadable models
// ---------------------------------------------------------------
const CATALOG = [
  {
    name: 'Phi-3-mini-4k-instruct Q4',
    size: '2.3 GB',
    tags: ['fast', 'small'],
    quality: 'medium',
    url: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
    filename: 'Phi-3-mini-4k-instruct-q4.gguf',
    desc: 'Excellent for 4 GB RAM. Microsoft Phi-3 mini.',
  },
  {
    name: 'TinyLlama 1.1B Chat Q4',
    size: '0.7 GB',
    tags: ['tiny', 'fastest'],
    quality: 'low',
    url: 'https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf',
    filename: 'tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf',
    desc: 'Sub-1 GB. Fastest possible inference.',
  },
  {
    name: 'Mistral 7B Instruct v0.2 Q4',
    size: '4.1 GB',
    tags: ['balanced'],
    quality: 'high',
    url: 'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf',
    filename: 'mistral-7b-instruct-v0.2.Q4_K_M.gguf',
    desc: 'Best quality/size ratio for 8 GB RAM.',
  },
  {
    name: 'Mistral 7B v0.3 IQ4_XS',
    size: '4.0 GB',
    tags: ['balanced', 'quality'],
    quality: 'high',
    url: 'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-IQ4_XS.gguf',
    filename: 'Mistral-7B-Instruct-v0.3-IQ4_XS.gguf',
    desc: 'IQ4 quant — better quality than Q4_K_M at same size.',
  },
  {
    name: 'Llama 3 8B Instruct Q4',
    size: '4.7 GB',
    tags: ['quality', 'popular'],
    quality: 'very-high',
    url: 'https://huggingface.co/TheBloke/Llama-3-8B-Instruct-GGUF/resolve/main/llama-3-8b-instruct.Q4_K_M.gguf',
    filename: 'llama-3-8b-instruct.Q4_K_M.gguf',
    desc: 'Meta Llama 3 — top-tier open source model.',
  },
  {
    name: 'Llama 3 8B Instruct IQ4_XS',
    size: '4.6 GB',
    tags: ['quality', 'popular'],
    quality: 'very-high',
    url: 'https://huggingface.co/bartowski/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-IQ4_XS.gguf',
    filename: 'Meta-Llama-3-8B-Instruct-IQ4_XS.gguf',
    desc: 'IQ4_XS variant — marginally better than Q4_K_M.',
  },
]

const QUALITY_BADGE = {
  'low':      { label: 'Low', cls: 'badge-muted' },
  'medium':   { label: 'Medium', cls: 'badge-cyan' },
  'high':     { label: 'High', cls: 'badge-purple' },
  'very-high':{ label: 'Very High', cls: 'badge-green' },
}

const ALL_TAG_FILTERS = ['all', 'tiny', 'fast', 'fastest', 'balanced', 'quality', 'popular', 'small']

export default function ModelManager({ localModels = [], toast }) {
  const [tab, setTab]           = useState('local')   // 'local' | 'download'
  const [search, setSearch]     = useState('')
  const [tagFilter, setTagFilter] = useState('all')
  const [tagsMap, setTagsMap]   = useState(getModelTags)
  const [addingTag, setAddingTag] = useState({})      // { filename: true }
  const [tagInput, setTagInput] = useState({})

  const refreshTags = () => setTagsMap(getModelTags())

  // ---- Tag management ----
  const addTag = (filename, tag) => {
    const trimmed = tag.trim().toLowerCase()
    if (!trimmed) return
    const current  = { ...getModelTags() }
    const existing = current[filename] || []
    if (existing.includes(trimmed)) return
    current[filename] = [...existing, trimmed]
    setModelTags(current)
    refreshTags()
    setTagInput(p => ({ ...p, [filename]: '' }))
  }

  const removeTag = (filename, tag) => {
    const current = { ...getModelTags() }
    current[filename] = (current[filename] || []).filter(t => t !== tag)
    setModelTags(current)
    refreshTags()
  }

  // ---- Filter local models ----
  const filteredLocal = useMemo(() => {
    return localModels.filter(m => {
      const name = m.name.toLowerCase()
      const tags = (tagsMap[m.name] || []).join(' ')
      if (search && !name.includes(search.toLowerCase()) && !tags.includes(search.toLowerCase())) return false
      if (tagFilter !== 'all' && !(tagsMap[m.name] || []).includes(tagFilter)) return false
      return true
    })
  }, [localModels, search, tagFilter, tagsMap])

  // ---- Filter catalog ----
  const filteredCatalog = useMemo(() => {
    return CATALOG.filter(m => {
      if (search && !m.name.toLowerCase().includes(search.toLowerCase()) &&
          !m.desc.toLowerCase().includes(search.toLowerCase())) return false
      if (tagFilter !== 'all' && !m.tags.includes(tagFilter)) return false
      return true
    })
  }, [search, tagFilter])

  return (
    <div className="model-manager">
      {/* Toolbar */}
      <div className="model-toolbar">
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.04)', padding: 3, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)' }}>
          {[['local', `Local (${localModels.length})`], ['download', 'Download']].map(([key, label]) => (
            <button
              key={key}
              className={`btn btn-sm ${tab === key ? 'btn-primary' : 'btn-ghost'}`}
              style={{ border: 'none' }}
              onClick={() => setTab(key)}
            >{label}</button>
          ))}
        </div>

        {/* Search */}
        <div className="search-box">
          <span className="search-icon">⌕</span>
          <input
            placeholder="Search models or tags…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button style={{ background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',fontSize:'0.8rem' }}
              onClick={() => setSearch('')}>×</button>
          )}
        </div>

        {/* Tag filter pills */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {ALL_TAG_FILTERS.map(t => (
            <button
              key={t}
              className={`badge ${tagFilter === t ? 'badge-purple' : 'badge-muted'}`}
              style={{ cursor: 'pointer', fontSize: '0.62rem', border: '1px solid' }}
              onClick={() => setTagFilter(t)}
            >{t}</button>
          ))}
        </div>

        {/* System optimization button */}
        <button 
          className="btn btn-secondary btn-sm"
          style={{ gap: 6, borderColor: 'var(--color-cyan)', color: 'var(--color-cyan)', marginLeft: 'auto' }}
          onClick={async () => {
            const confirmed = window.confirm("This will free up system RAM and pause non-essential background services. Continue?")
            if (!confirmed) return
            toast('⚙ Optimizing system... please wait.', 'info')
            try {
              const res = await optimizeSystem()
              if (res.success) {
                toast('✓ System optimized successfully!', 'success')
              } else {
                toast('⚠ Optimization partially complete.', 'info')
              }
            } catch (err) {
              toast(`Error: ${err.message}`, 'error')
            }
          }}
        >
          ⚡ Optimize System
        </button>
      </div>

      {/* Content */}
      {tab === 'local' ? (
        <div className="model-grid">
          {filteredLocal.length === 0 ? (
            <div className="empty-state" style={{ gridColumn: '1/-1' }}>
              <div className="empty-icon">📦</div>
              <div className="empty-title">{localModels.length === 0 ? 'No models found' : 'No matches'}</div>
              <div className="empty-body">
                {localModels.length === 0
                  ? 'Add GGUF files to the models/ folder, or use the Download tab.'
                  : 'Try a different search or filter.'}
              </div>
              {localModels.length === 0 && (
                <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => setTab('download')}>
                  Browse Catalog
                </button>
              )}
            </div>
          ) : filteredLocal.map(m => (
            <LocalModelCard
              key={m.name}
              model={m}
              tags={tagsMap[m.name] || []}
              adding={!!addingTag[m.name]}
              tagInputVal={tagInput[m.name] || ''}
              onTagInputChange={v => setTagInput(p => ({ ...p, [m.name]: v }))}
              onAddTag={tag => addTag(m.name, tag)}
              onRemoveTag={tag => removeTag(m.name, tag)}
              onToggleAdding={() => setAddingTag(p => ({ ...p, [m.name]: !p[m.name] }))}
              toast={toast}
            />
          ))}
        </div>
      ) : (
        <div className="model-grid">
          {filteredCatalog.map(m => (
            <DownloadCard key={m.filename} model={m} toast={toast} />
          ))}
        </div>
      )}
    </div>
  )
}

function LocalModelCard({ model, tags, adding, tagInputVal, onTagInputChange, onAddTag, onRemoveTag, onToggleAdding, toast }) {
  const [loading, setLoading] = useState(false)
  const [converting, setConverting] = useState(false)
  const format = getModelFormat(model.name)
  const needsConversion = format.type !== 'GGUF'

  const handleConvert = async () => {
    if (converting) return
    setConverting(true)
    try {
      toast('Starting conversion... This may take several minutes.', 'info')
      const response = await fetch('/api/convert-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: model.name,
          quantization: 'Q4_K_M'
        })
      })
      const result = await response.json()
      if (result.success) {
        toast(`Conversion complete! Model saved.`, 'success')
      } else {
        toast(`Conversion failed: ${result.error || 'Unknown error'}`, 'error')
      }
    } catch (err) {
      toast(`Conversion error: ${err.message}`, 'error')
    } finally {
      setConverting(false)
    }
  }

  const handleLoad = async () => {
    if (loading) return
    setLoading(true)
    try {
      toast(`Loading ${model.name}...`, 'info')
      const result = await apiLoadModel(model.name)
      if (result.status === 'success') {
        toast(`✓ Model loaded successfully on port ${result.port}!`, 'success')
      } else {
        toast(`Failed to load: ${result.error}`, 'error')
      }
    } catch (err) {
      toast(`Error loading model: ${err.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="model-card">
      <div className="model-card-header">
        <div className="model-icon">🧠</div>
        <div className="model-info">
          <div className="model-name" title={model.name}>{model.name}</div>
          <div className="model-size">{model.size}</div>
        </div>
        <div className="model-card-format">
          <span className="badge" style={{ background: format.color, color: '#fff', fontSize: '0.65rem', padding: '2px 6px' }}>
            {format.label}
          </span>
          {needsConversion && (
            <span className="badge" style={{ background: 'var(--color-orange)', color: '#fff', fontSize: '0.65rem', padding: '2px 6px' }}>
              ⚠ Convert
            </span>
          )}
        </div>
        <div className="model-card-actions">
          <button
            className="btn btn-ghost btn-sm btn-icon"
            title="Copy filename"
            onClick={() => { navigator.clipboard.writeText(model.name); toast('Copied!', 'success') }}
          >⎘</button>
        </div>
      </div>

      {/* Tags */}
      <div className="model-tags">
        {tags.map(t => (
          <span
            key={t}
            className="badge badge-purple"
            style={{ cursor: 'pointer', gap: 4 }}
          >
            {t}
            <span style={{ opacity: 0.6, marginLeft: 2, fontSize: '0.7rem' }}
              onClick={() => onRemoveTag(t)}>×</span>
          </span>
        ))}
        <button
          className="badge badge-muted"
          style={{ cursor: 'pointer', border: '1px dashed rgba(255,255,255,0.15)' }}
          onClick={onToggleAdding}
        >
          {adding ? '−' : '+ tag'}
        </button>
      </div>

      {adding && (
        <div className="model-tag-input">
          <input
            placeholder="e.g. fast, coding, chat…"
            value={tagInputVal}
            onChange={e => onTagInputChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onAddTag(tagInputVal) }}
            autoFocus
          />
          <button className="btn btn-primary btn-sm" onClick={() => onAddTag(tagInputVal)}>Add</button>
        </div>
      )}
      {needsConversion && (
        <div style={{ marginTop: 8, padding: 8, background: 'rgba(255,165,0,0.1)', borderRadius: 'var(--r-sm)', border: '1px solid rgba(255,165,0,0.3)', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
          <div style={{ marginBottom: 6 }}>This model is in {format.label} format. Convert to GGUF to use it.</div>
          <button
            className="btn btn-primary btn-sm"
            style={{ width: '100%' }}
            onClick={handleConvert}
            disabled={converting}
          >
            {converting ? '⏳ Converting...' : '🔄 Convert to GGUF'}
          </button>
        </div>
      )}

      {!needsConversion && (
        <div style={{ marginTop: 8 }}>
          <button
            className="btn btn-primary btn-sm"
            style={{ width: '100%', background: 'var(--color-green)', borderColor: 'var(--color-green)' }}
            onClick={handleLoad}
            disabled={loading}
          >
            {loading ? '⏳ Loading...' : '▶ Load Model'}
          </button>
        </div>
      )}
    </div>
  )
}

function DownloadCard({ model, toast }) {
  const [downloading, setDownloading] = useState(false)
  const q = QUALITY_BADGE[model.quality] || QUALITY_BADGE['medium']
  
  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    console.log(`[Download] Starting download: ${model.name}`)
    console.log(`[Download] URL: ${model.url}`)
    console.log(`[Download] Filename: ${model.filename}`)
    
    try {
      toast(`Starting download of ${model.name}...`, 'info')
      const result = await downloadModel(model.url, model.filename)
      
      console.log(`[Download] Response:`, result)
      
      if (result.error) {
        console.error(`[Download] Error: ${result.error}`)
        toast(`Download failed: ${result.error}`, 'error')
      } else if (result.status === 'exists') {
        toast(`Model already exists in models/ folder`, 'info')
      } else if (result.status === 'started') {
        toast(`✓ ${model.name} is downloading in the background. Check the console for progress.`, 'success')
      } else {
        toast(`${model.name} download initiated`, 'success')
      }
    } catch (err) {
      console.error(`[Download] Exception:`, err)
      toast(`Error: ${err.message}`, 'error')
    }
    
    setDownloading(false)
  }
  
  return (
    <div className="model-card" style={{ cursor: 'default' }}>
      <div className="model-card-header">
        <div className="model-icon">⬇</div>
        <div className="model-info">
          <div className="model-name" title={model.name}>{model.name}</div>
          <div className="model-size">{model.size}</div>
        </div>
      </div>
      <div className="model-tags" style={{ marginBottom: 8 }}>
        <span className={`badge ${q.cls}`}>{q.label}</span>
        {model.tags.map(t => <span key={t} className="badge badge-muted">{t}</span>)}
      </div>
      <div style={{ fontSize: '0.73rem', color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
        {model.desc}
      </div>
      <button
        className="btn btn-primary"
        style={{ width: '100%', justifyContent: 'center', opacity: downloading ? 0.6 : 1, cursor: downloading ? 'not-allowed' : 'pointer' }}
        onClick={handleDownload}
        disabled={downloading}
      >
        {downloading ? '⏳ Downloading...' : '⬇ Download'}
      </button>
      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 8, textAlign: 'center' }}>
        Saves to <span className="font-mono">models/</span> folder automatically
      </div>
    </div>
  )
}
