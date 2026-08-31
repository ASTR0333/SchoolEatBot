from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    max_bot_token: str = Field(min_length=1)
    creator_user_id: int
    teacher_1_id: int | None = None
    teacher_2_id: int | None = None

    class_1: str = "8МК"
    class_2: str = "2Б"
    prompt_time: str = "15:00"
    reminder_time: str = "16:30"
    deadline_time: str = "17:00"

    @field_validator("teacher_1_id", "teacher_2_id", mode="before")
    @classmethod
    def empty_teacher_id_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("class_1", "class_2")
    @classmethod
    def normalize_class_name(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not normalized:
            raise ValueError("Название класса не может быть пустым")
        return normalized

    @property
    def class_choices(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys((self.class_1, self.class_2)))

    @property
    def timezone(self) -> str:
        return "Europe/Moscow"

    @property
    def school_days_only(self) -> bool:
        return True

    @property
    def teacher_assignments(self) -> tuple[tuple[int, str], ...]:
        assignments = (
            (self.teacher_1_id, self.class_1),
            (self.teacher_2_id, self.class_2),
        )
        return tuple((user_id, class_name) for user_id, class_name in assignments if user_id)

    def report_scope(self, user_id: int) -> tuple[bool, str | None]:
        if user_id == self.creator_user_id:
            return True, None
        for teacher_id, class_name in self.teacher_assignments:
            if user_id == teacher_id:
                return True, class_name
        return False, None

    @property
    def report_recipients(self) -> tuple[tuple[int, str | None], ...]:
        recipients: list[tuple[int, str | None]] = [(self.creator_user_id, None)]
        seen = {self.creator_user_id}
        for teacher_id, class_name in self.teacher_assignments:
            if teacher_id not in seen:
                recipients.append((teacher_id, class_name))
                seen.add(teacher_id)
        return tuple(recipients)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
