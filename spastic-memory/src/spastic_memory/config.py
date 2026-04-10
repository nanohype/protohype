from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    db_path: str = "/workspace/.spastic/memory.db"
    seed_md_path: str = "/workspace/.spastic/memory.md"
    embedding_model: str = "all-MiniLM-L6-v2"
    host: str = "0.0.0.0"
    port: int = 8765
    summarize_threshold: int = 200
    summarize_batch_size: int = 50
    summarize_min_age_hours: int = 24

    model_config = {"env_prefix": "SPASTIC_MEMORY_"}


settings = Settings()
