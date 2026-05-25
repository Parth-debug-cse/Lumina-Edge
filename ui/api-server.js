import express from 'express';
import cors from 'cors';
import { spawn, exec, execFile, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import http from 'http';
import { Router } from 'express';

// Separate router for /api/* routes — can be mounted on both primary and secondary servers
const apiRouter = Router();

const app = express();
app.use(cors());
app.use(express.json());

// Create __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root paths — anchored to this file's location, NOT cwd
const rootDir = path.resolve(__dirname, '..');
const scriptsDir = path.join(rootDir, 'scripts');
const modelsDir = path.join(rootDir, 'models');
const binDir = path.join(rootDir, 'bin');

// Get Python executable - prefer venv if it exists
// Pick python vs python3 depending on platform
function getPythonCmd() {
  return os.platform() === 'win32' ? 'python' : 'python3';
}

console.log('[API Server] Starting Lumina Edge API Gateway');
console.log('[API Server] Root directory:', rootDir);
console.log('[API Server] Models directory:', modelsDir);

// _vulkanCapable cache — checked once via `strings | grep -i vulkan` on llama-server binary, cached forever
let _vulkanCapable = null;

async function checkVulkanCapability() {
  if (_vulkanCapable !== null) return _vulkanCapable;
  if (os.platform() !== 'linux') { _vulkanCapable = false; return false; }
  
  try {
    const llamaServer = path.join(binDir, 'llama-server');
    if (!fs.existsSync(llamaServer)) { _vulkanCapable = false; return false; }
    
    // Grep binary strings for Vulkan symbols — slow check, but runs exactly once
    const { execSync } = await import('child_process');
    const symbols = execSync(`strings "${llamaServer}" 2>/dev/null | grep -i vulkan | head -5`, {
      timeout: 3000
    }).toString();
    
    _vulkanCapable = symbols.toLowerCase().includes('vulkan');
    console.log(`[Router] Vulkan capability: ${_vulkanCapable}`);
  } catch (e) {
    _vulkanCapable = false; // Silent failure — fall back to CPU-only
  }
  
  return _vulkanCapable;
}

// Spawns system_optimizer.py, reloads config on completion
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

    result.on('error', (err) => {
      console.error(`[Optimizer] Spawn error: ${err.message}`);
    });

    result.on('close', (code) => {
      if (code === 0) {
        console.log('[Optimizer] ✓ Dynamic hardware optimization completed');
        // Reload config after optimization (cache will pick up mtime change)
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

// Linux prelaunch script — runs system-level tunables on startup
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

// Cleanup handlers — kill llama-server processes on exit to prevent orphans
process.on('exit', killAllModels);
process.on('SIGINT', () => { killAllModels(); process.exit(0); });
process.on('SIGTERM', () => { killAllModels(); process.exit(0); });
process.on('uncaughtException', (err) => { 
  console.error('[Fatal]', err); 
  killAllModels(); 
  process.exit(1); 
});

// Nuke all model processes — clears intervals, timers, then SIGKILL
function killAllModels() {
  for (const [, m] of routerModels) {
    if (m.readyCheckInterval) clearInterval(m.readyCheckInterval);
    if (m.failsafeTimer) clearTimeout(m.failsafeTimer);
    try { m.process?.kill('SIGKILL'); } catch {}
  }
}

// Test port availability by creating a temporary listening socket
function isPortFree(port) {
  return new Promise(resolve => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

// Kill zombie llama-server from previous session using lsof/ss
async function killProcessOnPort(port) {
  if (os.platform() === 'win32') return false; // lsof/ss not available, skip
  try {
    const result = execSync(`lsof -ti :${port} 2>/dev/null || ss -tlnp sport = :${port} 2>/dev/null | grep -oP 'pid=\\K\\d+' | head -1`, { timeout: 3000 }).toString().trim();
    if (result) {
      const pids = result.split('\n').filter(Boolean);
      for (const pid of pids) {
        console.log(`[Port Cleanup] Killing zombie process PID ${pid} on port ${port}`);
        try { execSync(`kill -9 ${pid} 2>/dev/null`); } catch {}
      }
      return true;
    }
  } catch {}
  return false;
}

// Clean up models stuck in error/loading from a previous process crash
function clearStaleModelState() {
  for (const [id, modelInfo] of routerModels) {
    if (modelInfo.status === 'error' || modelInfo.status === 'loading') {
      if (modelInfo.readyCheckInterval) clearInterval(modelInfo.readyCheckInterval);
      if (modelInfo.failsafeTimer) clearTimeout(modelInfo.failsafeTimer);
      try { modelInfo.process?.kill('SIGKILL'); } catch {}
      routerModels.delete(id);
      console.log(`[Startup] Cleared stale model state: ${modelInfo.name} (id: ${id}, status: ${modelInfo.status})`);
    }
  }
}

// Ensure models directory exists
if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
  console.log('[API Server] Created models directory');
}

// Global state maps
const conversionJobs = new Map(); // file -> status
const downloadJobs = new Map(); // filename -> { status, error, progress }
const routerModels = new Map(); // id -> model info
let routingPolicy = 'round-robin';
let nextPort = 8000;

// Find next available port in the 8000-9000 range
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

// Load config to get port settings (loadConfig needs to be hoisted above usage)
const config = loadConfig();
// Dual-port setup: PRIMARY_PORT (8090) for inference+management, SECONDARY_PORT (8081) for management-only
const PRIMARY_PORT = parseInt(process.env.LUMINA_API_PORT) || config.api_port || 8090;
const SECONDARY_PORT = parseInt(process.env.LUMINA_API_PORT_SECONDARY) || config.api_port_secondary || 8081;

// Config caching — checks mtime for hot reload, avoids repeated file reads
var cachedConfig = null;
var configTimestamp = 0;

function loadConfig() {
  try {
    const stats = fs.existsSync(configPath) ? fs.statSync(configPath) : null;
    // Only re-read if file was modified since last load
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
    configTimestamp = Date.now(); // Reset cache timestamp so next loadConfig() returns this
    return true;
  } catch (err) {
    console.error('[Config] Failed to save config:', err.message);
    return false;
  }
}

function isConvertibleFile(filename) {
  return convertibleExtensions.includes(path.extname(filename).toLowerCase());
}

// Target format depends on platform: macOS/ARM64 → MLX, everything else → GGUF
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

// Convenience helper — is this macOS ARM64?
function isMac() {
  return os.platform() === 'darwin' && os.arch() === 'arm64';
}

// Spawns model-converter.py, parses PROGRESS: N% from stdout for UI progress bar
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

  proc.on('error', (err) => {
    console.error(`[Converter] Spawn error: ${err.message}`);
  });

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
// Simple liveness probe — no auth, no DB dependency

apiRouter.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Report which model formats this platform supports
apiRouter.get('/supported-formats', (req, res) => {
  res.json({
    formats: isMac() ? ['safetensors', 'mlx'] : ['gguf', 'safetensors', 'bin', 'pt'],
    converter_available: fs.existsSync(getScriptPath('model-converter.py'))
  });
});

// === SYSTEM INFO ===
// Platform detection, backend type (mlx vs llama.cpp), and chat URL resolution

apiRouter.get('/system-info', (req, res) => {
  const mac = isMac();
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    isMacAppleSilicon: mac,
    backend: mac ? 'mlx' : 'llama.cpp'
  });
});

// Tell the frontend which URL to open for chat
// macOS → OpenWebUI on port 3000; Linux → llama-server port of first ready model
apiRouter.get('/chat-url', (req, res) => {
  const mac = isMac();
  let chatUrl;
  if (mac) {
    chatUrl = `http://127.0.0.1:${process.env.LUMINA_OW_PORT || 3000}`;
  } else {
    // Linux/Windows: use the port of the first ready model
    const readyModel = Array.from(routerModels.values()).find(m => m.status === 'ready');
    if (readyModel) {
      chatUrl = `http://127.0.0.1:${readyModel.port}`;
    } else {
      // No model loaded — return API gateway root (proxies to backend)
      chatUrl = `http://127.0.0.1:${PRIMARY_PORT}`;
    }
  }
  res.json({ url: chatUrl, platform: os.platform(), modelLoaded: !!Array.from(routerModels.values()).find(m => m.status === 'ready') });
});

// Open chat URL in system browser — platform-aware dispatch
apiRouter.post('/open-chat', (req, res) => {
  const platform = os.platform();
  const url = platform === 'darwin'
    ? 'http://localhost:3000'
    : 'http://localhost:8000';

  try {
    let openCmd;
    if (platform === 'linux') {
      openCmd = `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || x-www-browser "${url}" 2>/dev/null`;
    } else if (platform === 'darwin') {
      openCmd = `open "${url}"`;
    } else {
      openCmd = `start "${url}"`;
    }
    exec(openCmd, (err) => {
      if (err) console.log(`[Open Chat] Browser open failed: ${err.message}`);
      else console.log(`[Open Chat] Opened ${url}`);
    });
    res.json({ status: 'opened', url });
  } catch (err) {
    res.json({ status: 'opened', url });
  }
});

// Get current optimized configuration from cached config
apiRouter.get('/optimized-config', (req, res) => {
  const config = loadConfig();
  res.json({
    ctx_size: config.ctx_size,
    batch_size: config.batch_size,
    ubatch_size: config.ubatch_size,
    n_gpu_layers: config.n_gpu_layers,
    gpu_type: config.gpu_type,
    http_threads: config.http_threads,
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

  result.on('error', (err) => {
    console.error(`[Reoptimize] Spawn error: ${err.message}`);
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
// Get current context size and memory-based safe upper bound
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

// Adjust context size at runtime — enforces 4096 min, sanity checks vs free RAM
// NOTE: requires model restart to take effect
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

// Get detailed hardware information — runs system_optimizer.py --print-info, falls back to os.*
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

  proc.on('error', (err) => {
    console.error(`[HardwareInfo] Spawn error: ${err.message}`);
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
          ctx_size: config.ctx_size,
          batch_size: config.batch_size,
          n_gpu_layers: config.n_gpu_layers,
          gpu_type: config.gpu_type,
          http_threads: config.http_threads
        },
        raw_output: output
      });
    } else {
      res.status(500).json({ error: 'Failed to get hardware info' });
    }
  });
});

// === HUGGINGFACE REPO BROWSING ===
// Fetches HF API repo tree, filters for model weights + JSON configs

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

// Scan models/ for MLX directories (config.json + weights) and loose GGUF/safetensors files
apiRouter.get('/models/list', (req, res) => {
  try {
    const files = fs.readdirSync(modelsDir);
    const models = [];
    
    for (const f of files) {
      const fullPath = path.join(modelsDir, f);
      const stats = fs.statSync(fullPath);
      
      if (stats.isDirectory()) {
        // Detect MLX model directory: has config.json + .safetensors or .npz files
        const hasConfig = fs.existsSync(path.join(fullPath, 'config.json'));
        // Check for model.safetensors, weights.*.safetensors, or weights.npz
        const modelFiles = fs.readdirSync(fullPath).filter(n => n.endsWith('.safetensors') || n.endsWith('.npz'));
        const hasWeights = modelFiles.length > 0;
        
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

// Config CRUD — read/write config.json
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

// Check whether a given file path exists on disk
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

// List files convertible to target format — filters by convertibleExtensions
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

// Convert a model via model-converter.py
apiRouter.post('/convert-model', (req, res) => {
  const { input_file, quantization, format } = req.body;
  if (!input_file) return res.status(400).send('input_file required');

  const result = createConversionJob(input_file, quantization || 'Q4_K_M', format);
  res.json(result);
});

// Quantization endpoint — uses mlx-lm on macOS, llama.cpp quantize elsewhere
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

  proc.on('error', (err) => {
    console.error(`[Quantizer] Spawn error: ${err.message}`);
  });

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

// Poll conversion job status
apiRouter.get('/conversion-status', (req, res) => {
  const input = req.query.input;
  if (!input) return res.status(400).send('input required');
  const job = conversionJobs.get(input);
  if (job) return res.json(job);
  res.json({ status: 'unknown' });
});

// Estimate conversion memory requirements
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

// Convert model with shard-aware handling
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
// Determine if a model is sharded (multiple .safetensors files) and its memory footprint

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
// Run optimize_system.py and return output

apiRouter.post('/system/optimize', (req, res) => {
  const pythonCmd = getPythonCmd();
  const scriptPath = path.join(scriptsDir, 'optimize_system.py');
  
  console.log('[System Optimizer] Starting optimization...');
  
  const proc = spawn(pythonCmd, [scriptPath]);
  proc.on('error', (err) => {
    console.error(`[System Optimizer] Spawn error: ${err.message}`);
  });
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

// Benchmark inference speed by sending N runs to a loaded model and reporting tokens/sec
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

// 3-second cache for resource monitor to avoid hammering Python subprocess
let resourceCache = { data: null, ts: 0 };

// Spawn resource_monitor.py, cached for 3s
apiRouter.get('/system/resources', (req, res) => {
  const now = Date.now();
  if (resourceCache.data && now - resourceCache.ts < 3000) {
    return res.json(resourceCache.data);
  }

  const pythonCmd = getPythonCmd();
  const scriptPath = path.join(scriptsDir, 'resource_monitor.py');
  const proc = spawn(pythonCmd, [scriptPath, 'snapshot']);

  proc.on('error', (err) => {
    console.error(`[Resources] Spawn error: ${err.message}`);
  });

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

// Run inference diagnostics script
apiRouter.get('/inference/diagnose', (req, res) => {
  const pythonCmd = getPythonCmd();
  const scriptPath = path.join(scriptsDir, 'inference_diagnostics.py');
  const proc = spawn(pythonCmd, [scriptPath, 'diagnose']);

  proc.on('error', (err) => {
    console.error(`[Diagnose] Spawn error: ${err.message}`);
  });
  
  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { output += data.toString(); });
  proc.on('close', (code) => {
    res.json({ success: code === 0, output });
  });
});

// Generate inference benchmark report
apiRouter.get('/inference/report', async (req, res) => {
  const port = parseInt(req.query.port) || 8000;
  const maxTokens = parseInt(req.query.max_tokens) || 64;
  const pythonCmd = getPythonCmd();
  const scriptPath = path.join(scriptsDir, 'inference_diagnostics.py');
  const proc = spawn(pythonCmd, [scriptPath, 'report', '--port', port.toString(), '--max-tokens', maxTokens.toString()]);

  proc.on('error', (err) => {
    console.error(`[Report] Spawn error: ${err.message}`);
  });
  
  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { output += data.toString(); });
  proc.on('close', (code) => {
    res.json({ success: code === 0, output });
  });
});

// === GPU BENCHMARK ===
// Full GPU benchmark with configurable layer counts — tests [0, 10, 20, 30, 50, 99] layers by default

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
  proc.on('error', (err) => {
    console.error(`[Benchmark] Spawn error: ${err.message}`);
  });
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

// Quick single-run benchmark
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
  proc.on('error', (err) => {
    console.error(`[QuickBench] Spawn error: ${err.message}`);
  });
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

// Estimate memory usage for a given model + context config
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

// Recommend optimal ctx_size given available memory
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

// Compare KV cache quantization strategies side by side
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

// Status of all loaded models — enriched view for the UI
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

// Minimal model list (no PIDs, no inference count)
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

// Get the port of the first ready model (quick check for the frontend)
apiRouter.get('/router/active-port', (req, res) => {
  const ready = Array.from(routerModels.values()).find(m => m.status === 'ready');
  if (!ready) return res.status(502).json({ error: 'No model ready' });
  res.json({ port: ready.port, model: ready.name, id: ready.id });
});

// SSE client management — broadcasts model status changes in real time to connected UIs
const sseClients = new Set();

function broadcastModelStatus(modelId, status, port, error = null) {
  const data = JSON.stringify({ modelId, status, port, error, timestamp: Date.now() });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// SSE endpoint for real-time model status updates
apiRouter.get('/router/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const origin = req.headers.origin || '';
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  sseClients.add(res);
  console.log(`[SSE] Client connected. Total clients: ${sseClients.size}`);

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected. Total clients: ${sseClients.size}`);
  });
});

// List available routes (ready model endpoints)
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

// Set routing policy (round-robin, load-balanced, first-available)
apiRouter.post('/router/policy', (req, res) => {
  const { policy } = req.body;
  if (['round-robin', 'load-balanced', 'first-available'].includes(policy)) {
    routingPolicy = policy;
    res.json({ status: 'success', policy });
  } else {
    res.status(400).json({ error: 'Invalid policy' });
  }
});

// === LOAD MODEL (THE KEY ENDPOINT) ===
// Loads a model via MLX backend (macOS) or llama-server (Linux/Windows).
// Handles: path validation, port allocation, Vulkan check, NUMA detection,
// taskset pinning, OpenMP env vars, priority tuning, ready polling (60s timeout).

apiRouter.post('/router/load', async (req, res) => {
  console.log(`[DEBUG] /api/router/load called with body:`, JSON.stringify(req.body));
  const { model_path, port_offset } = req.body;
  if (!model_path) {
    console.error('[DEBUG] model_path is missing from request body');
    return res.status(400).json({ error: 'model_path is required' });
  }
  if (port_offset) {
    console.log(`[api-server] port_offset received but parallel loading not yet implemented: ${port_offset}`);
  }
  console.log('[Router Load] Received model_path:', model_path);
  
  const isMacPlatform = os.platform() === 'darwin' && os.arch() === 'arm64';
  let targetPath = path.isAbsolute(model_path) ? model_path : path.join(modelsDir, model_path);
  
  console.log('[Router Load] Resolved targetPath:', targetPath);
  console.log('[Router Load] File exists:', fs.existsSync(targetPath));
  
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Model not found' });

  // macOS path validation: verify MLX model dir has config.json + .safetensors
  let stats;
  if (isMacPlatform) {
    stats = fs.statSync(targetPath);
    if (stats.isDirectory()) {
      const hasConfig = fs.existsSync(path.join(targetPath, 'config.json'));
      const hasSafetensors = fs.readdirSync(targetPath).some(f => f.endsWith('.safetensors'));
      if (!hasConfig || !hasSafetensors) {
        return res.status(400).json({ 
          error: `Directory ${targetPath} does not appear to be a valid MLX model (missing config.json or .safetensors files)` 
        });
      }
      console.log(`[Router] macOS: Loading MLX model directory: ${targetPath}`);
    }
    
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

  // Find available port (starts at nextPort, searches upward)
  let port = await findAvailablePort();

  // If port is occupied, kill zombie process and retry once
  if (!await isPortFree(port)) {
    console.log(`[Router Load] Port ${port} is occupied, attempting cleanup...`);
    await killProcessOnPort(port);
    // Give the OS a moment to release the port
    await new Promise(r => setTimeout(r, 500));
    if (!await isPortFree(port)) {
      console.log(`[Router Load] Port ${port} still occupied after cleanup, finding another...`);
      port = await findAvailablePort();
    }
  }
  console.log(`[Router Load] Using port: ${port}`);

  // Create model entry in state map — status starts at 'loading'
  const id = Math.random().toString(36).substring(7);
  const modelInfo = { 
    id, 
    name: path.basename(targetPath), 
    path: targetPath, 
    port, 
    status: 'loading',
    inference_count: 0,  // BUG-C1 FIX: was missing — caused NaN in /api/router/status total_inferences
    loaded_at: new Date().toISOString()
  };
  routerModels.set(id, modelInfo);

  let proc;

  // macOS branch: spawn MLX Python backend
  if (isMacPlatform) {
    const pythonCmd = getPythonCmd();
    const modelDir = stats.isFile() ? path.dirname(targetPath) : targetPath;

    // Spawn MLX backend with stable env (strip OMP vars — MLX doesn't use them)
    try {
      proc = spawn(pythonCmd, [
        path.join(scriptsDir, 'mlx_backend.py'),
        '--mode', 'api',
        '--model', modelDir,
        '--port', port.toString()
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OMP_NUM_THREADS: undefined, OMP_PROC_BIND: undefined, GOMP_SPINCOUNT: undefined, MALLOC_ARENA_MAX: undefined }
      });

      proc.stdout.on('data', (data) => {
        console.log(`[MLX stdout]: ${data}`);
      });

      proc.stderr.on('data', (data) => {
        console.error(`[MLX stderr]: ${data}`);
      });

      proc.on('error', (err) => {
        console.error(`[MLX] Spawn error:`, err.message);
        modelInfo.status = 'error';
      });

      proc.on('close', (code) => {
        console.log(`[MLX] Process exited with code ${code}`);
        if (modelInfo.status !== 'unloaded') {
          modelInfo.status = 'error';
        }
      });

      // Wait up to 2 minutes for the MLX backend to load the model
      const MAX_RETRIES = 60;
      const RETRY_DELAY = 2000;
      let backendReady = false;
      let lastError = null;
      let mlxStderr = '';

      // Accumulate stderr for error reporting if startup fails
      proc.stderr.on('data', (data) => {
        mlxStderr += data.toString();
      });

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const httpClient = http;
          await new Promise((resolve, reject) => {
            let body = '';
            const req = httpClient.get(`http://127.0.0.1:${port}/v1/models`, (resp) => {
              resp.on('data', (chunk) => { body += chunk; });
              resp.on('end', () => {
                if (resp.statusCode === 200) {
                  backendReady = true;
                  resolve();
                } else {
                  // Try to extract the actual MLX error from the response body for better diagnostics
                  let detail = `Status ${resp.statusCode}`;
                  try {
                    const parsed = JSON.parse(body);
                    if (parsed.detail) detail = parsed.detail;
                    else if (parsed.error) detail = parsed.error;
                  } catch {}
                  reject(new Error(detail));
                }
              });
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
          });
          if (backendReady) break;
        } catch (e) {
          lastError = e.message;
          console.log(`[MLX] Waiting for model to load... (attempt ${attempt + 1}/${MAX_RETRIES}, detail: ${e.message})`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
      }

      if (!backendReady) {
        modelInfo.status = 'error';
        if (proc && !proc.killed) proc.kill();
        return res.status(500).json({
          error: 'MLX backend failed to start',
          detail: lastError || 'Unknown error',
          stderr: mlxStderr.slice(-2000)
        });
      }

      modelInfo.process = proc;
      modelInfo.status = 'ready';
      return res.json({ success: true, message: `Model loaded on port ${port}`, port, id });

    } catch (err) {
      routerModels.delete(id);
      return res.status(500).json({
        error: 'Failed to start MLX backend',
        detail: err.message
      });
    }
  } else {
    // Linux/Windows branch: spawn llama-server
    let llamaServer = path.join(binDir, 'llama-server');
    if (os.platform() === 'win32') llamaServer += '.exe';
    
    if (!fs.existsSync(llamaServer)) {
      routerModels.delete(id);
      return res.status(500).json({ 
        error: 'llama-server binary not found',
        message: `Expected binary at: ${llamaServer}. Please extract llama.cpp release binaries to the bin/ directory.`
      });
    }

    // Verify llama-server is executable (chmod +x check on Linux)
    if (os.platform() === 'linux') {
      try {
        fs.accessSync(llamaServer, fs.constants.X_OK);
      } catch (e) {
        routerModels.delete(id);
        return res.status(500).json({
          error: 'llama-server is not executable',
          message: `Run: chmod +x ${llamaServer}`
        });
      }
    }
    
    // Context size safety clamp: min 512, max 32768 (prevents OOM on 16GB machines)
const ctxSize = (() => {
  const val = parseInt(config.ctx_size);
  if (!val || isNaN(val) || val < 512) return 4096; // safe minimum
  return Math.min(val, 32768); // cap at 32K — beyond this is memory waste on 16GB
})();
const batchSize = parseInt(config.batch_size) || 256;
const ubatchSize = parseInt(config.ubatch_size) || 256;
const nGpuLayers = parseInt(config.n_gpu_layers) || 999; // 999 = offload as many layers as GPU can hold, rest fall back to CPU
const kvCacheTypeK = config.kv_cache_type_k || config.kv_cache_quant || 'q4_0';
const kvCacheTypeV = config.kv_cache_type_v || config.kv_cache_quant || 'q4_0';
const splitMode = config.split_mode || 'row';
const httpThreads = parseInt(config.http_threads) || 2;
const useMlock = config.use_mlock === true;
const contBatching = config.cont_batching !== false;
const promptCache = config.prompt_cache === true;

// Check Vulkan capability and set effective GPU layers (needed for logging below)
const vulkanOk = await checkVulkanCapability();
const effectiveGpuLayers = vulkanOk ? nGpuLayers : 0;

const cmdArgs = [
  '-m', targetPath,                           // model path
  '--port', port.toString(),
  '--host', '127.0.0.1',
  '--ctx-size', ctxSize.toString(),
  '--batch-size', batchSize.toString(),       // prompt batch size
  '--ubatch-size', ubatchSize.toString(),     // micro-batch size
  '--split-mode', splitMode,                  // tensor split mode
  '--threads-http', httpThreads.toString(),   // HTTP server threads
  '--flash-attn', 'on',                       // Flash Attention enabled
  '--cache-type-k', kvCacheTypeK,            // KV key cache quantization
  '--cache-type-v', kvCacheTypeV,            // KV value cache quantization
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
console.log(`[Router]   n-gpu-layers: ${effectiveGpuLayers || nGpuLayers}`);
console.log(`[Router]   kv-cache-type-k: ${kvCacheTypeK}, kv-cache-type-v: ${kvCacheTypeV}`);
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

// Vulkan capability already checked earlier, use those results
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
  }
}

// Pre-spawn log — must appear in terminal immediately
console.log(`[Lumina] Spawning llama.cpp for model: ${path.basename(targetPath)} on port ${port}`);
console.log(`[Lumina] Binary: ${finalCmd}, Args: ${finalArgs.slice(0, 6).join(' ')}...`);

proc = spawn(finalCmd, finalArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    // Optimize OpenMP threading for llama.cpp
    OMP_NUM_THREADS: httpThreads.toString(),
    OMP_PROC_BIND: 'close',
    OMP_PLACES: 'cores',
    // Optimize memory allocation
    MALLOC_ARENA_MAX: '2',
    // Disable CPU frequency scaling interference
    GOMP_SPINCOUNT: '0',
  }
});

// Capture stdout in real time
proc.stdout.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.log(`[llama-server] ${text}`);
});

// Capture stderr in real time — critical for diagnosing crashes
proc.stderr.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.error(`[llama-server ERR] ${text}`);
});

proc.on('error', (err) => {
  console.error(`[Router] Spawn error for llama-server: ${err.message}`);
  modelInfo.status = 'error';
  broadcastModelStatus(id, 'error', port, err.message);
});

// Set llama-server to high I/O and CPU priority on Linux
if (os.platform() === 'linux' && proc.pid) {
  try {
    exec(`renice -n -5 -p ${proc.pid} 2>/dev/null || true`);
    exec(`ionice -c 2 -n 0 -p ${proc.pid} 2>/dev/null || true`);
    console.log(`[Router] Set priority for llama-server PID ${proc.pid}`);
  } catch (e) {
    // Non-fatal
  }
}

// Set process scheduling to SCHED_BATCH for better throughput
if (os.platform() === 'linux' && proc.pid) {
  try {
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
      broadcastModelStatus(id, 'error', port, 'Model failed to become ready after 60s');
      return;
    }
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (resp.ok) {
        modelInfo.status = 'ready';
        clearInterval(checkReady);
        clearTimeout(failsafeTimer);
        console.log(`[Router] Model ${modelInfo.name} is ready on port ${port}`);
        broadcastModelStatus(id, 'ready', port);
      }
    } catch (e) { }
  }, 1000);

  // Failsafe
  const failsafeTimer = setTimeout(() => {
    clearInterval(checkReady);
    modelInfo.status = 'error';
    console.error(`[Router] Failsafe timeout hit for model ${modelInfo.name}`);
    broadcastModelStatus(id, 'error', port, 'Failsafe timeout - model failed to load');
  }, 60000);

  // Store interval ref so we can clear it on unload
  modelInfo.readyCheckInterval = checkReady;
  modelInfo.failsafeTimer = failsafeTimer;

  res.json({ status: 'success', id, port });
});

