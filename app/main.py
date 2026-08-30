from __future__ import annotations

import asyncio
import hmac
import logging
from contextlib import asynccontextmanager
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, Header, HTTPException, Request

from app.config import Settings, get_settings
from app.database import Database
from app.max_client import MaxClient
from app.scheduler import DailyScheduler
from app.service import BotService
from app.timeutils import parse_clock

logger = logging.getLogger(__name__)


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


def create_app(settings: Settings | None = None) -> FastAPI:
    configured = settings or get_settings()
    _validate_schedule(configured)
    logging.basicConfig(
        level=getattr(logging, configured.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        sqlite_path = configured.sqlite_path
        if sqlite_path:
            sqlite_path.parent.mkdir(parents=True, exist_ok=True)

        database = Database(configured.database_url)
        max_client = MaxClient(configured.max_bot_token, configured.max_api_base)
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
            seconds=configured.scheduler_interval_seconds,
            id="daily-dispatch",
            max_instances=1,
            coalesce=True,
        )
        scheduler.start()

        stop = asyncio.Event()
        poll_task: asyncio.Task[None] | None = None
        if configured.webhook_url:
            await max_client.ensure_webhook(configured.webhook_url, configured.webhook_secret)
            logger.info("Running in Webhook mode")
        else:
            if configured.polling_delete_webhooks:
                await max_client.delete_all_webhooks()
            poll_task = asyncio.create_task(_poll_updates(service, stop), name="max-polling")
            logger.warning("Running in Long Polling mode (development only)")

        app.state.settings = configured
        app.state.database = database
        app.state.max_client = max_client
        app.state.service = service
        app.state.bot = bot
        asyncio.create_task(daily.tick())
        try:
            yield
        finally:
            stop.set()
            if poll_task:
                poll_task.cancel()
                await asyncio.gather(poll_task, return_exceptions=True)
            scheduler.shutdown(wait=False)
            await max_client.close()
            await database.close()

    application = FastAPI(title="School Eat MAX Bot", lifespan=lifespan)

    @application.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        bot = getattr(request.app.state, "bot", {})
        return {
            "status": "ok",
            "mode": "webhook" if configured.webhook_url else "polling",
            "bot_id": bot.get("user_id"),
        }

    @application.post("/webhook")
    async def webhook(
        request: Request,
        update: dict[str, Any],
        x_max_bot_api_secret: str | None = Header(default=None),
    ) -> dict[str, bool]:
        expected = configured.webhook_secret
        if expected and (
            x_max_bot_api_secret is None or not hmac.compare_digest(expected, x_max_bot_api_secret)
        ):
            raise HTTPException(status_code=401, detail="Invalid webhook secret")
        asyncio.create_task(_safe_handle(request.app.state.service, update))
        return {"ok": True}

    return application


app = create_app()
