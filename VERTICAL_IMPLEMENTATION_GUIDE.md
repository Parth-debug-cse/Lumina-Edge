# Lumina Edge — NGO/Legal/HR Use Case Implementation Guide

Complete step-by-step process to build, deploy, and demo privacy-first AI for sensitive data workflows.

---

## 1. Value Proposition

**The Core Problem:** Cloud LLMs are legally unusable for organizations handling sensitive data.

| Sector | Data Types | Legal Constraints | Cloud AI Risk |
|--------|-----------|-------------------|---------------|
| **NGO** | Refugee records, beneficiary data, donor info | GDPR, data residency laws, donor agreements | Data breach = loss of funding, legal liability |
| **Legal** | Attorney-client communications, case files, contracts | Attorney-client privilege, ethics rules | Cloud upload = potential bar violation |
| **HR** | Compensation, performance reviews, medical records | HIPAA, GDPR, PDPA, employment law | Privacy violation = regulatory fines, lawsuits |

**Lumina Edge Solution:** 100% on-device inference. Data never leaves the machine. Zero API calls. Zero cloud dependency.

### Competitive Positioning

| Solution | Cost | Data Privacy | Hardware Requirement | Lumina Edge Advantage |
|----------|------|--------------|---------------------|----------------------|
| OpenAI API | $0.01-0.06/1K tokens | Data sent to cloud | Any | Zero egress, zero cost per query |
| Azure OpenAI (Private) | $5K-20K/month | Private cloud, not on-prem | Enterprise infra | Runs on Rs.40K laptop |
| **Lumina Edge** | $0 (one-time hardware) | 100% on-device | Consumer laptop | All of the above |

---

## 2. Technical Architecture

### Four-Layer Architecture

```
Layer 4: Vertical Configuration Layer
  (System prompts, RAG, document ingestion)
Layer 3: OpenAI-Compatible API
Layer 2: Inference Engine (llama.cpp / MLX)
Layer 1: System Optimization
```

**New Components:**
1. **System Prompt Presets** — Domain-specific behavior tuning (`presets/legal.txt`, `presets/hr.txt`, `presets/ngo.txt`)
2. **Document Ingestion Pipeline** — PDF/DOCX -> text extraction -> chunking -> embeddings
3. **Vector Database** — Local embeddings storage (ChromaDB)
4. **RAG Query Engine** — Retrieval + context injection + LLM generation

---

## 3. Prerequisites & Setup

### 3.1 Install Dependencies

```bash
# From Lumina-Edge root
pip install -r scripts/requirements-rag.txt
```

**Dependency Breakdown:**
- `chromadb` — Local vector database (SQLite-backed, no server)
- `sentence-transformers` — Embedding model (runs locally)
- `pymupdf` — PDF text extraction
- `pdfplumber` — Alternative PDF parser (tables)
- `python-docx` — Microsoft Word parsing
- `tiktoken` — Token counting for chunking
- `requests` — HTTP client for local API

### 3.2 Directory Structure

Already created:
- `presets/` — System prompt files
- `vectordb/` — ChromaDB persistent storage
- `ingestion_cache/` — Temporary processing storage
- `demo_docs/` — Sample documents for demo

---

## 4. Configuration

### config.json

The following fields have been added to `config.json`:

```json
{
  "use_case": "legal",
  "system_prompt_preset": "presets/legal.txt",
  "rag_enabled": true,
  "vectordb_path": "vectordb/",
  "embedding_model": "all-MiniLM-L6-v2",
  "chunk_size": 512,
  "chunk_overlap": 50,
  "retrieval_top_k": 5
}
```

- `use_case` — Selector: `"legal"`, `"hr"`, or `"ngo"`
- `system_prompt_preset` — Path to system prompt file
- `rag_enabled` — Toggle RAG pipeline on/off
- `vectordb_path` — ChromaDB storage location
- `embedding_model` — HuggingFace model for embeddings
- `chunk_size` — Text chunk size in tokens
- `chunk_overlap` — Overlap between chunks
- `retrieval_top_k` — Number of chunks to retrieve

---

## 5. Usage

### Step 1: Ingest Documents

```bash
python scripts/ingest_docs.py demo_docs/
```

Or on Windows:
```bash
scripts\ingest_docs.bat demo_docs\
```

### Step 2: Start Lumina Edge API Server

Use the existing launcher in `core/` (e.g., `lumina-launcher.bat` or `.sh`).

### Step 3: Query Documents

```bash
python scripts/query_docs.py "What is the term length of the NDA?"
```

---

## 6. Demo Documents

Sample documents for all three verticals are provided in `demo_docs/`:
- `sample_nda.txt` — Legal (Non-Disclosure Agreement)
- `employee_handbook_excerpt.txt` — HR (Vacation, Remote Work, Development)
- `grant_report_q1.txt` — NGO (Quarterly Grant Report)

### Suggested Test Queries

**Legal:**
- "What obligations does the Receiving Party have?"
- "What happens to confidential materials after termination?"
- "Which state's laws govern this agreement?"

**HR:**
- "How many vacation days do I get in my 5th year?"
- "What's the budget for professional development?"
- "Can I work remotely full-time?"

**NGO:**
- "How many beneficiaries were reached this quarter?"
- "What was the budget utilization percentage?"
- "What challenges did the project face?"

---

## 7. Troubleshooting

### "No module named 'sentence_transformers'"
```bash
pip install sentence-transformers
```

### "Collection not found"
Run ingestion before querying:
```bash
python scripts/ingest_docs.py demo_docs/
```

### "Cannot connect to Lumina Edge API"
Ensure the API server is running. Check the port in `config.json` (`api_port`).

### Slow embedding generation
First run downloads the embedding model from HuggingFace. Subsequent runs are fast. Switch to a smaller model if needed:
```json
"embedding_model": "paraphrase-MiniLM-L3-v2"
```

### Out of memory during query
Reduce `retrieval_top_k` in `config.json`:
```json
"retrieval_top_k": 3
```

---

## Summary Checklist

- [ ] Base Lumina Edge installation working
- [ ] All Python dependencies installed (`pip install -r scripts/requirements-rag.txt`)
- [ ] System prompt presets created (`presets/`)
- [ ] `config.json` updated with RAG settings
- [ ] Document ingestion script tested
- [ ] Query script tested
- [ ] Demo documents prepared (`demo_docs/`)
- [ ] End-to-end workflow tested
