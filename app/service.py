from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any

from sqlalchemy import and_, func, select

from app.config import Settings
from app.database import Database
from app.keyboards import (
    admin_decision_keyboard,
    callback_button,
    class_keyboard,
    main_keyboard,
    order_keyboard,
)
from app.max_client import MaxClient
from app.models import AdminRequest, Delivery, Order, Parent, utc_now
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
                "/report [ГГГГ-ММ-ДД] — отчёт (для администратора)",
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
            elif payload == "admin:request":
                await self._request_admin(parent.user_id, callback_id)
            elif payload == "admin:pending":
                await self.max.answer_callback(callback_id, "Заявка ещё ожидает решения владельца")
            elif payload == "owner:requests":
                await self.max.answer_callback(callback_id, "Показываю заявки")
                await self._send_pending_requests(parent.user_id)
            elif payload.startswith("admin:approve:"):
                await self._decide_admin(parent.user_id, payload, callback_id, approve=True)
            elif payload.startswith("admin:reject:"):
                await self._decide_admin(parent.user_id, payload, callback_id, approve=False)
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
        async with self.db.session() as session:
            parent = await session.get(Parent, user_id)
            if parent is None:
                return
            if user_id == self.settings.owner_user_id and (
                not parent.class_name or not parent.child_name
            ):
                pending_count = await session.scalar(
                    select(func.count())
                    .select_from(AdminRequest)
                    .where(AdminRequest.status == "pending")
                )
                text = "Панель владельца бота."
                if pending_count:
                    text += f"\n\nЗаявок администратора: {pending_count}."
                else:
                    text += "\n\nНовых заявок администратора нет."
                buttons = []
                if pending_count:
                    buttons.append([callback_button("Заявки администраторов", "owner:requests")])
                buttons.append([callback_button("Добавить ребёнка", "profile:edit")])
                await self.max.send_message(user_id, text, buttons)
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
            approved_count = await session.scalar(
                select(func.count())
                .select_from(AdminRequest)
                .where(AdminRequest.status == "approved")
            )
            request = await session.get(AdminRequest, user_id)
            pending_count = await session.scalar(
                select(func.count())
                .select_from(AdminRequest)
                .where(AdminRequest.status == "pending")
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
        if request and request.status == "approved":
            text += "\n\nВы — администратор. Итоговый Excel придёт после закрытия заказов."

        buttons = main_keyboard(
            can_order=target is not None,
            has_order=order is not None,
            show_admin_request=(
                not approved_count
                and user_id != self.settings.owner_user_id
                and (request is None or request.status != "pending")
            ),
            admin_request_pending=(
                not approved_count and request is not None and request.status == "pending"
            ),
            is_owner=user_id == self.settings.owner_user_id,
            has_pending_requests=bool(pending_count),
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

    async def _request_admin(self, user_id: int, callback_id: str) -> None:
        async with self.db.session() as session:
            approved = await session.scalar(
                select(AdminRequest).where(AdminRequest.status == "approved")
            )
            if approved:
                await self.max.answer_callback(callback_id, "Администратор уже назначен")
                return
            parent = await session.get(Parent, user_id)
            if parent is None or not parent.child_name or not parent.class_name:
                await self.max.answer_callback(callback_id, "Сначала заполните данные ребёнка")
                return
            request = await session.get(AdminRequest, user_id)
            if request is None:
                request = AdminRequest(user_id=user_id, status="pending")
                session.add(request)
            else:
                request.status = "pending"
                request.requested_at = utc_now()
                request.decided_at = None
                request.decided_by = None
            await session.commit()
        await self.max.answer_callback(callback_id, "Заявка отправлена владельцу")
        await self.max.send_message(user_id, "Заявка администратора отправлена владельцу бота.")
        try:
            await self._send_admin_request_to_owner(user_id)
        except Exception:
            logger.exception("Could not notify owner about admin request")

    async def _send_admin_request_to_owner(self, candidate_id: int) -> None:
        async with self.db.session() as session:
            parent = await session.get(Parent, candidate_id)
            if parent is None:
                return
        await self.max.send_message(
            self.settings.owner_user_id,
            "Заявка на роль администратора:\n"
            f"Пользователь: {parent.display_name}\n"
            f"MAX user_id: {parent.user_id}\n"
            f"Ребёнок: {parent.child_name}\nКласс: {parent.class_name}",
            admin_decision_keyboard(candidate_id),
        )

    async def _send_pending_requests(self, owner_id: int) -> None:
        if owner_id != self.settings.owner_user_id:
            await self.max.send_message(owner_id, "Эта команда доступна только владельцу.")
            return
        async with self.db.session() as session:
            ids = list(
                await session.scalars(
                    select(AdminRequest.user_id).where(AdminRequest.status == "pending")
                )
            )
        if not ids:
            await self.max.send_message(owner_id, "Новых заявок нет.")
            return
        for candidate_id in ids:
            await self._send_admin_request_to_owner(candidate_id)

    async def _decide_admin(
        self, owner_id: int, payload: str, callback_id: str, *, approve: bool
    ) -> None:
        if owner_id != self.settings.owner_user_id:
            await self.max.answer_callback(callback_id, "Только владелец может принять решение")
            return
        try:
            candidate_id = int(payload.rsplit(":", 1)[1])
        except ValueError:
            await self.max.answer_callback(callback_id, "Некорректная заявка")
            return

        async with self.db.session() as session:
            request = await session.get(AdminRequest, candidate_id)
            if request is None:
                await self.max.answer_callback(callback_id, "Заявка не найдена")
                return
            if approve:
                approved = await session.scalar(
                    select(AdminRequest).where(
                        AdminRequest.status == "approved", AdminRequest.user_id != candidate_id
                    )
                )
                if approved:
                    await self.max.answer_callback(callback_id, "Администратор уже назначен")
                    return
                request.status = "approved"
            else:
                request.status = "rejected"
            request.decided_at = utc_now()
            request.decided_by = owner_id
            await session.commit()

        result = "одобрена" if approve else "отклонена"
        await self.max.answer_callback(callback_id, f"Заявка {result}")
        await self.max.send_message(
            candidate_id,
            "Ваша заявка администратора одобрена. Итоговые Excel-таблицы будут приходить сюда."
            if approve
            else "Ваша заявка администратора отклонена владельцем бота.",
        )

    async def _is_report_allowed(self, user_id: int) -> bool:
        if user_id == self.settings.owner_user_id:
            return True
        async with self.db.session() as session:
            request = await session.get(AdminRequest, user_id)
            return bool(request and request.status == "approved")

    async def _manual_report(self, user_id: int, command: str) -> None:
        if not await self._is_report_allowed(user_id):
            await self.max.send_message(
                user_id, "Отчёт доступен только владельцу и администратору."
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
        await self.send_report_to(user_id, target)

    async def _report_rows(self, target: date) -> list[ReportRow]:
        async with self.db.session() as session:
            result = await session.execute(
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
            return [
                ReportRow(
                    class_name=parent.class_name or "",
                    child_name=parent.child_name or "",
                    breakfast=bool(order and order.breakfast),
                    lunch=bool(order and order.lunch),
                )
                for parent, order in result.all()
            ]

    async def send_report_to(self, user_id: int, target: date) -> None:
        content = build_report(target, await self._report_rows(target))
        filename = f"orders_{target.isoformat()}.xlsx"
        await self.max.send_excel(
            user_id,
            filename,
            content,
            f"Итоговый заказ на {format_date_ru(target)}.",
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

    async def approved_admin_ids(self) -> list[int]:
        async with self.db.session() as session:
            return list(
                await session.scalars(
                    select(AdminRequest.user_id)
                    .join(Parent, Parent.user_id == AdminRequest.user_id)
                    .where(AdminRequest.status == "approved", Parent.active.is_(True))
                )
            )
