export default function ProgressBar({ percent = 0, status = '' }) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0))
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
        <span>Progress</span>
        <span>{value}%</span>
      </div>
      <div style={{ width: '100%', height: 12, background: 'rgba(255,255,255,0.1)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s ease' }} />
      </div>
      {status && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{status}</div>}
    </div>
  )
}
