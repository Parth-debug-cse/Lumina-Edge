# Lumina Edge — Windows Setup Guide

Quick reference for setting up and running Lumina Edge on Windows.

---

## Prerequisites

- **Python 3.8+** installed
- **llama.cpp** binaries in `bin/` directory (specifically `llama-server.exe`)
- **GGUF model file** in `models/` directory
- **PowerShell** (Windows PowerShell or PowerShell Core)

---

## Step 1: Verify Installation

Run the validation script to check everything:

```cmd
python scripts\validate_startup.py
```

This checks:
- ✓ config.json is valid
- ✓ Model file exists
- ✓ llama-server.exe binary exists
- ✓ API server is running (or provides start instructions)
- ✓ VectorDB is initialized
- ✓ Python dependencies are installed

---

## Step 2: Install Python Dependencies

Create and activate a virtual environment (recommended):

```cmd
cd "C:\Users\likit\OneDrive\Desktop\Lumina Edge\2026-Lumina-Edge-LLM-Inference-Framework"
python -m venv venv
venv\Scripts\activate
```

Install required packages:

```cmd
pip install requests chromadb sentence-transformers tiktoken pymupdf python-docx
```

---

## Step 3: Download a Model

If you don't have a model yet, download one from [HuggingFace TheBloke](https://huggingface.co/TheBloke):

**Recommended starter models:**
- `mistral-7b-instruct-v0.2.Q4_K_M.gguf` (good balance of quality/speed)
- `llama-2-7b-chat.Q4_K_M.gguf` (robust general purpose)
- `phi-3-mini-4k-instruct.Q4_K_M.gguf` (faster, smaller)

Place the downloaded `.gguf` file in the `models/` directory.

---

## Step 4: Configure config.json

Edit `config.json` to set your model:

```json
{
  "model": "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
  "api_port": 8090,
  "ctx_size": 16384,
  ...
}
```

---

## Step 5: Start the API Server

### Option A: Using PowerShell script (Recommended)

```powershell
powershell -ExecutionPolicy Bypass -File core\launch_api.ps1
```

The script will:
- Read settings from `config.json`
- Check if the model exists
- Verify the port is available
- Start `llama-server.exe`
- Wait for the server to be ready
- Show "✓ Server is ready!" when done

### Option B: Using the main launcher

```powershell
powershell -ExecutionPolicy Bypass -File core\lumina-launcher.ps1
```

This provides an interactive menu with more options.

**Wait for message:** `llama-server listening on http://127.0.0.1:8090`

---

## Step 6: Verify Server (in new terminal)

Keep the server running and open a new terminal:

```cmd
venv\Scripts\activate
python scripts\check_server.py
```

Expected output:
```
Checking API server on port 8090...
✓ Server is running on port 8090
```

---

## Step 7: Prepare Demo Documents

Create sample documents for testing:

```cmd
mkdir demo_docs
```

Create a sample file `demo_docs\sample_contract.txt`:

```
SERVICE AGREEMENT

This agreement is effective January 1, 2025 between:
- Service Provider: TechCorp Inc.
- Client: ClientCompany LLC

1. TERM
The agreement duration is 12 months from the effective date.

2. PAYMENT
Monthly fee of $5,000, due on the 1st of each month.

3. TERMINATION
Either party may terminate with 30 days written notice.
```

---

## Step 8: Ingest Documents

```cmd
python scripts\ingest_docs.py demo_docs\ --verbose
```

Expected output:
```
Loading embedding model: all-MiniLM-L6-v2
Created new collection: default_docs

Found 1 document(s) to ingest

📄 Processing: sample_contract.txt
  Extracted 312 characters
  Created 1 chunks
  ✓ Ingested 1 chunks successfully

============================================================
✓ Ingestion complete!
  Files processed: 1/1
  Total chunks stored: 1
  Collection: default_docs
  Total documents in collection: 1
============================================================
```

---

## Step 9: Run a Query

```cmd
python scripts\query_docs.py "What is the payment amount?"
```

Expected output:
```
🔍 Query: "What is the payment amount?"
📚 Retrieving top 5 relevant chunks...

✓ Retrieved 1 chunks
⚙️ Querying LLM on port 8090...

======================================================================
📝 ANSWER:
======================================================================
According to the service agreement, the monthly fee is $5,000, due on the 1st of each month.
======================================================================

📚 Sources Referenced:
  📄 sample_contract.txt (chunk 1/1)
```

---

## Troubleshooting

### Server won't start: "Model not found"

**Problem:** Model file doesn't exist in `models/`

**Solution:**
```cmd
dir models\*.gguf
```

If empty, download a model:
```powershell
# Using PowerShell
Invoke-WebRequest -Uri "https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf" -OutFile "models\mistral-7b-instruct-v0.2.Q4_K_M.gguf"
```

### Server won't start: "Port already in use"

**Problem:** Port 8090 is being used by another process

**Solution:**
```cmd
netstat -ano | findstr ":8090"
taskkill /PID <PID> /F
```

Or change port in `config.json`:
```json
"api_port": 8091
```

### "llama-server.exe not found"

**Problem:** llama.cpp binaries not in expected location

**Solution:**
- Download llama.cpp Windows binaries from [releases](https://github.com/ggerganov/llama.cpp/releases)
- Extract `llama-server.exe` to `bin/` directory
- Or place it in the project root

### Query returns "No relevant documents found"

**Problem:** Documents not ingested or collection name mismatch

**Solution:**
```cmd
# Check config use_case field
python -c "import json; print(json.load(open('config.json')).get('use_case', 'default'))"

# Re-ingest documents
python scripts\ingest_docs.py demo_docs\
```

### Import errors (missing dependencies)

**Problem:** Python packages not installed

**Solution:**
```cmd
venv\Scripts\activate
pip install requests chromadb sentence-transformers tiktoken pymupdf python-docx
```

### PowerShell execution policy error

**Problem:** PowerShell won't run scripts

**Solution:**
```powershell
# Run as Administrator or use -ExecutionPolicy Bypass
powershell -ExecutionPolicy Bypass -File core\launch_api.ps1

# Or change policy for current user (one-time)
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

## Quick Reference Commands

| Task | Command |
|------|---------|
| Validate setup | `python scripts\validate_startup.py` |
| Check server | `python scripts\check_server.py` |
| Start server | `powershell -ExecutionPolicy Bypass -File core\launch_api.ps1` |
| Ingest docs | `python scripts\ingest_docs.py demo_docs\` |
| Query docs | `python scripts\query_docs.py "Your question"` |
| View logs | `type logs\api_server.log` |

---

## File Locations

| Component | Path |
|-----------|------|
| Config | `config.json` |
| Models | `models\*.gguf` |
| Logs | `logs\api_server.log` |
| VectorDB | `vectordb\` |
| Scripts | `scripts\*.py` |
| Binaries | `bin\llama-server.exe` |

---

## Next Steps

1. Add more documents to `demo_docs/`
2. Create custom system prompts in `presets/`
3. Adjust `chunk_size` in `config.json` for different document types
4. Try different embedding models via `embedding_model` config

---

**Need help?** Check the logs at `logs\api_server.log` for detailed error messages.
