# 🌟 Lumina Edge

Lumina Edge is a lightweight execution framework designed to make **local Large Language Model (LLM) inference and development practical on low-RAM, consumer-grade hardware**.

The objective is simple:

> **Run local LLMs as efficiently and reliably as possible.**

---

## 🖼️ Lumina Edge in Action

Below is a real execution of Lumina Edge running a quantized LLM on constrained hardware

(**8GB RAM · Intel UHD 620 · Vulkan backend**):

---

## ⚡ Quick Start (5 Minutes)

1. **Install llama.cpp**
* Download from: [https://github.com/ggml-org/llama.cpp/releases](https://github.com/ggml-org/llama.cpp/releases)
* Vulkan build → Integrated GPU users
* CUDA build → NVIDIA GPU users
* Extract into:
```text
C:\Lumina-Edge\bin

```




2. **Add a model**
```text
C:\Lumina-Edge\models\one.gguf

```


3. **Run Lumina Edge**
* Double-click `lumina-core.bat`
* **Run as Administrator**
* Start chatting locally


4. *(Optional)* **Start API mode:**
* Run `lumina-api.bat`
* API available at:
```text
http://127.0.0.1:1234/v1

```





---

## ⚙️ System Requirements

### Software

* **Windows**
* **Administrator privileges**
* **llama.cpp**

#### Setting up llama.cpp

Download releases from:
[https://github.com/ggml-org/llama.cpp/releases](https://github.com/ggml-org/llama.cpp/releases)

* **Integrated GPU (Vulkan)** → Vulkan build
* **NVIDIA GPU (CUDA)** → CUDA build

Extract all binaries into:

```text
C:\Lumina-Edge\bin

```

> ⚠️ The core controller must be run **as Administrator** to allow temporary system optimization.

---

### Hardware

#### 🟦 Integrated Graphics (Vulkan – Default)

* **RAM**
* Minimum: 4GB
* Recommended: 8GB+


* **GPU**
* Integrated GPU with **Vulkan 1.2+**
* Intel UHD / Iris or AMD Radeon iGPU


* **Storage**
* SSD strongly recommended



#### 🟩 NVIDIA GPU (CUDA Variant)

* **RAM**
* 8GB+ recommended


* **GPU**
* NVIDIA GPU with CUDA support


* **Drivers**
* Latest NVIDIA drivers installed


* **CUDA**
* Automatically handled by llama.cpp CUDA builds



---

## 📂 Project Layout

```text
C:\Lumina-Edge
├─ bin\        → llama.cpp binaries
├─ core\       → controllers (chat + API)
├─ scripts\    → system optimization (PowerShell)
├─ models\     → GGUF model (named "one")
└─ assets\     → screenshots and visuals

```

> The framework assumes the project is located at: **C:\Lumina-Edge**

---

## 🧠 System Optimization (Important)

Before initializing the model, Lumina Edge performs a **temporary system optimization step**.

### What this does

* Frees unused RAM
* Reduces background service pressure
* Prepares memory for inference workloads

### What this does NOT do

* ❌ No permanent system changes
* ❌ No registry edits
* ❌ No services installed or removed

Optimization scripts live in:

```text
C:\Lumina-Edge\scripts

```

---

## 🤖 Model Setup (Critical)

1. Download any **GGUF** model
2. Place it in:
```text
C:\Lumina-Edge\models

```


3. Rename it to:
```text
one.gguf

```



The controller automatically detects any file named `one.*`.

---

## 🚀 Running Lumina Edge (Local Chat)

### Integrated GPU (Vulkan)

* Run:
```text
core\lumina-core.bat

```


* Uses Vulkan backend automatically
* Optimized for low-RAM systems

### NVIDIA GPU (CUDA)

* Run:
```text
core\lumina-core-nvidia.bat

```


* Uses CUDA acceleration
* Supports GPU layer offloading

> ⚠️ Always run **as Administrator**

---

## 📈 Reference Performance

*(8GB RAM · Intel UHD 620 · Vulkan)*

| Model Size | Quantization | Tokens / Second |
| --- | --- | --- |
| 1B | Q8_0 | ~15 t/s |
| 1.5B | Q6_K | ~9 t/s |
| 7B | Q4_K_M | ~4–6 t/s |

---

## 🔌 OpenAI-Compatible Local API

Run **`lumina-api.bat` as Administrator**.

Lumina Edge supports running your local model as an **OpenAI-compatible API**, enabling:

* Programmatic access (Python, JS, etc.)
* Drop-in compatibility with OpenAI SDKs
* Local chat without a GUI
* Zero API keys
* No internet required

Powered by `llama.cpp`’s built-in server mode.

---

## 🌐 API Endpoint

```text
http://127.0.0.1:1234/v1

```

Fully compatible with OpenAI `/v1` APIs.

---

## ▶️ Starting the API Server

1. Confirm model exists:
```text
C:\Lumina-Edge\models\one.gguf

```


2. Run the API controller **as Administrator**
3. Wait for:
```text
STAGE 2 :: STARTING API SERVER

OpenAI-compatible endpoint:
  http://127.0.0.1:1234/v1

```



Server runs in blocking mode.

---

## ✅ Verifying the Server (PowerShell)

```powershell
Invoke-RestMethod http://localhost:1234/v1/models

```

Expected output:

```json
"model": "one.gguf"

```

A **200 OK** confirms correct operation.

---

## 💬 Chat Completions (PowerShell)

### Build Request

```powershell
$body = @{
  model = "one.gguf"
  messages = @(
    @{ role = "system"; content = "You are a helpful assistant." }
    @{ role = "user"; content = "Explain black holes simply." }
  )
} | ConvertTo-Json -Depth 5

```

### Send Request

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:1234/v1/chat/completions" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body

```

---

## 🐍 Python Client Usage

### Requirements

* Python **3.10+**
* Added to `PATH`

### Install Client

```powershell
python -m pip install openai

```

### Minimal Example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:1234/v1",
    api_key="none"
)

response = client.chat.completions.create(
    model="one.gguf",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain black holes simply."}
    ]
)

print(response.choices[0].message.content)

```

Run:

```powershell
python chat.py

```

---

## ✨ What This Enables

* Local chat-based LLM usage
* OpenAI-compatible API
* PowerShell-native workflows
* Python SDK compatibility
* Low-RAM inference on iGPU & NVIDIA GPUs

**No cloud. No API keys. No telemetry.**
