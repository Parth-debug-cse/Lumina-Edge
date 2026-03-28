import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 1235;

// Create __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root paths
const rootDir = path.resolve(__dirname, '..');
const scriptsDir = path.join(rootDir, 'scripts');
const modelsDir = path.join(rootDir, 'models');
const binDir = path.join(rootDir, 'bin');

console.log('[API Server] Starting Lumina Edge API Gateway');
console.log('[API Server] Root directory:', rootDir);
console.log('[API Server] Models directory:', modelsDir);
console.log('[API Server] Listening on port:', PORT);

// Ensure models directory exists
if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
  console.log('[API Server] Created models directory');
}

// State maps
const conversionJobs = new Map(); // file -> status
const routerModels = new Map(); // id -> model info
let routingPolicy = 'round-robin';
let nextPort = 8000;

// === HEALTH CHECK ===

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/test', (req, res) => {
  console.log('[Test Endpoint] Hit');
  res.json({ test: 'success', message: 'API server is working' });
});

app.get('/api/supported-formats', (req, res) => {
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  res.json({
    formats: isMac ? ['safetensors', 'mlx', 'gguf', 'pt', 'bin'] : ['gguf', 'safetensors', 'bin', 'pt'],
    converter_available: fs.existsSync(path.join(scriptsDir, 'model-converter.py'))
  });
});

app.get('/api/models/list', (req, res) => {
  try {
    const files = fs.readdirSync(modelsDir);
    const models = files
      .filter(f => ['.gguf', '.safetensors', '.bin', '.pt'].includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stats = fs.statSync(path.join(modelsDir, f));
        return {
          name: f,
          size: (stats.size / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          mtime: stats.mtime
        };
      });
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-config', (req, res) => {
  try {
    const configPath = path.join(rootDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2));
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/convert-model', (req, res) => {
  const { input_file, quantization } = req.body;
  if (!input_file) return res.status(400).send('input_file required');
  
  const inputPath = path.join(modelsDir, path.basename(input_file));
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  
  const ext = path.extname(input_file);
  const baseName = path.basename(input_file, ext);
  const outName = isMac ? `${baseName}.mlx` : `${baseName}.gguf`;
  const outPath = path.join(modelsDir, outName);

  if (conversionJobs.has(input_file)) {
    return res.json({ status: 'converting', output: outName });
  }

  conversionJobs.set(input_file, { status: 'converting', progress: 0 });

  const pyScript = path.join(scriptsDir, 'model-converter.py');
  const targetFormat = isMac ? 'mlx' : 'gguf';
  const args = ['convert', inputPath, outPath, '--quantization', quantization || 'Q4_K_M', '--format', targetFormat];
  
  const pythonCmd = os.platform() === 'win32' ? 'python' : 'python3';
  const proc = spawn(pythonCmd, [pyScript, ...args]);
  
  proc.on('close', (code) => {
    if (code === 0) {
      conversionJobs.set(input_file, { status: 'complete', output: outName });
    } else {
      conversionJobs.set(input_file, { status: 'error', error: 'Conversion failed' });
    }
  });

  res.json({ status: 'started', output: outName });
});

app.get('/api/conversion-status', (req, res) => {
  const input = req.query.input;
  if (!input) return res.status(400).send('input required');
  const job = conversionJobs.get(input);
  if (job) return res.json(job);
  res.json({ status: 'unknown' });
});

// === SHARD DETECTION ===

app.post('/api/convert/detect-shards', (req, res) => {
  const { model_path } = req.body;
  const target = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  
  const pythonCmd = os.platform() === 'win32' ? 'python' : 'python3';
  exec(`${pythonCmd} ${path.join(scriptsDir, 'model-converter.py')} shards "${target}"`, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      is_sharded: stdout.includes('Sharded: True'),
      format: stdout.includes('safetensors') ? 'safetensors' : 'pytorch',
      total_shards: parseInt(stdout.match(/Total Shards: (\d+)/)?.[1] || '0'),
      memory_estimate_str: stdout.match(/Memory Estimate: (.+)/)?.[1] || 'Unknown'
    });
  });
});

// === ROUTER BACKEND ===

app.get('/api/router/status', (req, res) => {
  res.json({
    total_models: routerModels.size,
    ready_models: Array.from(routerModels.values()).filter(m => m.status === 'ready').length,
    routing_policy: routingPolicy,
    total_inferences: Array.from(routerModels.values()).reduce((sum, m) => sum + m.inference_count, 0),
    models: Array.from(routerModels.values())
  });
});

app.post('/api/router/policy', (req, res) => {
  const { policy } = req.body;
  if (['round-robin', 'load-balanced', 'first-available'].includes(policy)) {
    routingPolicy = policy;
    res.json({ status: 'success', policy });
  } else {
    res.status(400).json({ error: 'Invalid policy' });
  }
});

