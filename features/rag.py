"""features/rag.py — Feature 5: retrieval-augmented Q&A over uploaded documents.

Uploaded PDFs / Word / PowerPoint already have their text extracted. Instead of
stuffing a truncated blob into the prompt, this module chunks the documents,
retrieves the chunks most relevant to a question, and asks Claude to answer
using only those chunks — with inline [n] citations back to the source file.

Retrieval uses sentence-transformer embeddings + FAISS when available, and
falls back to a fully-offline TF-IDF cosine retriever otherwise.
"""
import hashlib
import re
from typing import Optional

import numpy as np

_CACHE: dict = {}          # cache_key -> _Retriever
_EMBED_MODEL = None        # lazily loaded sentence-transformer (or False if unavailable)


# ── Chunking ──────────────────────────────────────────────────────────────────

def _chunk(text: str, size: int = 900, overlap: int = 150) -> list:
    text = re.sub(r"\n{3,}", "\n\n", text or "").strip()
    if not text:
        return []
    chunks, start = [], 0
    while start < len(text):
        end = start + size
        chunk = text[start:end]
        # try not to cut mid-paragraph
        if end < len(text):
            nl = chunk.rfind("\n")
            if nl > size * 0.5:
                chunk = chunk[:nl]
                end = start + nl
        chunks.append(chunk.strip())
        start = max(end - overlap, end) if end <= start else end - overlap
    return [c for c in chunks if c]


def _get_embed_model():
    global _EMBED_MODEL
    if _EMBED_MODEL is None:
        try:
            from sentence_transformers import SentenceTransformer
            _EMBED_MODEL = SentenceTransformer("all-MiniLM-L6-v2")
        except Exception:
            _EMBED_MODEL = False     # mark unavailable → TF-IDF fallback
    return _EMBED_MODEL or None


# ── Retriever ─────────────────────────────────────────────────────────────────

class _Retriever:
    def __init__(self, chunks: list, sources: list):
        self.chunks  = chunks
        self.sources = sources       # parallel list of source filenames
        self.mode    = ""
        self._index  = None
        self._matrix = None
        self._vectorizer = None
        self._build()

    def _build(self):
        model = _get_embed_model()
        if model is not None:
            try:
                import faiss
                emb = model.encode(self.chunks, normalize_embeddings=True,
                                   show_progress_bar=False).astype("float32")
                self._index = faiss.IndexFlatIP(emb.shape[1])
                self._index.add(emb)
                self._embeddings = emb
                self.mode = "embeddings"
                return
            except Exception:
                pass
        # Fallback: TF-IDF cosine
        from sklearn.feature_extraction.text import TfidfVectorizer
        self._vectorizer = TfidfVectorizer(stop_words="english", max_features=20000)
        self._matrix = self._vectorizer.fit_transform(self.chunks)
        self.mode = "tfidf"

    def search(self, query: str, k: int = 5) -> list:
        k = min(k, len(self.chunks))
        if k == 0:
            return []
        if self.mode == "embeddings":
            model = _get_embed_model()
            q = model.encode([query], normalize_embeddings=True,
                             show_progress_bar=False).astype("float32")
            scores, idx = self._index.search(q, k)
            idx, scores = idx[0], scores[0]
        else:
            from sklearn.metrics.pairwise import linear_kernel
            qv = self._vectorizer.transform([query])
            sims = linear_kernel(qv, self._matrix).ravel()
            idx = np.argsort(sims)[::-1][:k]
            scores = sims[idx]
        return [
            {"rank": r + 1, "source": self.sources[i], "text": self.chunks[i],
             "score": round(float(scores[r]), 4)}
            for r, i in enumerate(idx)
        ]


# ── Index build (cached) ──────────────────────────────────────────────────────

def _cache_key(docs: list) -> str:
    h = hashlib.sha256()
    for d in docs:
        h.update((d.get("name", "") + "::" + (d.get("text", "")[:2000])).encode("utf-8", "ignore"))
    return h.hexdigest()[:16]


def build_index(docs: list) -> _Retriever:
    """docs: list of {"name": filename, "text": extracted_text}. Cached by content."""
    key = _cache_key(docs)
    if key in _CACHE:
        return _CACHE[key]
    chunks, sources = [], []
    for d in docs:
        for ch in _chunk(d.get("text", "")):
            chunks.append(ch)
            sources.append(d.get("name", "document"))
    if not chunks:
        raise ValueError("No extractable document text to index.")
    retr = _Retriever(chunks, sources)
    _CACHE[key] = retr
    return retr


# ── Public Q&A ────────────────────────────────────────────────────────────────

def answer(docs: list, question: str, k: int = 5) -> dict:
    """Retrieve the most relevant chunks and answer the question with citations."""
    from config import query_cerebras

    retriever = build_index(docs)
    hits = retriever.search(question, k=k)
    if not hits:
        return {"answer": "No relevant content found in the documents.",
                "citations": [], "retrieval_mode": retriever.mode}

    context = "\n\n".join(f"[{h['rank']}] (source: {h['source']})\n{h['text']}" for h in hits)
    resp = query_cerebras([
        {"role": "system", "content": (
            "You are a document analyst. Answer the user's question using ONLY the "
            "numbered context passages provided. Cite the passages you use with "
            "their bracket number, e.g. [1]. If the answer is not in the passages, "
            "say so plainly. Be concise and specific."
        )},
        {"role": "user", "content": f"Question: {question}\n\nContext passages:\n{context}"},
    ], max_tokens=900)

    citations = [{"n": h["rank"], "source": h["source"],
                  "snippet": h["text"][:240], "score": h["score"]} for h in hits]
    return {"answer": resp, "citations": citations, "retrieval_mode": retriever.mode}


def context_for_chat(docs: list, question: str, k: int = 4, max_chars: int = 4000) -> str:
    """Return a retrieved-context block to inject into the existing chat prompt."""
    try:
        retriever = build_index(docs)
        hits = retriever.search(question, k=k)
    except Exception:
        return ""
    if not hits:
        return ""
    block = "\n\n".join(f"[{h['rank']}] (source: {h['source']})\n{h['text']}" for h in hits)
    return block[:max_chars]