// Graceful unload: SIGTERM → 5s → SIGKILL escalation
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

// Bulk unload all models
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
// Handles single file downloads (fetch + ReadableStream → fs.createWriteStream)
// and full repo downloads (huggingface_hub snapshot_download via inline Python).
// macOS: rejects GGUF files (must use MLX/safetensors).

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

// Get download status for a specific file (progress, error, complete)
apiRouter.get('/download-status', (req, res) => {
  const { filename } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  
  const job = downloadJobs.get(filename);
  if (!job) {
    // Check if file exists (download completed successfully)
    const outputPath = path.join(modelsDir, filename);
    if (fs.existsSync(outputPath)) {
      return res.json({ status: 'complete', progress: 100, error: null });
    }
    return res.json({ status: 'unknown' });
  }
  res.json(job);
});

// Get all download jobs
apiRouter.get('/download-jobs', (req, res) => {
  const jobs = Array.from(downloadJobs.entries()).map(([filename, job]) => ({
    filename,
    ...job
  }));
  res.json({ jobs });
});

// Single file download: uses fetch + ReadableStream → fs.createWriteStream with 30-min timeout
async function downloadInBackground(url, outputPath, filename, autoConvert) {
  downloadJobs.set(filename, { status: 'downloading', progress: 0, error: null });
  
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
    downloadJobs.set(filename, { status: 'complete', progress: 100, error: null });

    if (autoConvert && isConvertibleFile(filename)) {
      createConversionJob(filename);
    }
  } catch (err) {
    console.error(`[Download] ✗ Failed: ${filename}`, err.message);
    downloadJobs.set(filename, { status: 'error', progress: 0, error: err.message });
    fs.unlink(outputPath, () => {});
  }
}

