"""Integration tests for the memory service API."""
import pytest


# ---------------------------------------------------------------------------
# POST /api/v1/memories
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_write_memory_returns_201(client):
    resp = await client.post("/api/v1/memories", json={
        "role": "eng-backend",
        "content": "Used SQLite WAL mode for concurrent reads.",
        "tags": ["decision", "database"],
    })
    assert resp.status_code == 201
    body = resp.json()
    assert body["role"] == "eng-backend"
    assert body["content"] == "Used SQLite WAL mode for concurrent reads."
    assert "decision" in body["tags"]
    assert "id" in body
    assert "created_at" in body
    assert body["is_summary"] is False


@pytest.mark.asyncio
async def test_write_memory_minimal(client):
    """Tags are optional."""
    resp = await client.post("/api/v1/memories", json={
        "role": "product",
        "content": "v1 ships without auth.",
    })
    assert resp.status_code == 201
    assert resp.json()["tags"] == []


@pytest.mark.asyncio
async def test_write_memory_validates_role_length(client):
    resp = await client.post("/api/v1/memories", json={
        "role": "x" * 65,
        "content": "too long role",
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_write_memory_validates_content_required(client):
    resp = await client.post("/api/v1/memories", json={
        "role": "product",
        "content": "",
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_write_memory_validates_content_length(client):
    resp = await client.post("/api/v1/memories", json={
        "role": "product",
        "content": "x" * 10001,
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_write_memory_validates_tag_length(client):
    resp = await client.post("/api/v1/memories", json={
        "role": "product",
        "content": "test",
        "tags": ["x" * 65],
    })
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/v1/memories
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_memories_empty(client):
    resp = await client.get("/api/v1/memories")
    assert resp.status_code == 200
    body = resp.json()
    assert body["memories"] == []
    assert body["total"] == 0


@pytest.mark.asyncio
async def test_list_memories_returns_in_desc_order(client):
    for i in range(3):
        await client.post("/api/v1/memories", json={
            "role": "product",
            "content": f"Memory number {i}",
        })

    resp = await client.get("/api/v1/memories")
    assert resp.status_code == 200
    memories = resp.json()["memories"]
    assert len(memories) == 3
    # Newest first
    assert memories[0]["content"] == "Memory number 2"
    assert memories[2]["content"] == "Memory number 0"


@pytest.mark.asyncio
async def test_list_memories_filter_by_role(client):
    await client.post("/api/v1/memories", json={"role": "product", "content": "A"})
    await client.post("/api/v1/memories", json={"role": "eng-backend", "content": "B"})

    resp = await client.get("/api/v1/memories?role=product")
    assert resp.status_code == 200
    memories = resp.json()["memories"]
    assert all(m["role"] == "product" for m in memories)
    assert len(memories) == 1


@pytest.mark.asyncio
async def test_list_memories_pagination(client):
    for i in range(5):
        await client.post("/api/v1/memories", json={"role": "qa", "content": f"M{i}"})

    resp = await client.get("/api/v1/memories?limit=2&offset=0")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["memories"]) == 2
    assert body["total"] == 5
    assert body["limit"] == 2
    assert body["offset"] == 0

    resp2 = await client.get("/api/v1/memories?limit=2&offset=2")
    body2 = resp2.json()
    assert len(body2["memories"]) == 2
    # IDs should be different pages
    ids_p1 = {m["id"] for m in body["memories"]}
    ids_p2 = {m["id"] for m in body2["memories"]}
    assert ids_p1.isdisjoint(ids_p2)


# ---------------------------------------------------------------------------
# POST /api/v1/memories/search
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_returns_relevant_results(client):
    await client.post("/api/v1/memories", json={
        "role": "eng-backend",
        "content": "We chose SQLite as our database because the solopreneur constraint requires zero ops overhead.",
        "tags": ["decision", "database"],
    })
    await client.post("/api/v1/memories", json={
        "role": "marketing",
        "content": "We launched our first blog post on the company's content strategy.",
        "tags": ["marketing", "content"],
    })

    resp = await client.post("/api/v1/memories/search", json={
        "query": "what database decisions did the team make?",
        "top_k": 5,
    })
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) > 0
    # Database memory should be top result
    top = results[0]
    assert "database" in top["memory"]["content"].lower() or "sqlite" in top["memory"]["content"].lower()
    assert 0.0 <= top["score"] <= 1.0


@pytest.mark.asyncio
async def test_search_empty_store(client):
    resp = await client.post("/api/v1/memories/search", json={
        "query": "anything",
        "top_k": 5,
    })
    assert resp.status_code == 200
    assert resp.json()["results"] == []


@pytest.mark.asyncio
async def test_search_role_filter(client):
    await client.post("/api/v1/memories", json={"role": "product", "content": "product decision about features"})
    await client.post("/api/v1/memories", json={"role": "eng-backend", "content": "backend decision about features"})

    resp = await client.post("/api/v1/memories/search", json={
        "query": "decision about features",
        "top_k": 5,
        "role_filter": "product",
    })
    assert resp.status_code == 200
    for r in resp.json()["results"]:
        assert r["memory"]["role"] == "product"


@pytest.mark.asyncio
async def test_search_validates_empty_query(client):
    resp = await client.post("/api/v1/memories/search", json={"query": "", "top_k": 5})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# DELETE /api/v1/memories/:id
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_memory(client):
    create_resp = await client.post("/api/v1/memories", json={
        "role": "product",
        "content": "To be deleted",
    })
    memory_id = create_resp.json()["id"]

    resp = await client.delete(f"/api/v1/memories/{memory_id}")
    assert resp.status_code == 204

    # Verify gone
    list_resp = await client.get("/api/v1/memories")
    ids = [m["id"] for m in list_resp.json()["memories"]]
    assert memory_id not in ids


@pytest.mark.asyncio
async def test_delete_nonexistent_memory_returns_404(client):
    resp = await client.delete("/api/v1/memories/nonexistent_id_xyz")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/v1/memories/summarize
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_manual_summarize(client):
    # Write enough memories to summarize (threshold set to 5 in fixture)
    for i in range(6):
        await client.post("/api/v1/memories", json={
            "role": "eng-backend",
            "content": f"Technical decision number {i}: we decided to use approach {i}.",
            "tags": ["decision"],
        })

    resp = await client.post("/api/v1/memories/summarize")
    assert resp.status_code == 200
    body = resp.json()
    assert body["memories_compressed"] >= 0
    assert "message" in body


# ---------------------------------------------------------------------------
# GET /api/v1/health
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_health_check(client):
    resp = await client.get("/api/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "memory_count" in body
    assert "db_size_bytes" in body
    assert "uptime_seconds" in body
    assert body["uptime_seconds"] >= 0


@pytest.mark.asyncio
async def test_health_reflects_write(client):
    resp1 = await client.get("/api/v1/health")
    count_before = resp1.json()["memory_count"]

    await client.post("/api/v1/memories", json={"role": "product", "content": "new memory"})

    resp2 = await client.get("/api/v1/health")
    count_after = resp2.json()["memory_count"]
    assert count_after == count_before + 1
