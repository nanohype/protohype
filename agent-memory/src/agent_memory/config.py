from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    db_path: str = "./data/memory.db"
    seed_md_path: str = "./data/memory.md"
    embedding_model: str = "all-MiniLM-L6-v2"
    host: str = "127.0.0.1"
    port: int = 8765
    summarize_threshold: int = 200
    summarize_batch_size: int = 50
    summarize_min_age_hours: int = 24
    api_key: str | None = None
    seed_default_role: str = "system"

    model_config = {"env_prefix": "AGENT_MEMORY_"}


settings = Settings()