// Full repo download: uses huggingface_hub snapshot_download via inline Python script
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

// === LUMINA SCREEN PIPELINE ===
// Resume screening pipeline. Manages main.py subprocess lifecycle.
// Reads hits from page_hit.txt, config from config.json, JD from jd.txt.

const luminaScreenDir = path.join(rootDir, 'lumina_screen');
let luminaScreenProcess = null;
let luminaScreenState = 'idle'; // 'idle' | 'running' | 'stopped'

// Get pipeline state: hits, config, JD text
apiRouter.get('/lumina-screen/status', (req, res) => {
  const hits = [];
  const hitPath = path.join(luminaScreenDir, 'page_hit.txt');
  if (fs.existsSync(hitPath)) {
    const lines = fs.readFileSync(hitPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines.slice(-50)) {
      const match = line.match(/^\[(.+?)\]\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\d.]+)\s*\|\s*(.*?)\s*\|\s*(.*)$/);
      if (match) {
        hits.push({
          timestamp: match[1],
          name: match[2],
          filename: match[3],
          score: parseFloat(match[4]),
          email: match[5],
          phone: match[6],
        });
      }
    }
  }
  let config = {};
  const configPath = path.join(luminaScreenDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {
      // BUG-UI2 FIX: Silent catch meant a malformed config.json returned empty config
      // to the UI with no error signal, hiding the root cause from the operator.
      console.error(`[LuminaScreen] config.json parse error: ${e.message}`);
      config = { _parse_error: e.message };
    }
  }
  let jd_text = '';
  const jdPath = path.join(luminaScreenDir, 'jd.txt');
  if (fs.existsSync(jdPath)) {
    try { jd_text = fs.readFileSync(jdPath, 'utf8'); } catch {}
  }
  res.json({ status: luminaScreenState, hits, config, jd_text });
});

