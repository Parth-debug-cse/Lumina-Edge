import { useState, useEffect, useMemo } from 'react'
import {
  getModelTags, setModelTags,
  getSessions, exportAsJSON, exportAsMarkdown,
  deleteSession,
} from '../utils/storage.js'
import { downloadModel, optimizeSystem, loadModel as apiLoadModel, fetchHFFiles, getSystemInfo, fetchConfig, saveConfig, getRouterStatus, unloadAllModels, getDownloadStatus } from '../utils/api.js'
import ConverterTab from './ConverterTab.jsx'

// Helper to detect model format
function getModelFormat(modelName, isDirectory = false) {
  if (isDirectory) {
    // For MLX model directories, check if they contain model.safetensors
    // This is a heuristic - the backend already validates these directories
    return { type: 'MLX', label: 'MLX', color: 'var(--color-green)' }
  }
  
  const ext = modelName.split('.').pop().toLowerCase()
  switch (ext) {
    case 'gguf': return { type: 'GGUF', label: 'GGUF', color: 'var(--color-green)' }
    case 'safetensors': return { type: 'SafeTensors', label: 'SafeTensors', color: 'var(--color-purple)' }
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
  'high':     { label: 'High', cls: 'badge-accent' },
  'very-high':{ label: 'Very High', cls: 'badge-green' },
}

const ALL_TAG_FILTERS = ['all', 'tiny', 'fast', 'fastest', 'balanced', 'quality', 'popular', 'small']

export default function ModelManager({ localModels = [], toast, onModelsRefresh }) {
  const [tab, setTab]           = useState('local')   // 'local' | 'download' | 'custom' | 'converter'
  const [tagFilter, setTagFilter] = useState('all')
  const [tagsMap, setTagsMap]   = useState(getModelTags)
  const [addingTag, setAddingTag] = useState({})      // { filename: true }
  const [tagInput, setTagInput] = useState({})
  const [systemInfo, setSystemInfo] = useState({ isMacAppleSilicon: false })
  const [hfLink, setHfLink] = useState('')
  const [hfFiles, setHfFiles] = useState(null)
  const [hfLoading, setHfLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  const [autoConvertOnDownload, setAutoConvertOnDownload] = useState(true)
  const [routerStatus, setRouterStatus] = useState(null)
  const [unloading, setUnloading] = useState(false)

  useEffect(() => {
    getSystemInfo().then(setSystemInfo)
    fetchConfig().then(config => {
      if (config && typeof config.autoConvertOnDownload === 'boolean') {
        setAutoConvertOnDownload(config.autoConvertOnDownload)
      }
    })
  }, [])

  // Poll router status to show currently loaded model
  useEffect(() => {
    const refreshRouterStatus = async () => {
      try {
        const status = await getRouterStatus()
        console.log('[ModelManager] Router status:', status)
        setRouterStatus(status)
      } catch (err) {
        console.log('[ModelManager] Router status check failed:', err)
        // Router may not be running, that's ok
        setRouterStatus(null)
      }
    }
    refreshRouterStatus()
    const interval = setInterval(refreshRouterStatus, 2000) // Poll more frequently
    return () => clearInterval(interval)
  }, [])

  const refreshTags = () => setTagsMap(getModelTags())

  const handleUnloadAll = async () => {
    const loadedModels = routerStatus?.models?.filter(m => m.status === 'ready') || []
    if (loadedModels.length === 0) {
      toast('No models are currently loaded', 'info')
      return
    }

    const confirmed = window.confirm(
      `Unload ${loadedModels.length} model(s)? This will stop all inference processes.`
    )
    if (!confirmed) return

    setUnloading(true)
    try {
      const result = await unloadAllModels()
      if (result.status === 'success') {
        toast(`✓ Unloaded ${result.unloaded} model(s)`, 'success')
        setRouterStatus(null)
      } else {
        toast(`Failed to unload: ${result.error}`, 'error')
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'error')
    } finally {
      setUnloading(false)
    }
  }

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
      if (tagFilter !== 'all' && !(tagsMap[m.name] || []).includes(tagFilter)) return false
      return true
    })
  }, [localModels, tagFilter, tagsMap])

  // ---- Filter catalog ----
  const filteredCatalog = useMemo(() => {
    return CATALOG.filter(m => {
      if (tagFilter !== 'all' && !m.tags.includes(tagFilter)) return false
      return true
    })
  }, [tagFilter])

  return (
    <div className="model-manager">
      {/* Toolbar */}
      <div className="model-toolbar">
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.04)', padding: 3, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)' }}>
          {[['local', `⚡ Load (${localModels.length})`], ['download', '⬇ Download'], ['custom', '🔗 Custom'], ['converter', '🔄 Convert']].map(([key, label]) => (
            <button
              key={key}
              className={`btn btn-sm ${tab === key ? 'btn-primary' : 'btn-ghost'}`}
              style={{ border: 'none' }}
              onClick={() => {
                setTab(key)
                if (key === 'custom') {
                  setHfLink('')
                  setHfFiles(null)
                  setSelectedFile(null)
                }
              }}
            >{label}</button>
          ))}
        </div>

        {/* Tag filter pills */}
        {(tab === 'local' || tab === 'download') && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {ALL_TAG_FILTERS.map(t => (
            <button
              key={t}
              className={`badge ${tagFilter === t ? 'badge-accent' : 'badge-muted'}`}
              style={{ cursor: 'pointer', fontSize: '0.62rem', border: '1px solid' }}
              onClick={() => setTagFilter(t)}
            >{t}</button>
          ))}
        </div>
        )}

        {/* Refresh & System optimization buttons */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        <button
          className="btn btn-ghost btn-sm"
          style={{ gap: 6, borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
          onClick={() => onModelsRefresh?.()}
          title="Refresh model list from disk"
        >↺ Refresh</button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ gap: 6, borderColor: 'var(--accent)', color: 'var(--accent)' }}
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
      </div>

      {/* Currently Loaded Model Indicator */}
      {routerStatus?.models?.some(m => m.status === 'ready') && (
        <div style={{
          background: 'var(--green-dim)',
          border: '1px solid rgba(74,222,128,0.3)',
          borderRadius: 8,
          padding: '12px 16px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2 }}>
              Currently Loaded ({routerStatus.models.filter(m => m.status === 'ready').length})
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500 }}>
              {routerStatus.models.filter(m => m.status === 'ready').map(m => m.name || m.model_name).join(', ')}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Ports: {routerStatus.models.filter(m => m.status === 'ready').map(m => m.port).join(', ')}
            </div>
          </div>
          <button
            className="btn btn-sm"
            style={{
              background: 'var(--red-dim)',
              borderColor: 'rgba(239,68,68,0.4)',
              color: 'var(--red)',
              padding: '6px 12px',
              fontSize: '0.75rem',
            }}
            onClick={handleUnloadAll}
            disabled={unloading}
          >
            {unloading ? '⏳ Unloading...' : '🗑 Unload All'}
          </button>
        </div>
      )}

      {/* Loading Models Indicator */}
      {routerStatus?.models?.some(m => m.status === 'loading') && (
        <div style={{
          background: 'rgba(245,158,11,0.1)',
          border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: 8,
          padding: '12px 16px',
          marginBottom: 16,
        }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--color-orange)', marginBottom: 2 }}>
            Loading Models
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500 }}>
            {routerStatus.models.filter(m => m.status === 'loading').map(m => m.name || m.model_name).join(', ')}
          </div>
        </div>
      )}

      {/* Content */}
      {tab === 'local' ? (
        <div className="model-grid">
          {filteredLocal.length === 0 ? (
            <div className="empty-state" style={{ gridColumn: '1/-1' }}>
              <div className="empty-icon">📦</div>
              <div className="empty-title">{localModels.length === 0 ? 'No models in folder' : 'No matches'}</div>
              <div className="empty-body">
                {localModels.length === 0
                  ? 'Downloaded models appear here. Go to Download tab to get models, or add files directly to the models/ folder.'
                  : 'Try a different filter.'}
              </div>
              {localModels.length === 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setTab('download')}>
                    ⬇ Browse Catalog
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setTab('custom')}>
                    🔗 Custom HF Link
                  </button>
                </div>
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
              onLoaded={() => {
                // Refresh router status to update the loaded model indicator
                getRouterStatus().then(setRouterStatus).catch(() => {})
              }}
              toast={toast}
              systemInfo={systemInfo}
              routerStatus={routerStatus}
            />
          ))}
        </div>
      ) : tab === 'download' ? (
        <div className="model-grid">
          {filteredCatalog.map(m => (
            <DownloadCard key={m.filename} model={m} toast={toast} autoConvertOnDownload={autoConvertOnDownload} systemInfo={systemInfo} onModelsRefresh={onModelsRefresh} />
          ))}
        </div>
      ) : tab === 'custom' ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          <CustomHFLinkPanel
            hfLink={hfLink}
            setHfLink={setHfLink}
            hfFiles={hfFiles}
            setHfFiles={setHfFiles}
            hfLoading={hfLoading}
            setHfLoading={setHfLoading}
            selectedFile={selectedFile}
            setSelectedFile={setSelectedFile}
            systemInfo={systemInfo}
            autoConvertOnDownload={autoConvertOnDownload}
            toast={toast}
            onModelsRefresh={onModelsRefresh}
          />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          <ConverterTab
            systemInfo={systemInfo}
            apiLoadModel={apiLoadModel}
            toast={toast}
            autoConvertOnDownload={autoConvertOnDownload}
            setAutoConvertOnDownload={setAutoConvertOnDownload}
          />
        </div>
      )}
    </div>
  )
}

