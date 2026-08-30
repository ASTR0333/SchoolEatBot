from __future__ import annotations

from datetime import date
from typing import Any


def callback_button(text: str, payload: str, intent: str = "default") -> dict[str, Any]:
    return {"type": "callback", "text": text, "payload": payload, "intent": intent}


def class_keyboard(classes: tuple[str, ...]) -> list[list[dict[str, Any]]]:
    return [[callback_button(name, f"class:{name}")] for name in classes]


def order_keyboard(target: date) -> list[list[dict[str, Any]]]:
    suffix = target.isoformat()
    return [
        [
            callback_button("🥣 Завтрак", f"order:{suffix}:breakfast", "positive"),
            callback_button("🍲 Обед", f"order:{suffix}:lunch", "positive"),
        ],
        [callback_button("🥣 + 🍲 Завтрак и обед", f"order:{suffix}:both", "positive")],
        [callback_button("Ничего не заказывать", f"order:{suffix}:none", "negative")],
    ]


def main_keyboard(
    *,
    can_order: bool,
    has_order: bool,
    show_admin_request: bool,
    admin_request_pending: bool,
    is_owner: bool,
    has_pending_requests: bool,
) -> list[list[dict[str, Any]]]:
    rows: list[list[dict[str, Any]]] = []
    if can_order:
        label = "✏️ Изменить заказ" if has_order else "🍽 Выбрать питание"
        rows.append([callback_button(label, "menu:order", "positive")])
    rows.append([callback_button("👦 Изменить ребёнка", "profile:edit")])
    if show_admin_request:
        rows.append([callback_button("Стать администратором", "admin:request")])
    elif admin_request_pending:
        rows.append([callback_button("Заявка администратора ожидает решения", "admin:pending")])
    if is_owner and has_pending_requests:
        rows.append([callback_button("Заявки администраторов", "owner:requests")])
    return rows


def admin_decision_keyboard(user_id: int) -> list[list[dict[str, Any]]]:
    return [
        [
            callback_button("✅ Одобрить", f"admin:approve:{user_id}", "positive"),
            callback_button("❌ Отклонить", f"admin:reject:{user_id}", "negative"),
        ]
    ]
