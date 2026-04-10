"""Local embedding generation and semantic search using sentence-transformers."""
import numpy as np
from typing import TYPE_CHECKING

from .config import settings

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

_model: "SentenceTransformer | None" = None


def get_model() -> "SentenceTransformer":
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(settings.embedding_model)
    return _model


def embed(text: str) -> list[float]:
    """Generate a normalized embedding vector for the given text."""
    model = get_model()
    vector = model.encode(text, normalize_embeddings=True)
    return vector.tolist()


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two normalized vectors (dot product suffices)."""
    va = np.array(a, dtype=np.float32)
    vb = np.array(b, dtype=np.float32)
    return float(np.dot(va, vb))


def top_k_similar(
    query_vector: list[float],
    candidates: list[tuple[str, list[float]]],
    k: int,
    min_score: float = 0.0,
) -> list[tuple[str, float]]:
    """
    Find top-k most similar memory_ids from candidates.

    Args:
        query_vector: normalized query embedding
        candidates: list of (memory_id, vector) pairs
        k: number of results to return
        min_score: minimum similarity threshold

    Returns:
        list of (memory_id, score) sorted by score descending
    """
    if not candidates:
        return []

    query_np = np.array(query_vector, dtype=np.float32)
    ids = [c[0] for c in candidates]
    matrix = np.array([c[1] for c in candidates], dtype=np.float32)

    scores = matrix @ query_np  # shape: (N,)

    # Get top-k indices
    k = min(k, len(scores))
    top_indices = np.argpartition(scores, -k)[-k:]
    top_indices = top_indices[np.argsort(scores[top_indices])[::-1]]

    results = []
    for idx in top_indices:
        score = float(scores[idx])
        if score >= min_score:
            results.append((ids[idx], score))

    return results
