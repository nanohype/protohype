"""SQLite database layer using aiosqlite with WAL mode."""
import json
import struct
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from .config import settings

_db: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    global _db
    if _db is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    return _db


async def init_db() -> None:
    global _db
    import os
    os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)

    _db = await aiosqlite.connect(settings.db_path)
    _db.row_factory = aiosqlite.Row

    await _db.execute("PRAGMA journal_mode=WAL")
    await _db.execute("PRAGMA synchronous=NORMAL")
    await _db.execute("PRAGMA foreign_keys=ON")
    await _db.execute("PRAGMA cache_size=-32000")

    await _db.executescript("""
        CREATE TABLE IF NOT EXISTS memories (
            id          TEXT PRIMARY KEY,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            tags        TEXT NOT NULL DEFAULT '[]',
            is_summary  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_role ON memories(role);
        CREATE INDEX IF NOT EXISTS idx_memories_is_summary ON memories(is_summary);

        CREATE TABLE IF NOT EXISTS embeddings (
            id          TEXT PRIMARY KEY,
            memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            vector      BLOB NOT NULL,
            model       TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_embeddings_memory_id ON embeddings(memory_id);

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
    await _db.commit()


async def close_db() -> None:
    global _db
    if _db is not None:
        await _db.close()
        _db = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def pack_vector(v: list[float]) -> bytes:
    return struct.pack(f"{len(v)}f", *v)


def unpack_vector(b: bytes) -> list[float]:
    n = len(b) // 4
    return list(struct.unpack(f"{n}f", b))


async def insert_memory(id: str, role: str, content: str, tags: list[str], is_summary: bool = False) -> dict[str, Any]:
    db = await get_db()
    now = _now_iso()
    await db.execute(
        """INSERT INTO memories (id, role, content, tags, is_summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (id, role, content, json.dumps(tags), 1 if is_summary else 0, now, now),
    )
    await db.commit()
    return {"id": id, "role": role, "content": content, "tags": tags, "is_summary": is_summary, "created_at": now, "updated_at": now}


async def insert_embedding(id: str, memory_id: str, vector: list[float], model: str) -> None:
    db = await get_db()
    now = _now_iso()
    await db.execute(
        "INSERT INTO embeddings (id, memory_id, vector, model, created_at) VALUES (?, ?, ?, ?, ?)",
        (id, memory_id, pack_vector(vector), model, now),
    )
    await db.commit()


async def get_memory_by_id(id: str) -> dict[str, Any] | None:
    db = await get_db()
    async with db.execute("SELECT * FROM memories WHERE id = ?", (id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    return _row_to_dict(row)


async def delete_memory(id: str) -> bool:
    db = await get_db()
    async with db.execute("DELETE FROM memories WHERE id = ?", (id,)) as cur:
        deleted = cur.rowcount > 0
    await db.commit()
    return deleted


async def list_memories(limit: int = 20, offset: int = 0, role: str | None = None, tag: str | None = None, since: str | None = None) -> tuple[list[dict[str, Any]], int]:
    db = await get_db()
    conditions = []
    params: list[Any] = []
    from_clause = "FROM memories"

    if role:
        conditions.append("role = ?")
        params.append(role)
    if tag:
        from_clause = "FROM memories, json_each(memories.tags)"
        conditions.append("json_each.value = ?")
        params.append(tag)
    if since:
        conditions.append("created_at >= ?")
        params.append(since)

    where = ""
    if conditions:
        where = "WHERE " + " AND ".join(conditions)

    count_sql = f"SELECT COUNT(DISTINCT memories.id) {from_clause} {where}"
    async with db.execute(count_sql, params) as cur:
        row = await cur.fetchone()
    total = row[0] if row else 0

    query_sql = f"""
        SELECT DISTINCT memories.*
        {from_clause}
        {where}
        ORDER BY memories.created_at DESC
        LIMIT ? OFFSET ?
    """
    async with db.execute(query_sql, params + [limit, offset]) as cur:
        rows = await cur.fetchall()

    return [_row_to_dict(r) for r in rows], total


async def get_memory_count() -> int:
    db = await get_db()
    async with db.execute("SELECT COUNT(*) FROM memories") as cur:
        row = await cur.fetchone()
    return row[0] if row else 0


async def get_all_embeddings() -> list[tuple[str, list[float]]]:
    db = await get_db()
    async with db.execute("SELECT memory_id, vector FROM embeddings") as cur:
        rows = await cur.fetchall()
    return [(row[0], unpack_vector(row[1])) for row in rows]


async def get_memories_by_ids(ids: list[str]) -> list[dict[str, Any]]:
    if not ids:
        return []
    db = await get_db()
    placeholders = ",".join("?" * len(ids))
    async with db.execute(f"SELECT * FROM memories WHERE id IN ({placeholders})", ids) as cur:
        rows = await cur.fetchall()
    by_id = {r["id"]: _row_to_dict(r) for r in rows}
    return [by_id[id] for id in ids if id in by_id]


async def get_old_nonsummary_memories(older_than_iso: str, limit: int = 50) -> list[dict[str, Any]]:
    db = await get_db()
    async with db.execute(
        """SELECT * FROM memories WHERE is_summary = 0 AND created_at < ? ORDER BY created_at ASC LIMIT ?""",
        (older_than_iso, limit),
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_dict(r) for r in rows]


async def delete_memories_by_ids(ids: list[str]) -> int:
    if not ids:
        return 0
    db = await get_db()
    placeholders = ",".join("?" * len(ids))
    async with db.execute(f"DELETE FROM memories WHERE id IN ({placeholders})", ids) as cur:
        count = cur.rowcount
    await db.commit()
    return count


async def get_db_size_bytes() -> int:
    import os
    try:
        return os.path.getsize(settings.db_path)
    except OSError:
        return 0


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    d["tags"] = json.loads(d.get("tags", "[]"))
    d["is_summary"] = bool(d.get("is_summary", 0))
    return d
