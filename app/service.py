from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any

from sqlalchemy import and_, select

from app.config import Settings
from app.database import Database
from app.keyboards import (
    callback_button,
    class_keyboard,
    main_keyboard,
    order_keyboard,
)
from app.max_client import MaxClient
from app.models import Delivery, Order, Parent
from app.reports import ReportRow, build_report
from app.timeutils import active_order_target, format_date_ru, local_now, next_service_day

logger = logging.getLogger(__name__)


class BotService:
    def __init__(self, settings: Settings, db: Database, max_client: MaxClient) -> None:
        self.settings = settings
        self.db = db
        self.max = max_client

    def now(self) -> datetime:
        return local_now(self.settings.timezone)

    def active_target(self) -> date | None:
        return active_order_target(
            self.now(),
            self.settings.prompt_time,
            self.settings.deadline_time,
            self.settings.school_days_only,
        )

    @staticmethod
    def _display_name(user: dict[str, Any]) -> str:
        parts = [
            str(user.get("first_name") or "").strip(),
            str(user.get("last_name") or "").strip(),
        ]
        return " ".join(part for part in parts if part) or f"Пользователь {user.get('user_id')}"

    async def upsert_parent(self, user: dict[str, Any], chat_id: int | None = None) -> Parent:
        user_id = int(user["user_id"])
        async with self.db.session() as session:
            parent = await session.get(Parent, user_id)
            if parent is None:
                parent = Parent(
                    user_id=user_id,
                    chat_id=int(chat_id or user_id),
                    display_name=self._display_name(user),
                    active=True,
                )
                session.add(parent)
            else:
                parent.display_name = self._display_name(user)
                parent.chat_id = int(chat_id or parent.chat_id or user_id)
                parent.active = True
            await session.commit()
            return parent

    async def handle_update(self, update: dict[str, Any]) -> None:
        update_type = update.get("update_type")
        if update_type == "bot_started":
            user = update["user"]
            await self.upsert_parent(user, update.get("chat_id"))
            await self.send_menu(int(user["user_id"]), greeting=True)
        elif update_type == "message_created":
            await self._handle_message(update)
        elif update_type == "message_callback":
            await self._handle_callback(update)
        elif update_type == "bot_stopped":
            user_id = int(update["user"]["user_id"])
            async with self.db.session() as session:
                parent = await session.get(Parent, user_id)
                if parent:
                    parent.active = False
                    await session.commit()

    async def _handle_message(self, update: dict[str, Any]) -> None:
        message = update.get("message") or {}
        user = message.get("sender") or {}
        if not user.get("user_id") or user.get("is_bot"):
            return
        recipient = message.get("recipient") or {}
        parent = await self.upsert_parent(user, recipient.get("chat_id"))
        text = str((message.get("body") or {}).get("text") or "").strip()

        if text.startswith("/id"):
            await self.max.send_message(parent.user_id, f"Ваш MAX user_id: {parent.user_id}")
            return
        if text.startswith("/help"):
            await self.max.send_message(
                parent.user_id,
                "Команды:\n/start или /menu — открыть меню\n/id — узнать свой MAX user_id\n"
                "/report [ГГГГ-ММ-ДД] — отчёт (для создателя и преподавателей)",
            )
            return
        if text.startswith("/report"):
            await self._manual_report(parent.user_id, text)
            return
        if text.startswith(("/start", "/menu")):
            await self.send_menu(parent.user_id, greeting=text.startswith("/start"))
            return

        if parent.state == "awaiting_child_name":
            await self._save_child_name(parent.user_id, text)
            return

        await self.send_menu(parent.user_id)

    async def _handle_callback(self, update: dict[str, Any]) -> None:
        callback = update.get("callback") or {}
        user = callback.get("user") or {}
        callback_id = str(callback.get("callback_id") or "")
        payload = str(callback.get("payload") or "")
        message = update.get("message") or {}
        recipient = message.get("recipient") or {}
        if not user.get("user_id") or not callback_id:
            return

        parent = await self.upsert_parent(user, recipient.get("chat_id"))
        try:
            if payload.startswith("class:"):
                await self._select_class(parent.user_id, payload.removeprefix("class:"))
                await self.max.answer_callback(callback_id, "Класс выбран")
            elif payload == "profile:edit":
                await self.max.answer_callback(callback_id, "Выберите класс")
                await self._start_profile(parent.user_id)
            elif payload == "menu:main":
                await self.max.answer_callback(callback_id, "Открываю меню")
                await self.send_menu(parent.user_id)
            elif payload == "menu:order":
                await self.max.answer_callback(callback_id, "Открываю выбор питания")
                await self.send_order_prompt(parent.user_id)
            elif payload.startswith("order:"):
                await self._save_order(parent.user_id, payload, callback_id)
            else:
                await self.max.answer_callback(callback_id, "Эта кнопка уже неактуальна")
        except Exception:
            logger.exception("Failed to handle callback %s", payload)
            try:
                await self.max.answer_callback(callback_id, "Не получилось выполнить действие")
            except Exception:
                logger.exception("Failed to answer callback error")

    async def _start_profile(self, user_id: int) -> None:
        async with self.db.session() as session:
            parent = await session.get(Parent, user_id)
            if parent:
                parent.state = "choosing_class"
                await session.commit()
        await self.max.send_message(
            user_id,
            "Выберите класс ребёнка:",
            class_keyboard(self.settings.class_choices),
        )

    async def _select_class(self, user_id: int, class_name: str) -> None:
        normalized = class_name.strip().upper()
        if normalized not in self.settings.class_choices:
            await self.max.send_message(user_id, "Такого класса нет. Выберите вариант из списка.")
            await self._start_profile(user_id)
            return
        async with self.db.session() as session:
            parent = await session.get(Parent, user_id)
            if parent is None:
                return
            parent.class_name = normalized
            parent.state = "awaiting_child_name"
            await session.commit()
        await self.max.send_message(
            user_id,
            f"Класс {normalized} выбран. Напишите ФИО ребёнка одним сообщением, "
            "например: Иванов Иван Иванович.",
        )

    async def _save_child_name(self, user_id: int, text: str) -> None:
        name = " ".join(text.split())
        if text.startswith("/") or not 3 <= len(name) <= 200 or len(name.split()) < 2:
            await self.max.send_message(
                user_id, "Пожалуйста, напишите фамилию и имя ребёнка одним сообщением."
            )
            return
        async with self.db.session() as session:
            parent = await session.get(Parent, user_id)
            if parent is None:
                return
            parent.child_name = name
            parent.state = None
            await session.commit()
        await self.max.send_message(user_id, f"Ребёнок сохранён: {name}.")
        await self.send_menu(user_id)

    async def send_menu(self, user_id: int, *, greeting: bool = False) -> None:
        target = self.active_target()
        report_allowed, report_class = self.settings.report_scope(user_id)
        if report_allowed:
            if report_class is None:
                text = (
                    "Панель создателя бота. После закрытия заказов сюда придёт общий "
                    "Excel-отчёт по всем классам."
                )
            else:
                text = (
                    f"Панель преподавателя класса {report_class}. После закрытия заказов "
                    "сюда придёт Excel-отчёт только по вашему классу."
                )
            text += "\n\nПолучить отчёт вручную: /report или /report ГГГГ-ММ-ДД."
            await self.max.send_message(user_id, text)
            return

        async with self.db.session() as session:
            parent = await session.get(Parent, user_id)
            if parent is None:
                return
            if not parent.class_name:
                await self._start_profile(user_id)
                return
            if not parent.child_name:
                parent.state = "awaiting_child_name"
                await session.commit()
                await self.max.send_message(
                    user_id,
                    "Напишите ФИО ребёнка одним сообщением, например: Иванов Иван Иванович.",
                )
                return

            order = None
            if target:
                order = await session.scalar(
                    select(Order).where(
                        Order.parent_user_id == user_id, Order.target_date == target
                    )
                )
        intro = "Здравствуйте!\n\n" if greeting else ""
        text = f"{intro}Ребёнок: {parent.child_name}\nКласс: {parent.class_name}"
        if target:
            if order:
                label = self._order_label(order.breakfast, order.lunch)
                text += f"\n\nЗаказ на {format_date_ru(target)}: {label}."
            else:
                text += f"\n\nЗаказ на {format_date_ru(target)} ещё не выбран."
        else:
            text += (
                f"\n\nЗаказ можно выбрать с {self.settings.prompt_time} до "
                f"{self.settings.deadline_time} по московскому времени."
            )
        buttons = main_keyboard(
            can_order=target is not None,
            has_order=order is not None,
        )
        await self.max.send_message(user_id, text, buttons)

    async def send_order_prompt(self, user_id: int, *, reminder: bool = False) -> None:
        target = self.active_target()
        if target is None:
            await self.max.send_message(
                user_id,
                f"Сейчас заказ закрыт. Выбор доступен с {self.settings.prompt_time} до "
                f"{self.settings.deadline_time} по московскому времени.",
            )
            return
        async with self.db.session() as session:
            parent = await session.get(Parent, user_id)
            if parent is None or not parent.child_name or not parent.class_name:
                await self.send_menu(user_id)
                return
        prefix = "Напоминаю: " if reminder else ""
        await self.max.send_message(
            user_id,
            f"{prefix}что заказываем ребёнку на {format_date_ru(target)}?\n"
            f"Изменить решение можно до {self.settings.deadline_time}.",
            order_keyboard(target),
        )

    async def _save_order(self, user_id: int, payload: str, callback_id: str) -> None:
        try:
            _, raw_date, choice = payload.split(":", 2)
            target = date.fromisoformat(raw_date)
        except ValueError:
            await self.max.answer_callback(callback_id, "Некорректная кнопка")
            return

        active_target = self.active_target()
        if target != active_target:
            await self.max.answer_callback(callback_id, "Время изменения заказа уже закончилось")
            await self.max.send_message(user_id, "Этот заказ уже закрыт. Откройте /menu.")
            return
        choices = {
            "breakfast": (True, False),
            "lunch": (False, True),
            "both": (True, True),
            "none": (False, False),
        }
        if choice not in choices:
            await self.max.answer_callback(callback_id, "Неизвестный вариант")
            return
        breakfast, lunch = choices[choice]

        async with self.db.session() as session:
            parent = await session.get(Parent, user_id)
            if parent is None or not parent.child_name or not parent.class_name:
                await self.max.answer_callback(callback_id, "Сначала заполните данные ребёнка")
                return
            order = await session.scalar(
                select(Order).where(Order.parent_user_id == user_id, Order.target_date == target)
            )
            if order is None:
                order = Order(parent_user_id=user_id, target_date=target)
                session.add(order)
            order.breakfast = breakfast
            order.lunch = lunch
            await session.commit()

        label = self._order_label(breakfast, lunch)
        await self.max.answer_callback(callback_id, "Заказ сохранён")
        await self.max.send_message(
            user_id,
            f"Готово. На {format_date_ru(target)} выбрано: {label}.\n"
            f"Изменить решение можно до {self.settings.deadline_time}.",
            [
                [callback_button("✏️ Изменить заказ", "menu:order")],
                [callback_button("В меню", "menu:main")],
            ],
        )

    @staticmethod
    def _order_label(breakfast: bool, lunch: bool) -> str:
        if breakfast and lunch:
            return "завтрак и обед"
        if breakfast:
            return "завтрак"
        if lunch:
            return "обед"
        return "ничего не заказывать"

    async def _manual_report(self, user_id: int, command: str) -> None:
        allowed, class_name = self.settings.report_scope(user_id)
        if not allowed:
            await self.max.send_message(
                user_id, "Отчёт доступен только создателю и указанным преподавателям."
            )
            return
        parts = command.split(maxsplit=1)
        if len(parts) == 2:
            try:
                target = date.fromisoformat(parts[1].strip())
            except ValueError:
                await self.max.send_message(user_id, "Дата должна быть в формате ГГГГ-ММ-ДД.")
                return
        else:
            target = self.active_target() or next_service_day(
                self.now().date(), self.settings.school_days_only
            )
        await self.send_report_to(user_id, target, class_name=class_name)

    async def _report_rows(self, target: date, class_name: str | None = None) -> list[ReportRow]:
        async with self.db.session() as session:
            statement = (
                select(Parent, Order)
                .outerjoin(
                    Order,
                    and_(
                        Order.parent_user_id == Parent.user_id,
                        Order.target_date == target,
                    ),
                )
                .where(
                    Parent.active.is_(True),
                    Parent.child_name.is_not(None),
                    Parent.class_name.is_not(None),
                )
                .order_by(Parent.class_name, Parent.child_name)
            )
            if class_name is not None:
                statement = statement.where(Parent.class_name == class_name)
            result = await session.execute(statement)
            return [
                ReportRow(
                    class_name=parent.class_name or "",
                    child_name=parent.child_name or "",
                    breakfast=bool(order and order.breakfast),
                    lunch=bool(order and order.lunch),
                )
                for parent, order in result.all()
            ]

    async def send_report_to(
        self, user_id: int, target: date, *, class_name: str | None = None
    ) -> None:
        content = build_report(target, await self._report_rows(target, class_name))
        class_suffix = f"_{class_name}" if class_name else ""
        filename = f"orders{class_suffix}_{target.isoformat()}.xlsx"
        scope_text = f" для класса {class_name}" if class_name else " по всем классам"
        await self.max.send_excel(
            user_id,
            filename,
            content,
            f"Итоговый заказ{scope_text} на {format_date_ru(target)}.",
        )

    async def delivery_exists(self, key: str) -> bool:
        async with self.db.session() as session:
            return await session.get(Delivery, key) is not None

    async def record_delivery(self, key: str) -> None:
        async with self.db.session() as session:
            if await session.get(Delivery, key) is None:
                session.add(Delivery(key=key))
                await session.commit()

    async def registered_parent_ids(self, *, unanswered_for: date | None = None) -> list[int]:
        async with self.db.session() as session:
            statement = select(Parent.user_id).where(
                Parent.active.is_(True),
                Parent.child_name.is_not(None),
                Parent.class_name.is_not(None),
            )
            if unanswered_for:
                statement = statement.where(
                    ~select(Order.id)
                    .where(
                        Order.parent_user_id == Parent.user_id,
                        Order.target_date == unanswered_for,
                    )
                    .exists()
                )
            return list(await session.scalars(statement))
