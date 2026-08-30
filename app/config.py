from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    max_bot_token: str = Field(min_length=1)
    owner_user_id: int
    max_api_base: str = "https://platform-api2.max.ru"

    database_url: str = "sqlite+aiosqlite:////app/data/bot.db"
    timezone: str = "Europe/Moscow"
    classes: str = "8МК,2Б"
    prompt_time: str = "15:00"
    reminder_time: str = "16:30"
    deadline_time: str = "17:00"
    school_days_only: bool = True

    webhook_url: str | None = None
    webhook_secret: str | None = None
    polling_delete_webhooks: bool = False
    listen_host: str = "0.0.0.0"
    listen_port: int = 8080
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    scheduler_interval_seconds: int = Field(default=30, ge=10, le=300)

    @field_validator("max_api_base")
    @classmethod
    def strip_api_base(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator("webhook_url")
    @classmethod
    def validate_webhook_url(cls, value: str | None) -> str | None:
        if not value:
            return None
        value = value.rstrip("/")
        if not value.startswith("https://"):
            raise ValueError("WEBHOOK_URL должен начинаться с https://")
        return value

    @field_validator("webhook_secret")
    @classmethod
    def validate_webhook_secret(cls, value: str | None) -> str | None:
        if value is None:
            return None
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        if not 5 <= len(value) <= 256 or any(char not in allowed for char in value):
            raise ValueError("WEBHOOK_SECRET: 5-256 символов A-Z, a-z, 0-9, _ или -")
        return value

    @property
    def class_choices(self) -> tuple[str, ...]:
        result = tuple(item.strip().upper() for item in self.classes.split(",") if item.strip())
        if not result:
            raise ValueError("CLASSES не может быть пустым")
        return result

    @property
    def sqlite_path(self) -> Path | None:
        prefix = "sqlite+aiosqlite:///"
        if not self.database_url.startswith(prefix):
            return None
        return Path(self.database_url.removeprefix(prefix))


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
