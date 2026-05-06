import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import { Router } from 'express';

const apiRouter = Router();

const app = express();
app.use(cors());
app.use(express.json());

const PRIMARY_PORT = 8080;
const SECONDARY_PORT = 8081;

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
console.log('[API Server] Primary port (inference + management):', PRIMARY_PORT);
console.log('[API Server] Secondary port (management only):', SECONDARY_PORT);

// Vulkan capability check - caches result to avoid repeated checks
let _vulkanCapable = null;

async function checkVulkanCapability() {
  if (_vulkanCapable !== null) return _vulkanCapable;
  if (os.platform() !== 'linux') { _vulkanCapable = false; return false; }
  
  try {
    const llamaServer = path.join(binDir, 'llama-server');
    if (!fs.existsSync(llamaServer)) { _vulkanCapable = false; return false; }
    
    // Check if binary has Vulkan symbols
    const { execSync } = await import('child_process');
    const symbols = execSync(`strings "${llamaServer}" 2>/dev/null | grep -i vulkan | head -5`, {
      timeout: 3000
    }).toString();
    
    _vulkanCapable = symbols.toLowerCase().includes('vulkan');
    console.log(`[Router] Vulkan capability: ${_vulkanCapable}`);
  } catch (e) {
    _vulkanCapable = false;
  }
  
  return _vulkanCapable;
}

// Run system optimizer on startup for dynamic hardware detection
function runSystemOptimizer() {
  const optimizerPath = getScriptPath('system_optimizer.py');
  if (!fs.existsSync(optimizerPath)) {
    console.log('[Optimizer] System optimizer not found, skipping dynamic optimization');
    return;
  }

  console.log('[Optimizer] Running dynamic hardware detection and optimization...');
  const pythonCmd = getPythonCmd();

  try {
    const result = spawn(pythonCmd, [optimizerPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: rootDir
    });

    let output = '';
    result.stdout.on('data', (data) => {
      output += data.toString();
    });

    result.stderr.on('data', (data) => {
      console.log('[Optimizer]', data.toString().trim());
    });

    result.on('close', (code) => {
      if (code === 0) {
        console.log('[Optimizer] ✓ Dynamic hardware optimization completed');
        // Reload config after optimization
        const newConfig = loadConfig();
        console.log('[Optimizer] Detected settings:', {
          threads: newConfig.threads,
          n_gpu_layers: newConfig.n_gpu_layers,
          batch_size: newConfig.batch_size,
          ctx_size: newConfig.ctx_size,
          gpu_type: newConfig.gpu_type
        });
      } else {
        console.warn('[Optimizer] Optimization script exited with code', code);
      }
    });
  } catch (err) {
    console.error('[Optimizer] Failed to run system optimizer:', err.message);
  }
}

// Run optimizer on startup
runSystemOptimizer();

// Run Linux system optimizations on startup
(async () => {
  if (os.platform() === 'linux') {
    const prelaunchScript = path.join(scriptsDir, 'linux_prelaunch.sh');
    if (fs.existsSync(prelaunchScript)) {
      console.log('[Startup] Running Linux system optimizer...');
      try {
        const { execSync } = await import('child_process');
        execSync(`bash "${prelaunchScript}"`, {
          timeout: 15000,
          cwd: rootDir,
          stdio: 'inherit', // show output in Node console
        });
      } catch (e) {
        console.log('[Startup] Linux optimizer completed (non-zero exit is OK)');
      }
    }
  }
})();

// Process cleanup handlers to prevent zombie processes
process.on('exit', killAllModels);
process.on('SIGINT', () => { killAllModels(); process.exit(0); });
process.on('SIGTERM', () => { killAllModels(); process.exit(0); });
process.on('uncaughtException', (err) => { 
  console.error('[Fatal]', err); 
  killAllModels(); 
  process.exit(1); 
});

function killAllModels() {
  for (const [, m] of routerModels) {
    if (m.readyCheckInterval) clearInterval(m.readyCheckInterval);
    if (m.failsafeTimer) clearTimeout(m.failsafeTimer);
    try { m.process?.kill('SIGKILL'); } catch {}
  }
}

