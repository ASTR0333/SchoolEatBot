from __future__ import annotations

import asyncio
import logging
import signal
from pathlib import Path
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config import Settings, get_settings
from app.database import Database
from app.max_client import MaxClient
from app.scheduler import DailyScheduler
from app.service import BotService
from app.timeutils import parse_clock

logger = logging.getLogger(__name__)

MAX_API_BASE = "https://platform-api2.max.ru"
DATABASE_URL = "sqlite+aiosqlite:///data/bot.db"
SCHEDULER_INTERVAL_SECONDS = 30


async def _safe_handle(service: BotService, update: dict[str, Any]) -> None:
    try:
        await service.handle_update(update)
    except Exception:
        logger.exception("Failed to process MAX update")


async def _poll_updates(service: BotService, stop: asyncio.Event) -> None:
    marker: int | None = None
    while not stop.is_set():
        try:
            result = await service.max.get_updates(marker)
            marker = result.get("marker", marker)
            for update in result.get("updates", []):
                await _safe_handle(service, update)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Long Polling failed; retrying")
            try:
                await asyncio.wait_for(stop.wait(), timeout=5)
            except TimeoutError:
                pass


def _validate_schedule(settings: Settings) -> None:
    prompt = parse_clock(settings.prompt_time)
    reminder = parse_clock(settings.reminder_time)
    deadline = parse_clock(settings.deadline_time)
    if not prompt < reminder < deadline:
        raise ValueError("Должно выполняться PROMPT_TIME < REMINDER_TIME < DEADLINE_TIME")


async def run_bot(settings: Settings | None = None) -> None:
    configured = settings or get_settings()
    _validate_schedule(configured)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    Path("data").mkdir(parents=True, exist_ok=True)
    database = Database(DATABASE_URL)
    max_client = MaxClient(configured.max_bot_token, MAX_API_BASE)
    scheduler: AsyncIOScheduler | None = None
    poll_task: asyncio.Task[None] | None = None
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stop.set)
        except NotImplementedError:
            pass

    try:
        await database.create_schema()
        await max_client.start()
        bot = await max_client.get_me()
        logger.info("Connected as MAX bot %s (%s)", bot.get("name"), bot.get("user_id"))

        service = BotService(configured, database, max_client)
        daily = DailyScheduler(service)
        scheduler = AsyncIOScheduler(timezone=configured.timezone)
        scheduler.add_job(
            daily.tick,
            "interval",
            seconds=SCHEDULER_INTERVAL_SECONDS,
            id="daily-dispatch",
            max_instances=1,
            coalesce=True,
        )
        scheduler.start()
        poll_task = asyncio.create_task(_poll_updates(service, stop), name="max-polling")
        await daily.tick()
        logger.info("Bot is running in Long Polling mode")
        await stop.wait()
    finally:
        stop.set()
        if poll_task:
            poll_task.cancel()
            await asyncio.gather(poll_task, return_exceptions=True)
        if scheduler:
            scheduler.shutdown(wait=False)
        await max_client.close()
        await database.close()


def main() -> None:
    asyncio.run(run_bot())


if __name__ == "__main__":
    main()