// Start the Lumina Screen pipeline (spawns main.py as subprocess)
apiRouter.post('/lumina-screen/start', (req, res) => {
  if (luminaScreenProcess) {
    return res.json({ status: 'already_running' });
  }
  const pythonCmd = getPythonCmd();
  const mainScript = path.join(luminaScreenDir, 'main.py');
  if (!fs.existsSync(mainScript)) {
    return res.status(500).json({ error: 'lumina_screen/main.py not found' });
  }
  // BUG FIX: spawn with cwd=luminaScreenDir so that Python's os.path.abspath(__file__)
  // resolves correctly and relative paths in config.json point to the right locations.
  luminaScreenState = 'running';
  luminaScreenProcess = spawn(pythonCmd, [mainScript], {
    cwd: luminaScreenDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  luminaScreenProcess.stdout.on('data', (data) => {
    console.log(`[LuminaScreen] ${data.toString().trim()}`);
  });
  luminaScreenProcess.stderr.on('data', (data) => {
    console.error(`[LuminaScreen] STDERR: ${data.toString().trim()}`);
  });
  luminaScreenProcess.on('error', (err) => {
    console.error(`[LuminaScreen] Spawn error: ${err.message}`);
    luminaScreenState = 'stopped';
    luminaScreenProcess = null;
  });
  luminaScreenProcess.on('close', (code) => {
    console.log(`[LuminaScreen] Process exited with code ${code}`);
    luminaScreenState = code === 0 || code === null ? 'stopped' : 'stopped';
    luminaScreenProcess = null;
  });
  console.log('[LuminaScreen] Started pipeline (cwd: lumina_screen/)');
  res.json({ status: 'started' });
});

// Stop the pipeline — SIGTERM → 3s → SIGKILL escalation
apiRouter.post('/lumina-screen/stop', (req, res) => {
  const proc = luminaScreenProcess;
  if (!proc) {
    return res.json({ status: 'not_running' });
  }
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, 3000);
  } catch (err) {
    console.error(`[LuminaScreen] Kill error: ${err.message}`);
  }
  luminaScreenState = 'stopped';
  luminaScreenProcess = null;
  console.log('[LuminaScreen] Stopped pipeline');
  res.json({ status: 'stopped' });
});

