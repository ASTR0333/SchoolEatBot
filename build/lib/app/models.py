from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def utc_now() -> datetime:
    """Return naive UTC for SQLite while avoiding deprecated utcnow()."""
    return datetime.now(UTC).replace(tzinfo=None)


class Parent(Base):
    __tablename__ = "parents"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    chat_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    child_name: Mapped[str | None] = mapped_column(String(200))
    class_name: Mapped[str | None] = mapped_column(String(50))
    state: Mapped[str | None] = mapped_column(String(50))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class AdminRequest(Base):
    __tablename__ = "admin_requests"

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("parents.user_id"), primary_key=True, autoincrement=False
    )
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)
    decided_by: Mapped[int | None] = mapped_column(BigInteger)


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (UniqueConstraint("parent_user_id", "target_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("parents.user_id"))
    target_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    breakfast: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    lunch: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class Delivery(Base):
    __tablename__ = "deliveries"

    key: Mapped[str] = mapped_column(String(250), primary_key=True)
    delivered_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
