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

// Get Python executable - prefer venv if it exists
function getPythonCmd() {
  const venvPython = path.join(rootDir, 'venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return os.platform() === 'win32' ? 'python' : 'python3';
}

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

const configPath = path.join(rootDir, 'config.json');
const convertibleExtensions = ['.gguf', '.safetensors', '.bin', '.pt'];

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch (err) {
    console.error('[Config] Failed to load config:', err.message)
  }
  return {}
}

function saveConfigData(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('[Config] Failed to save config:', err.message);
    return false;
  }
}

function isConvertibleFile(filename) {
  return convertibleExtensions.includes(path.extname(filename).toLowerCase());
}

function getTargetFormat() {
  return os.platform() === 'darwin' && os.arch() === 'arm64' ? 'mlx' : 'gguf';
}

function createConversionJob(input_file, quantization = 'Q4_K_M', targetFormat = null) {
  const outputExt = targetFormat || getTargetFormat();
  const inputPath = path.join(modelsDir, path.basename(input_file));
  const ext = path.extname(input_file).toLowerCase();
  const baseName = path.basename(input_file, ext);
  const outName = `${baseName}.${outputExt}`;
  const outPath = path.join(modelsDir, outName);

  if (conversionJobs.has(input_file)) {
    return { status: 'converting', output: outName };
  }

  conversionJobs.set(input_file, { status: 'converting', progress: 0, output: outName });

  const pyScript = path.join(scriptsDir, 'model-converter.py');
  const args = ['convert', inputPath, outPath, '--quantization', quantization || 'Q4_K_M', '--format', outputExt, '--report-progress'];
  const pythonCmd = getPythonCmd();
  const proc = spawn(pythonCmd, [pyScript, ...args]);

  let fullOutput = '';
  proc.stdout.on('data', (data) => {
    fullOutput += data.toString();
    const matches = fullOutput.match(/PROGRESS:\s*(\d+)%/g);
    if (matches) {
      const lastMatch = matches[matches.length - 1].match(/(\d+)%/);
      const progress = lastMatch ? parseInt(lastMatch[1]) : null;
      if (progress !== null) {
        const job = conversionJobs.get(input_file);
        if (job) {
          job.progress = Math.min(progress, 99);
          job.status = 'converting';
        }
      }
    }
  });

  proc.stderr.on('data', (data) => {
    console.log('[Converter] stderr:', data.toString());
  });

  proc.on('close', (code) => {
    if (code === 0) {
      conversionJobs.set(input_file, { status: 'complete', progress: 100, output: outName });
      console.log(`[Converter] ✓ Complete: ${outName}`);
    } else {
      conversionJobs.set(input_file, { status: 'error', progress: 0, error: 'Conversion failed' });
      console.log(`[Converter] ✗ Error: ${input_file}`);
    }
  });

  return { status: 'started', output: outName };
}

// === HEALTH CHECK ===

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/supported-formats', (req, res) => {
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  res.json({
    formats: isMac ? ['safetensors', 'mlx', 'gguf', 'pt', 'bin'] : ['gguf', 'safetensors', 'bin', 'pt'],
    converter_available: fs.existsSync(path.join(scriptsDir, 'model-converter.py'))
  });
});

// === SYSTEM INFO ===

app.get('/api/system-info', (req, res) => {
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    isMacAppleSilicon: isMac
  });
});

// === HUGGINGFACE REPO BROWSING ===

app.get('/api/hf-files', async (req, res) => {
  try {
    const { repo } = req.query;
    if (!repo) return res.status(400).json({ error: 'repo parameter required (format: user/repo-name)' });

    // Format: extract user/repo from full URL or accept direct "user/repo"
    let repoId = repo;
    if (repo.includes('huggingface.co')) {
      const match = repo.match(/huggingface\.co\/([^/\s]+\/[^/?#\s]+)/);
      if (!match) return res.status(400).json({ error: 'Invalid HuggingFace URL format' });
      repoId = match[1];
    }

    console.log(`[HF API] Fetching files for repo: ${repoId}`);

    // Fetch repo tree from HF API (returns all files)
    const apiUrl = `https://huggingface.co/api/models/${repoId}/tree/main`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Lumina-Edge' }
    });

    if (!response.ok) {
      console.error(`[HF API] Failed to fetch: ${response.status}`);
      return res.status(response.status).json({ 
        error: response.status === 404 ? 'Model not found on HuggingFace' : `HuggingFace API error: ${response.status}`
      });
    }

    const files = await response.json();
    
    // Filter for relevant model files (include JSON files for MLX compatibility)
    const modelFiles = files.filter(f => {
      const name = f.name || f.path.split('/').pop();
      // Include model weights files AND essential JSON config files
      return /\.(mlx|gguf|safetensors|bin|pt|json)$/i.test(name) && 
             (name.endsWith('.json') ? 
              ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'generation_config.json'].includes(name) : 
              true);
    }).map(f => ({
      name: f.path || f.name,
      size: f.size || 0,
      type: f.type // 'file' or 'directory'
    }));

    res.json({
      repo: repoId,
      totalFiles: modelFiles.length,
      files: modelFiles
    });
  } catch (err) {
    console.error('[HF API] Error:', err.message);
    res.status(500).json({ error: `Failed to fetch HuggingFace files: ${err.message}` });
  }
});

