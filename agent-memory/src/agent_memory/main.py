"""Application entrypoint."""
import logging
import signal
import asyncio

import uvicorn
from fastapi import FastAPI
from contextlib import asynccontextmanager

from .config import settings
from . import db
from .seeder import seed_from_markdown
from .api import router, public_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Starting agent-memory on {settings.host}:{settings.port}")
    logger.info(f"DB: {settings.db_path}")
    logger.info(f"Embedding model: {settings.embedding_model}")

    await db.init_db()
    logger.info("Database initialized")

    from . import embeddings as emb
    logger.info("Loading embedding model...")
    emb.get_model()
    logger.info("Embedding model loaded")

    seeded = await seed_from_markdown()
    if seeded:
        logger.info(f"Seeded {seeded} memories from memory.md")

    yield

    logger.info("Shutting down...")
    await db.close_db()
    logger.info("Database closed. Bye.")


app = FastAPI(
    title="Agent Memory Service",
    description="Persistent memory for multi-agent systems",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(router)
app.include_router(public_router)


def run():
    uvicorn.run(
        "agent_memory.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
        access_log=True,
    )


if __name__ == "__main__":
    run()
