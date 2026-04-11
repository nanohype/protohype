"""
Embedding Lambda — computes sentence embeddings using sentence-transformers.

Model: all-MiniLM-L6-v2 (22 MB, 384-dim, fast + high quality for semantic search)
Runtime: Python 3.11 container image

Input:  {"texts": ["string1", "string2", ...]}
Output: {"embeddings": [[float, ...], ...], "model": "all-MiniLM-L6-v2", "dim": 384}
"""

import json
import logging
import os
from typing import Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Model is loaded once at module scope (cold start) and reused on warm invocations.
# The model is baked into the container image at /opt/ml/model/.
MODEL_PATH = os.environ.get("MODEL_PATH", "/opt/ml/model")
MODEL_NAME = os.environ.get("MODEL_NAME", "all-MiniLM-L6-v2")

_model = None


def _get_model():
    global _model  # noqa: PLW0603
    if _model is None:
        from sentence_transformers import SentenceTransformer  # lazy import

        logger.info("Loading model %s from %s", MODEL_NAME, MODEL_PATH)
        _model = SentenceTransformer(MODEL_PATH)
        logger.info("Model loaded. Embedding dim: %d", _model.get_sentence_embedding_dimension())
    return _model


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    texts: list[str] = event.get("texts", [])

    if not texts:
        return {"embeddings": [], "model": MODEL_NAME, "dim": 0}

    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
        raise ValueError("'texts' must be a list of strings")

    # Truncate to 512 tokens max (model limit)
    MAX_CHARS = 2048
    texts = [t[:MAX_CHARS] for t in texts]

    model = _get_model()
    vectors = model.encode(
        texts,
        batch_size=32,
        normalize_embeddings=True,  # L2-normalize for cosine similarity via dot product
        show_progress_bar=False,
    )

    return {
        "embeddings": vectors.tolist(),
        "model": MODEL_NAME,
        "dim": vectors.shape[1] if vectors.ndim > 1 else 0,
    }
