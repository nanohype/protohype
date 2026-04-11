"""FastAPI router: all /api/v1/* endpoints."""
import logging
import re
import time
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from ulid import ULID

from .config import settings
from . import db, embeddings as emb, summarizer

_TAG_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------

async def verify_api_key(x_api_key: str | None = Header(None)) -> None:
    """Optional API key auth. Skipped if AGENT_MEMORY_API_KEY is not set."""
    if settings.api_key is None:
        return
    if x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_api_key)])
public_router = APIRouter(prefix="/api/v1")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class WriteMemoryRequest(BaseModel):
    role: str = Field(..., min_length=1, max_length=64)
    content: str = Field(..., min_length=1, max_length=10000)
    tags: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, tags: list[str]) -> list[str]:
        for tag in tags:
            if len(tag) > 64:
                raise ValueError(f"Tag exceeds 64 chars: {tag!r}")
            if not _TAG_RE.match(tag):
                raise ValueError(f"Tag contains invalid characters: {tag!r}. Only [a-zA-Z0-9_-] allowed.")
        return tags

    model_config = {"json_schema_extra": {
        "example": {
            "role": "eng-backend",
            "content": "Chose SQLite WAL mode — no ops overhead.",
            "tags": ["decision", "database"],
        }
    }}


class MemoryResponse(BaseModel):
    id: str
    role: str
    content: str
    tags: list[str]
    is_summary: bool
    created_at: str
    updated_at: str


class ListMemoriesResponse(BaseModel):
    memories: list[MemoryResponse]
    total: int
    limit: int
    offset: int


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=1000)
    top_k: int = Field(default=5, ge=1, le=50)
    role_filter: str | None = None
    tag_filter: str | None = None


class SearchResult(BaseModel):
    memory: MemoryResponse
    score: float


class SearchResponse(BaseModel):
    results: list[SearchResult]
    query: str
    top_k: int


class SummarizeResponse(BaseModel):
    summary_id: str | None
    memories_compressed: int
    message: str


class HealthResponse(BaseModel):
    status: str
    memory_count: int
    db_size_bytes: int
    uptime_seconds: float


# ---------------------------------------------------------------------------
# Startup timestamp for uptime tracking
# ---------------------------------------------------------------------------
_started_at = time.monotonic()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/memories", response_model=MemoryResponse, status_code=201)
async def write_memory(req: WriteMemoryRequest) -> MemoryResponse:
    """Write a new memory. Generates and stores an embedding."""
    memory_id = str(ULID())
    memory = await db.insert_memory(
        id=memory_id,
        role=req.role,
        content=req.content,
        tags=req.tags,
    )

    # Generate embedding (CPU, fast for MiniLM)
    vector = emb.embed(req.content)
    await db.insert_embedding(
        id=str(ULID()),
        memory_id=memory_id,
        vector=vector,
        model=emb.settings.embedding_model,
    )

    # Async summarization check (fire and don't block)
    try:
        await summarizer.maybe_summarize()
    except Exception as e:
        logger.warning(f"Summarization check failed: {e}")

    return MemoryResponse(**memory)


@router.get("/memories", response_model=ListMemoriesResponse)
async def list_memories(
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    role: str | None = None,
    tag: str | None = None,
    since: str | None = None,
) -> ListMemoriesResponse:
    """List memories in reverse chronological order."""
    memories, total = await db.list_memories(
        limit=limit, offset=offset, role=role, tag=tag, since=since
    )
    return ListMemoriesResponse(
        memories=[MemoryResponse(**m) for m in memories],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/memories/search", response_model=SearchResponse)
async def search_memories(req: SearchRequest) -> SearchResponse:
    """Semantic search over stored memories using cosine similarity."""
    query_vector = emb.embed(req.query)
    all_embeddings = await db.get_all_embeddings()

    if not all_embeddings:
        return SearchResponse(results=[], query=req.query, top_k=req.top_k)

    top_pairs = emb.top_k_similar(query_vector, all_embeddings, k=req.top_k)
    if not top_pairs:
        return SearchResponse(results=[], query=req.query, top_k=req.top_k)

    memory_ids = [p[0] for p in top_pairs]
    score_map = {p[0]: p[1] for p in top_pairs}

    memories = await db.get_memories_by_ids(memory_ids)

    # Apply optional filters post-retrieval
    results = []
    for m in memories:
        if req.role_filter and m["role"] != req.role_filter:
            continue
        if req.tag_filter and req.tag_filter not in m["tags"]:
            continue
        results.append(SearchResult(
            memory=MemoryResponse(**m),
            score=score_map.get(m["id"], 0.0),
        ))

    return SearchResponse(results=results, query=req.query, top_k=req.top_k)


@router.delete("/memories/{memory_id}", status_code=204)
async def delete_memory(memory_id: str) -> None:
    """Delete a memory by ID."""
    deleted = await db.delete_memory(memory_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Memory {memory_id!r} not found")


@router.post("/memories/summarize", response_model=SummarizeResponse)
async def trigger_summarize() -> SummarizeResponse:
    """Manually trigger summarization of old memories."""
    result = await summarizer.run_summarize()
    return SummarizeResponse(**result)


@public_router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Health check with service stats."""
    count = await db.get_memory_count()
    size = await db.get_db_size_bytes()
    uptime = time.monotonic() - _started_at
    return HealthResponse(
        status="ok",
        memory_count=count,
        db_size_bytes=size,
        uptime_seconds=round(uptime, 2),
    )
