"""Auto-summarization: compress old memories into a single summary memory."""
import logging
from datetime import datetime, timezone, timedelta

from ulid import ULID

from .config import settings
from . import db

logger = logging.getLogger(__name__)


def _build_summary_content(memories: list[dict]) -> str:
    """Produce a human-readable summary from a list of memory dicts."""
    lines = [
        f"AUTO-SUMMARY of {len(memories)} memories "
        f"(from {memories[0]['created_at'][:10]} to {memories[-1]['created_at'][:10]}):\n"
    ]
    # Group by role
    by_role: dict[str, list[str]] = {}
    for m in memories:
        role = m["role"]
        by_role.setdefault(role, []).append(m["content"])

    for role, contents in by_role.items():
        lines.append(f"\n[{role}]")
        for content in contents:
            # Truncate very long individual entries
            snippet = content[:300] + "..." if len(content) > 300 else content
            lines.append(f"  - {snippet}")

    return "\n".join(lines)


async def maybe_summarize() -> None:
    """Check memory count and trigger summarization if threshold exceeded."""
    count = await db.get_memory_count()
    if count <= settings.summarize_threshold:
        return

    logger.info(f"Memory count {count} exceeds threshold {settings.summarize_threshold}. Summarizing...")
    await run_summarize()


async def run_summarize() -> dict:
    """
    Compress old memories into a summary. Returns summary info dict.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=settings.summarize_min_age_hours)
    cutoff_iso = cutoff.isoformat()

    old_memories = await db.get_old_nonsummary_memories(
        older_than_iso=cutoff_iso,
        limit=settings.summarize_batch_size,
    )

    if not old_memories:
        return {
            "summary_id": None,
            "memories_compressed": 0,
            "message": "No memories old enough to summarize",
        }

    summary_content = _build_summary_content(old_memories)
    summary_id = str(ULID())

    await db.insert_memory(
        id=summary_id,
        role="system",
        content=summary_content,
        tags=["summary", "auto-generated"],
        is_summary=True,
    )

    # Generate and store embedding for the summary
    from . import embeddings as emb
    from ulid import ULID as _ULID
    vector = emb.embed(summary_content)
    await db.insert_embedding(
        id=str(_ULID()),
        memory_id=summary_id,
        vector=vector,
        model=settings.embedding_model,
    )

    old_ids = [m["id"] for m in old_memories]
    deleted = await db.delete_memories_by_ids(old_ids)

    msg = (
        f"Summarized {deleted} memories older than {settings.summarize_min_age_hours}h "
        f"into summary memory {summary_id}"
    )
    logger.info(msg)

    return {
        "summary_id": summary_id,
        "memories_compressed": deleted,
        "message": msg,
    }
