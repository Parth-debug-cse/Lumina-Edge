import { useState, useEffect, useRef } from 'react'
import { getConvertibleModels, convertModel, getConversionStatus, saveConfig, quantizeModel, getQuantizationStatus } from '../utils/api.js'
import ProgressBar from './ProgressBar.jsx'

export default function ConverterTab({ systemInfo, apiLoadModel, toast, autoConvertOnDownload, setAutoConvertOnDownload }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  const [status, setStatus] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [outputFile, setOutputFile] = useState('')
  const [converting, setConverting] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [selectedBits, setSelectedBits] = useState(4)
  const intervalRef = useRef(null)

  const isMac = systemInfo?.isMacAppleSilicon
  // Mac: Quantize safetensors to different bit levels using mlx-lm
  // Linux/Windows: Convert to GGUF format for llama.cpp
  const targetLabel = isMac ? 'Quantized' : 'GGUF'
  const targetFormat = isMac ? 'safetensors' : 'gguf'

  useEffect(() => {
    refreshFileList()
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  const refreshFileList = async () => {
    setLoading(true)
    try {
      const result = await getConvertibleModels()
      setFiles(result.files || [])
    } catch (err) {
      toast(`Failed to load convertible files: ${err.message || err}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const startPolling = (filename, isQuantize = false) => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }

    intervalRef.current = setInterval(async () => {
      const statusResult = isQuantize 
        ? await getQuantizationStatus(filename, selectedBits)
        : await getConversionStatus(filename)
      if (!statusResult) return
      setStatus(statusResult.status || 'unknown')
      setProgress(statusResult.progress || 0)
      setOutputFile(statusResult.output || '')

      if (statusResult.status === 'complete' || statusResult.status === 'quantizing') {
        if (statusResult.progress === 100) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
          setConverting(false)
          if (statusResult.status === 'complete' || (statusResult.status === 'quantizing' && statusResult.progress === 100)) {
            toast(`${isQuantize ? 'Quantization' : 'Conversion'} complete: ${statusResult.output}`, 'success')
            refreshFileList()
          } else {
            toast(`${isQuantize ? 'Quantization' : 'Conversion'} failed`, 'error')
          }
        }
      } else if (statusResult.status === 'error') {
        clearInterval(intervalRef.current)
        intervalRef.current = null
        setConverting(false)
        toast(`${isQuantize ? 'Quantization' : 'Conversion'} failed`, 'error')
      }
    }, 1000)
  }

  const handleConvert = async () => {
    if (!selectedFile) {
      toast('Select a downloaded model file first', 'info')
      return
    }
    
    // Mac quantization
    if (isMac) {
      if (!selectedFile.name.endsWith('.safetensors')) {
        toast('Only .safetensors files can be quantized on Mac', 'error')
        return
      }
      setConverting(true)
      setStatus('starting')
      setProgress(0)
      setOutputFile('')
      
      try {
        const result = await quantizeModel(selectedFile.name, selectedBits)
        if (result.error) {
          toast(`Quantization error: ${result.error}`, 'error')
          setConverting(false)
          setStatus('error')
          return
        }
        setStatus('quantizing')
        setOutputFile(result.output || '')
        startPolling(selectedFile.name, true)
      } catch (err) {
        toast(`Quantization failed: ${err.message}`, 'error')
        setConverting(false)
        setStatus('error')
      }
      return
    }
    
    // Linux/Windows GGUF conversion
    setConverting(true)
    setStatus('starting')
    setProgress(0)
    setOutputFile('')

    try {
      const result = await convertModel(selectedFile.name, 'Q4_K_M', targetFormat)
      if (result.error) {
        toast(`Conversion error: ${result.error}`, 'error')
        setConverting(false)
        setStatus('error')
        return
      }
      setStatus(result.status || 'converting')
      setOutputFile(result.output || '')
      startPolling(selectedFile.name)
    } catch (err) {
      toast(`Conversion failed: ${err.message}`, 'error')
      setConverting(false)
      setStatus('error')
    }
  }

  const handleLoad = async () => {
    if (!outputFile) {
      toast('No converted model output available yet', 'info')
      return
    }
    try {
      toast(`Loading ${outputFile}...`, 'info')
      const result = await apiLoadModel(outputFile)
      if (result.status === 'success') {
        toast(`✓ Model loaded successfully on port ${result.port}!`, 'success')
      } else {
        toast(`Failed to load model: ${result.error}`, 'error')
      }
    } catch (err) {
      toast(`Error loading model: ${err.message}`, 'error')
    }
  }

  const handleAutoConvertToggle = async () => {
    const newValue = !autoConvertOnDownload
    setAutoConvertOnDownload(newValue)
    setSavingConfig(true)
    const result = await saveConfig({ autoConvertOnDownload: newValue })
    setSavingConfig(false)
    if (result.error) {
      toast(`Failed to save setting: ${result.error}`, 'error')
    } else {
      toast(`Auto-convert on download ${newValue ? 'enabled' : 'disabled'}`, 'success')
    }
  }

  return (
    <div className="model-grid" style={{ gridTemplateColumns: '1fr', gap: '16px' }}>
      <div className="model-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div className="model-name" style={{ marginBottom: 4 }}>Converter</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {isMac 
                ? 'Quantize safetensors to lower bit precision (recommended: 4 or 8 bit)'
                : `Convert downloaded models to ${targetLabel} format.`}
            </div>
          </div>
          <button
            className={`btn btn-sm ${autoConvertOnDownload ? 'btn-primary' : 'btn-ghost'}`}
            onClick={handleAutoConvertToggle}
            disabled={savingConfig}
          >
            {savingConfig ? 'Saving...' : autoConvertOnDownload ? 'Auto' : 'Manual'}
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>Downloaded convertible models</div>
          <button className="btn btn-secondary btn-sm" onClick={refreshFileList} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh list'}
          </button>
        </div>

        {loading ? (
          <div style={{ color: 'var(--text-muted)' }}>Loading files…</div>
        ) : files.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No convertible models found in models/.</div>
        ) : (
          <div style={{ display: 'grid', gap: '10px' }}>
            {files.map((file) => (
              <button
                key={file.name}
                className={`btn btn-ghost btn-sm ${selectedFile?.name === file.name ? 'btn-primary' : ''}`}
                style={{ justifyContent: 'space-between', width: '100%' }}
                onClick={() => setSelectedFile(file)}
              >
                <span style={{ textAlign: 'left' }}>{file.name}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{file.size}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="model-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div className="model-name" style={{ marginBottom: 4 }}>Converter panel</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Select a file and press Convert to begin manual conversion.
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '0.8rem', marginBottom: 4 }}>Selected file</div>
          <div style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: 'var(--r-sm)' }}>
            {selectedFile ? selectedFile.name : 'No file selected'}
          </div>
        </div>

        {isMac && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '0.8rem', marginBottom: 8 }}>
              Quantization bits {selectedBits === 4 && <span style={{ color: 'var(--color-green)' }}>(recommended)</span>}
              {selectedBits === 8 && <span style={{ color: 'var(--accent)' }}>(recommended for quality)</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[2, 3, 4, 6, 8].map((bits) => (
                <button
                  key={bits}
                  className={`btn btn-sm ${selectedBits === bits ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setSelectedBits(bits)}
                  disabled={converting}
                >
                  {bits}-bit
                </button>
              ))}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>
              Lower bits = smaller file, faster inference. Higher bits = better quality.
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            className="btn btn-primary"
            onClick={handleConvert}
            disabled={converting || !selectedFile}
          >
            {converting ? (isMac ? 'Quantizing…' : 'Converting…') : (isMac ? 'Quantize' : 'Convert')}
          </button>
          <button
            className="btn btn-secondary"
            onClick={refreshFileList}
            disabled={loading}
          >
            Refresh files
          </button>
        </div>

        <ProgressBar percent={progress} status={
          status === 'converting' ? 'Converting...' 
          : status === 'quantizing' ? 'Quantizing...'
          : status === 'complete' ? (isMac ? 'Quantization complete' : 'Conversion complete')
          : status === 'error' ? 'Error' 
          : 'Idle'
        } />

        {(status === 'complete' || (status === 'quantizing' && progress === 100)) && outputFile && (
          <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Output</div>
            <div style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: 'var(--r-sm)' }}>{outputFile}</div>
            <button className="btn btn-primary" onClick={handleLoad}>Load Model</button>
          </div>
        )}
      </div>
    </div>
  )
}
