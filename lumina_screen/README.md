# Lumina Screen

A self-contained resume screening pipeline that watches a folder for PDF
resumes, parses them, computes semantic similarity against a job description
using sentence-transformers + ChromaDB, and fires desktop notifications for
shortlisted candidates.

## Pipeline

```
watch → dedup → parse → embed → match → notify
```

1. **Watcher** — polls a folder for new files (pure `time.sleep()`, no OS-specific APIs)
2. **Dedup** — SHA-256 hash of file bytes, persisted to `processed.json`
3. **Parser** — extracts text via `pdfplumber`, pulls name/email/phone by regex
4. **Embedder** — `all-MiniLM-L6-v2` embeddings stored in local ChromaDB
5. **Matcher** — cosine similarity vs. JD embedding, configurable threshold
6. **Notifier** — OS-native popup + append to `page_hit.txt`

## Requirements

| OS | Notes |
|----|-------|
| Windows | Python 3.8+ |
| Linux   | Python 3.8+, `libnotify` (`sudo apt install libnotify-bin`) |
| macOS   | Python 3.8+ |

## Setup

```bash
# 1. Install dependencies
pip install -r lumina_screen/requirements.txt

# 2. (Optional) Edit configuration
#     nano lumina_screen/config.json

# 3. Place your job description in lumina_screen/jd.txt
#     (a placeholder is already there)

# 4. Create the resumes folder (or change resume_folder in config)
mkdir -p resumes

# 5. Run the pipeline
python lumina_screen/main.py
```

Drop PDF resumes into the watched folder. Shortlisted candidates appear as
desktop notifications and are logged to `lumina_screen/page_hit.txt`.

## Configuration

All settings in `lumina_screen/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `resume_folder` | `./resumes` | Folder to watch for PDF files |
| `poll_interval_ms` | `300` | Watcher poll interval in milliseconds |
| `match_threshold` | `0.65` | Minimum cosine similarity for shortlisting |
| `chroma_store_path` | `./lumina_screen/chroma_store` | ChromaDB persistent storage path |
| `jd_path` | `./lumina_screen/jd.txt` | Job description text file |
| `page_hit_path` | `./lumina_screen/page_hit.txt` | Output log for shortlisted candidates |

## page_hit.txt format

```
[TIMESTAMP] | [NAME] | [FILENAME] | [SCORE] | [EMAIL] | [PHONE]
```

## Notes

- No LLM calls — the embedding model is the sole AI component
- No OCR — scanned PDFs without extractable text are silently skipped
- No watchdog — pure polling for cross-platform consistency
- Processed files are tracked by SHA-256 hash across restarts
- ChromaDB collection name: `lumina_screen_resumes`
