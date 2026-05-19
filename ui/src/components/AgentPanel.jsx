import { useState, useEffect, useRef } from 'react';
import { Play, Square, Terminal, CheckCircle, AlertCircle, Loader } from 'lucide-react';

export default function LuminaAgentPanel({ toast }) {
  const [goal, setGoal] = useState('');
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(null);
  const [steps, setSteps] = useState([]);
  const [finalReport, setFinalReport] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const stepsEndRef = useRef(null);

  // Auto-scroll steps log to bottom
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps]);

  // Cleanup poll on unmount
  useEffect(() => () => clearInterval(pollRef.current), []);

  const pollStatus = async (id) => {
    try {
      const res = await fetch(`/api/lumina-agent/status/${id}`);
      if (!res.ok) {
        // FIXED: handle non-OK response instead of silently failing
        const errData = await res.json().catch(() => ({}));
        setError(`Status check failed: ${errData.error || `HTTP ${res.status}`}`);
        clearInterval(pollRef.current);
        setRunning(false);
        return;
      }
      const data = await res.json();
      setSteps(data.steps || []);
      if (data.status === 'done' || data.status === 'error' || data.status === 'stopped') {
        clearInterval(pollRef.current);
        setRunning(false);
        setFinalReport(data.finalReport);
        if (data.error) setError(data.error);
        if (data.status === 'done' && toast) toast('Agent task complete', 'success');
      }
    } catch (e) {
      // network hiccup — keep polling but log
      console.warn('[AgentPanel] Poll network error:', e.message);
    }
  };

  const handleRun = async () => {
    if (!goal.trim() || running) return;
    setRunning(true);
    setSteps([]);
    setFinalReport(null);
    setError(null);
    setRunId(null);

    try {
      const res = await fetch('/api/lumina-agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: goal.trim() }),
      });
      // FIXED: check response.ok before parsing to avoid crash on error responses
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server error ${res.status}`);
      }
      const { runId: id } = await res.json();
      setRunId(id);
      pollRef.current = setInterval(() => pollStatus(id), 1500);
    } catch (e) {
      setError(`Failed to start agent: ${e.message}`);
      setRunning(false);
    }
  };

  const handleStop = async () => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/lumina-agent/stop/${runId}`, { method: 'POST' });
      // FIXED: check response and handle errors
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setError(`Failed to stop agent: ${errData.error || `HTTP ${res.status}`}`);
      } else if (toast) {
        toast('Agent stopped', 'info');
      }
    } catch (e) {
      setError(`Failed to stop agent: ${e.message}`);
    }
    clearInterval(pollRef.current);
    setRunning(false);
  };

  const exampleGoals = [
    "Check disk space and find the 3 largest directories in home",
    "Find all running processes using more than 100MB of RAM",
    "Check if port 8090 is open and what process is using it",
  ];

  return (
    <div style={{ padding: '0 8px 24px', overflow: 'auto', flex: 1 }}>

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <Terminal size={24} />
          <div>
            <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Lumina Agent</h2>
            <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', opacity: 0.7 }}>
              Autonomous local IT ops agent — no cloud, no data leaves this machine
            </p>
          </div>
        </div>
      </div>

      {/* Goal input card */}
      <div style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 20,
        marginBottom: 16,
      }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: 8, fontSize: '0.9rem' }}>
          Task Goal
        </label>
        <textarea
          style={{
            width: '100%',
            minHeight: 80,
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--surface-2)',
            color: 'var(--text-primary)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.85rem',
            resize: 'vertical',
            opacity: running ? 0.6 : 1,
            cursor: running ? 'not-allowed' : 'text',
          }}
          rows={3}
          placeholder="Describe what you want the agent to do in plain English..."
          value={goal}
          onChange={e => setGoal(e.target.value)}
          disabled={running}
        />

        {/* Example goals */}
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {exampleGoals.map((eg, i) => (
            <button
              key={i}
              onClick={() => setGoal(eg)}
              disabled={running}
              style={{
                fontSize: '11px',
                padding: '4px 8px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text-secondary)',
                cursor: running ? 'not-allowed' : 'pointer',
                opacity: running ? 0.5 : 1,
              }}
            >
              {eg}
            </button>
          ))}
        </div>

        {/* Run / Stop buttons */}
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            onClick={handleRun}
            disabled={running || !goal.trim()}
            style={{
              padding: '8px 16px',
              background: running || !goal.trim() ? 'var(--surface-2)' : 'var(--accent)',
              color: 'var(--text-primary)',
              border: 'none',
              borderRadius: 6,
              cursor: running || !goal.trim() ? 'not-allowed' : 'pointer',
              fontWeight: 500,
              fontSize: '0.9rem',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {running ? (
              <>
                <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                Running...
              </>
            ) : (
              <>
                <Play size={14} />
                Run Agent
              </>
            )}
          </button>
          {running && (
            <button
              onClick={handleStop}
              style={{
                padding: '8px 16px',
                background: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: '0.9rem',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Square size={14} />
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Live steps log */}
      {steps.length > 0 && (
        <div style={{
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Agent Log</span>
            <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
              {running ? `Step ${steps.length} — running...` : `${steps.length} steps`}
            </span>
          </div>

          <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {steps.map((step, i) => (
              <div key={i} style={{
                background: 'var(--surface-2)',
                borderRadius: 8,
                padding: 12,
                borderLeft: `3px solid ${step.tool === 'report' ? 'var(--accent)' : 'var(--border)'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent)' }}>
                    Step {step.iteration} — {step.tool}
                  </span>
                </div>
                {step.thought && (
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: 6, fontStyle: 'italic' }}>
                    💭 {step.thought}
                  </div>
                )}
                {step.tool !== 'report' && (
                  <div style={{ fontSize: '0.75rem', fontFamily: 'monospace', opacity: 0.6, marginBottom: 6 }}>
                    $ {JSON.stringify(step.args)}
                  </div>
                )}
                <div style={{
                  fontSize: '0.75rem',
                  fontFamily: 'monospace',
                  background: 'var(--surface)',
                  borderRadius: 4,
                  padding: 8,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  maxHeight: 120,
                  overflowY: 'auto',
                }}>
                  {String(step.result).slice(0, 300)}{String(step.result).length > 300 ? '...' : ''}
                </div>
              </div>
            ))}
            <div ref={stepsEndRef} />
          </div>
        </div>
      )}

      {/* Final report */}
      {finalReport && (
        <div style={{
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderLeft: '3px solid var(--accent)',
          borderRadius: 12,
          padding: 20,
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <CheckCircle size={18} color='var(--accent)' />
            <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Task Complete</span>
          </div>
          <div style={{ fontSize: '0.9rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
            {finalReport}
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div style={{
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderLeft: '3px solid #ef4444',
          borderRadius: 12,
          padding: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <AlertCircle size={18} color='#ef4444' />
            <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Error</span>
          </div>
          <div style={{ fontSize: '0.8rem', fontFamily: 'monospace', opacity: 0.8 }}>{error}</div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
