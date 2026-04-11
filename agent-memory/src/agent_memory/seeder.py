"""Seed the database from a markdown file on startup."""
import logging
import os
import re

from ulid import ULID

from .config import settings
from . import db, embeddings as emb

logger = logging.getLogger(__name__)


async def seed_from_markdown() -> int:
    path = settings.seed_md_path
    if not os.path.exists(path):
        logger.info(f"No seed file found at {path}, skipping")
        return 0

    with open(path, "r", encoding="utf-8") as f:
        content = f.read().strip()

    if not content:
        return 0

    db_conn = await db.get_db()
    async with db_conn.execute("SELECT value FROM meta WHERE key = 'seeded_md_hash'") as cur:
        row = await cur.fetchone()

    import hashlib
    content_hash = hashlib.sha256(content.encode()).hexdigest()

    if row and row[0] == content_hash:
        logger.info("memory.md already seeded (hash match), skipping")
        return 0

    sections = _parse_sections(content)
    count = 0
    for section_role, section_content in sections:
        if not section_content.strip():
            continue
        memory_id = str(ULID())
        await db.insert_memory(id=memory_id, role=section_role, content=section_content.strip(), tags=["seeded", "memory-md"])
        vector = emb.embed(section_content)
        await db.insert_embedding(id=str(ULID()), memory_id=memory_id, vector=vector, model=settings.embedding_model)
        count += 1

    await db_conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_md_hash', ?)", (content_hash,))
    await db_conn.commit()

    logger.info(f"Seeded {count} memories from {path}")
    return count


def _parse_sections(content: str) -> list[tuple[str, str]]:
    header_pattern = re.compile(r"^##\s+(.+)$", re.MULTILINE)
    matches = list(header_pattern.finditer(content))

    if not matches:
        return [(settings.seed_default_role, content)]

    sections = []
    for i, match in enumerate(matches):
        role = match.group(1).strip().lower().replace(" ", "-")
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        section_content = content[start:end]
        sections.append((role, section_content))

    return sections