function LocalModelCard({ model, tags, adding, tagInputVal, onTagInputChange, onAddTag, onRemoveTag, onToggleAdding, onLoaded, toast, systemInfo, routerStatus }) {
  const [loading, setLoading] = useState(false)
  const [converting, setConverting] = useState(false)
  const format = getModelFormat(model.name, model.isDirectory)

  // Check if this model is currently loaded
  const isLoaded = routerStatus?.models?.some(m => 
    (m.status === 'ready' || m.status === 'loading') && 
    (m.name === model.name || m.model_name === model.name)
  )
  const loadedModel = routerStatus?.models?.find(m => 
    (m.status === 'ready' || m.status === 'loading') && 
    (m.name === model.name || m.model_name === model.name)
  )

  const handleConvert = async () => {
    if (converting) return
    setConverting(true)
    try {
      toast('Converting to GGUF... This may take several minutes.', 'info')
      const response = await fetch('/api/convert-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input_file: model.name,
          quantization: 'Q4_K_M',
          format: 'gguf'
        })
      })
      const result = await response.json()
      if (result.status === 'started' || result.status === 'complete') {
        toast(`Conversion started! Model will be saved as GGUF.`, 'success')
      } else if (result.error) {
        toast(`Conversion failed: ${result.error}`, 'error')
      } else {
        toast(`Conversion started!`, 'success')
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
      console.log('[ModelManager] Load result:', result)
      
      if (result.status === 'success') {
        toast(`✓ Model loaded successfully on port ${result.port}!`, 'success')
        onLoaded?.()
        
        // Wait a moment then refresh status to ensure UI updates
        setTimeout(() => {
          getRouterStatus().then(setRouterStatus).catch(() => {})
        }, 1000)
      } else {
        // Show detailed error message if available
        const errorMsg = result.message || result.error || 'Unknown error'
        console.error('[ModelManager] Load failed:', result)
        toast(`Failed to load: ${errorMsg}`, 'error')
      }
    } catch (err) {
      console.error('[ModelManager] Load exception:', err)
      toast(`Error loading model: ${err.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`model-card ${isLoaded ? 'model-card-loaded' : ''}`} style={{
      border: isLoaded ? '2px solid rgba(74,222,128,0.5)' : undefined,
      background: isLoaded ? 'rgba(74,222,128,0.05)' : undefined
    }}>
      <div className="model-card-header">
        <div className="model-icon">
          {isLoaded ? (loadedModel?.status === 'loading' ? '⏳' : '✅') : '🧠'}
        </div>
        <div className="model-info">
          <div className="model-name" title={model.name}>
            {model.name}
            {isLoaded && (
              <span className="badge" style={{ 
                background: loadedModel?.status === 'loading' ? 'var(--color-orange)' : 'var(--color-green)', 
                color: '#1C1917', 
                fontSize: '0.6rem', 
                padding: '2px 6px',
                marginLeft: '8px'
              }}>
                {loadedModel?.status === 'loading' ? 'Loading...' : `Loaded (Port ${loadedModel?.port})`}
              </span>
            )}
          </div>
          <div className="model-size">{model.size}</div>
        </div>
        <div className="model-card-format">
          <span className="badge" style={{ background: format.color, color: '#1C1917', fontSize: '0.65rem', padding: '2px 6px' }}>
            {format.label}
          </span>
          {format.type !== 'GGUF' && format.type !== 'MLX' && (
            <span className="badge" style={{ background: 'var(--color-orange)', color: '#1C1917', fontSize: '0.65rem', padding: '2px 6px' }}>
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
            className="badge badge-accent"
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

      {format.type !== 'GGUF' && format.type !== 'MLX' && (
        <div style={{ marginTop: 8, padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--r-sm)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-orange)', marginBottom: 8 }}>
            This format can be converted to GGUF for inference
          </div>
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

      <div style={{ marginTop: 8 }}>
          <button
            className="btn btn-primary"
            style={{ width: '100%', background: 'var(--color-green)', borderColor: 'var(--color-green)', fontSize: '0.9rem', padding: '8px 12px' }}
            onClick={handleLoad}
            disabled={loading}
          >
            {loading ? '⏳ Loading model into memory...' : '▶ LOAD MODEL'}
          </button>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: 4 }}>
            Click to load and start using this model
          </div>
        </div>
    </div>
  )
}

function DownloadCard({ model, toast, autoConvertOnDownload, systemInfo, onModelsRefresh }) {
  const [downloading, setDownloading] = useState(false)
  const q = QUALITY_BADGE[model.quality] || QUALITY_BADGE['medium']
  
  const handleDownload = async () => {
    if (downloading) return
    
    setDownloading(true)

    try {
      toast(`Starting download of ${model.name}...`, 'info')
      const result = await downloadModel(model.url, model.filename, autoConvertOnDownload)
      
      console.log(`[Download] Response:`, result)
      
      if (result.error) {
        toast(`Download failed: ${result.error}`, 'error')
      } else if (result.status === 'exists') {
        toast(`Model already exists in models/ folder`, 'info')
      } else if (result.status === 'started') {
        // Poll for download status to catch errors
        let pollCount = 0
        const maxPolls = 15 // Poll for 30 seconds (15 * 2s)
        const pollInterval = 2000
        
        const checkDownload = async () => {
          if (pollCount >= maxPolls) {
            toast(`✓ ${model.name} is downloading. This may take several minutes.`, 'success')
            return
          }
          
          const status = await getDownloadStatus(model.filename)
          console.log(`[Download] Status check:`, status)
          
          if (status.status === 'error') {
            toast(`Download failed: ${status.error || 'Unknown error'}`, 'error')
          } else if (status.status === 'complete') {
            toast(`✓ ${model.name} downloaded successfully!`, 'success')
            onModelsRefresh?.()
          } else if (status.status === 'downloading') {
            pollCount++
            setTimeout(checkDownload, pollInterval)
          }
        }
        
        setTimeout(checkDownload, pollInterval)
      } else {
        toast(`${model.name} download initiated`, 'success')
      }
    } catch (err) {
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

function CustomHFLinkPanel({ hfLink, setHfLink, hfFiles, setHfFiles, hfLoading, setHfLoading, selectedFile, setSelectedFile, systemInfo, autoConvertOnDownload, toast, onModelsRefresh }) {
  const [downloading, setDownloading] = useState(false)
  const [downloadingRepo, setDownloadingRepo] = useState(false)

  const handleFetchFiles = async () => {
    if (!hfLink.trim()) {
      toast('Please paste a HuggingFace link', 'info')
      return
    }

    console.log('[CustomLink] Fetching files for:', hfLink)
    setHfLoading(true)
    try {
      const result = await fetchHFFiles(hfLink)
      console.log('[CustomLink] Response:', result)
      if (result.error) {
        toast(`Error: ${result.error}`, 'error')
        setHfFiles(null)
      } else {
        setHfFiles(result)
        setSelectedFile(null)
        if (result.totalFiles === 0) {
          toast('No model files found in this repository', 'info')
        } else {
          toast(`Found ${result.totalFiles} model file(s)`, 'success')
        }
      }
    } catch (err) {
      console.error('[CustomLink] Fetch error:', err)
      toast(`Failed to fetch files: ${err.message}`, 'error')
    } finally {
      setHfLoading(false)
    }
  }

  const handleDownloadFile = async () => {
    if (!selectedFile) {
      toast('Please select a file to download', 'info')
      return
    }

    setDownloading(true)
    try {
      const filename = selectedFile.name.split('/').pop()

      // Construct direct download URL using HF CDN
      const repoId = hfFiles.repo
      const filePath = selectedFile.name
      const directUrl = `https://huggingface.co/${repoId}/resolve/main/${filePath}?download=true`

      toast(`Starting download of ${filename}...`, 'info')
      const result = await downloadModel(directUrl, filename, autoConvertOnDownload)

      if (result.error) {
        toast(`Download failed: ${result.error}`, 'error')
      } else if (result.status === 'exists') {
        toast(`Model already exists in models/ folder`, 'info')
      } else if (result.status === 'started') {
        // Poll for download status to catch errors
        let pollCount = 0
        const maxPolls = 15
        const pollInterval = 2000
        
        const checkDownload = async () => {
          if (pollCount >= maxPolls) {
            toast(`✓ ${filename} is downloading. This may take several minutes.`, 'success')
            return
          }
          
          const status = await getDownloadStatus(filename)
          
          if (status.status === 'error') {
            toast(`Download failed: ${status.error || 'Unknown error'}`, 'error')
          } else if (status.status === 'complete') {
            toast(`✓ ${filename} downloaded successfully!`, 'success')
            onModelsRefresh?.()
          } else if (status.status === 'downloading') {
            pollCount++
            setTimeout(checkDownload, pollInterval)
          }
        }
        
        setTimeout(checkDownload, pollInterval)
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'error')
    } finally {
      setDownloading(false)
    }
  }

  const handleDownloadRepo = async () => {
    if (!hfFiles) {
      toast('Please search for a repository first', 'info')
      return
    }

    setDownloadingRepo(true)
    try {
      const repoId = hfFiles.repo
      const dirName = repoId.split('/').pop()

      toast(`Downloading entire repository ${repoId}...`, 'info')
      
      const response = await fetch('/api/download-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: hfLink,
          filename: dirName,
          downloadRepo: true
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        toast(`Download failed: ${errorText || `Server error ${response.status}`}`, 'error')
        setDownloadingRepo(false)
        return
      }

      const result = await response.json()

      if (result.error) {
        toast(`Download failed: ${result.error}`, 'error')
      } else if (result.status === 'exists') {
        toast(`Repository already exists in models/ folder`, 'info')
      } else if (result.status === 'started') {
        toast(`✓ Repository is downloading. This may take several minutes. Check console for progress.`, 'success')
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'error')
    } finally {
      setDownloadingRepo(false)
    }
  }

  // Get format badge for a file
  const getFileBadge = (filename) => {
    const ext = filename.split('.').pop().toLowerCase()
    switch (ext) {
      case 'mlx': return { label: 'MLX', color: '#4ade80', recommended: true }
      case 'gguf': return { label: 'GGUF', color: '#3b82f6', recommended: false }
      case 'safetensors': return { label: 'SafeTensor', color: '#D97757', recommended: false }
      case 'bin':
      case 'pt': return { label: 'PyTorch', color: '#f59e0b', recommended: false }
      default: return { label: ext.toUpperCase(), color: '#6b7280', recommended: false }
    }
  }

  return (
    <div style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--r-md)', marginBottom: '16px' }}>
      <div style={{ marginBottom: '16px' }}>
        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
          Paste HuggingFace Model Link:
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            placeholder="https://huggingface.co/mlx-community/TinyLlama-1.1B-Chat-v1.0-mlx"
            value={hfLink}
            onChange={e => setHfLink(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleFetchFiles() }}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              color: 'var(--text)',
              fontSize: '0.85rem'
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={handleFetchFiles}
            disabled={hfLoading}
          >
            {hfLoading ? '⏳' : '🔍'} Search
          </button>
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '6px' }}>
          Supports HuggingFace links and any model format: MLX, GGUF, SafeTensors, etc.
        </div>
      </div>

      {hfFiles && hfFiles.totalFiles > 0 && (
        <div>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>
              Available Files ({hfFiles.totalFiles}):
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '300px', overflow: 'auto' }}>
              {hfFiles.files.map((file, idx) => {
                const badge = getFileBadge(file.name)
                const isSelected = selectedFile?.name === file.name
                const sizeGB = (file.size / 1024 / 1024 / 1024).toFixed(2)
                return (
                  <div
                    key={idx}
                    style={{
                      padding: '10px 12px',
                      background: isSelected ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)',
                      border: isSelected ? '1px solid var(--color-blue)' : '1px solid var(--border)',
                      borderRadius: 'var(--r-sm)',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                    onClick={() => setSelectedFile(file)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '8px' }}>
                      <div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text)', wordBreak: 'break-all' }}>
                          {file.name.split('/').pop()}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                          {sizeGB} GB
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                        {badge.recommended && (
                          <span title="Optimized for this system" style={{ fontSize: '0.75rem', background: 'rgba(74,222,128,0.2)', color: 'var(--green)', padding: '2px 6px', borderRadius: '3px' }}>
                            ⭐ Best
                          </span>
                        )}
                        <span style={{ background: badge.color, color: '#1C1917', fontSize: '0.65rem', padding: '2px 6px', borderRadius: '3px', minWidth: '40px', textAlign: 'center' }}>
                          {badge.label}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {selectedFile && (
            <div style={{ padding: '12px', background: 'rgba(59,130,246,0.1)', borderRadius: 'var(--r-sm)', marginBottom: '12px', borderLeft: '3px solid var(--color-blue)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Selected:</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text)', marginBottom: '8px', wordBreak: 'break-all' }}>
                {selectedFile.name}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                Size: {(selectedFile.size / 1024 / 1024 / 1024).toFixed(2)} GB
              </div>
            </div>
          )}

          {/* Download entire repository button */}
          <div style={{ marginBottom: '12px' }}>
            <button
              className="btn btn-secondary"
              onClick={handleDownloadRepo}
              disabled={downloadingRepo}
              style={{
                width: '100%',
                justifyContent: 'center',
                opacity: downloadingRepo ? 0.6 : 1,
                cursor: downloadingRepo ? 'not-allowed' : 'pointer',
                background: 'rgba(217,119,87,0.2)',
                borderColor: 'rgba(217,119,87,0.5)',
                color: '#D97757'
              }}
            >
              {downloadingRepo ? '⏳ Downloading Repository...' : '📦 Download Entire Repository'}
            </button>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px', textAlign: 'center' }}>
              Downloads all files including config.json, tokenizer.json, and model weights
            </div>
          </div>

          <button
            className="btn btn-primary"
            onClick={handleDownloadFile}
            disabled={downloading || !selectedFile}
            style={{
              width: '100%',
              justifyContent: 'center',
              opacity: (downloading || !selectedFile) ? 0.6 : 1,
              cursor: (downloading || !selectedFile) ? 'not-allowed' : 'pointer'
            }}
          >
            {downloading ? '⏳ Downloading...' : '⬇ Download Selected File'}
          </button>
        </div>
      )}

      {!hfFiles && !hfLoading && (
        <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>🔗</div>
          <div style={{ fontSize: '0.85rem' }}>Paste a HuggingFace model link above to browse available files</div>
        </div>
      )}
    </div>
  )
}
