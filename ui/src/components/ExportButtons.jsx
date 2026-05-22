import { exportAsJSON, exportAsMarkdown } from '../utils/storage.js'

/**
 * ExportButtons - Reusable export UI component
 * Provides JSON and Markdown export for sessions/benchmarks
 * 
 * Props:
 *  - data: Object or Array to export
 *  - label: Export label prefix (e.g., "Session", "Benchmark")
 *  - toast: Toast callback for notifications
 *  - onSuccess: Optional callback after export
 */
export default function ExportButtons({ data, label = 'Data', toast, onSuccess }) {
  // Supports single objects and arrays — iterates and exports each item
  const handleExportJSON = () => {
    try {
      if (Array.isArray(data)) {
        data.forEach(item => exportAsJSON(item))
        const msg = `Exported ${data.length} ${label}${data.length !== 1 ? 's' : ''} as JSON`
        toast(msg, 'success')
      } else {
        exportAsJSON(data)
        toast(`Exported ${label} as JSON`, 'success')
      }
      onSuccess?.()
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'error')
    }
  }

  // Same structure as handleExportJSON but produces Markdown files instead
  const handleExportMarkdown = () => {
    try {
      if (Array.isArray(data)) {
        data.forEach(item => exportAsMarkdown(item))
        const msg = `Exported ${data.length} ${label}${data.length !== 1 ? 's' : ''} as Markdown`
        toast(msg, 'success')
      } else {
        exportAsMarkdown(data)
        toast(`Exported ${label} as Markdown`, 'success')
      }
      onSuccess?.()
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'error')
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={handleExportJSON}
        title={`Export ${label} as JSON`}
      >
        Export JSON
      </button>
      <button
        className="btn btn-ghost btn-sm"
        onClick={handleExportMarkdown}
        title={`Export ${label} as Markdown`}
      >
        Export MD
      </button>
    </div>
  )
}
