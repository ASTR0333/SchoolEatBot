from datetime import date, datetime
from zoneinfo import ZoneInfo

from app.timeutils import active_order_target, format_date_ru, next_service_day, parse_clock


def test_next_service_day_on_friday_is_monday() -> None:
    assert next_service_day(date(2026, 9, 4)) == date(2026, 9, 7)


def test_next_service_day_can_include_weekends() -> None:
    assert next_service_day(date(2026, 9, 4), school_days_only=False) == date(2026, 9, 5)


def test_order_window_is_open_before_deadline() -> None:
    now = datetime(2026, 8, 31, 16, 45, tzinfo=ZoneInfo("Europe/Moscow"))
    assert active_order_target(now, "15:00", "17:00") == date(2026, 9, 1)


def test_order_window_closes_at_deadline() -> None:
    now = datetime(2026, 8, 31, 17, 0, tzinfo=ZoneInfo("Europe/Moscow"))
    assert active_order_target(now, "15:00", "17:00") is None


def test_parse_and_format() -> None:
    assert parse_clock("16:30").hour == 16
    assert format_date_ru(date(2026, 8, 29)) == "29 августа"