// SECURITY: Validate resume folder path against path traversal and home directory containment
function validateResumeFolderPath(folderPath) {
  if (!folderPath || !folderPath.trim()) {
    return { valid: false, error: "Resume folder path cannot be empty." };
  }

  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(folderPath.trim()));
  } catch (e) {
    return { valid: false, error: `Invalid path: ${e.message}` };
  }

  if (!fs.existsSync(resolved)) {
    return { valid: false, error: `Path does not exist: ${resolved}` };
  }

  const stats = fs.statSync(resolved);
  if (!stats.isDirectory()) {
    return { valid: false, error: `Path is not a directory: ${resolved}` };
  }

  // Check readability
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (e) {
    return { valid: false, error: `Path is not readable: ${resolved}` };
  }

  // Path traversal containment: must be within user's home directory
  const homeDir = os.homedir();
  const resolvedHome = fs.realpathSync(path.resolve(homeDir));
  if (resolved !== resolvedHome && !resolved.startsWith(resolvedHome + path.sep)) {
    return { valid: false, error: "Path must be within your home directory." };
  }

  return { valid: true, resolved };
}

// Save Lumina Screen config — validates resume folder path, normalizes to avoid double-nesting
apiRouter.post('/lumina-screen/config', (req, res) => {
  const { resume_folder, poll_interval_ms, match_threshold, jd_text } = req.body;
  const configPath = path.join(luminaScreenDir, 'config.json');
  const jdPath = path.join(luminaScreenDir, 'jd.txt');
  try {
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    if (resume_folder !== undefined) {
      // SECURITY: Validate resume folder path before saving to config.
      // Resolves symlinks, .., etc. and checks existence/type/readability.
      // Also enforces containment within the user's home directory.
      const validation = validateResumeFolderPath(resume_folder);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      // BUG FIX: Normalize resume_folder so it is always relative to lumina_screen/.
      // Strip any leading 'lumina_screen/' prefix the UI may have sent, preventing
      // double-nesting (lumina_screen/lumina_screen/resumes) at runtime.
      let normalizedFolder = resume_folder.trim();
      const redundantPrefix = 'lumina_screen/';
      if (normalizedFolder.startsWith(redundantPrefix)) {
        normalizedFolder = './' + normalizedFolder.slice(redundantPrefix.length);
      } else if (normalizedFolder.startsWith('./' + redundantPrefix)) {
        normalizedFolder = './' + normalizedFolder.slice(2 + redundantPrefix.length);
      }
      // If an absolute path outside luminaScreenDir is given, keep it as-is.
      config.resume_folder = normalizedFolder;
    }
    if (poll_interval_ms !== undefined) config.poll_interval_ms = poll_interval_ms;
    if (match_threshold !== undefined) config.match_threshold = match_threshold;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    if (jd_text !== undefined) {
      fs.writeFileSync(jdPath, jd_text, 'utf8');
    }
    console.log('[LuminaScreen] Config saved');
    res.json({ status: 'saved', config });
  } catch (err) {
    console.error(`[LuminaScreen] Config save error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Rescan: delete processed.json so all resumes are re-evaluated from scratch
apiRouter.post('/lumina-screen/rescan', (req, res) => {
  const processedPath = path.join(luminaScreenDir, 'processed.json');
  try {
    if (fs.existsSync(processedPath)) {
      fs.unlinkSync(processedPath);
      console.log('[LuminaScreen] Cleared processed.json — all resumes will be re-scanned');
    }
    res.json({ status: 'cleared', message: 'Dedup state reset. Restart the pipeline to re-process all existing resumes.' });
  } catch (err) {
    console.error(`[LuminaScreen] Rescan error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Get all hits from page_hit.txt
apiRouter.get('/lumina-screen/hits', (req, res) => {
  const hitPath = path.join(luminaScreenDir, 'page_hit.txt');
  const hits = [];
  if (!fs.existsSync(hitPath)) {
    return res.json([]);
  }
  const lines = fs.readFileSync(hitPath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^\[(.+?)\]\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\d.]+)\s*\|\s*(.*?)\s*\|\s*(.*)$/);
    if (match) {
      hits.push({
        timestamp: match[1],
        name: match[2],
        filename: match[3],
        score: parseFloat(match[4]),
        email: match[5],
        phone: match[6],
      });
    }
  }
  res.json(hits);
});

// Clear all hits from page_hit.txt on disk (persists across restarts)
apiRouter.post('/lumina-screen/clear-hits', (req, res) => {
  const hitPath = path.join(luminaScreenDir, 'page_hit.txt');
  try {
    if (fs.existsSync(hitPath)) {
      fs.writeFileSync(hitPath, '', 'utf8');
      console.log('[LuminaScreen] Cleared page_hit.txt');
    }
    res.json({ status: 'cleared' });
  } catch (err) {
    console.error(`[LuminaScreen] Clear hits error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// === LUMINA AGENT ===
// Runs an AI agent in a subprocess. Goal is passed via env var (no shell injection).
// Agent streams JSON-delimited steps back via stdout. Runs are stored in-memory with
// periodic cleanup to cap at MAX_AGENT_RUNS and prevent memory leaks.

const luminaAgentDir = path.join(rootDir, 'lumina_agent');
const agentRuns = new Map(); // runId -> { steps[], status, finalReport, error, proc }
const MAX_AGENT_RUNS = 100; // Cap to prevent memory leak

// Periodic cleanup of old completed runs (trims oldest 25% when at capacity)
function cleanupAgentRuns() {
  if (agentRuns.size <= MAX_AGENT_RUNS) return;
  const toRemove = [];
  for (const [id, run] of agentRuns) {
    if (run.status !== 'running') toRemove.push(id);
  }
  // Remove oldest completed runs first
  for (const id of toRemove.slice(0, Math.ceil(MAX_AGENT_RUNS * 0.25))) {
    agentRuns.delete(id);
  }
}

// Run Lumina Agent — goal passed via env var (security: prevents shell injection from malicious input)
apiRouter.post('/lumina-agent/run', async (req, res) => {
  const { goal } = req.body;
  if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
    return res.status(400).json({ error: 'goal is required' });
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  agentRuns.set(runId, { steps: [], status: 'running', finalReport: null, error: null, proc: null });

  // SECURITY: Use environment variables to pass data to subprocess instead of
  // string interpolation, preventing shell/Python injection from malicious goal strings.
  const { spawn } = await import('child_process');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  const proc = spawn(pythonCmd, ['-c', `
import sys, os, json
sys.path.insert(0, os.environ['LUMINA_ROOT_DIR'])
from lumina_agent.agent import run_agent

goal = os.environ['LUMINA_AGENT_GOAL']
run_id = os.environ['LUMINA_AGENT_RUN_ID']

def on_update(step):
    print(json.dumps({"type": "step", "data": step}), flush=True)

result = run_agent(goal, run_id, on_update)
print(json.dumps({"type": "done", "data": result}), flush=True)
  `], {
    cwd: luminaAgentDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      LUMINA_ROOT_DIR: rootDir,
      LUMINA_AGENT_GOAL: goal,
      LUMINA_AGENT_RUN_ID: runId,
    }
  });

  // Store proc reference so stop endpoint can kill it directly
  const run = agentRuns.get(runId);
  run.proc = proc;

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const r = agentRuns.get(runId);
        if (!r) return;
        if (msg.type === 'step') {
          r.steps.push(msg.data);
        } else if (msg.type === 'done') {
          r.status = 'done';
          r.finalReport = msg.data;
        }
      } catch (e) {
        // BUG-UI1 FIX: Silent swallow meant any non-JSON stdout line (e.g. a Python
        // warning or print() from an imported library) silently dropped the line.
        // If the final {"type":"done",...} chunk shared a buffer with a warning,
        // the split could break it and the run would stay 'running' forever.
        console.warn(`[LuminaAgent] Non-JSON stdout from agent: ${line.substring(0, 120)}`);
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const r = agentRuns.get(runId);
    if (r) r.error = (r.error || '') + chunk.toString();
  });

  // Fix 1: Handle spawn failures (e.g. python3 not found).
  // Without this, the 'error' event is unhandled and the frontend polls forever.
  proc.on('error', (err) => {
    console.error('[LuminaAgent] Spawn error:', err.message);
    const r = agentRuns.get(runId);
    if (r) {
      r.status = 'error';
      r.error = `Failed to start Python process: ${err.message}`;
    }
  });

  // Fix 2: Null-guard r in case cleanupAgentRuns() already removed this run.
  proc.on('close', (code) => {
    const r = agentRuns.get(runId);
    if (!r) return;
    if (r.status === 'running') {
      r.status = code === 0 ? 'done' : 'error';
    }
    cleanupAgentRuns();
  });

  console.log('[LuminaAgent] Started run:', runId);
  res.json({ runId });
});

// Get agent run status (steps, finalReport, error)
apiRouter.get('/lumina-agent/status/:runId', (req, res) => {
  const run = agentRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    status: run.status,
    steps: run.steps,
    finalReport: run.finalReport,
    error: run.error,
  });
});

// Stop agent run — kills subprocess directly (SIGTERM → 3s → SIGKILL)
apiRouter.post('/lumina-agent/stop/:runId', (req, res) => {
  const run = agentRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  // SECURITY: Kill the actual child process directly instead of spawning
  // a separate Python process that can't reach the in-memory stop flag.
  if (run.proc && !run.proc.killed) {
    run.proc.kill('SIGTERM');
    // Fallback to SIGKILL after 3 seconds if process doesn't exit
    setTimeout(() => {
      if (run.proc && !run.proc.killed) {
        try { run.proc.kill('SIGKILL'); } catch {}
      }
    }, 3000);
  }

  run.status = 'stopped';
  console.log('[LuminaAgent] Stopped run:', req.params.runId);
  res.json({ ok: true });
});

// === LUMINA SCOUT ===
// Hardware detection, model recommendations, and deployment planning.
// Uses spawnScoutEndpoint helper: passes all args via SCOUT_ARG_* env vars
// (zero string interpolation of user input into code — no shell injection).

const luminaScoutDir = path.join(rootDir, 'lumina_scout');

// Helper: spawn Python with args passed as env vars (SCOUT_ARG_*) — no string interpolation, no injection risk
function spawnScoutEndpoint(args, callback) {
  const pythonCmd = getPythonCmd();
  const scoutScript = path.join(luminaScoutDir, 'scout.py');
  if (!fs.existsSync(scoutScript)) {
    return callback({ error: 'lumina_scout/scout.py not found', status: 500 });
  }

  // Build env: pass all args as SCOUT_ARG_* env vars
  const env = { ...process.env };
  for (const [key, val] of Object.entries(args)) {
    env[`SCOUT_ARG_${key.toUpperCase()}`] = val !== null && val !== undefined ? String(val) : '';
  }

// Inline Python reads SCOUT_ARG_* env vars and calls scout.py functions accordingly — zero string interpolation
  const pyScript = `
import sys, os, json
sys.path.insert(0, os.environ.get('SCOUT_ARG_SCOUT_DIR', ''))
from scout import get_hardware_info, get_recommendations, get_plan

def _e(name, default=None):
    v = os.environ.get(name, '')
    return v if v else default

def _ei(name, default):
    try: return int(os.environ.get(name, str(default)))
    except: return default

def _ef(name, default=None):
    try: return float(os.environ.get(name, str(default)))
    except: return default

def _eb(name, default=False):
    return os.environ.get(name, str(default)).lower() == 'true'

_func = os.environ.get('SCOUT_ARG_FUNC', '')
if _func == 'get_hardware_info':
    result = get_hardware_info()
elif _func == 'get_recommendations':
    q = _e('SCOUT_ARG_QUANT')
    ms = _ef('SCOUT_ARG_MIN_SPEED')
    result = get_recommendations(
        top=_ei('SCOUT_ARG_TOP', 10),
        profile=_e('SCOUT_ARG_PROFILE', 'general'),
        quant=q if q else None,
        min_speed=ms if ms is not None else None,
        gpu_override=_e('SCOUT_ARG_GPU_OVERRIDE') or None,
        cpu_only=_eb('SCOUT_ARG_CPU_ONLY', False),
        refresh=_eb('SCOUT_ARG_REFRESH', False),
    )
elif _func == 'get_plan':
    q = _e('SCOUT_ARG_QUANT')
    result = get_plan(
        model_query=_e('SCOUT_ARG_MODEL_QUERY', ''),
        quant=q if q else None,
        context_length=_ei('SCOUT_ARG_CONTEXT_LENGTH', 4096),
    )
else:
    result = {"error": "unknown function"}

print(json.dumps(result))
`;

  const proc = spawn(pythonCmd, ['-c', pyScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: luminaScoutDir,
    env,
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { console.log(`[Scout] ${d.toString().trim()}`); });
  proc.on('close', (code) => {
    if (code === 0) {
      try { callback(null, JSON.parse(out)); } catch { callback({ error: 'Parse error', raw: out.slice(0, 500) }, null); }
    } else {
      callback({ error: 'Scout endpoint failed' }, null);
    }
  });
}

// Get hardware info from scout.py
apiRouter.get('/lumina-scout/hardware', (req, res) => {
  spawnScoutEndpoint({
    scout_dir: luminaScoutDir,
    func: 'get_hardware_info',
  }, (err, data) => {
    if (err) return res.status(err.status || 500).json({ error: err.error || 'Hardware detection failed' });
    res.json(data);
  });
});

// Get model recommendations from scout.py
apiRouter.get('/lumina-scout/recommend', (req, res) => {
  const top = parseInt(req.query.top) || 10;
  const profile = req.query.profile || 'general';
  const quant = req.query.quant || '';
  const minSpeedRaw = req.query.min_speed ? parseFloat(req.query.min_speed) : null;
  const minSpeed = (minSpeedRaw !== null && !isNaN(minSpeedRaw)) ? minSpeedRaw : null;
  const gpuOverride = req.query.gpu_override || '';
  const cpuOnly = req.query.cpu_only === 'true';
  const refresh = req.query.refresh === 'true';

  spawnScoutEndpoint({
    scout_dir: luminaScoutDir,
    func: 'get_recommendations',
    top: String(top),
    profile: profile,
    quant: quant,
    min_speed: minSpeed !== null ? String(minSpeed) : '',
    gpu_override: gpuOverride,
    cpu_only: String(cpuOnly),
    refresh: String(refresh),
  }, (err, data) => {
    if (err) return res.status(500).json({ error: err.error || 'Recommendation failed' });
    res.json(data);
  });
});

// Get deployment plan for a specific model
apiRouter.get('/lumina-scout/plan', (req, res) => {
  const model = req.query.model;
  if (!model) return res.status(400).json({ error: 'model query parameter required' });
  const quant = req.query.quant || '';
  const ctxLen = parseInt(req.query.context_length) || 4096;

  spawnScoutEndpoint({
    scout_dir: luminaScoutDir,
    func: 'get_plan',
    model_query: model,
    quant: quant,
    context_length: String(ctxLen),
  }, (err, data) => {
    if (err) return res.status(500).json({ error: err.error || 'Plan lookup failed' });
    if (data && data.error) return res.status(400).json(data);
    res.json(data);
  });
});

// === STARTUP PIPELINE ===
// Runs at server boot:
//   1. System optimization (non-blocking background spawn)
//   1b. macOS MLX optimization (blocking execSync)
//   2. Auto-load model (only if startup.auto_load_model == true)

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
  }

  // Step 2: Auto-load model (only if explicitly enabled)
  if (startupCfg.auto_load_model === true) {
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
          const modelFiles = fs.readdirSync(fullPath).filter(n => n.endsWith('.safetensors') || n.endsWith('.npz'));
          if (hasConfig && modelFiles.length > 0) {
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
        // BUG-C3 FIX: Was `const port = nextPort++` — no availability check.
        // If the startup port was already in use, llama-server/MLX would fail silently
        // and the model would be stuck in status:'error' with no diagnostic.
        const port = await findAvailablePort();
        
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

          try {
            proc = spawn(getPythonCmd(), [
              path.join(scriptsDir, 'mlx_backend.py'),
              '--mode', 'api',
              '--model', modelDir,
              '--port', port.toString()
            ], {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, OMP_NUM_THREADS: undefined, OMP_PROC_BIND: undefined, GOMP_SPINCOUNT: undefined, MALLOC_ARENA_MAX: undefined }
            });

            proc.stdout.on('data', (data) => {
              console.log(`[MLX stdout]: ${data}`);
            });

            proc.stderr.on('data', (data) => {
              console.error(`[MLX stderr]: ${data}`);
            });

            proc.on('error', (err) => {
              console.error(`[MLX] Spawn error:`, err.message);
              modelInfo.status = 'error';
            });

            proc.on('close', (code) => {
              console.log(`[MLX] Process exited with code ${code}`);
              if (modelInfo.status !== 'unloaded') {
                modelInfo.status = 'error';
              }
            });
          } catch (err) {
            routerModels.delete(id);
            console.error('[Startup] Failed to start MLX backend:', err.message);
          }
        } else {
          let llamaServer = path.join(binDir, 'llama-server');
          if (os.platform() === 'win32') llamaServer += '.exe';
          
          if (!fs.existsSync(llamaServer)) {
            routerModels.delete(id);
            console.error(`[Startup] llama-server binary not found at: ${llamaServer}`);
            return;
          }
          
          // Helper to read config values with defaults
const ctxSize = parseInt(cfg.ctx_size) || 4096;
const batchSize = parseInt(cfg.batch_size) || 256;
const ubatchSize = parseInt(cfg.ubatch_size) || 256;
const nGpuLayers = parseInt(cfg.n_gpu_layers) || 999; // 999 = offload max layers GPU can hold, rest CPU
const kvCacheTypeK = cfg.kv_cache_type_k || cfg.kv_cache_quant || 'q4_0';
const kvCacheTypeV = cfg.kv_cache_type_v || cfg.kv_cache_quant || 'q4_0';
const splitMode = cfg.split_mode || 'row';
const httpThreads = parseInt(cfg.http_threads) || 2;
const useMlock = cfg.use_mlock === true;
const contBatching = cfg.cont_batching !== false;
const promptCache = cfg.prompt_cache === true;

// Check Vulkan capability and set effective GPU layers (needed for logging below)
const vulkanOk = await checkVulkanCapability();
const effectiveGpuLayers = vulkanOk ? nGpuLayers : 0;

const cmdArgs = [
  '-m', targetModel.path,                       // model path
  '--port', port.toString(),
  '--host', '127.0.0.1',
  '--ctx-size', ctxSize.toString(),
  '--batch-size', batchSize.toString(),       // prompt batch size
  '--ubatch-size', ubatchSize.toString(),     // micro-batch size
  '--split-mode', splitMode,                  // tensor split mode
  '--threads-http', httpThreads.toString(),   // HTTP server threads
  '--flash-attn', 'on',                       // Flash Attention always on
  '--cache-type-k', 'q4_0',                  // KV key cache always q4_0
  '--cache-type-v', 'q4_0',                  // KV value cache always q4_0
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
console.log(`[Startup]   n-gpu-layers: ${effectiveGpuLayers || nGpuLayers}`);
console.log(`[Startup]   kv-cache-type-k: ${kvCacheTypeK}, kv-cache-type-v: ${kvCacheTypeV}`);
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

// Vulkan capability already checked earlier, use those results
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

console.log(`[Lumina] Spawning llama.cpp for model: ${path.basename(targetModel.path)} on port ${port}`);

proc = spawn(finalCmd, finalArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    OMP_NUM_THREADS: httpThreads.toString(),
    OMP_PROC_BIND: 'close',
    OMP_PLACES: 'cores',
    MALLOC_ARENA_MAX: '2',
    GOMP_SPINCOUNT: '0',
  }
});

proc.stdout.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.log(`[llama-server] ${text}`);
});

proc.stderr.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.error(`[llama-server ERR] ${text}`);
});

proc.on('error', (err) => {
  console.error(`[Startup] Spawn error for llama-server: ${err.message}`);
  modelInfo.status = 'error';
});

proc.on('close', (code) => {
  console.log(`[llama-server] Process exited with code ${code}`);
  if (modelInfo.status !== 'unloaded' && modelInfo.status !== 'error') {
    modelInfo.status = 'error';
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
// Secondary (8081): management-only, no /v1 proxy
// Primary (8090): inference + management + /v1 proxy

// Secondary management-only server — no /v1 routes exposed
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
// Enriched /v1/models and /v1/chat/completions for Continue/Cline/OpenAI-compatible clients

// === Enriched /v1/models endpoint (for Continue/Cline compatibility) ===
// Returns router models if loaded, otherwise probes direct backend ports
app.get('/v1/models', async (req, res) => {
  try {
    const readyModels = Array.from(routerModels.values()).filter(m => m.status === 'ready');

    if (readyModels.length === 0) {
      // No router models — try direct backend on multiple ports
      const mlxPort = parseInt(process.env.LUMINA_MLX_PORT || '8091');
      const directPorts = [PRIMARY_PORT, mlxPort, 8091];
      
      for (const port of directPorts) {
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/v1/models`, { timeout: 3000 });
          if (resp.ok) {
            const data = await resp.json();
            return res.json(data);
          }
        } catch { }
      }

      return res.status(200).json({
        object: 'list',
        data: []
      });
    }
    
    const now = Math.floor(Date.now() / 1000);
    const modelList = readyModels.map(m => {
      const modelId = m.name ? path.basename(m.name, path.extname(m.name)) : 'local-model';
      return {
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
      };
    });
    
    res.json({
      object: 'list',
      data: modelList
    });
  } catch (err) {
    console.error('[/v1/models] Error:', err.message);
    res.status(200).json({ object: 'list', data: [] });
  }
});

