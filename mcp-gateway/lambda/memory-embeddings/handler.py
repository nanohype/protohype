"""
Embedding Lambda Handler

Receives: { "text": "string to embed" } or { "texts": ["array", "of", "strings"] }
Returns:  { "embedding": [float, ...] } or { "embeddings": [[float, ...], ...] }

Model: all-MiniLM-L6-v2 — 384 dimensions, ~90MB, semantic similarity search
"""

import json
import os
import logging
from typing import Union

logger = logging.getLogger(__name__)
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_model = None


def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        model_name = os.environ.get("MODEL_NAME", "all-MiniLM-L6-v2")
        logger.info(f"Loading model: {model_name}")
        _model = SentenceTransformer(model_name)
        logger.info("Model loaded successfully")
    return _model


def embed_text(text: str) -> list[float]:
    model = get_model()
    embedding = model.encode(text, normalize_embeddings=True)
    return embedding.tolist()


def embed_texts(texts: list[str]) -> list[list[float]]:
    model = get_model()
    embeddings = model.encode(texts, normalize_embeddings=True, batch_size=32)
    return [e.tolist() for e in embeddings]


def lambda_handler(event: dict, context) -> dict:
    try:
        if "text" in event:
            text = event["text"]
            if not isinstance(text, str) or not text.strip():
                return {"error": "text must be a non-empty string"}
            # Truncate to stay within model limits
            text = text[:2048]
            embedding = embed_text(text)
            return {"embedding": embedding, "dimensions": len(embedding)}

        elif "texts" in event:
            texts = event["texts"]
            if not isinstance(texts, list) or not texts:
                return {"error": "texts must be a non-empty list"}
            if len(texts) > 100:
                return {"error": f"texts array too large ({len(texts)}). Maximum 100 items."}
            texts = [str(t)[:2048] for t in texts]
            embeddings = embed_texts(texts)
            return {"embeddings": embeddings, "count": len(embeddings), "dimensions": len(embeddings[0]) if embeddings else 0}

        else:
            return {"error": "Request must contain 'text' or 'texts' field"}

    except Exception as e:
        logger.error(f"Embedding error: {e}", exc_info=True)
        return {"error": str(e)}