function isPortFree(port) {
  return new Promise(resolve => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

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

// Find an available port for model loading
async function findAvailablePort() {
  let port = nextPort;
  while (!(await isPortFree(port))) {
    port++;
    if (port > 9000) {
      throw new Error('No available ports found in range 8000-9000');
    }
  }
  nextPort = port + 1;
  return port;
}

const configPath = path.join(rootDir, 'config.json');
const convertibleExtensions = ['.gguf', '.safetensors', '.bin', '.pt'];

// Config caching to avoid repeated file reads
let cachedConfig = null;
let configTimestamp = 0;

function loadConfig() {
  try {
    const stats = fs.existsSync(configPath) ? fs.statSync(configPath) : null;
    if (stats && stats.mtimeMs > configTimestamp) {
      cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      configTimestamp = stats.mtimeMs;
    } else if (!cachedConfig) {
      cachedConfig = stats ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
      configTimestamp = stats ? stats.mtimeMs : Date.now();
    }
    return cachedConfig;
  } catch (err) {
    console.error('[Config] Failed to load config:', err.message);
    return {};
  }
}

function saveConfigData(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    cachedConfig = config;
    configTimestamp = Date.now();
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

// Helper functions to reduce repeated path constructions
function getScriptPath(scriptName) {
  return path.join(scriptsDir, scriptName);
}

function getBinPath(binaryName) {
  const binPath = path.join(binDir, binaryName);
  return os.platform() === 'win32' ? binPath + '.exe' : binPath;
}

function isMac() {
  return os.platform() === 'darwin' && os.arch() === 'arm64';
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

  const pyScript = getScriptPath('model-converter.py');
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

apiRouter.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

apiRouter.get('/supported-formats', (req, res) => {
  res.json({
    formats: isMac() ? ['safetensors', 'mlx'] : ['gguf', 'safetensors', 'bin', 'pt'],
    converter_available: fs.existsSync(getScriptPath('model-converter.py'))
  });
});

// === SYSTEM INFO ===

apiRouter.get('/system-info', (req, res) => {
  const mac = isMac();
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    is_mac: mac,
    is_apple_silicon: mac,
    backend: mac ? 'mlx' : 'llama.cpp'
  });
});

// Get current optimized configuration
apiRouter.get('/optimized-config', (req, res) => {
  const config = loadConfig();
  res.json({
    threads: config.threads,
    threads_batch: config.threads_batch,
    ctx_size: config.ctx_size,
    batch_size: config.batch_size,
    ubatch_size: config.ubatch_size,
    n_gpu_layers: config.n_gpu_layers,
    gpu_type: config.gpu_type,
    http_threads: config.http_threads,
    parallel_slots: config.parallel_slots,
    flash_attn: config.flash_attn,
    kv_cache_quant: config.kv_cache_quant,
    cont_batching: config.cont_batching,
    dynamically_optimized: true
  });
});

// Trigger re-optimization on demand
apiRouter.post('/reoptimize', (req, res) => {
  console.log('[API] Triggering dynamic re-optimization...');

  const optimizerPath = path.join(scriptsDir, 'system_optimizer.py');
  if (!fs.existsSync(optimizerPath)) {
    return res.status(500).json({ error: 'System optimizer not found' });
  }

  const pythonCmd = getPythonCmd();
  const result = spawn(pythonCmd, [optimizerPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: rootDir
  });

  let output = '';
  result.stdout.on('data', (data) => {
    output += data.toString();
  });

  result.on('close', (code) => {
    if (code === 0) {
      const newConfig = loadConfig();
      console.log('[API] ✓ Re-optimization completed');
      res.json({
        success: true,
        message: 'System re-optimized successfully',
        config: {
          threads: newConfig.threads,
          threads_batch: newConfig.threads_batch,
          ctx_size: newConfig.ctx_size,
          batch_size: newConfig.batch_size,
          n_gpu_layers: newConfig.n_gpu_layers,
          gpu_type: newConfig.gpu_type
        }
      });
    } else {
      res.status(500).json({ error: 'Re-optimization failed', code });
    }
  });
});

// === CONTEXT SIZE MANAGEMENT ===

// Get current context size configuration
apiRouter.get('/context-config', (req, res) => {
  const config = loadConfig();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  res.json({
    current_ctx_size: config.ctx_size || 4096,
    min_recommended: 4096,
    max_safe_estimate: Math.floor((freeMem / (1024 * 1024)) * 0.6),  // Estimate based on free RAM
    memory_status: {
      total_mb: Math.floor(totalMem / (1024 * 1024)),
      free_mb: Math.floor(freeMem / (1024 * 1024)),
      usage_percent: Math.floor(((totalMem - freeMem) / totalMem) * 100)
    },
    adjustable: true,
    note: 'Context size can be adjusted at runtime. Minimum is 4096 tokens.'
  });
});

// Adjust context size at runtime (requires model restart)
apiRouter.post('/adjust-context', (req, res) => {
  const { ctx_size } = req.body;

  if (!ctx_size || typeof ctx_size !== 'number') {
    return res.status(400).json({ error: 'ctx_size (number) is required' });
  }

  // Enforce minimum 4096
  if (ctx_size < 4096) {
    return res.status(400).json({ error: 'ctx_size must be at least 4096 tokens' });
  }

  // Sanity check maximum (prevent OOM)
  const maxSafe = Math.floor((os.freemem() / (1024 * 1024)) * 0.7);  // 70% of free RAM
  if (ctx_size > maxSafe && ctx_size > 32768) {
    return res.status(400).json({
      error: `ctx_size ${ctx_size} may cause out-of-memory. Max safe: ~${maxSafe}`,
      recommended_max: maxSafe
    });
  }

  try {
    const config = loadConfig();
    config.ctx_size = ctx_size;

    if (saveConfigData(config)) {
      console.log(`[API] Context size adjusted to ${ctx_size} tokens`);
      res.json({
        success: true,
        message: `Context size set to ${ctx_size} tokens. Restart the model to apply changes.`,
        ctx_size: ctx_size,
        requires_restart: true
      });
    } else {
      res.status(500).json({ error: 'Failed to save configuration' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get detailed hardware information
apiRouter.get('/hardware-info', async (req, res) => {
  const hwInfoPath = path.join(scriptsDir, 'system_optimizer.py');

  if (!fs.existsSync(hwInfoPath)) {
    // Fallback to basic info
    return res.json({
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      note: 'Detailed hardware info not available - system optimizer not found'
    });
  }

  const pythonCmd = getPythonCmd();
  const proc = spawn(pythonCmd, [hwInfoPath, '--print-info'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: rootDir
  });

  let output = '';
  proc.stdout.on('data', (data) => {
    output += data.toString();
  });

  proc.on('close', (code) => {
    if (code === 0) {
      // Try to parse the detected system info from the optimizer output
      // and return it in a structured format
      const config = loadConfig();
      res.json({
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        cpu_model: os.cpus()[0]?.model || 'unknown',
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        optimized_settings: {
          threads: config.threads,
          threads_batch: config.threads_batch,
          ctx_size: config.ctx_size,
          batch_size: config.batch_size,
          n_gpu_layers: config.n_gpu_layers,
          gpu_type: config.gpu_type,
          http_threads: config.http_threads,
          parallel_slots: config.parallel_slots
        },
        raw_output: output
      });
    } else {
      res.status(500).json({ error: 'Failed to get hardware info' });
    }
  });
});

// === HUGGINGFACE REPO BROWSING ===

apiRouter.get('/hf-files', async (req, res) => {
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

apiRouter.get('/models/list', (req, res) => {
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

apiRouter.get('/config', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

apiRouter.post('/save-config', (req, res) => {
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

apiRouter.get('/model-exists', (req, res) => {
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

apiRouter.get('/models/convertible', (req, res) => {
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

apiRouter.post('/convert-model', (req, res) => {
  const { input_file, quantization, format } = req.body;
  if (!input_file) return res.status(400).send('input_file required');

  const result = createConversionJob(input_file, quantization || 'Q4_K_M', format);
  res.json(result);
});

// Quantization endpoint (macOS only - uses mlx-lm)
apiRouter.post('/quantize-model', (req, res) => {
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

apiRouter.get('/conversion-status', (req, res) => {
  const input = req.query.input;
  if (!input) return res.status(400).send('input required');
  const job = conversionJobs.get(input);
  if (job) return res.json(job);
  res.json({ status: 'unknown' });
});

apiRouter.post('/convert/memory-estimate', (req, res) => {
  try {
    const { model_path } = req.body;
    if (!model_path) return res.status(400).json({ error: 'model_path required' });
    
    const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });
    
    const pythonCmd = getPythonCmd();
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

apiRouter.post('/convert/sharded', (req, res) => {
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

apiRouter.post('/convert/detect-shards', (req, res) => {
  const { model_path } = req.body;
  const target = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  
  const pythonCmd = getPythonCmd();
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

apiRouter.post('/system/optimize', (req, res) => {
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

// === INFERENCE DIAGNOSTICS ===

apiRouter.post('/inference/profile', async (req, res) => {
  const { model_id, prompt = 'Write a short poem about the sea.', max_tokens = 64, runs = 3 } = req.body;
  
  let targetPort = null;
  if (model_id) {
    const modelInfo = routerModels.get(model_id);
    if (!modelInfo || modelInfo.status !== 'ready') {
      return res.status(404).json({ error: 'Model not found or not ready' });
    }
    targetPort = modelInfo.port;
  } else {
    const readyModel = Array.from(routerModels.values()).find(m => m.status === 'ready');
    if (!readyModel) return res.status(502).json({ error: 'No models loaded' });
    targetPort = readyModel.port;
  }

  const results = [];
  for (let run = 0; run < runs; run++) {
    const payload = {
      model: 'local',
      messages: [{ role: 'user', content: prompt }],
      max_tokens,
      temperature: 0.7,
      stream: false
    };

    const start = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      const elapsed = (Date.now() - start) / 1000;
      const usage = result.usage || {};
      const completionTokens = usage.completion_tokens || 0;
      const promptTokens = usage.prompt_tokens || 0;
      const tps = completionTokens / elapsed;

      results.push({
        run: run + 1,
        total_time_s: parseFloat(elapsed.toFixed(3)),
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        tokens_per_sec: parseFloat(tps.toFixed(2)),
        ms_per_token: parseFloat((elapsed / completionTokens * 1000).toFixed(2))
      });
    } catch (err) {
      results.push({ run: run + 1, error: err.message });
    }
  }

  const validResults = results.filter(r => !r.error);
  const summary = {
    port: targetPort,
    prompt: prompt.substring(0, 80),
    max_tokens,
    num_runs: runs,
    avg_tokens_per_sec: validResults.length > 0 ? parseFloat((validResults.reduce((s, r) => s + r.tokens_per_sec, 0) / validResults.length).toFixed(2)) : 0,
    avg_total_latency_s: validResults.length > 0 ? parseFloat((validResults.reduce((s, r) => s + r.total_time_s, 0) / validResults.length).toFixed(3)) : 0,
    avg_ms_per_token: validResults.length > 0 ? parseFloat((validResults.reduce((s, r) => s + r.ms_per_token, 0) / validResults.length).toFixed(2)) : 0,
    runs: results
  };

  res.json(summary);
});

let resourceCache = { data: null, ts: 0 };

apiRouter.get('/system/resources', (req, res) => {
  const now = Date.now();
  if (resourceCache.data && now - resourceCache.ts < 3000) {
    return res.json(resourceCache.data);
  }

  const pythonCmd = getPythonCmd();
  const scriptPath = path.join(scriptsDir, 'resource_monitor.py');
  const proc = spawn(pythonCmd, [scriptPath, 'snapshot']);

  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { output += data.toString(); });
  proc.on('close', (code) => {
    if (code === 0) {
      try {
        const data = JSON.parse(output);
        resourceCache = { data, ts: Date.now() };
        res.json(data);
      } catch (e) {
        res.json({ success: true, raw: output });
      }
    } else {
      res.status(500).json({ error: 'Resource monitor failed', output });
    }
  });
});

apiRouter.get('/inference/diagnose', (req, res) => {
  const pythonCmd = getPythonCmd();
  const scriptPath = path.join(scriptsDir, 'inference_diagnostics.py');
  const proc = spawn(pythonCmd, [scriptPath, 'diagnose']);
  
  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { output += data.toString(); });
  proc.on('close', (code) => {
    res.json({ success: code === 0, output });
  });
});

apiRouter.get('/inference/report', async (req, res) => {
  const port = parseInt(req.query.port) || 8000;
  const maxTokens = parseInt(req.query.max_tokens) || 64;
  const pythonCmd = getPythonCmd();
  const scriptPath = path.join(scriptsDir, 'inference_diagnostics.py');
  const proc = spawn(pythonCmd, [scriptPath, 'report', '--port', port.toString(), '--max-tokens', maxTokens.toString()]);
  
  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { output += data.toString(); });
  proc.on('close', (code) => {
    res.json({ success: code === 0, output });
  });
});

// === GPU BENCHMARK ===

apiRouter.post('/benchmark/gpu', (req, res) => {
  const { model_path, gpu_layers, ctx_size = 2048, threads = 4, max_tokens = 64, runs = 3 } = req.body;
  if (!model_path) return res.status(400).json({ error: 'model_path required' });

  const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  const pythonCmd = getPythonCmd();
  const layersList = gpu_layers || [0, 10, 20, 30, 50, 99];
  const args = [
    path.join(scriptsDir, 'gpu_benchmark.py'), 'run',
    '--bin-dir', binDir,
    '--model', targetPath,
    '--gpu-layers', ...layersList.map(String),
    '--ctx-size', ctx_size.toString(),
    '--threads', threads.toString(),
    '--max-tokens', max_tokens.toString(),
    '--runs', runs.toString()
  ];

  const proc = spawn(pythonCmd, args);
  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { output += data.toString(); });
  proc.on('close', (code) => {
    if (code === 0) {
      try {
        res.json(JSON.parse(output));
      } catch (e) {
        res.json({ success: true, output });
      }
    } else {
      res.status(500).json({ error: 'Benchmark failed', output });
    }
  });
});

apiRouter.post('/benchmark/quick', (req, res) => {
  const { model_path, ctx_size = 2048, threads = 4 } = req.body;
  if (!model_path) return res.status(400).json({ error: 'model_path required' });

  const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  const pythonCmd = getPythonCmd();
  const args = [
    path.join(scriptsDir, 'gpu_benchmark.py'), 'quick',
    '--bin-dir', binDir,
    '--model', targetPath,
    '--ctx-size', ctx_size.toString(),
    '--threads', threads.toString()
  ];

  const proc = spawn(pythonCmd, args);
  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { output += data.toString(); });
  proc.on('close', (code) => {
    if (code === 0) {
      try {
        res.json(JSON.parse(output));
      } catch (e) {
        res.json({ success: true, output });
      }
    } else {
      res.status(500).json({ error: 'Quick benchmark failed', output });
    }
  });
});

// === CONTEXT & MEMORY OPTIMIZATION ===

apiRouter.post('/memory/estimate', (req, res) => {
  const { model_path, ctx_size = 4096, kv_quant = 'q8_0' } = req.body;
  if (!model_path) return res.status(400).json({ error: 'model_path required' });

  const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  const pythonCmd = getPythonCmd();
  execFile(pythonCmd, [path.join(scriptsDir, 'ctx_memory_opt.py'), 'estimate', targetPath, '--ctx-size', ctx_size.toString(), '--kv-quant', kv_quant], (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      res.json(JSON.parse(stdout));
    } catch (e) {
      res.json({ raw: stdout });
    }
  });
});

apiRouter.post('/memory/recommend-ctx', (req, res) => {
  const { model_path, available_mem, kv_quant = 'q8_0', headroom = 15 } = req.body;
  if (!model_path) return res.status(400).json({ error: 'model_path required' });

  const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  const pythonCmd = getPythonCmd();
  const args = [path.join(scriptsDir, 'ctx_memory_opt.py'), 'recommend', targetPath, '--kv-quant', kv_quant, '--headroom', headroom.toString()];
  if (available_mem) args.push('--available-mem', available_mem.toString());
  
  execFile(pythonCmd, args, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      res.json(JSON.parse(stdout));
    } catch (e) {
      res.json({ raw: stdout });
    }
  });
});

apiRouter.post('/memory/compare-kv', (req, res) => {
  const { model_path, ctx_size = 4096 } = req.body;
  if (!model_path) return res.status(400).json({ error: 'model_path required' });

  const targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  const pythonCmd = getPythonCmd();
  execFile(pythonCmd, [path.join(scriptsDir, 'ctx_memory_opt.py'), 'compare-kv', targetPath, '--ctx-size', ctx_size.toString()], (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ output: stdout });
  });
});

// === ROUTER BACKEND ===

apiRouter.get('/router/status', (req, res) => {
  const models = Array.from(routerModels.values());
  res.json({
    total_models: models.length,
    ready_models: models.filter(m => m.status === 'ready').length,
    routing_policy: routingPolicy,
    total_inferences: models.reduce((sum, m) => sum + m.inference_count, 0),
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      port: m.port,
      status: m.status,
      inference_count: m.inference_count,
      pid: m.process?.pid || null
    }))
  });
});

apiRouter.get('/router/models', (req, res) => {
  const models = Array.from(routerModels.values()).map(m => ({
    id: m.id,
    name: m.name,
    port: m.port,
    status: m.status,
    inference_count: m.inference_count
  }));
  res.json({ models });
});

apiRouter.get('/router/active-port', (req, res) => {
  const ready = Array.from(routerModels.values()).find(m => m.status === 'ready');
  if (!ready) return res.status(502).json({ error: 'No model ready' });
  res.json({ port: ready.port, model: ready.name, id: ready.id });
});

apiRouter.get('/router/routes', (req, res) => {
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

apiRouter.post('/router/policy', (req, res) => {
  const { policy } = req.body;
  if (['round-robin', 'load-balanced', 'first-available'].includes(policy)) {
    routingPolicy = policy;
    res.json({ status: 'success', policy });
  } else {
    res.status(400).json({ error: 'Invalid policy' });
  }
});

apiRouter.post('/router/load', async (req, res) => {
  const { model_path } = req.body;
  console.log('[Router Load] Received model_path:', model_path);
  
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  let targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  
  console.log('[Router Load] Resolved targetPath:', targetPath);
  console.log('[Router Load] File exists:', fs.existsSync(targetPath));
  
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  // macOS MLX specific path handling
  if (isMac) {
    // Check if it's a directory (MLX model) or file (GGUF)
    const stats = fs.statSync(targetPath);
    if (stats.isDirectory()) {
      // MLX model directory — check for required files
      const hasConfig = fs.existsSync(path.join(targetPath, 'config.json'));
      const hasSafetensors = fs.readdirSync(targetPath).some(f => f.endsWith('.safetensors'));
      if (!hasConfig || !hasSafetensors) {
        return res.status(400).json({ 
          error: `Directory ${targetPath} does not appear to be a valid MLX model (missing config.json or .safetensors files)` 
        });
      }
      console.log(`[Router] macOS: Loading MLX model directory: ${targetPath}`);
    }
    
    // Mac MLX requires config.json in the model directory
    const modelDir = stats.isFile() ? path.dirname(targetPath) : targetPath;
    const configPath = path.join(modelDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      return res.status(400).json({ 
        error: 'Missing config.json',
        message: 'MLX models require config.json with model architecture. Please download the full HuggingFace model directory (not just .safetensors file).',
        modelDir: modelDir
      });
    }
  }

  // Load config (will be cached)
  const config = loadConfig();
  console.log('[Router Load] Config loaded:', { 
    ctx_size: config.ctx_size, 
    n_gpu_layers: config.n_gpu_layers,
    use_mlock: config.use_mlock,
    flash_attn: config.flash_attn
  });

  // Find available port
  const port = findAvailablePort();
  console.log(`[Router Load] Using port: ${port}`);

  // Store model info
  const id = Math.random().toString(36).substring(7);
  const modelInfo = { 
    id, 
    name: path.basename(targetPath), 
    path: targetPath, 
    port, 
    status: 'loading',
    loaded_at: new Date().toISOString()
  };
  routerModels.set(id, modelInfo);

  let proc;

  if (isMac) {
    const pythonCmd = getPythonCmd();
    // MLX expects a directory with config.json + weights, not a single file
    // If target is a file, use its parent directory
    const modelDir = stats.isFile() ? path.dirname(targetPath) : targetPath;
    proc = spawn(pythonCmd, [path.join(scriptsDir, 'mlx_backend.py'), '--mode', 'api', '--model', modelDir, '--port', port.toString()]);
  } else {
    let llamaServer = path.join(binDir, 'llama-server');
    if (os.platform() === 'win32') llamaServer += '.exe';
    
    if (!fs.existsSync(llamaServer)) {
      routerModels.delete(id);
      return res.status(500).json({ 
        error: 'llama-server binary not found',
        message: `Expected binary at: ${llamaServer}. Please extract llama.cpp release binaries to the bin/ directory.`
      });
    }
    
    // Helper to read config values with enforced safety limits
const threads = parseInt(config.threads) || 2;
const threadsBatch = (() => {
  const val = parseInt(config.threads_batch);
  if (!val || isNaN(val)) return 4;
  return val;
})();
const ctxSize = (() => {
  const val = parseInt(config.ctx_size);
  if (!val || isNaN(val) || val < 512) return 4096; // safe minimum
  return Math.min(val, 32768); // cap at 32K — beyond this is memory waste on 16GB
})();
const batchSize = parseInt(config.batch_size) || 256;
const ubatchSize = parseInt(config.ubatch_size) || 256;
const nGpuLayers = parseInt(config.n_gpu_layers) ?? 0;
const kvCacheType = config.kv_cache_quant || 'q8_0';
const splitMode = config.split_mode || 'row';
const defragThold = config.defrag_thold ?? 0.1;
const parallelSlots = (() => {
  const val = parseInt(config.parallel_slots);
  if (!val || isNaN(val)) return 1;
  return val;
})();
const httpThreads = parseInt(config.http_threads) || 2;
const useMlock = config.use_mlock === true;
const contBatching = config.cont_batching !== false;
const promptCache = config.prompt_cache === true;

const cmdArgs = [
  '-m', targetPath,                           // model path
  '--port', port.toString(),
  '--host', '127.0.0.1',
  '--ctx-size', ctxSize.toString(),
  '--threads', threads.toString(),            // CPU threads for generation
  '--threads-batch', threadsBatch.toString(), // CPU threads for prompt processing
  '--batch-size', batchSize.toString(),       // prompt batch size
  '--ubatch-size', ubatchSize.toString(),     // micro-batch size
  '--split-mode', splitMode,                  // tensor split mode
  '--defrag-thold', defragThold.toString(),   // KV cache defrag threshold
  '--parallel', parallelSlots.toString(),     // parallel request slots
  '--threads-http', httpThreads.toString(),   // HTTP server threads
  '--flash-attn',                             // NO argument — just the flag
  '--cache-type-k', kvCacheType,             // KV key cache quantization
  '--cache-type-v', kvCacheType,             // KV value cache quantization
];

// Continuous batching — enabled by default, only disable if explicitly false
if (contBatching) {
  cmdArgs.push('--cont-batching');
}

// Disable prompt cache — it defaults to 8GB limit on this machine
// Re-enable only if user explicitly sets it in config
if (!promptCache) {
  cmdArgs.push('--no-cache-prompt');
}

// Log actual flags being passed to llama-server
console.log(`[Router] Launching llama-server with flags:`);
console.log(`[Router]   ctx-size: ${ctxSize}`);
console.log(`[Router]   threads: ${threads} / threads-batch: ${threadsBatch}`);
console.log(`[Router]   n-gpu-layers: ${effectiveGpuLayers || nGpuLayers}`);
console.log(`[Router]   parallel: ${parallelSlots}`);
console.log(`[Router]   kv-cache-type: ${kvCacheType}`);
console.log(`[Router]   mlock: ${useMlock}`);
console.log(`[Router]   prompt-cache: ${promptCache}`);
console.log(`[Router]   flash-attn: enabled`);

// mlock — only enable if explicitly true AND we have enough free RAM
// On 16GB machines with iGPU sharing memory, mlock can cause OOM
if (useMlock) {
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const freePercent = freeMem / totalMem;
  if (freePercent > 0.25) {
    // Only mlock if >25% RAM is free — prevents OOM on constrained systems
    cmdArgs.push('--mlock');
  } else {
    console.log('[Router] Skipping --mlock: less than 25% RAM free');
  }
}

// NUMA: only use if multiple NUMA nodes exist
// --numa distribute is for multi-socket servers ONLY
// Single NUMA node machines (like i3-1005G1) must NOT use this flag
try {
  const { execSync } = await import('child_process');
  const numaNodes = parseInt(
    execSync(
      'cat /sys/devices/system/node/online 2>/dev/null || echo "0"',
      { timeout: 1000 }
    ).toString().trim().split('-').pop()
  ) + 1;
  if (numaNodes > 1) {
    cmdArgs.push('--numa', 'distribute');
    console.log(`[Router] NUMA: ${numaNodes} nodes detected, enabling distribute mode`);
  } else {
    console.log('[Router] NUMA: single node, skipping --numa flag');
  }
} catch (e) {
  // Can't detect NUMA — skip the flag to be safe
}

// Check Vulkan capability and set effective GPU layers
const vulkanOk = await checkVulkanCapability();
const effectiveGpuLayers = vulkanOk ? nGpuLayers : 0;
cmdArgs.push('--n-gpu-layers', effectiveGpuLayers.toString());

if (!vulkanOk && nGpuLayers > 0) {
  console.log('[Router] ⚠ llama-server binary has no Vulkan support — running CPU-only');
  console.log('[Router] ⚠ For Intel iGPU acceleration, use a Vulkan-compiled llama-server binary');
}
    
// On Linux: pin to physical cores only using taskset
// Hyperthreaded siblings hurt llama.cpp throughput on 2-core machines
// Physical cores on i3-1005G1 are 0,2 — logical/HT siblings are 1,3
// For other machines: detect physical core IDs dynamically
let finalCmd = llamaServer;
let finalArgs = cmdArgs;

if (os.platform() === 'linux') {
  try {
    // Detect physical core IDs dynamically
    const cpuinfoRaw = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const physicalCores = new Map();
    let currentProcessor = null;
    let currentPhysicalId = null;
    let currentCoreId = null;
    
    for (const line of cpuinfoRaw.split('\n')) {
      if (line.startsWith('processor')) {
        currentProcessor = parseInt(line.split(':')[1].trim());
      } else if (line.startsWith('physical id')) {
        currentPhysicalId = line.split(':')[1].trim();
      } else if (line.startsWith('core id')) {
        currentCoreId = line.split(':')[1].trim();
        const key = `${currentPhysicalId}-${currentCoreId}`;
        if (!physicalCores.has(key)) {
          physicalCores.set(key, currentProcessor);
        }
      }
    }
    
    if (physicalCores.size > 0) {
      const physicalCpuList = Array.from(physicalCores.values()).join(',');
      finalCmd = 'taskset';
      finalArgs = ['-c', physicalCpuList, llamaServer, ...cmdArgs];
      console.log(`[Router] Pinning llama-server to physical cores: ${physicalCpuList}`);
    }
  } catch (e) {
    console.log('[Router] taskset pinning skipped:', e.message);
    // Fall through to normal spawn
  }
}

proc = spawn(finalCmd, finalArgs, {
  env: {
    ...process.env,
    // Optimize OpenMP threading for llama.cpp
    OMP_NUM_THREADS: threads.toString(),
    OMP_PROC_BIND: 'close',
    OMP_PLACES: 'cores',
    // Optimize memory allocation
    MALLOC_ARENA_MAX: '2',
    // Disable CPU frequency scaling interference
    GOMP_SPINCOUNT: '0',
  }
});

// Set llama-server to high I/O and CPU priority on Linux
if (os.platform() === 'linux' && proc.pid) {
  try {
    // High CPU priority (nice -5 = slightly above normal, doesn't require root)
    exec(`renice -n -5 -p ${proc.pid} 2>/dev/null || true`);
    // High I/O priority — critical during model load from disk
    exec(`ionice -c 2 -n 0 -p ${proc.pid} 2>/dev/null || true`);
    console.log(`[Router] Set priority for llama-server PID ${proc.pid}`);
  } catch (e) {
    // Non-fatal — just run at default priority
  }
}

// Set process scheduling to SCHED_BATCH for better throughput
if (os.platform() === 'linux' && proc.pid) {
  try {
    // Set to SCHED_BATCH — better throughput for CPU-bound inference
    exec(`chrt -b -p 0 ${proc.pid} 2>/dev/null || true`);
    console.log(`[Router] ✓ Process scheduling optimized for PID ${proc.pid}`);
  } catch (e) {
    // Non-fatal
  }
}
  }

  modelInfo.process = proc;

  // Poll for readiness
  let attempts = 0;
  const maxAttempts = 60;
  const checkReady = setInterval(async () => {
    if (++attempts > maxAttempts) {
      clearInterval(checkReady);
      clearTimeout(failsafeTimer);
      modelInfo.status = 'error';
      console.error(`[Router] Model ${modelInfo.name} failed to become ready after 60s`);
      return;
    }
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (resp.ok) {
        modelInfo.status = 'ready';
        clearInterval(checkReady);
        clearTimeout(failsafeTimer);
      }
    } catch (e) { }
  }, 1000);

  // Failsafe
  const failsafeTimer = setTimeout(() => {
    clearInterval(checkReady);
    modelInfo.status = 'error';
    console.error(`[Router] Failsafe timeout hit for model ${modelInfo.name}`);
  }, 60000);

  // Store interval ref so we can clear it on unload
  modelInfo.readyCheckInterval = checkReady;
  modelInfo.failsafeTimer = failsafeTimer;

  proc.on('close', () => {
    clearInterval(checkReady);
    clearTimeout(failsafeTimer);
    if (modelInfo.status !== 'unloaded') {
      modelInfo.status = 'error';
    }
  });

  res.json({ status: 'success', id, port });
});

apiRouter.delete('/router/unload/:id', (req, res) => {
  const modelInfo = routerModels.get(req.params.id);
  if (!modelInfo) return res.status(404).json({ error: 'Not found' });

  // Clear polling interval and failsafe timer
  if (modelInfo.readyCheckInterval) clearInterval(modelInfo.readyCheckInterval);
  if (modelInfo.failsafeTimer) clearTimeout(modelInfo.failsafeTimer);

  if (modelInfo.process) {
    const proc = modelInfo.process;
    const pid = proc.pid;
    modelInfo.status = 'unloading';

    // Send SIGTERM first
    try { proc.kill('SIGTERM'); } catch (e) { /* already dead */ }

    // Escalate to SIGKILL after 5s if still running
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
        console.log(`[Router Unload] SIGKILL sent to PID ${pid} after timeout`);
      } catch (e) { /* already dead */ }
    }, 5000);

    // Wait for exit (up to 8s total), then clean up
    const exitTimeout = setTimeout(() => {
      clearTimeout(killTimer);
      routerModels.delete(req.params.id);
      console.log(`[Router Unload] Force-removed model ${req.params.id}`);
    }, 8000);

    proc.on('close', () => {
      clearTimeout(killTimer);
      clearTimeout(exitTimeout);
      routerModels.delete(req.params.id);
      console.log(`[Router Unload] Model ${req.params.id} (PID ${pid}) exited cleanly`);
    });
  } else {
    routerModels.delete(req.params.id);
  }

  res.json({ status: 'unloading', id: req.params.id });
});

apiRouter.delete('/router/unload-all', (req, res) => {
  const ids = Array.from(routerModels.keys());
  let unloaded = 0;

  for (const id of ids) {
    const modelInfo = routerModels.get(id);
    if (!modelInfo) continue;

    if (modelInfo.readyCheckInterval) clearInterval(modelInfo.readyCheckInterval);
    if (modelInfo.failsafeTimer) clearTimeout(modelInfo.failsafeTimer);

    if (modelInfo.process) {
      const proc = modelInfo.process;
      try { proc.kill('SIGTERM'); } catch (e) { /* already dead */ }

      // Escalate to SIGKILL after 5s
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
      }, 5000);
    }

    routerModels.delete(id);
    unloaded++;
  }

  console.log(`[Router Unload-All] Unloading ${unloaded} models`);
  res.json({ status: 'success', unloaded });
});

// === MODEL DOWNLOAD ===

apiRouter.post('/download-model', async (req, res) => {
  const { url, filename, autoConvert = false, downloadRepo = false } = req.body;
  console.log('[Download] Request received:', { url: url?.substring(0, 80), filename, autoConvert, downloadRepo });
  
  if (!url) {
    console.error('[Download] Missing url');
    return res.status(400).json({ error: 'url required' });
  }
  
  // macOS/MLX format validation: reject GGUF files
  const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
  if (isMac && filename) {
    const lowerFilename = filename.toLowerCase();
    if (lowerFilename.endsWith('.gguf')) {
      return res.status(400).json({
        error: 'GGUF format not supported on macOS/MLX',
        message: 'This model is in GGUF format, which is not compatible with macOS/MLX. Use models in safetensors or MLX format. Convert GGUF to MLX using the Converter tab, or choose an MLX-native model from HuggingFace (e.g., mlx-community models).'
      });
    }
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
    
    const dlController = new AbortController();
    const dlTimeout = setTimeout(() => dlController.abort(), 30 * 60 * 1000); // 30 min max
    const response = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Lumina-Edge/1.2' },
      signal: dlController.signal,
    });
    clearTimeout(dlTimeout);
    
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
  const escapedRepoId = repoId.replace(/"/g, '\\"');
  const escapedOutputDir = outputDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  console.log(`[Download Repo] Starting: ${repoId} -> ${dirName}`);

  // Step 1: Ensure huggingface_hub is installed before attempting import
  console.log(`[Download Repo] Ensuring huggingface_hub is installed...`);
  const pipProc = spawn(pythonCmd, ['-m', 'pip', 'install', '-q', 'huggingface_hub']);

  let pipOk = false;
  await new Promise((resolve) => {
    pipProc.on('close', (code) => {
      pipOk = (code === 0);
      if (!pipOk) {
        console.warn(`[Download Repo] pip install huggingface_hub exited with code ${code}, will attempt anyway`);
      }
      resolve();
    });
    pipProc.on('error', (err) => {
      console.error(`[Download Repo] pip install failed: ${err.message}`);
      resolve();
    });
  });

  // Convert JS boolean to Python boolean (True/False)
  const pyPipOk = pipOk ? 'True' : 'False';

  const script = `
import sys
import importlib
if ${pyPipOk}:
    importlib.invalidate_caches()
try:
    from huggingface_hub import snapshot_download
    snapshot_download(repo_id="${escapedRepoId}", local_dir="${escapedOutputDir}", local_dir_use_symlinks=False)
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;
  const proc = spawn(pythonCmd, ['-c', script]);
  
  proc.stdout.on('data', (data) => {
    console.log(`[Download Repo] ${data.toString().trim()}`);
  });
  
  proc.stderr.on('data', (data) => {
    console.error(`[Download Repo] ERROR: ${data.toString().trim()}`);
  });
  
  proc.on('close', (code) => {
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
  });
}

// === STARTUP PIPELINE ===

async function runStartupPipeline() {
  const config = loadConfig();
  const startupCfg = config.startup || {};
  
  console.log('[Startup] Running startup pipeline...');

  // Step 1: System optimization (runs first, non-blocking)
  if (startupCfg.optimize_on_launch === true) {
    console.log('[Startup] Step 1: Starting system optimization (non-blocking)...');
    try {
      const pythonCmd = getPythonCmd();
      const scriptPath = path.join(scriptsDir, 'optimize_system.py');
      const proc = spawn(pythonCmd, [scriptPath]);
      
      // Start optimization but don't wait for it - let it run in background
      proc.stdout.on('data', (data) => { 
        console.log(`[Optimization] ${data.toString().trim()}`);
      });
      proc.stderr.on('data', (data) => { 
        console.log(`[Optimization] ${data.toString().trim()}`);
      });
      proc.on('close', (code) => {
        if (code === 0) {
          console.log('[Startup] ✓ System optimization completed in background');
        } else {
          console.warn('[Startup] ⚠ System optimization failed (non-critical)');
        }
      });
      proc.on('error', (err) => {
        console.warn('[Startup] ⚠ System optimization error (non-critical):', err.message);
      });
      
      console.log('[Startup] ✓ System optimization started - continuing with startup...');
    } catch (err) {
      console.warn('[Startup] ⚠ System optimization failed to start (non-critical):', err.message);
    }
  } else {
    console.log('[Startup] Step 1: System optimization disabled');
  }

  // Step 1b: macOS MLX specific optimization
  if (process.platform === 'darwin') {
    console.log('[Startup] Step 1b: Running macOS MLX system optimizer...');
    const mlxOptimizer = path.join(scriptsDir, 'mlx_optimize_system.py');
    if (fs.existsSync(mlxOptimizer)) {
      try {
        const pythonCmd = getPythonCmd();
        const { execSync } = await import('child_process');
        execSync(`${pythonCmd} "${mlxOptimizer}" optimize`, {
          timeout: 10000,
          cwd: rootDir,
          stdio: 'inherit'
        });
        console.log('[Startup] ✓ macOS MLX optimization completed');
      } catch (e) {
        console.log('[Startup] MLX optimizer completed (non-zero exit is OK)');
      }
    } else {
      console.log('[Startup] MLX optimizer not found, skipping');
    }
    
    // Check mlx_optimized flag from config
    const configPath = path.join(rootDir, 'config.json');
    let mlxOptimized = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      mlxOptimized = cfg.mlx_optimized === true;
    } catch (e) {
      // Config not readable
    }
    if (!mlxOptimized) {
      console.warn('[Startup] ⚠ Warning: system_optimizer.py has not been run (mlx_optimized=false in config).');
      console.warn('[Startup] ⚠ Run "python3 scripts/system_optimizer.py" for best macOS performance.');
    }
  }

  // Step 2: Auto-load model
  if (startupCfg.auto_load_model !== false) {
    console.log('[Startup] Step 2: Scanning for models to auto-load...');
    try {
      const files = fs.readdirSync(modelsDir);
      const isMac = os.platform() === 'darwin' && os.arch() === 'arm64';
      
      // Find candidate models
      let candidates = [];
      for (const f of files) {
        const fullPath = path.join(modelsDir, f);
        const stats = fs.statSync(fullPath);
        
        if (stats.isDirectory()) {
          // MLX model directory
          const hasConfig = fs.existsSync(path.join(fullPath, 'config.json'));
          const hasWeights = fs.existsSync(path.join(fullPath, 'model.safetensors')) || 
                            fs.existsSync(path.join(fullPath, 'weights.npz'));
          if (hasConfig && hasWeights) {
            candidates.push({ name: f, path: fullPath, isDirectory: true });
          }
        } else {
          const ext = path.extname(f).toLowerCase();
          // On macOS, MLX models are directories (handled above), not files
          // On other platforms, look for GGUF files
          if (!isMac && ext === '.gguf') {
            candidates.push({ name: f, path: fullPath, isDirectory: false });
          }
        }
      }

      // If default_model specified, try that first
      let targetModel = null;
      if (startupCfg.default_model) {
        const defaultPath = path.join(modelsDir, startupCfg.default_model);
        if (fs.existsSync(defaultPath)) {
          targetModel = { name: startupCfg.default_model, path: defaultPath, isDirectory: fs.statSync(defaultPath).isDirectory() };
        } else {
          console.warn(`[Startup] ⚠ Default model '${startupCfg.default_model}' not found`);
        }
      }

      // Fall back to first candidate
      if (!targetModel && candidates.length > 0) {
        targetModel = candidates[0];
      }

      if (targetModel) {
        console.log(`[Startup] Auto-loading model: ${targetModel.name}`);
        
        // Use the /api/router/load logic inline
        const id = Math.random().toString(36).substring(7);
        const port = nextPort++;
        
        const modelInfo = {
          id,
          name: path.basename(targetModel.path),
          port,
          status: 'loading',
          inference_count: 0
        };
        
        routerModels.set(id, modelInfo);
        
        // Check if port is free before spawning
        if (!await isPortFree(port)) {
          console.error(`[Startup] Port ${port} already in use, skipping model ${targetModel.name}`);
          routerModels.delete(id);
          return;
        }
        
        let proc;
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8')); } catch (e) {}

        if (isMac) {
          const modelDir = targetModel.isDirectory ? targetModel.path : path.dirname(targetModel.path);
          proc = spawn(getPythonCmd(), [path.join(scriptsDir, 'mlx_backend.py'), '--mode', 'api', '--model', modelDir, '--port', port.toString()]);
        } else {
          let llamaServer = path.join(binDir, 'llama-server');
          if (os.platform() === 'win32') llamaServer += '.exe';
          
          if (!fs.existsSync(llamaServer)) {
            routerModels.delete(id);
            return res.status(500).json({ 
              error: 'llama-server binary not found',
              message: `Expected binary at: ${llamaServer}. Please extract llama.cpp release binaries to the bin/ directory.`
            });
          }
          
          // Helper to read config values with defaults
const threads = parseInt(cfg.threads) || 2;
const threadsBatch = parseInt(cfg.threads_batch) || 4;
const ctxSize = parseInt(cfg.ctx_size) || 4096;
const batchSize = parseInt(cfg.batch_size) || 256;
const ubatchSize = parseInt(cfg.ubatch_size) || 256;
const nGpuLayers = parseInt(cfg.n_gpu_layers) ?? 0;
const kvCacheType = cfg.kv_cache_quant || 'q8_0';
const splitMode = cfg.split_mode || 'row';
const defragThold = cfg.defrag_thold ?? 0.1;
const parallelSlots = parseInt(cfg.parallel_slots) || 1;
const httpThreads = parseInt(cfg.http_threads) || 2;
const useMlock = cfg.use_mlock === true;
const contBatching = cfg.cont_batching !== false;

const cmdArgs = [
  '-m', targetModel.path,                       // model path
  '--port', port.toString(),
  '--host', '127.0.0.1',
  '--ctx-size', ctxSize.toString(),
  '--threads', threads.toString(),            // CPU threads for generation
  '--threads-batch', threadsBatch.toString(), // CPU threads for prompt processing
  '--batch-size', batchSize.toString(),       // prompt batch size
  '--ubatch-size', ubatchSize.toString(),     // micro-batch size
  '--split-mode', splitMode,                  // tensor split mode
  '--defrag-thold', defragThold.toString(),   // KV cache defrag threshold
  '--parallel', parallelSlots.toString(),     // parallel request slots
  '--threads-http', httpThreads.toString(),   // HTTP server threads
  '--flash-attn',                             // NO argument — just the flag
  '--cache-type-k', kvCacheType,             // KV key cache quantization
  '--cache-type-v', kvCacheType,             // KV value cache quantization
];

// Continuous batching — enabled by default, only disable if explicitly false
if (contBatching) {
  cmdArgs.push('--cont-batching');
}

// Disable prompt cache — it defaults to 8GB limit on this machine
// Re-enable only if user explicitly sets it in config
if (!promptCache) {
  cmdArgs.push('--no-cache-prompt');
}

// Log actual flags being passed to llama-server
console.log(`[Startup] Launching llama-server with flags:`);
console.log(`[Startup]   ctx-size: ${ctxSize}`);
console.log(`[Startup]   threads: ${threads} / threads-batch: ${threadsBatch}`);
console.log(`[Startup]   n-gpu-layers: ${effectiveGpuLayers || nGpuLayers}`);
console.log(`[Startup]   parallel: ${parallelSlots}`);
console.log(`[Startup]   kv-cache-type: ${kvCacheType}`);
console.log(`[Startup]   mlock: ${useMlock}`);
console.log(`[Startup]   prompt-cache: ${promptCache}`);
console.log(`[Startup]   flash-attn: enabled`);

// mlock — only enable if explicitly true AND we have enough free RAM
// On 16GB machines with iGPU sharing memory, mlock can cause OOM
if (useMlock) {
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const freePercent = freeMem / totalMem;
  if (freePercent > 0.25) {
    // Only mlock if >25% RAM is free — prevents OOM on constrained systems
    cmdArgs.push('--mlock');
  } else {
    console.log('[Startup] Skipping --mlock: less than 25% RAM free');
  }
}

// NUMA: only use if multiple NUMA nodes exist
// --numa distribute is for multi-socket servers ONLY
// Single NUMA node machines (like i3-1005G1) must NOT use this flag
try {
  const { execSync } = await import('child_process');
  const numaNodes = parseInt(
    execSync(
      'cat /sys/devices/system/node/online 2>/dev/null || echo "0"',
      { timeout: 1000 }
    ).toString().trim().split('-').pop()
  ) + 1;
  if (numaNodes > 1) {
    cmdArgs.push('--numa', 'distribute');
    console.log(`[Startup] NUMA: ${numaNodes} nodes detected, enabling distribute mode`);
  } else {
    console.log('[Startup] NUMA: single node, skipping --numa flag');
  }
} catch (e) {
  // Can't detect NUMA — skip the flag to be safe
}

// Check Vulkan capability and set effective GPU layers
const vulkanOk = await checkVulkanCapability();
const effectiveGpuLayers = vulkanOk ? nGpuLayers : 0;
cmdArgs.push('--n-gpu-layers', effectiveGpuLayers.toString());

if (!vulkanOk && nGpuLayers > 0) {
  console.log('[Startup] ⚠ llama-server binary has no Vulkan support — running CPU-only');
  console.log('[Startup] ⚠ For Intel iGPU acceleration, use a Vulkan-compiled llama-server binary');
}

// On Linux: pin to physical cores only using taskset
// Hyperthreaded siblings hurt llama.cpp throughput on 2-core machines
// Physical cores on i3-1005G1 are 0,2 — logical/HT siblings are 1,3
// For other machines: detect physical core IDs dynamically
let finalCmd = llamaServer;
let finalArgs = cmdArgs;

if (os.platform() === 'linux') {
  try {
    // Detect physical core IDs dynamically
    const cpuinfoRaw = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const physicalCores = new Map();
    let currentProcessor = null;
    let currentPhysicalId = null;
    let currentCoreId = null;
    
    for (const line of cpuinfoRaw.split('\n')) {
      if (line.startsWith('processor')) {
        currentProcessor = parseInt(line.split(':')[1].trim());
      } else if (line.startsWith('physical id')) {
        currentPhysicalId = line.split(':')[1].trim();
      } else if (line.startsWith('core id')) {
        currentCoreId = line.split(':')[1].trim();
        const key = `${currentPhysicalId}-${currentCoreId}`;
        if (!physicalCores.has(key)) {
          physicalCores.set(key, currentProcessor);
        }
      }
    }
    
    if (physicalCores.size > 0) {
      const physicalCpuList = Array.from(physicalCores.values()).join(',');
      finalCmd = 'taskset';
      finalArgs = ['-c', physicalCpuList, llamaServer, ...cmdArgs];
      console.log(`[Startup] Pinning llama-server to physical cores: ${physicalCpuList}`);
    }
  } catch (e) {
    console.log('[Startup] taskset pinning skipped:', e.message);
    // Fall through to normal spawn
  }
}

proc = spawn(finalCmd, finalArgs, {
  env: {
    ...process.env,
    // Optimize OpenMP threading for llama.cpp
    OMP_NUM_THREADS: threads.toString(),
    OMP_PROC_BIND: 'close',
    OMP_PLACES: 'cores',
    // Optimize memory allocation
    MALLOC_ARENA_MAX: '2',
    // Disable CPU frequency scaling interference
    GOMP_SPINCOUNT: '0',
  }
});

// Set llama-server to high I/O and CPU priority on Linux
if (os.platform() === 'linux' && proc.pid) {
  try {
    // High CPU priority (nice -5 = slightly above normal, doesn't require root)
    exec(`renice -n -5 -p ${proc.pid} 2>/dev/null || true`);
    // High I/O priority — critical during model load from disk
    exec(`ionice -c 2 -n 0 -p ${proc.pid} 2>/dev/null || true`);
    console.log(`[Startup] Set priority for llama-server PID ${proc.pid}`);
  } catch (e) {
    // Non-fatal — just run at default priority
  }
}

// Set process scheduling to SCHED_BATCH for better throughput
if (os.platform() === 'linux' && proc.pid) {
  try {
    // Set to SCHED_BATCH — better throughput for CPU-bound inference
    exec(`chrt -b -p 0 ${proc.pid} 2>/dev/null || true`);
    console.log(`[Startup] ✓ Process scheduling optimized for PID ${proc.pid}`);
  } catch (e) {
    // Non-fatal
  }
}
        }

        modelInfo.process = proc;

        let attempts = 0;
        const maxAttempts = 60;
        const checkReady = setInterval(async () => {
          if (++attempts > maxAttempts) {
            clearInterval(checkReady);
            clearTimeout(failsafeTimer);
            modelInfo.status = 'error';
            console.error(`[Startup] Model '${targetModel.name}' failed to become ready after 60s`);
            return;
          }
          try {
            const resp = await fetch(`http://127.0.0.1:${port}/v1/models`);
            if (resp.ok) {
              modelInfo.status = 'ready';
              clearInterval(checkReady);
              clearTimeout(failsafeTimer);
              console.log(`[Startup] ✓ Model '${targetModel.name}' loaded and ready on port ${port}`);
            }
          } catch (e) { }
        }, 1000);

        const failsafeTimer = setTimeout(() => {
          clearInterval(checkReady);
          modelInfo.status = 'error';
          console.error(`[Startup] Failsafe timeout hit for model ${targetModel.name}`);
        }, 60000);
        modelInfo.readyCheckInterval = checkReady;
        modelInfo.failsafeTimer = failsafeTimer;

        proc.on('close', () => {
          clearInterval(checkReady);
          clearTimeout(failsafeTimer);
          if (modelInfo.status !== 'unloaded') {
            modelInfo.status = 'error';
          }
        });
      } else {
        console.log('[Startup] No models found to auto-load. Use /api/router/load to load a model manually.');
      }
    } catch (err) {
      console.warn('[Startup] ⚠ Auto-load error:', err.message);
    }
  } else {
    console.log('[Startup] Step 2: Auto-load skipped (disabled in config)');
  }

  console.log('[Startup] Pipeline complete');
}

// ===== DUAL-PORT SERVER STARTUP =====

// Secondary server: management-only (no /v1 proxy)
const mgmtOnlyApp = express();
mgmtOnlyApp.use(cors());
mgmtOnlyApp.use(express.json());
mgmtOnlyApp.use('/api', apiRouter);

const secondaryServer = mgmtOnlyApp.listen(SECONDARY_PORT, '127.0.0.1', () => {
  console.log(`[API Server] ✓ Secondary (management) listening on http://127.0.0.1:${SECONDARY_PORT}`);
});

secondaryServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[API Server] ⚠ Secondary port ${SECONDARY_PORT} in use, management-only endpoint unavailable`);
  }
});

// Primary server: inference + management
app.use('/api', apiRouter);

// ===== /V1 ENDPOINTS FOR EXTENSION COMPATIBILITY =====

// === Enriched /v1/models endpoint (for Continue/Cline) ===
app.get('/v1/models', (req, res) => {
  try {
    const readyModel = Array.from(routerModels.values()).find(m => m.status === 'ready');
    
    if (!readyModel) {
      // No model loaded - return empty list with 200 OK (not 502)
      return res.status(200).json({
        object: 'list',
        data: []
      });
    }
    
    // Get model filename without extension
    const modelId = readyModel.name ? path.basename(readyModel.name, path.extname(readyModel.name)) : 'local-model';
    const now = Math.floor(Date.now() / 1000);
    
    res.json({
      object: 'list',
      data: [{
        id: modelId,
        object: 'model',
        created: now,
        owned_by: 'lumina-edge',
        capabilities: {
          completion: true,
          chat_completion: true,
          tool_calling: true,
          streaming: true
        }
      }]
    });
  } catch (err) {
    console.error('[/v1/models] Error:', err.message);
    res.status(200).json({ object: 'list', data: [] });
  }
});

// === Tool-calling middleware and /v1/chat/completions route ===

// Helper: Parse tool_calls from model response text
function extractToolCall(text) {
  // Look for JSON pattern: {"tool_call": {"name": "...", "arguments": {...}}}
  // More robust regex that handles nested objects
  const toolCallMatch = text.match(/\{\"tool_call\"\s*:\s*\{\s*\"name\"\s*:\s*\"([^\"]+)\"[^}]*\"arguments\"\s*:\s*(\{(?:[^{}]|(?:\{[^}]*\}))*\})/);
  if (toolCallMatch) {
    try {
      const name = toolCallMatch[1];
      const argsJson = toolCallMatch[2];
      return {
        id: `call_${Math.random().toString(36).substring(7)}`,
        type: 'function',
        function: {
          name: name,
          arguments: argsJson
        }
      };
    } catch (e) {
      return null;
    }
  }
  return null;
}

// Helper: Format system message with tools
function formatToolSystemPrompt(tools) {
  if (!tools || tools.length === 0) return '';
  
  let toolDesc = '\nYou are a helpful assistant with access to the following tools. ';
  toolDesc += 'When you need to use a tool, respond with ONLY a JSON block in this exact format:\n';
  toolDesc += '{"tool_call": {"name": "<tool_name>", "arguments": {<args>}}}\n\n';
  toolDesc += 'Available tools:\n';
  
  for (const tool of tools) {
    if (tool.type === 'function') {
      const func = tool.function;
      toolDesc += `${func.name}: ${func.description}\n`;
      if (func.parameters) {
        toolDesc += `Parameters: ${JSON.stringify(func.parameters, null, 2)}\n`;
      }
    }
  }
  
  return toolDesc;
}

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const readyModel = Array.from(routerModels.values()).find(m => m.status === 'ready');
    if (!readyModel) {
      return res.status(502).json({ error: 'No models currently loaded. Port 8000 is inactive.' });
    }

    const targetPort = readyModel.port;
    const targetUrl = `http://127.0.0.1:${targetPort}/v1/chat/completions`;
    const body = { ...req.body };
    const hasTools = body.tools && Array.isArray(body.tools) && body.tools.length > 0;

    // If tools are present, inject them as system prompt and force non-streaming
    if (hasTools) {
      const toolPrompt = formatToolSystemPrompt(body.tools);
      
      // Inject tool prompt into system message or create one
      if (!body.messages) body.messages = [];
      const systemMsgIdx = body.messages.findIndex(m => m.role === 'system');
      
      if (systemMsgIdx >= 0) {
        body.messages[systemMsgIdx].content = (body.messages[systemMsgIdx].content || '') + toolPrompt;
      } else {
        body.messages.unshift({ role: 'system', content: toolPrompt });
      }
      
      // Remove tools from request (we've injected them into system prompt)
      delete body.tools;
      
      // Force non-streaming for tool calls
      body.stream = false;
    }

    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });

    // Parse and potentially modify response
    const responseData = await response.json();

    // If tools were requested, try to parse tool_calls from response
    if (hasTools && responseData.choices && responseData.choices.length > 0) {
      const choice = responseData.choices[0];
      if (choice.message && choice.message.content) {
        const toolCall = extractToolCall(choice.message.content);
        if (toolCall) {
          // Replace content with null and add tool_calls
          choice.message.content = null;
          choice.message.tool_calls = [toolCall];
          choice.finish_reason = 'tool_calls';
        }
      }
    }

    res.status(response.status).json(responseData);
  } catch (err) {
    console.error('[/v1/chat/completions] Error:', err.message);
    res.status(500).json({ error: 'Chat completions failed', message: err.message });
  }
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

const server = app.listen(PRIMARY_PORT, '127.0.0.1', () => {
  console.log(`[API Server] ✓ Primary (inference + management) listening on http://127.0.0.1:${PRIMARY_PORT}`);
  console.log(`[API Server] Running startup pipeline...`);
  runStartupPipeline().then(() => {
    console.log(`[API Server] Ready to accept connections`);
  });
});

// Handle startup errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[API Server] ✗ Port ${PRIMARY_PORT} is already in use`);
    console.error(`[API Server] Make sure no other Lumina Edge instance is running`);
  } else {
    console.error(`[API Server] ✗ Server error:`, err.message);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[API Server] Shutting down...');
  // Unload all models first
  for (const [id, modelInfo] of routerModels) {
    if (modelInfo.readyCheckInterval) clearInterval(modelInfo.readyCheckInterval);
    if (modelInfo.failsafeTimer) clearTimeout(modelInfo.failsafeTimer);
    if (modelInfo.process) {
      try { modelInfo.process.kill('SIGTERM'); } catch (e) {}
    }
  }
  routerModels.clear();
  secondaryServer.close();
  server.close(() => {
    console.log('[API Server] Closed both ports');
    process.exit(0);
  });
});
