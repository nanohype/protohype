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
    """Isolated SQLite DB per test."""
    path = str(tmp_path / "test_memory.db")
    return path


@pytest_asyncio.fixture(scope="function")
async def app(db_path, monkeypatch):
    """Fresh FastAPI app with isolated DB for each test."""
    monkeypatch.setenv("SPASTIC_MEMORY_DB_PATH", db_path)
    monkeypatch.setenv("SPASTIC_MEMORY_SEED_MD_PATH", "/nonexistent/memory.md")
    monkeypatch.setenv("SPASTIC_MEMORY_SUMMARIZE_THRESHOLD", "5")  # Low for testing
    monkeypatch.setenv("SPASTIC_MEMORY_SUMMARIZE_BATCH_SIZE", "3")
    monkeypatch.setenv("SPASTIC_MEMORY_SUMMARIZE_MIN_AGE_HOURS", "0")

    # Reset module-level DB state
    import importlib
    from spastic_memory import db as db_mod
    db_mod._db = None

    # Reload settings with new env
    from spastic_memory import config
    importlib.reload(config)
    from spastic_memory import db as db_reload
    importlib.reload(db_reload)

    from spastic_memory.main import app as _app
    async with _app.router.lifespan_context(_app):
        yield _app


@pytest_asyncio.fixture(scope="function")
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
