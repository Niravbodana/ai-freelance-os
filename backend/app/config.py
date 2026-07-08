"""Application configuration via environment variables."""
from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    app_name: str = Field(default="AI Freelance OS")
    app_env: str = Field(default="development")
    app_debug: bool = Field(default=False)
    app_host: str = Field(default="0.0.0.0")
    app_port: int = Field(default=8000)
    secret_key: str = Field(default="change-me-in-production")

    # PostgreSQL
    database_url: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/ai_freelance_os"
    )

    # Redis
    redis_url: str = Field(default="redis://localhost:6379/0")

    # ── AI Provider selection ────────────────────────────────────────────────
    # Which provider to use by default: openai | anthropic | deepseek | gemini
    default_ai_provider: str = Field(default="openai")

    # OpenAI
    openai_api_key: str = Field(default="")
    openai_model: str = Field(default="gpt-4o")
    openai_max_tokens: int = Field(default=4096)
    openai_temperature: float = Field(default=0.7)

    # Anthropic
    anthropic_api_key: str = Field(default="")
    anthropic_model: str = Field(default="claude-3-5-sonnet-20241022")
    anthropic_max_tokens: int = Field(default=4096)

    # DeepSeek (OpenAI-compatible API)
    deepseek_api_key: str = Field(default="")
    deepseek_model: str = Field(default="deepseek-chat")
    deepseek_base_url: str = Field(default="https://api.deepseek.com/v1")

    # Gemini
    gemini_api_key: str = Field(default="")
    gemini_model: str = Field(default="gemini-1.5-pro")

    # ── Human-in-the-loop ───────────────────────────────────────────────────
    approval_required: bool = Field(default=True)
    approval_timeout_seconds: int = Field(default=300)

    # ── Task Queue ──────────────────────────────────────────────────────────
    queue_default_name: str = Field(default="tasks")
    queue_max_retries: int = Field(default=3)
    queue_retry_delay_seconds: int = Field(default=5)

    # ── Metrics ─────────────────────────────────────────────────────────────
    metrics_enabled: bool = Field(default=True)
    metrics_path: str = Field(default="/metrics")

    # ── Retry ───────────────────────────────────────────────────────────────
    retry_max_attempts: int = Field(default=3)
    retry_wait_min_seconds: float = Field(default=1.0)
    retry_wait_max_seconds: float = Field(default=10.0)

    # ── Plugin system ───────────────────────────────────────────────────────
    plugins_enabled: list[str] = Field(default_factory=list)

    # WhatsApp Business (future)
    whatsapp_access_token: str = Field(default="")
    whatsapp_phone_number_id: str = Field(default="")
    whatsapp_webhook_verify_token: str = Field(default="")

    # Logging
    log_level: str = Field(default="INFO")
    log_format: str = Field(default="json")

    @model_validator(mode="after")
    def validate_production_settings(self) -> "Settings":
        if self.app_env == "production" and self.secret_key == "change-me-in-production":
            raise ValueError("SECRET_KEY must be set in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings: Settings = get_settings()