// === Tool-calling middleware and /v1/chat/completions route ===

// Parse tool_calls from model response text using regex
// Looks for JSON: {"tool_call": {"name": "...", "arguments": {...}}}
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

// Format system message with tools injected as text prompt (no native tool_calls API)
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

// === THE MAIN INFERENCE ENDPOINT ===
// Routes to first ready router model. If no router models loaded, falls back to
// direct backend (MLX on LUMINA_MLX_PORT or llama-server).
// Tool-call injection: if tools array is present, injects as system prompt, forces non-streaming.
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const readyModel = Array.from(routerModels.values()).find(m => m.status === 'ready');
    if (!readyModel) {
      // No router models loaded — try direct backend (MLX on LUMINA_MLX_PORT, or llama-server on LUMINA_API_PORT)
      const mlxPort = parseInt(process.env.LUMINA_MLX_PORT || '8091');
      const directPort = (process.env.LUMINA_API_PORT && parseInt(process.env.LUMINA_API_PORT) !== PRIMARY_PORT)
        ? parseInt(process.env.LUMINA_API_PORT)
        : (mlxPort !== PRIMARY_PORT ? mlxPort : 8091);
      const targetUrl = `http://127.0.0.1:${directPort}/v1/chat/completions`;

      const body = { ...req.body };
      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];

      const isStreaming = body.stream === true;

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const origin = req.headers.origin || '';
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
          res.setHeader('Access-Control-Allow-Origin', origin);
        }

        try {
          // BUG-C5 FIX (no-model streaming path): No timeout meant a hung backend held
          // the connection open indefinitely, leaking a file descriptor and response object.
          const _ac_s1 = new AbortController();
          const _at_s1 = setTimeout(() => _ac_s1.abort(), 300_000); // 5-min max
          const response = await fetch(targetUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
            signal: _ac_s1.signal,
          });
          clearTimeout(_at_s1);

          if (!response.ok) {
            const errorText = await response.text();
            res.write(`data: ${JSON.stringify({ error: errorText })}\n\n`);
            res.end();
            return;
          }

          if (response.body) {
            const reader = response.body.getReader();
            const encoder = new TextEncoder();

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            } catch (streamErr) {
              console.error('[/v1/chat/completions] Stream error:', streamErr.message);
            }
          }
        } catch (err) {
          console.error('[/v1/chat/completions] Streaming error:', err.message);
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        }
        res.end();
        return;
      }

      // Non-streaming: fetch and return
      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          const errorText = await response.text();
          return res.status(response.status).json({ error: errorText });
        }

        const data = await response.json();
        res.json(data);
      } catch (err) {
        console.error('[/v1/chat/completions] Direct backend error:', err.message);
        return res.status(502).json({ error: `Backend error: ${err.message}` });
      }
      return;
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

    const isStreaming = body.stream === true;

    // Handle streaming vs non-streaming differently
    if (isStreaming) {
      // For streaming: pipe the response directly back to client
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const origin = req.headers.origin || '';
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }

      try {
        // BUG-C5 FIX (ready-model streaming path): No timeout meant a hung backend held
        // the connection open indefinitely, leaking a file descriptor and response object.
        const _ac_s2 = new AbortController();
        const _at_s2 = setTimeout(() => _ac_s2.abort(), 300_000); // 5-min max
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: _ac_s2.signal,
        });
        clearTimeout(_at_s2);

        if (!response.ok) {
          const errorText = await response.text();
          res.write(`data: ${JSON.stringify({ error: errorText })}\n\n`);
          res.end();
          return;
        }

        // Pipe the stream directly to the client
        if (response.body) {
          const reader = response.body.getReader();
          const encoder = new TextEncoder();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          } catch (streamErr) {
            console.error('[/v1/chat/completions] Stream error:', streamErr.message);
          }
        }
      } catch (err) {
        console.error('[/v1/chat/completions] Streaming error:', err.message);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }

      res.end();
      return;
    }

    // Non-streaming: fetch full response and potentially modify
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });

    // BUG-C6 FIX: response.json() was called before checking response.ok.
    // If the backend returned a non-JSON error body (e.g. plain-text '503 Service Unavailable'),
    // response.json() would throw and the outer catch would return 500 — losing the original
    // status code.  Now we forward the raw error text with the correct status.
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const responseData = await response.json();

    // If tools were requested, try to parse tool_calls from response
    if (hasTools && responseData.choices && responseData.choices.length > 0) {
      const choice = responseData.choices[0];
      if (choice.message && choice.message.content) {
        const toolCall = extractToolCall(choice.message.content);
        if (toolCall) {
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

// Generic /v1/* proxy to first ready model
// MLX models: translates 'local' model name to full path for mlx_lm
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
          // Strip .safetensors/.npz extension if present — mlx_lm expects dir names.
          // BUG-C2 FIX: Previous code called fs.statSync(modelBase) unconditionally;
          // if the model name had no extension, modelBase was unchanged and statSync
          // would throw ENOENT for non-existent paths, crashing the proxy request.
          const modelBase = bodyToUse.model.replace(/\.(safetensors|npz)$/i, '');
          try {
            bodyToUse.model = fs.existsSync(modelBase) && fs.statSync(modelBase).isDirectory()
              ? modelBase
              : path.dirname(modelBase);
          } catch {
            bodyToUse.model = path.dirname(modelBase);
          }
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

// =============================================================================
// Non-API request proxy to chat web UI.
// Linux → llama-server built-in web UI (port MLX_PORT).
// macOS → OpenWebUI (port OW_PORT) since MLX has no built-in web UI.
// =============================================================================
const isDarwin = os.platform() === 'darwin' && os.arch() === 'arm64';
const BACKEND_PORT = isDarwin
  ? parseInt(process.env.LUMINA_OW_PORT || '8080')
  : parseInt(process.env.LUMINA_MLX_PORT || '8091');
const BACKEND_HOST = '127.0.0.1';

app.use((req, res, next) => {
  // Let explicit API routes handle their own paths
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
    return next();
  }

  const proxyReq = http.request({
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${BACKEND_HOST}:${BACKEND_PORT}`
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[Proxy] Backend error for ${req.method} ${req.url}:`, err.message);
    res.status(502).send('Backend unavailable');
  });

  if (req.body !== undefined) {
    // express.json() already consumed the stream — forward parsed body
    const body = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
    proxyReq.write(body);
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
});

// Clear stale models before accepting connections
clearStaleModelState();

// Start primary server — models load async via startup pipeline
const server = app.listen(PRIMARY_PORT, '127.0.0.1', () => {
  console.log(`[API Server] ✓ Primary (inference + management) listening on http://127.0.0.1:${PRIMARY_PORT}`);
  console.log(`[API Server] Running startup pipeline...`);
  runStartupPipeline().then(() => {
    console.log(`[API Server] Ready to accept connections`);
  });
});

// Handle startup errors (port already in use, etc.)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[API Server] ✗ Port ${PRIMARY_PORT} is already in use`);
    console.error(`[API Server] Make sure no other Lumina Edge instance is running`);
  } else {
    console.error(`[API Server] ✗ Server error:`, err.message);
  }
  process.exit(1);
});

// Graceful shutdown: unloads all models, closes both servers
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
