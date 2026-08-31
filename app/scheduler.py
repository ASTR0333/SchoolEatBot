from __future__ import annotations

import asyncio
import logging

from app.service import BotService
from app.timeutils import is_schedule_day, next_service_day, parse_clock

logger = logging.getLogger(__name__)


class DailyScheduler:
    def __init__(self, service: BotService) -> None:
        self.service = service
        self._lock = asyncio.Lock()

    async def tick(self) -> None:
        if self._lock.locked():
            return
        async with self._lock:
            try:
                await self._tick()
            except Exception:
                logger.exception("Scheduled task failed")

    async def _tick(self) -> None:
        settings = self.service.settings
        now = self.service.now()
        if not is_schedule_day(now.date(), settings.school_days_only):
            return

        current_time = now.timetz().replace(tzinfo=None)
        prompt = parse_clock(settings.prompt_time)
        reminder = parse_clock(settings.reminder_time)
        deadline = parse_clock(settings.deadline_time)
        target = next_service_day(now.date(), settings.school_days_only)

        if prompt <= current_time < reminder:
            await self._send_prompts(target)
        elif reminder <= current_time < deadline:
            await self._send_reminders(target)
        elif current_time >= deadline:
            await self._send_reports(target)

    async def _send_prompts(self, target) -> None:  # noqa: ANN001
        for user_id in await self.service.registered_parent_ids(unanswered_for=target):
            key = f"prompt:{target.isoformat()}:{user_id}"
            if await self.service.delivery_exists(key):
                continue
            try:
                await self.service.send_order_prompt(user_id)
                await self.service.record_delivery(key)
            except Exception:
                logger.exception("Could not send order prompt to %s", user_id)

    async def _send_reminders(self, target) -> None:  # noqa: ANN001
        for user_id in await self.service.registered_parent_ids(unanswered_for=target):
            key = f"reminder:{target.isoformat()}:{user_id}"
            if await self.service.delivery_exists(key):
                continue
            try:
                await self.service.send_order_prompt(user_id, reminder=True)
                await self.service.record_delivery(key)
            except Exception:
                logger.exception("Could not send reminder to %s", user_id)

    async def _send_reports(self, target) -> None:  # noqa: ANN001
        for user_id, class_name in self.service.settings.report_recipients:
            scope = class_name or "all"
            key = f"report:v2:{target.isoformat()}:{user_id}:{scope}"
            if await self.service.delivery_exists(key):
                continue
            try:
                await self.service.send_report_to(user_id, target, class_name=class_name)
                await self.service.record_delivery(key)
            except Exception:
                logger.exception("Could not send report to %s", user_id)
