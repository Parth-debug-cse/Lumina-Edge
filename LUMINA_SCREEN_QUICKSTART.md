# Lumina Screen — Quick Start Guide

## Prerequisites (One-Time Setup)

### Step 1: Install Dependencies
```bash
cd /Users/maansibr/Developer/2026-Lumina-Edge-LLM-Inference-Framework
pip install -r lumina_screen/requirements.txt
```

**What it installs:**
- pdfplumber (reads PDFs)
- sentence-transformers (makes embeddings)
- chromadb (stores vectors)
- numpy, torch (required libraries)

**Expected**: Text scrolls by, ends with "Successfully installed..."

---

## Running the Pipeline

### Step 2: Verify Everything is Ready
```bash
python3 lumina_screen/init_pipeline.py
```

**Expected output:**
```
[Lumina Screen Init] ✓ All dependencies available
[Lumina Screen Init] ✓ config.json valid
[Lumina Screen Init] ✓ JD file valid (50 chars)
[Lumina Screen Init] ✓ PIPELINE READY
```

**If you see errors**: Stop here and fix them before continuing.

---

### Step 3: Start the Pipeline
```bash
python3 lumina_screen/main.py
```

**Expected output (takes 5-10 seconds):**
```
Warning: You are sending unauthenticated requests to the HF Hub...
Loading weights: 100%|████████████| 103/103 [00:08<00:00, 10.9MB/s]
[Lumina Screen] Resume folder : /Users/maansibr/Developer/2026-Lumina-Edge-LLM-Inference-Framework/lumina_screen/resumes
[Lumina Screen] JD loaded      : /Users/maansibr/Developer/2026-Lumina-Edge-LLM-Inference-Framework/lumina_screen/jd.txt
[Lumina Screen] Match threshold: 0.4
[Lumina Screen] Model loaded   : all-MiniLM-L6-v2
[Lumina Screen] ChromaDB path  : /Users/maansibr/Developer/2026-Lumina-Edge-LLM-Inference-Framework/lumina_screen/chroma_store
[Lumina Screen] Startup scan   : N PDF(s) found
[Lumina Screen] SHORTLISTED: [Name] ([score])
[Lumina Screen] SHORTLISTED: [Name] ([score])
[Lumina Screen] Watching for resumes... (Ctrl+C to stop)
```

**DO NOT CLOSE THIS TERMINAL** — Keep it running. The pipeline is now watching for resumes.

---

### Step 4: Test It Works (In a NEW Terminal)
Open a new terminal window and run:

```bash
cd /Users/maansibr/Developer/2026-Lumina-Edge-LLM-Inference-Framework

# Copy a test resume
cp lumina_screen/resumes/Jane_Smith_resume.pdf lumina_screen/resumes/test_$(date +%s).pdf

# Wait 3 seconds for processing
sleep 3

# Check results
cat lumina_screen/page_hit.txt
```

**Expected output:**
```
[2026-05-15 HH:MM:SS] | John Doe | John_Doe_resume.pdf | 0.4899 | john.doe@email.com | +1 555 123 4567
```

If you see a line, **IT WORKS!** ✅

---

## How to Use It

### Dropping Resumes
1. Copy/paste PDF files into `lumina_screen/resumes/`
2. Pipeline detects them automatically (within 1 second)
3. Processes them and scores against JD
4. Shortlisted candidates appear in `page_hit.txt`

### Viewing Results
```bash
# See all shortlisted candidates
cat lumina_screen/page_hit.txt

# See which resumes have been processed
cat lumina_screen/processed.json | python3 -m json.tool
```

### Changing the Job Description
```bash
# Edit the JD
nano lumina_screen/jd.txt

# Save, then restart the pipeline (Ctrl+C in pipeline terminal, then re-run Step 3)
```

### Adjusting Match Threshold
Edit `lumina_screen/config.json`:
```json
{
  "match_threshold": 0.40
}
```
- **0.20-0.40** = Loose matching (more candidates)
- **0.40-0.60** = Moderate (default)
- **0.60-0.80** = Strict (fewer candidates)
- **0.80-1.00** = Very strict (only perfect matches)

---

## Stopping the Pipeline

In the terminal where the pipeline is running:
```bash
Ctrl+C
```

Wait 2 seconds, it will shut down cleanly.

---

## Troubleshooting

### Problem: "pdfplumber is not installed"
```bash
pip install pdfplumber
```

### Problem: Pipeline loads but no resumes process
**Check 1:** Is jd.txt empty?
```bash
cat lumina_screen/jd.txt
wc -c lumina_screen/jd.txt  # Should be > 0
```

**Check 2:** Are there PDFs in the resumes folder?
```bash
ls lumina_screen/resumes/*.pdf
```

**Check 3:** Did you wait long enough for scoring?
- First run takes 8-10 seconds (downloading model)
- Subsequent runs take 1-2 seconds per resume

### Problem: Match scores too low/too high
Edit `lumina_screen/config.json` and change `match_threshold`:
```bash
nano lumina_screen/config.json
```
Then restart the pipeline.

### Problem: Pipeline exits with error
Run the verification script:
```bash
python3 lumina_screen/init_pipeline.py
```
It will tell you what's wrong.

---

## Summary

| Step | Command | Time |
|------|---------|------|
| 1 | `pip install -r lumina_screen/requirements.txt` | 2-5 min |
| 2 | `python3 lumina_screen/init_pipeline.py` | 5 sec |
| 3 | `python3 lumina_screen/main.py` | 8-10 sec (first run) |
| 4 | Copy resume & check results | 5 sec |

**Total time to first result: ~15-20 minutes**

---

## That's It!

The pipeline is now running and will:
- ✅ Automatically detect new resumes in the folder
- ✅ Extract text using pdfplumber
- ✅ Score them against your JD
- ✅ Log shortlisted candidates to `page_hit.txt`
- ✅ Track processed files to avoid duplicates

**Leave the pipeline running (Step 3 terminal) and drop resumes whenever you want.**
