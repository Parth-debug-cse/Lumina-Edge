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
    match = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    return match.group(0) if match else ""


def _extract_phone(text):
    """
    Match phone numbers in various formats:
      (123) 456-7890, 123-456-7890, +1 123 456 7890, 123.456.7890,
      +44 20 7946 0958, +91 98765 43210
    """
    pattern = r"(\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,5}"
    match = re.search(pattern, text)
    return match.group(0).strip() if match else ""


def _extract_name(text):
    """
    Heuristic: scan the first 5 non-empty lines for something that looks
    like a person's name (capitalized words, 2-4 tokens).
    """
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    for line in lines[:5]:
        if re.match(r"^[A-Z][a-zA-Z]+(?:[ '-][A-Z][a-zA-Z]+){1,3}$", line):
            return line
    return ""


def parse(filepath):
    """
    Extract full text from a PDF resume, then parse out name, email, and phone.
    Returns dict with keys: raw_text, name, email, phone.
    """
    raw_text = _extract_text(filepath)
    return {
        "raw_text": raw_text,
        "name": _extract_name(raw_text),
        "email": _extract_email(raw_text),
        "phone": _extract_phone(raw_text),
    }
