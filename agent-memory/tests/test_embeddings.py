"""Unit tests for the embedding and similarity search layer."""
import pytest
import math


def test_cosine_similarity_identical():
    from agent_memory.embeddings import cosine_similarity
    v = [1.0, 0.0, 0.0]
    assert math.isclose(cosine_similarity(v, v), 1.0, abs_tol=1e-6)


def test_cosine_similarity_orthogonal():
    from agent_memory.embeddings import cosine_similarity
    assert math.isclose(cosine_similarity([1.0, 0.0], [0.0, 1.0]), 0.0, abs_tol=1e-6)


def test_top_k_similar_returns_correct_order():
    from agent_memory.embeddings import top_k_similar
    results = top_k_similar([1.0, 0.0, 0.0], [("mem_a", [0.9, 0.1, 0.0]), ("mem_b", [0.0, 1.0, 0.0]), ("mem_c", [0.95, 0.05, 0.0])], k=2)
    assert len(results) == 2
    assert results[0][0] == "mem_c"
    assert results[1][0] == "mem_a"
    assert results[0][1] > results[1][1]


def test_top_k_similar_empty_candidates():
    from agent_memory.embeddings import top_k_similar
    assert top_k_similar([1.0, 0.0], [], k=5) == []


def test_top_k_similar_k_larger_than_candidates():
    from agent_memory.embeddings import top_k_similar
    assert len(top_k_similar([1.0, 0.0], [("mem_a", [1.0, 0.0])], k=10)) == 1


def test_top_k_similar_min_score_filter():
    from agent_memory.embeddings import top_k_similar
    results = top_k_similar([1.0, 0.0], [("mem_high", [1.0, 0.0]), ("mem_low", [0.0, 1.0])], k=5, min_score=0.5)
    ids = [r[0] for r in results]
    assert "mem_high" in ids
    assert "mem_low" not in ids


def test_embed_returns_normalized_vector():
    from agent_memory.embeddings import embed
    import math
    v = embed("test sentence for embedding")
    assert math.isclose(math.sqrt(sum(x ** 2 for x in v)), 1.0, abs_tol=1e-5)


def test_embed_different_texts_different_vectors():
    from agent_memory.embeddings import embed
    assert embed("database architecture decisions") != embed("marketing campaign strategy")


def test_embed_similar_texts_high_similarity():
    from agent_memory.embeddings import embed, cosine_similarity
    assert cosine_similarity(embed("we chose PostgreSQL as our database"), embed("we selected PostgreSQL for data storage")) > 0.7
