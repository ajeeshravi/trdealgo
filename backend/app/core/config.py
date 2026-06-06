"""Central application settings (12-factor, env-driven)."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- App ---
    APP_NAME: str = "TradeAlgo"
    ENV: Literal["dev", "staging", "prod"] = "dev"
    DEBUG: bool = True
    API_V1_PREFIX: str = "/api/v1"
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]

    # --- Security ---
    JWT_SECRET: str = "change-me-in-prod"
    JWT_ALG: str = "HS256"
    ACCESS_TOKEN_TTL_MIN: int = 15
    REFRESH_TOKEN_TTL_DAYS: int = 30
    # Fernet/KMS data key used for envelope-encrypting broker credentials.
    CREDENTIALS_ENC_KEY: str = ""  # base64 32-byte key; KMS-backed in prod

    # --- Database ---
    DATABASE_URL: str = "postgresql+asyncpg://trade:trade@localhost:5432/trade"
    DB_POOL_SIZE: int = 20
    DB_MAX_OVERFLOW: int = 10

    # --- Redis ---
    REDIS_URL: str = "redis://localhost:6379/0"

    # --- Brokers (defaults; per-user creds live encrypted in DB) ---
    ALPACA_BASE_URL: str = "https://paper-api.alpaca.markets"
    ALPACA_DATA_URL: str = "https://data.alpaca.markets"
    IBKR_HOST: str = "127.0.0.1"
    IBKR_PORT: int = 7497  # 7497 paper TWS, 4002 paper gateway

    # --- Market data vendors ---
    POLYGON_API_KEY: str = ""
    DATABENTO_API_KEY: str = ""

    # --- AI ---
    OPENAI_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    AI_DEFAULT_PROVIDER: Literal["anthropic", "openai"] = "anthropic"
    # Latest Claude models; Opus 4.8 is the most capable.
    ANTHROPIC_MODEL: str = "claude-opus-4-8"
    OPENAI_MODEL: str = "gpt-4o"

    # --- Risk defaults (per-account overrides in DB) ---
    DEFAULT_DAILY_LOSS_LIMIT: float = 2_000.0
    DEFAULT_MAX_DRAWDOWN_PCT: float = 0.10
    DEFAULT_MAX_EXPOSURE: float = 100_000.0
    DEFAULT_MAX_POSITION_PCT: float = 0.20

    # --- Notifications ---
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
