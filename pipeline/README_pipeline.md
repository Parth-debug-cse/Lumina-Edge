# Lumina Edge Pipeline — Enterprise Log Analysis

A two-agent sequential pipeline for real-time log cleaning and categorization.

## Architecture

```
OpenWebUI  -->  [Orchestrator:8000]  -->  [Agent 1 (Cleaner):8001]  -->  [Agent 2 (Categorizer):8002]
                  FastAPI                  llama-server                  llama-server
                  OpenAI-compatible       tinyllama-1.1b               LFM2.5-1.2B
```

## Requirements

- Linux or Windows with PowerShell
- Python 3.10+ with `fastapi`, `uvicorn`, `httpx`, `pydantic`
- llama-server binary in `bin/llama-server`
- Models specified in `config.json`

## Running on Linux

```bash
cd pipeline
chmod +x start_pipeline.sh
./start_pipeline.sh
```

## Running on Windows

```powershell
cd pipeline
.\start_pipeline.ps1
```

## How It Works

1. **Orchestrator** (port 8000) — FastAPI app exposing OpenAI-compatible `/v1/chat/completions`
2. **Agent 1 (Cleaner)** (port 8001) — llama-server with tinyllama, cleans raw logs
3. **Agent 2 (Categorizer)** (port 8002) — llama-server with LFM2.5-1.2B, categorizes into JSON

## OpenWebUI Configuration

- URL: `http://localhost:8000`
- Model Name: `lumina-pipeline`

## Testing

```bash
cd pipeline
python3 test_pipeline.py
```

## Configuration

Edit `config.json` to change:
- Agent ports (default: 8001, 8002)
- Model paths
- API port (default: 8000)