app.get('/api/models/list', (req, res) => {
  try {
    const files = fs.readdirSync(modelsDir);
    const models = [];
    
    for (const f of files) {
      const fullPath = path.join(modelsDir, f);
      const stats = fs.statSync(fullPath);
      
      if (stats.isDirectory()) {
        // Check if it's an MLX model directory (has config.json and weights)
        const hasConfig = fs.existsSync(path.join(fullPath, 'config.json'));
        const hasWeights = fs.existsSync(path.join(fullPath, 'model.safetensors')) || 
                          fs.existsSync(path.join(fullPath, 'weights.npz'));
        
        if (hasConfig && hasWeights) {
          // Calculate directory size
          let dirSize = 0;
          const calcSize = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const itemPath = path.join(dir, item);
              const itemStats = fs.statSync(itemPath);
              if (itemStats.isDirectory()) {
                calcSize(itemPath);
              } else {
                dirSize += itemStats.size;
              }
            }
          };
          calcSize(fullPath);
          
          models.push({
            name: f,
            size: (dirSize / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            mtime: stats.mtime,
            isDirectory: true
          });
        }
      } else {
        // Individual files
        if (['.gguf', '.safetensors', '.bin', '.pt'].includes(path.extname(f).toLowerCase())) {
          models.push({
            name: f,
            size: (stats.size / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            mtime: stats.mtime,
            isDirectory: false
          });
        }
      }
    }
    
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

app.post('/api/save-config', (req, res) => {
  try {
    const currentConfig = loadConfig();
    const newConfig = { ...currentConfig, ...req.body };
    if (!saveConfigData(newConfig)) {
      return res.status(500).json({ error: 'Failed to save config' });
    }
    res.json({ status: 'success', config: newConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/model-exists', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path parameter required' });
    
    const targetPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
    const exists = fs.existsSync(targetPath);
    res.json({ exists, path: targetPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/models/convertible', (req, res) => {
  try {
    const files = fs.readdirSync(modelsDir);
    const convertible = files
      .filter(f => convertibleExtensions.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stats = fs.statSync(path.join(modelsDir, f));
        return {
          name: f,
          size: (stats.size / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          mtime: stats.mtime
        };
      });
    res.json({ files: convertible });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/convert-model', (req, res) => {
  const { input_file, quantization, format } = req.body;
  if (!input_file) return res.status(400).send('input_file required');

  const result = createConversionJob(input_file, quantization || 'Q4_K_M', format);
  res.json(result);
});

// Quantization endpoint (macOS only - uses mlx-lm)
app.post('/api/quantize-model', (req, res) => {
  const { input_file, bits, output_name } = req.body;
  if (!input_file) return res.status(400).json({ error: 'input_file required' });
  if (!bits || ![2, 3, 4, 6, 8].includes(bits)) {
    return res.status(400).json({ error: 'bits must be 2, 3, 4, 6, or 8' });
  }

  const inputPath = path.join(modelsDir, path.basename(input_file));
  const ext = path.extname(input_file);
  const baseName = path.basename(input_file, ext);
  const outName = output_name || `${baseName}-q${bits}${ext}`;
  const outputPath = path.join(modelsDir, outName);

  // Check if already quantizing
  const jobKey = `quantize_${input_file}_${bits}`;
  if (conversionJobs.has(jobKey)) {
    return res.json({ status: 'quantizing', output: outName });
  }

  conversionJobs.set(jobKey, { status: 'quantizing', progress: 0, output: outName });

  const pyScript = path.join(scriptsDir, 'model-converter.py');
  const args = ['quantize', inputPath, outputPath, '--bits', bits.toString(), '--report-progress'];
  const pythonCmd = getPythonCmd();
  const proc = spawn(pythonCmd, [pyScript, ...args]);

  let fullOutput = '';
  proc.stdout.on('data', (data) => {
    fullOutput += data.toString();
    const matches = fullOutput.match(/PROGRESS:\s*(\d+)%/g);
    if (matches) {
      const lastMatch = matches[matches.length - 1].match(/(\d+)%/);
      const progress = lastMatch ? parseInt(lastMatch[1]) : null;
      if (progress !== null) {
        conversionJobs.set(jobKey, { status: 'quantizing', progress, output: outName });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    console.log(`[Quantizer] stderr: ${data.toString().trim()}`);
  });

  proc.on('close', (code) => {
    if (code === 0) {
      conversionJobs.set(jobKey, { status: 'complete', progress: 100, output: outName });
      console.log(`[Quantizer] ✓ Success: ${outName}`);
    } else {
      conversionJobs.set(jobKey, { status: 'error', error: `Exit code ${code}`, output: outName });
      console.error(`[Quantizer] ✗ Failed: ${input_file} (code ${code})`);
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

app.post('/api/convert/memory-estimate', (req, res) => {
  try {
    const { model_path } = req.body;
    if (!model_path) return res.status(400).json({ error: 'model_path required' });
    
    const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });
    
    const pythonCmd = getPythonCmd();
    const { execFile } = require('child_process');
    execFile(pythonCmd, [path.join(scriptsDir, 'model-converter.py'), 'shards', targetPath], (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message });
      const memMatch = stdout.match(/Memory Estimate:\s*(.+)/);
      const shardsMatch = stdout.match(/Total Shards:\s*(\d+)/);
      res.json({
        memory_estimate: memMatch ? memMatch[1] : 'Unknown',
        total_shards: shardsMatch ? parseInt(shardsMatch[1]) : 0
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/convert/sharded', (req, res) => {
  const { model_path, output_path, quantization } = req.body;
  if (!model_path || !output_path) {
    return res.status(400).json({ error: 'model_path and output_path required' });
  }
  
  const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  const finalOutputPath = path.isAbsolute(output_path) ? output_path : path.join(modelsDir, output_path);
  
  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'Model not found' });
  }
  
  const jobKey = `sharded-${path.basename(targetPath)}`;
  if (conversionJobs.has(jobKey)) {
    return res.json({ status: 'converting', output: path.basename(finalOutputPath) });
  }
  
  const result = createConversionJob(targetPath, quantization);
  res.json(result);
});

// === SHARD DETECTION ===

app.post('/api/convert/detect-shards', (req, res) => {
  const { model_path } = req.body;
  const target = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  
  const pythonCmd = getPythonCmd();
  const { execFile } = require('child_process');
  execFile(pythonCmd, [path.join(scriptsDir, 'model-converter.py'), 'shards', target], (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      is_sharded: stdout.includes('Sharded: True'),
      format: stdout.includes('safetensors') ? 'safetensors' : 'pytorch',
      total_shards: parseInt(stdout.match(/Total Shards: (\d+)/)?.[1] || '0'),
      memory_estimate_str: stdout.match(/Memory Estimate: (.+)/)?.[1] || 'Unknown'
    });
  });
});

// === SYSTEM OPTIMIZATION ===

app.post('/api/system/optimize', (req, res) => {
  const pythonCmd = getPythonCmd();
  const scriptPath = path.join(scriptsDir, 'optimize_system.py');
  
  console.log('[System Optimizer] Starting optimization...');
  
  const proc = spawn(pythonCmd, [scriptPath]);
  let output = '';
  
  proc.stdout.on('data', (data) => {
    output += data.toString();
  });
  
  proc.stderr.on('data', (data) => {
    output += data.toString();
  });
  
  proc.on('close', (code) => {
    console.log('[System Optimizer] Process finished with code:', code);
    res.json({
      success: code === 0,
      output: output,
      code: code
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

app.get('/api/router/models', (req, res) => {
  const models = Array.from(routerModels.values()).map(m => ({
    id: m.id,
    name: m.name,
    port: m.port,
    status: m.status,
    inference_count: m.inference_count
  }));
  res.json({ models });
});

app.get('/api/router/routes', (req, res) => {
  const routes = Array.from(routerModels.values())
    .filter(m => m.status === 'ready')
    .map(m => ({
      model_id: m.id,
      model_name: m.name,
      endpoint: `http://127.0.0.1:${m.port}/v1`,
      status: m.status
    }));
  res.json({ routes });
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
  console.log('[Router Load] Received model_path:', model_path);
  
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  
  console.log('[Router Load] Resolved targetPath:', targetPath);
  console.log('[Router Load] File exists:', fs.existsSync(targetPath));
  
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  // Mac MLX requires config.json in the model directory
  if (isMac) {
    const modelDir = fs.statSync(targetPath).isFile() ? path.dirname(targetPath) : targetPath;
    const configPath = path.join(modelDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      return res.status(400).json({ 
        error: 'Missing config.json',
        message: 'MLX models require config.json with model architecture. Please download the full HuggingFace model directory (not just .safetensors file).',
        modelDir: modelDir
      });
    }
  }

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
    const pythonCmd = getPythonCmd();
    // MLX expects a directory with config.json + weights, not a single file
    // If target is a file, use its parent directory
    const modelDir = fs.statSync(targetPath).isFile() ? path.dirname(targetPath) : targetPath;
    proc = spawn(pythonCmd, [path.join(scriptsDir, 'mlx_backend.py'), '--mode', 'api', '--model', modelDir, '--port', port.toString()]);
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
  const { url, filename, autoConvert = false, downloadRepo = false } = req.body;
  console.log('[Download] Request received:', { url: url?.substring(0, 80), filename, autoConvert, downloadRepo });
  
  if (!url) {
    console.error('[Download] Missing url');
    return res.status(400).json({ error: 'url required' });
  }
  
  // For repo downloads, extract repo ID and use directory name
  if (downloadRepo) {
    let repoId = url;
    if (url.includes('huggingface.co')) {
      const match = url.match(/huggingface\.co\/([^/\s]+\/[^/?#\s]+)/);
      if (!match) return res.status(400).json({ error: 'Invalid HuggingFace URL format' });
      repoId = match[1];
    }
    
    const dirName = filename || repoId.split('/').pop();
    const outputDir = path.join(modelsDir, dirName);
    
    // Check if already exists
    if (fs.existsSync(outputDir)) {
      console.log('[Download] Directory already exists:', dirName);
      return res.json({ status: 'exists', path: outputDir, filename: dirName, isDirectory: true });
    }
    
    res.json({ status: 'started', filename: dirName, isDirectory: true });
    
    // Download entire repo in background
    downloadRepoInBackground(repoId, outputDir, dirName);
    return;
  }
  
  // Single file download (existing behavior)
  if (!filename) {
    return res.status(400).json({ error: 'filename required for single file download' });
  }
  
  const outputPath = path.join(modelsDir, filename);
  
  // Check if already exists
  if (fs.existsSync(outputPath)) {
    console.log('[Download] File already exists:', filename);
    if (autoConvert && isConvertibleFile(filename)) {
      createConversionJob(filename);
    }
    return res.json({ status: 'exists', path: outputPath, filename, autoConvert });
  }
  
  // Make sure directory exists
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  
  res.json({ status: 'started', filename, autoConvert });
  
  // Download in background
  downloadInBackground(url, outputPath, filename, autoConvert);
});

async function downloadInBackground(url, outputPath, filename, autoConvert) {
  try {
    console.log(`[Download] Starting: ${filename}`);
    
    let fetchUrl = url;
    if (url.includes('huggingface.co') && !url.includes('?download=true')) {
      fetchUrl = url + '?download=true';
    }
    
    const response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const reader = response.body.getReader();
    const fileStream = fs.createWriteStream(outputPath);
    let done = false;
    while (!done) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      fileStream.write(Buffer.from(value));
    }
    fileStream.end();
    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
    
    const stats = fs.statSync(outputPath);
    console.log(`[Download] ✓ Complete: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    if (autoConvert && isConvertibleFile(filename)) {
      createConversionJob(filename);
    }
  } catch (err) {
    console.error(`[Download] ✗ Failed: ${filename}`, err.message);
    fs.unlink(outputPath, () => {});
  }
}

async function downloadRepoInBackground(repoId, outputDir, dirName) {
  const pythonCmd = getPythonCmd();
  
  console.log(`[Download Repo] Starting: ${repoId} -> ${dirName}`);
  
  // Create a Python script to download the repo
  const downloadScript = `
import sys
from huggingface_hub import snapshot_download

try:
    snapshot_download(
        repo_id="${repoId}",
        local_dir="${outputDir}",
        local_dir_use_symlinks=False
    )
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;
  
  const tempScriptPath = path.join(rootDir, 'temp_download_repo.py');
  fs.writeFileSync(tempScriptPath, downloadScript);
  
  const proc = spawn(pythonCmd, [tempScriptPath]);
  
  proc.stdout.on('data', (data) => {
    console.log(`[Download Repo] ${data.toString().trim()}`);
  });
  
  proc.stderr.on('data', (data) => {
    console.error(`[Download Repo] ERROR: ${data.toString().trim()}`);
  });
  
  proc.on('close', (code) => {
    fs.unlink(tempScriptPath, () => {});
    
    if (code === 0) {
      console.log(`[Download Repo] ✓ Complete: ${dirName}`);
    } else {
      console.error(`[Download Repo] ✗ Failed with code ${code}: ${dirName}`);
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    }
  });
  
  proc.on('error', (err) => {
    console.error(`[Download Repo] ✗ Spawn error: ${err.message}`);
    fs.unlink(tempScriptPath, () => {});
  });
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
      // For MLX models, replace 'local' model with actual model path
      let bodyToUse = { ...req.body };
      if (bodyToUse.model === 'local' && readyModel.name) {
        const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
        if (isMac) {
          // For MLX on Mac, use the full model path
          bodyToUse.model = path.join(modelsDir, readyModel.name);
        }
      }
      fetchOptions.body = JSON.stringify(bodyToUse);
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
