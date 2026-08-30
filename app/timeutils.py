from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def parse_clock(value: str) -> time:
    try:
        hour, minute = (int(part) for part in value.split(":"))
        return time(hour=hour, minute=minute)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Некорректное время: {value!r}; ожидается ЧЧ:ММ") from exc


def next_service_day(run_day: date, school_days_only: bool = True) -> date:
    target = run_day + timedelta(days=1)
    if school_days_only:
        while target.weekday() >= 5:
            target += timedelta(days=1)
    return target


def is_schedule_day(run_day: date, school_days_only: bool = True) -> bool:
    return not school_days_only or run_day.weekday() < 5


def active_order_target(
    now: datetime,
    prompt_time: str,
    deadline_time: str,
    school_days_only: bool = True,
) -> date | None:
    local_time = now.timetz().replace(tzinfo=None)
    if not is_schedule_day(now.date(), school_days_only):
        return None
    if parse_clock(prompt_time) <= local_time < parse_clock(deadline_time):
        return next_service_day(now.date(), school_days_only)
    return None


def local_now(timezone: str) -> datetime:
    return datetime.now(ZoneInfo(timezone))


RU_MONTHS = (
    "",
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
)


def format_date_ru(value: date) -> str:
    return f"{value.day} {RU_MONTHS[value.month]}"
