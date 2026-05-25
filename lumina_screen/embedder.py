import os

import numpy as np

# BUG LS-7 FIX: Lazy-import and cache SentenceTransformer at module level so
# the model is only loaded once across all Embedder instances, and a clear
# error is raised if the library or the model download fails.
try:
    from sentence_transformers import SentenceTransformer as _SentenceTransformer
except ImportError:
    _SentenceTransformer = None

import chromadb


COLLECTION_NAME = "lumina_screen_resumes"
CHUNK_SIZE = 200
CHUNK_OVERLAP = 50

# Module-level model singleton — avoids re-downloading / re-loading on every
# Embedder() construction and keeps startup deterministic.
_MODEL_NAME = "all-MiniLM-L6-v2"
_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", _MODEL_NAME)
_model_singleton = None


def _get_model():
    """Return the cached SentenceTransformer model, loading it on first call.

    The model is stored under lumina_screen/models/all-MiniLM-L6-v2/ so it is
    never re-downloaded from HuggingFace after the first successful download.
    """
    global _model_singleton
    if _model_singleton is None:
        if _SentenceTransformer is None:
            raise RuntimeError(
                "sentence-transformers is not installed. "
                "Run: pip install sentence-transformers"
            )
        try:
            if os.path.isdir(_MODEL_DIR):
                # Load from local cache — no network needed.
                _model_singleton = _SentenceTransformer(_MODEL_DIR)
            else:
                # First run: download from HuggingFace, then persist locally.
                print(f"[Lumina Screen] Downloading model '{_MODEL_NAME}' (one-time)...")
                tmp = _SentenceTransformer(_MODEL_NAME)
                os.makedirs(_MODEL_DIR, exist_ok=True)
                tmp.save(_MODEL_DIR)
                _model_singleton = tmp
                print(f"[Lumina Screen] Model saved to: {_MODEL_DIR}")
        except Exception as e:
            raise RuntimeError(
                f"Failed to load or download SentenceTransformer model '{_MODEL_NAME}': {e}\n"
                "Ensure you have an internet connection on first run."
            ) from e
    return _model_singleton


class Embedder:
    """
    Wraps sentence-transformers (all-MiniLM-L6-v2) and ChromaDB for
    JD + resume embedding and cosine-similarity scoring.
    """

    def __init__(self, chroma_path, jd_text):
        # BUG-LS7 FIX: An empty JD text produces a zero-vector embedding, causing every
        # resume to score ~0.0 silently.  Fail fast here with an actionable message.
        if not jd_text or not jd_text.strip():
            raise ValueError(
                "JD text is empty — cannot compute embeddings. "
                "Please add content to jd.txt before starting the pipeline."
            )

        os.makedirs(chroma_path, exist_ok=True)

        # BUG LS-7 FIX: Use the module-level singleton instead of constructing
        # a new SentenceTransformer on every Embedder instantiation.
        self.model = _get_model()

        # BUG LS-8 FIX: Wrap ChromaDB client and collection creation in
        # try/except so schema-change errors on fresh installs surface clearly.
        try:
            self.client = chromadb.PersistentClient(path=chroma_path)
        except Exception as e:
            raise RuntimeError(
                f"ChromaDB PersistentClient failed at path '{chroma_path}': {e}\n"
                "Try: pip install --upgrade chromadb"
            ) from e

        try:
            self.collection = self.client.get_or_create_collection(
                name=COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )
        except Exception as e:
            raise RuntimeError(
                f"ChromaDB get_or_create_collection('{COLLECTION_NAME}') failed: {e}\n"
                "If this is a fresh install, try deleting the chroma_store/ directory "
                "and re-running."
            ) from e

        self.jd_embedding = self._embed(jd_text)
        self.collection.upsert(
            ids=["__jd__"],
            embeddings=[self.jd_embedding],
            metadatas=[{"type": "jd"}],
            documents=[jd_text],
        )

    def reload_jd(self, new_jd_text):
        """
        BUG LS-D1 FIX: Reload and re-embed the JD text if it has changed.
        Called when the JD file is updated during pipeline execution.
        Updates both the cached embedding and the ChromaDB collection.
        """
        self.jd_embedding = self._embed(new_jd_text)
        self.collection.upsert(
            ids=["__jd__"],
            embeddings=[self.jd_embedding],
            metadatas=[{"type": "jd"}],
            documents=[new_jd_text],
        )

    @staticmethod
    def _chunk(text):
        """
        Split text into word-based chunks with overlap.
        Returns list of text chunks.
        """
        words = text.split()
        if len(words) <= CHUNK_SIZE:
            return [text]
        chunks = []
        start = 0
        while start < len(words):
            end = min(start + CHUNK_SIZE, len(words))
            chunks.append(" ".join(words[start:end]))
            if end == len(words):
                break
            start += CHUNK_SIZE - CHUNK_OVERLAP
        return chunks

    def _embed(self, text):
        return self.model.encode(text).tolist()

    @staticmethod
    def _mean_embedding(embeddings):
        if not embeddings:
            return None
        return np.array(embeddings).mean(axis=0).tolist()

    def embed_resume(self, resume_id, raw_text):
        """
        Chunk raw_text, embed each chunk, store in ChromaDB, and return
        the mean embedding vector for scoring.
        """
        if not raw_text.strip():
            return None
        chunks = self._chunk(raw_text)
        ids = [f"{resume_id}_chunk_{i}" for i in range(len(chunks))]

        embeddings = [self._embed(c) for c in chunks]
        self.collection.upsert(
            ids=ids,
            embeddings=embeddings,
            metadatas=[
                {"resume_id": resume_id, "chunk": i} for i in range(len(chunks))
            ],
            documents=chunks,
        )
        return self._mean_embedding(embeddings)

    def get_match_score(self, resume_embedding):
        """
        Compute cosine similarity between the JD embedding and a resume
        embedding vector. Returns a float in [0, 1].
        """
        if resume_embedding is None:
            return 0.0
        a = np.array(self.jd_embedding)
        b = np.array(resume_embedding)
        norm = np.linalg.norm(a) * np.linalg.norm(b)
        if norm == 0.0:
            return 0.0
        return float(np.dot(a, b) / norm)
