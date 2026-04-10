"""Unit tests for the embedding and similarity search layer."""
import pytest
import math


def test_cosine_similarity_identical():
    from spastic_memory.embeddings import cosine_similarity
    v = [1.0, 0.0, 0.0]
    assert math.isclose(cosine_similarity(v, v), 1.0, abs_tol=1e-6)


def test_cosine_similarity_orthogonal():
    from spastic_memory.embeddings import cosine_similarity
    a = [1.0, 0.0]
    b = [0.0, 1.0]
    assert math.isclose(cosine_similarity(a, b), 0.0, abs_tol=1e-6)


def test_top_k_similar_returns_correct_order():
    from spastic_memory.embeddings import top_k_similar
    query = [1.0, 0.0, 0.0]
    candidates = [
        ("mem_a", [0.9, 0.1, 0.0]),
        ("mem_b", [0.0, 1.0, 0.0]),
        ("mem_c", [0.95, 0.05, 0.0]),
    ]
    results = top_k_similar(query, candidates, k=2)
    assert len(results) == 2
    assert results[0][0] == "mem_c"  # highest similarity
    assert results[1][0] == "mem_a"
    assert results[0][1] > results[1][1]


def test_top_k_similar_empty_candidates():
    from spastic_memory.embeddings import top_k_similar
    results = top_k_similar([1.0, 0.0], [], k=5)
    assert results == []


def test_top_k_similar_k_larger_than_candidates():
    from spastic_memory.embeddings import top_k_similar
    query = [1.0, 0.0]
    candidates = [("mem_a", [1.0, 0.0])]
    results = top_k_similar(query, candidates, k=10)
    assert len(results) == 1


def test_top_k_similar_min_score_filter():
    from spastic_memory.embeddings import top_k_similar
    query = [1.0, 0.0]
    candidates = [
        ("mem_high", [1.0, 0.0]),
        ("mem_low", [0.0, 1.0]),
    ]
    results = top_k_similar(query, candidates, k=5, min_score=0.5)
    ids = [r[0] for r in results]
    assert "mem_high" in ids
    assert "mem_low" not in ids


def test_embed_returns_normalized_vector():
    """Embedding should return a vector with unit norm."""
    from spastic_memory.embeddings import embed
    import math
    v = embed("test sentence for embedding")
    norm = math.sqrt(sum(x ** 2 for x in v))
    assert math.isclose(norm, 1.0, abs_tol=1e-5)


def test_embed_different_texts_different_vectors():
    from spastic_memory.embeddings import embed
    v1 = embed("database architecture decisions")
    v2 = embed("marketing campaign strategy")
    # Should not be identical
    assert v1 != v2


def test_embed_similar_texts_high_similarity():
    from spastic_memory.embeddings import embed, cosine_similarity
    v1 = embed("we chose PostgreSQL as our database")
    v2 = embed("we selected PostgreSQL for data storage")
    sim = cosine_similarity(v1, v2)
    assert sim > 0.7  # Should be semantically similar