app.post('/api/router/load', (req, res) => {
  const { model_path } = req.body;
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, path.basename(model_path));
  
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  const id = Math.random().toString(36).substring(7);
  const port = nextPort++;
  
  const modelInfo = {
    id,
    name: path.basename(targetPath),
    port,
    status: 'loading',
    inference_count: 0
  };
  
  routerModels.set(id, modelInfo);
  
  let proc;
  
  let config = {};
  try {
    const configData = fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8');
    config = JSON.parse(configData);
  } catch (e) { }

  if (isMac) {
    const pythonCmd = os.platform() === 'win32' ? 'python' : 'python3';
    proc = spawn(pythonCmd, [path.join(scriptsDir, 'mlx_backend.py'), '--mode', 'api', '--model', targetPath, '--port', port.toString()]);
  } else {
    let llamaServer = path.join(binDir, 'llama-server');
    if (os.platform() === 'win32') llamaServer += '.exe';
    
    const cmdArgs = [
      '-m', targetPath,
      '--port', port.toString(),
      '--host', '127.0.0.1',
      '--ctx-size', (config.ctx_size || 4096).toString(),
      '--n-gpu-layers', (config.n_gpu_layers || 99).toString(),
      '--flash-attn', 'on',
      '--mlock'
    ];
    
    proc = spawn(llamaServer, cmdArgs);
  }

  modelInfo.process = proc;

  // Poll for readiness
  const checkReady = setInterval(async () => {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (resp.ok) {
        modelInfo.status = 'ready';
        clearInterval(checkReady);
      }
    } catch (e) { }
  }, 1000);

  // Failsafe
  setTimeout(() => clearInterval(checkReady), 30000);

  proc.on('close', () => {
    modelInfo.status = 'error';
  });

  res.json({ status: 'success', id, port });
});

app.delete('/api/router/unload/:id', (req, res) => {
  const modelInfo = routerModels.get(req.params.id);
  if (!modelInfo) return res.status(404).json({ error: 'Not found' });
  
  if (modelInfo.process) {
    modelInfo.process.kill('SIGTERM');
  }
  routerModels.delete(req.params.id);
  res.json({ status: 'success' });
});

// === MODEL DOWNLOAD ===

app.post('/api/download-model', async (req, res) => {
  const { url, filename } = req.body;
  console.log('[Download] Request received:', { url: url?.substring(0, 80), filename });
  
  if (!url || !filename) {
    console.error('[Download] Missing url or filename');
    return res.status(400).json({ error: 'url and filename required' });
  }
  
  const outputPath = path.join(modelsDir, filename);
  
  // Check if already exists
  if (fs.existsSync(outputPath)) {
    console.log('[Download] File already exists:', filename);
    return res.json({ status: 'exists', path: outputPath, filename });
  }
  
  // Make sure directory exists
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  
  res.json({ status: 'started', filename });
  
  // Download in background
  downloadInBackground(url, outputPath, filename);
});

async function downloadInBackground(url, outputPath, filename) {
  try {
    console.log(`[Download] Starting: ${filename}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const fileStream = fs.createWriteStream(outputPath);
    await new Promise((resolve, reject) => {
      response.body.pipe(fileStream);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
    
    const stats = fs.statSync(outputPath);
    console.log(`[Download] ✓ Complete: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.error(`[Download] ✗ Failed: ${filename}`, err.message);
    fs.unlink(outputPath, () => {});
  }
}

// ===== SERVER STARTUP =====
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[API Server] ✓ Listening on http://127.0.0.1:${PORT}`);
  console.log(`[API Server] Ready to accept connections`);
});

// Handle startup errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[API Server] ✗ Port ${PORT} is already in use`);
    console.error(`[API Server] Make sure no other Lumina Edge instance is running`);
  } else {
    console.error(`[API Server] ✗ Server error:`, err.message);
  }
  process.exit(1);
});

// Proxy /v1 requests to the first ready model
app.all(/^\/v1\/.*/, async (req, res) => {
  const readyModel = Array.from(routerModels.values()).find(m => m.status === 'ready');
  if (!readyModel) {
    return res.status(502).json({ error: 'No models currently loaded. Port 8000 is inactive.' });
  }

  const targetUrl = `http://127.0.0.1:${readyModel.port}${req.originalUrl}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length']; // Let fetch recalculate this

  try {
    console.log(`[API Proxy] Fetching: ${targetUrl}`);
    const fetchOptions = {
      method: req.method,
      headers: headers,
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);

    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      res.setHeader(key, value);
    }

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    console.error(`[API Proxy] Error: ${err.message}`);
    res.status(500).json({ error: 'Proxy failed', message: err.message });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[API Server] Shutting down...');
  server.close(() => {
    console.log('[API Server] Closed');
    process.exit(0);
  });
});
