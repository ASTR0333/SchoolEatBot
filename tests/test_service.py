from pathlib import Path

from sqlalchemy import select

from app.config import Settings
from app.database import Database
from app.models import AdminRequest, Parent
from app.service import BotService


class FakeMax:
    def __init__(self) -> None:
        self.messages: list[tuple[int, str, object]] = []
        self.callbacks: list[tuple[str, str]] = []

    async def send_message(self, user_id, text, buttons=None, **_kwargs) -> None:  # noqa: ANN001
        self.messages.append((user_id, text, buttons))

    async def answer_callback(self, callback_id: str, notification: str) -> None:
        self.callbacks.append((callback_id, notification))


def make_settings(database_path: Path) -> Settings:
    return Settings(
        max_bot_token="test-token",
        owner_user_id=100,
        database_url=f"sqlite+aiosqlite:///{database_path}",
    )


async def test_owner_can_approve_admin_without_registering_a_child(tmp_path: Path) -> None:
    settings = make_settings(tmp_path / "bot.sqlite")
    database = Database(settings.database_url)
    await database.create_schema()
    max_client = FakeMax()
    service = BotService(settings, database, max_client)  # type: ignore[arg-type]

    await service.upsert_parent({"user_id": 100, "first_name": "Владелец", "is_bot": False}, 100)
    await service.upsert_parent({"user_id": 200, "first_name": "Родитель", "is_bot": False}, 200)
    async with database.session() as session:
        candidate = await session.get(Parent, 200)
        assert candidate is not None
        candidate.class_name = "8МК"
        candidate.child_name = "Иванов Иван"
        await session.commit()

    await service.send_menu(100)
    assert "Панель владельца" in max_client.messages[-1][1]

    await service._request_admin(200, "request-callback")
    assert any(user_id == 100 and "Заявка" in text for user_id, text, _ in max_client.messages)

    await service._decide_admin(100, "admin:approve:200", "decision-callback", approve=True)
    assert await service.approved_admin_ids() == [200]
    async with database.session() as session:
        request = await session.scalar(select(AdminRequest).where(AdminRequest.user_id == 200))
        assert request is not None
        assert request.status == "approved"

    await database.close()
