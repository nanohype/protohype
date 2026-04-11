"""Shared test fixtures."""
import asyncio
import os
import tempfile
import pytest
import pytest_asyncio

from httpx import AsyncClient, ASGITransport


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="function")
async def db_path(tmp_path):
    path = str(tmp_path / "test_memory.db")
    return path


@pytest_asyncio.fixture(scope="function")
async def app(db_path, monkeypatch):
    monkeypatch.setenv("AGENT_MEMORY_DB_PATH", db_path)
    monkeypatch.setenv("AGENT_MEMORY_SEED_MD_PATH", "/nonexistent/memory.md")
    monkeypatch.setenv("AGENT_MEMORY_SUMMARIZE_THRESHOLD", "5")
    monkeypatch.setenv("AGENT_MEMORY_SUMMARIZE_BATCH_SIZE", "3")
    monkeypatch.setenv("AGENT_MEMORY_SUMMARIZE_MIN_AGE_HOURS", "0")

    import importlib
    from agent_memory import db as db_mod
    db_mod._db = None

    from agent_memory import config
    importlib.reload(config)
    from agent_memory import db as db_reload
    importlib.reload(db_reload)

    from agent_memory.main import app as _app
    async with _app.router.lifespan_context(_app):
        yield _app


@pytest_asyncio.fixture(scope="function")
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
