import { useState } from 'react'
import { Copy, Play } from 'lucide-react'

// Language tabs for the quick-start code snippet display
const LANGUAGES = ['Python', 'JavaScript', 'cURL', 'PowerShell']

// Each function returns a code snippet string for its language
function py() {
  return 'from openai import OpenAI\n\n' +
    'client = OpenAI(\n' +
    '    base_url="http://localhost:8090/v1",\n' +
    '    api_key="not-needed"\n' +
    ')\n\n' +
    'response = client.chat.completions.create(\n' +
    '    model="mistral-7b-instruct-v0.2.Q4_K_M.gguf",\n' +
    '    messages=[\n' +
    '        {"role": "user", "content": "Hello!"}\n' +
    '    ],\n' +
    '    temperature=0.7,\n' +
    '    max_tokens=2048\n' +
    ')\n\n' +
    'print(response.choices[0].message.content)'
}

function js() {
  return 'import OpenAI from \'openai\';\n\n' +
    'const client = new OpenAI({\n' +
    '  baseURL: \'http://localhost:8090/v1\',\n' +
    '  apiKey: \'not-needed\',\n' +
    '});\n\n' +
    'const response = await client.chat.completions.create({\n' +
    '  model: \'mistral-7b-instruct-v0.2.Q4_K_M.gguf\',\n' +
    '  messages: [\n' +
    '    { role: \'user\', content: \'Hello!\' }\n' +
    '  ],\n' +
    '  temperature: 0.7,\n' +
    '  max_tokens: 2048,\n' +
    '});\n\n' +
    'console.log(response.choices[0].message.content);'
}

function curl() {
  return 'curl http://localhost:8090/v1/chat/completions \\\n' +
    '  -H "Content-Type: application/json" \\\n' +
    '  -d \'{\n' +
    '    "model": "mistral-7b-instruct-v0.2.Q4_K_M.gguf",\n' +
    '    "messages": [\n' +
    '      {"role": "user", "content": "Hello!"}\n' +
    '    ],\n' +
    '    "temperature": 0.7,\n' +
    '    "max_tokens": 2048\n' +
    '  }\''
}

function ps() {
  return '$body = @{\n' +
    '  model = "mistral-7b-instruct-v0.2.Q4_K_M.gguf"\n' +
    '  messages = @(\n' +
    '    @{ role = "user"; content = "Hello!" }\n' +
    '  )\n' +
    '  temperature = 0.7\n' +
    '  max_tokens = 2048\n' +
    '} | ConvertTo-Json\n\n' +
    'Invoke-RestMethod -Uri "http://localhost:8090/v1/chat/completions" `\n' +
    '  -Method Post `\n' +
    '  -Body $body `\n' +
    '  -ContentType "application/json"'
}

const SNIPPETS = {
  Python: py(),
  JavaScript: js(),
  cURL: curl(),
  PowerShell: ps(),
}

export default function ApiDocs({ toast }) {
  const [lang, setLang] = useState('Python')
  const [copied, setCopied] = useState(false)  // 2s reset timer for copy feedback

  // Copy current language's snippet to clipboard via browser API
  const handleCopy = () => {
    navigator.clipboard.writeText(SNIPPETS[lang])
    setCopied(true)
    toast?.('Copied to clipboard', 'success')
    setTimeout(() => setCopied(false), 2000)
  }

  // Placeholder — could fire a real health-check request
  const handleTest = () => {
    toast?.('Testing API connection...', 'info')
  }

  return (
    <div className="api-docs">
      <div className="api-status">
        <span className="api-dot" />
        Server Running &nbsp;&nbsp; http://localhost:8090/v1
      </div>

      <div>
        <div className="api-section-title">&gt; Quick Start</div>
        <div style={{ marginTop: 8 }}>
          <div className="api-lang-tabs">
            {LANGUAGES.map(l => (
              <button
                key={l}
                className={`api-lang-tab ${lang === l ? 'active' : ''}`}
                onClick={() => setLang(l)}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="code-block" style={{ marginTop: 6 }}>
            <div className="code-block-header">
              <span className="code-block-lang">{lang}</span>
              <button className="code-block-copy" onClick={handleCopy}>
                {copied ? '> Copied' : '> Copy'}
              </button>
            </div>
            <pre>
              <code>{SNIPPETS[lang]}</code>
            </pre>
          </div>
        </div>
      </div>

      <div>
        <div className="api-section-title">&gt; Endpoints Reference</div>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="api-endpoint">
            <span className="api-method post">POST</span>
            <span className="api-path">/v1/chat/completions</span>
            <span className="api-desc">OpenAI-compatible chat completions</span>
          </div>
          <div className="api-endpoint">
            <span className="api-method get">GET</span>
            <span className="api-path">/api/health</span>
            <span className="api-desc">Server health check</span>
          </div>
          <div className="api-endpoint">
            <span className="api-method get">GET</span>
            <span className="api-path">/api/models/list</span>
            <span className="api-desc">List available models</span>
          </div>
          <div className="api-endpoint">
            <span className="api-method post">POST</span>
            <span className="api-path">/api/models/load</span>
            <span className="api-desc">Load a model into memory</span>
          </div>
          <div className="api-endpoint">
            <span className="api-method post">POST</span>
            <span className="api-path">/api/models/unload</span>
            <span className="api-desc">Unload a model from memory</span>
          </div>
          <div className="api-endpoint">
            <span className="api-method get">GET</span>
            <span className="api-path">/api/router/status</span>
            <span className="api-desc">Multi-model router status</span>
          </div>
          <div className="api-endpoint">
            <span className="api-method get">GET</span>
            <span className="api-path">/api/system/resources</span>
            <span className="api-desc">Live system resource usage</span>
          </div>
        </div>
      </div>

      <div>
        <div className="api-section-title">&gt; Test Connection</div>
        <div style={{ marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={handleTest}>
            <Play size={12} /> Test API
          </button>
          <span style={{ marginLeft: 10, fontSize: '0.68rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            Sends a health check to the server
          </span>
        </div>
      </div>
    </div>
  )
}
