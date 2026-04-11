"""Unit tests for the SQLite database layer."""
import pytest
import pytest_asyncio
import os


@pytest_asyncio.fixture
async def initialized_db(tmp_path):
    from agent_memory import db as db_mod
    import importlib
    from agent_memory import config

    os.environ["AGENT_MEMORY_DB_PATH"] = str(tmp_path / "test.db")
    importlib.reload(config)
    importlib.reload(db_mod)

    db_mod._db = None
    await db_mod.init_db()
    yield db_mod
    await db_mod.close_db()


@pytest.mark.asyncio
async def test_insert_and_retrieve_memory(initialized_db):
    db = initialized_db
    memory = await db.insert_memory(id="test_id_001", role="product", content="Test decision content", tags=["test", "decision"])
    assert memory["id"] == "test_id_001"
    assert memory["role"] == "product"
    assert memory["tags"] == ["test", "decision"]
    assert memory["is_summary"] is False
    retrieved = await db.get_memory_by_id("test_id_001")
    assert retrieved is not None
    assert retrieved["content"] == "Test decision content"


@pytest.mark.asyncio
async def test_delete_memory(initialized_db):
    db = initialized_db
    await db.insert_memory(id="del_001", role="qa", content="To delete", tags=[])
    deleted = await db.delete_memory("del_001")
    assert deleted is True
    assert await db.get_memory_by_id("del_001") is None


@pytest.mark.asyncio
async def test_delete_nonexistent_returns_false(initialized_db):
    deleted = await initialized_db.delete_memory("nonexistent_xyz")
    assert deleted is False


@pytest.mark.asyncio
async def test_memory_count(initialized_db):
    db = initialized_db
    assert await db.get_memory_count() == 0
    await db.insert_memory(id="c1", role="x", content="a", tags=[])
    await db.insert_memory(id="c2", role="x", content="b", tags=[])
    assert await db.get_memory_count() == 2


@pytest.mark.asyncio
async def test_list_memories_pagination(initialized_db):
    db = initialized_db
    for i in range(5):
        await db.insert_memory(id=f"pg_{i}", role="qa", content=f"memory {i}", tags=[])
    page1, total = await db.list_memories(limit=2, offset=0)
    assert len(page1) == 2
    assert total == 5
    page2, _ = await db.list_memories(limit=2, offset=2)
    assert len(page2) == 2
    assert {m["id"] for m in page1}.isdisjoint({m["id"] for m in page2})


@pytest.mark.asyncio
async def test_embedding_cascade_delete(initialized_db):
    db = initialized_db
    await db.insert_memory(id="emb_parent", role="eng-ai", content="with embedding", tags=[])
    await db.insert_embedding(id="emb_001", memory_id="emb_parent", vector=[0.1, 0.2, 0.3], model="test-model")
    assert any(mid == "emb_parent" for mid, _ in await db.get_all_embeddings())
    await db.delete_memory("emb_parent")
    assert not any(mid == "emb_parent" for mid, _ in await db.get_all_embeddings())


@pytest.mark.asyncio
async def test_vector_pack_unpack_roundtrip(initialized_db):
    db = initialized_db
    original = [0.1, 0.2, 0.3, -0.5, 1.0]
    packed = db.pack_vector(original)
    unpacked = db.unpack_vector(packed)
    assert len(unpacked) == len(original)
    for a, b in zip(original, unpacked):
        assert abs(a - b) < 1e-6


@pytest.mark.asyncio
async def test_summary_memory_flag(initialized_db):
    db = initialized_db
    await db.insert_memory(id="sum_001", role="system", content="Summary", tags=["summary"], is_summary=True)
    retrieved = await db.get_memory_by_id("sum_001")
    assert retrieved["is_summary"] is True
