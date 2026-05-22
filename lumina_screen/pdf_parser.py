import re

try:
    import pdfplumber
except ImportError:
    pdfplumber = None


def _extract_text(filepath):
    if pdfplumber is None:
        raise RuntimeError("pdfplumber is not installed. Run: pip install pdfplumber")
    text = ""
    with pdfplumber.open(filepath) as pdf:
        for page_num, page in enumerate(pdf.pages):
            # BUG LS-9 FIX: Wrap per-page extraction in try/except so that a
            # single corrupt, scanned, or table-heavy page does not abort the
            # entire file.  The rest of the resume is still extracted and scored.
            try:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
            except Exception as e:
                print(
                    f"[pdf_parser] Warning: page {page_num + 1} could not be "
                    f"extracted from {filepath}: {e}"
                )
    return text.strip()


def _extract_email(text):
    """Pull first email-like pattern from raw text. Returns '' if not found (silent)."""
    match = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    return match.group(0) if match else ""  # Silent: empty string if no email, caller handles it


def _extract_phone(text):
    """
    Match phone numbers in various formats:
      (123) 456-7890, 123-456-7890, +1 123 456 7890, 123.456.7890,
      +44 20 7946 0958, +91 98765 43210
    Handles international prefix (+1, +44, +91, etc.) and common separators.
    Returns '' if no match found (silent — phone is optional in results).
    """
    pattern = r"(\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,5}"
    match = re.search(pattern, text)
    return match.group(0).strip() if match else ""


def _extract_name(text):
    """
    Heuristic: scan the first 5 non-empty lines for something that looks
    like a person's name (capitalized words, 2-4 tokens).
    Assumes names appear near the top of a resume. Silent failure: returns
    '' if no pattern matches — filenames are used as fallback upstream.
    """
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    for line in lines[:5]:
        if re.match(r"^[A-Z][a-zA-Z]+(?:[ '-][A-Z][a-zA-Z]+){1,3}$", line):
            return line
    return ""  # No line matched — not an error, but entry will lack a parsed name


def parse(filepath):
    """
    Extract full text from a PDF resume, then parse out name, email, and phone.
    Returns dict with keys: raw_text, name, email, phone.
    Note: name/email/phone fields may be empty strings if extraction fails — the
    caller (process_file) treats those as optional metadata, not fatal errors.
    """
    raw_text = _extract_text(filepath)
    return {
        "raw_text": raw_text,
        "name": _extract_name(raw_text),
        "email": _extract_email(raw_text),
        "phone": _extract_phone(raw_text),
    }
