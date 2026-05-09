# Windows Setup Guide for Lumina Edge

This guide covers Windows-specific setup and usage instructions for Lumina Edge.

## Quick Start (Windows)

### Option 1: PowerShell Script (Recommended)

1. **Download llama.cpp binaries**
   - Go to [ggml-org/llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases/latest)
   - Download the appropriate Windows build:
     - **NVIDIA GPUs**: `llama-bXXX-bin-win-cuda-cu12.x-x64.zip`
     - **Intel/AMD GPUs**: `llama-bXXX-bin-win-vulkan-x64.zip`
   - Extract **all files directly** into `Lumina-Edge/bin/` (no subfolders)

2. **Run the launcher**
   ```powershell
   # Open PowerShell as Administrator (for full optimization)
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   .\start_lumina.ps1
   ```

3. **With custom model path**
   ```powershell
   .\start_lumina.ps1 -Model "C:\path\to\your\model.gguf"
   ```

### Option 2: Batch File (CMD)

```cmd
# Run from Command Prompt
start_lumina.bat

# With custom model path
start_lumina.bat "C:\path\to\your\model.gguf"
```

## Prerequisites

### Required Software

1. **Node.js** (v16 or later)
   - Download from [nodejs.org](https://nodejs.org/)
   - Install with default settings

2. **Python 3.8+** (for MLX backend on Mac, optional for Windows)
   - Download from [python.org](https://python.org/)
   - Add to PATH during installation

3. **Git** (optional, for cloning)
   - Download from [git-scm.com](https://git-scm.com/)

### GPU Drivers

#### NVIDIA GPUs
- Install latest drivers from [nvidia.com](https://www.nvidia.com/Download/index.aspx)
- Verify with: `nvidia-smi`

#### Intel/AMD GPUs  
- Install latest drivers from manufacturer
- Install [Vulkan Runtime](https://vulkan.lunarg.com/) if using Vulkan build

## Windows-Specific Features

### System Optimization

The Windows launcher includes comprehensive system optimization:

- **Power Plan**: Sets High Performance mode (requires admin)
- **CPU Optimization**: Disables idle states for better performance
- **Memory Management**: Optimizes file system cache
- **Network**: Configures TCP settings for lower latency
- **Services**: Temporarily stops Windows Search indexing
- **Process Priority**: Sets high priority for inference processes

**Note**: Run as Administrator for maximum optimization benefits.

### Docker Support

If you prefer using OpenWebUI via Docker:

```cmd
docker run -d -p 8080:8080 --add-host=host.docker.internal:host-gateway openwebui/openwebui:latest
```

The launcher will auto-detect and configure the Docker instance.

## Configuration

### Environment Variables

Set these variables in Windows or in the launcher:

```cmd
set LUMINA_API_PORT=8090
set LUMINA_UI_PORT=5173
set LUMINA_OW_PORT=8080
```

### Configuration File

Edit `config.json` in the project root:

```json
{
  "startup": {
    "default_model": "models\\your-model.gguf"
  },
  "ctx_size": 16384,
  "n_gpu_layers": 15,
  "batch_size": 256,
  "ubatch_size": 256
}
```

## Troubleshooting (Windows)

### Common Issues

#### "llama-server.exe not found"
- Extract llama.cpp release directly to `bin/` folder
- Ensure `llama-server.exe` is at the top level of `bin/`

#### "Access Denied" during optimization
- Right-click PowerShell/CMD and "Run as Administrator"
- Or edit the script to skip optimization steps

#### Port already in use
```cmd
# Find process using port 8090
netstat -ano | findstr ":8090"

# Kill the process
taskkill /PID <PID> /F
```

#### "Vulkan initialization failed"
- Install [Vulkan Runtime](https://vulkan.lunarg.com/)
- Update GPU drivers
- Verify with: `vulkaninfo | findstr "GPU id"`

#### Out of memory errors
- Use smaller models or lower quantization
- Close RAM-heavy applications (browsers, Electron apps)
- Ensure: model size (GB) + 2GB < total RAM

### Performance Tips

1. **Use SSD storage** for models
2. **Disable antivirus real-time scanning** for the project folder
3. **Close unnecessary applications** before launching
4. **Use High Performance power plan**
5. **Enable Game Mode** (Windows 10/11)

## File Structure (Windows)

```
Lumina-Edge/
├── start_lumina.ps1          # PowerShell launcher (recommended)
├── start_lumina.bat           # Batch file launcher
├── bin/                       # llama.cpp binaries
│   ├── llama-server.exe
│   ├── llama-cli.exe
│   └── *.dll files
├── models/                    # Your model files
│   └── *.gguf files
├── scripts/                   # Helper scripts
│   └── windows_prelaunch.ps1  # Windows optimizer
├── ui/                        # React web interface
└── .lumina_run/               # Runtime files (auto-created)
    ├── startup.log
    ├── pids.txt
    └── *.log files
```

## Security Considerations

- The launcher opens local ports (8090, 8091, 5173, 8080)
- Only bind to localhost (127.0.0.1) by default
- No authentication required for local connections
- Run with appropriate user permissions (avoid unnecessary admin rights)

## Advanced Usage

### Custom Model Paths

```powershell
# Absolute path
.\start_lumina.ps1 -Model "D:\Models\llama-3-8b-instruct.gguf"

# Relative path
.\start_lumina.ps1 -Model ".\models\custom-model.gguf"
```

### Multiple GPU Configuration

Edit `config.json` for multi-GPU setups:

```json
{
  "n_gpu_layers": 99,
  "main_gpu": 0,
  "tensor_split": [0.5, 0.5]
}
```

### Headless Mode

For server usage without UI:

```powershell
# Set environment variable to skip UI launch
$env:LUMINA_SKIP_UI = "1"
.\start_lumina.ps1
```

## Getting Help

1. Check log files in `.lumina_run/` directory
2. Run with `--help` flag for usage information
3. Review the main README.md for general troubleshooting
4. Check GitHub Issues for platform-specific problems

## Performance Benchmarks

Typical performance on Windows hardware:

| Hardware | Model | Tokens/sec | RAM Usage |
|----------|-------|------------|-----------|
| RTX 4090 | Llama 3 8B Q4_K_M | ~45 | ~6 GB |
| RTX 3060 | Llama 3 8B Q4_K_M | ~25 | ~6 GB |
| Intel iGPU | Llama 3 8B Q4_K_M | ~8 | ~6 GB |

*Results may vary based on system configuration and model quantization.*
