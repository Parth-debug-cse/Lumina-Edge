import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 1235;

// Root paths
const rootDir = path.resolve(__dirname, '..');
const scriptsDir = path.join(rootDir, 'scripts');
const modelsDir = path.join(rootDir, 'models');
const binDir = path.join(rootDir, 'bin');

// State maps
const conversionJobs = new Map(); // file -> status
const routerModels = new Map(); // id -> model info
let routingPolicy = 'round-robin';
let nextPort = 8000;

// === CONVERSION API ===

app.get('/api/supported-formats', (req, res) => {
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  res.json({
    formats: isMac ? ['safetensors', 'mlx', 'gguf', 'pt', 'bin'] : ['gguf', 'safetensors', 'bin', 'pt'],
    converter_available: fs.existsSync(path.join(scriptsDir, 'model-converter.py'))
  });
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
      '--flash-attn',
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Lumina Edge Internal API Gateway listening on port ${PORT}`);
});
