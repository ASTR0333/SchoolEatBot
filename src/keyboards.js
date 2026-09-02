import { Keyboard } from '@maxhub/max-bot-api';

const callback = (text, payload) => Keyboard.button.callback(text, payload);

export function classKeyboard(classes, { action = 'add', childId = 0 } = {}) {
  return Keyboard.inlineKeyboard(
    classes.map((className) => [callback(className, `class:${action}:${childId}:${className}`)]),
  );
}

export function orderKeyboard(childId, target) {
  return Keyboard.inlineKeyboard([
    [
      callback('🥣 Завтрак', `order:${childId}:${target}:breakfast`),
      callback('🍲 Обед', `order:${childId}:${target}:lunch`),
    ],
    [callback('🥣 + 🍲 Завтрак и обед', `order:${childId}:${target}:both`)],
    [callback('🚫 Ничего не заказывать', `order:${childId}:${target}:none`)],
    [callback('⬅️ К ребёнку', `child:view:${childId}`)],
  ]);
}

export function parentMenuKeyboard({ canOrder, staffRole = null, testMode = false }) {
  const rows = [
    [callback('👨‍👩‍👧‍👦 Мои дети', 'children:mine:0')],
    [callback('➕ Добавить ребёнка', 'child:add')],
  ];
  if (canOrder) rows.unshift([callback('🍽 Заказать питание', 'children:order:0')]);
  if (staffRole === 'teacher') rows.push([callback('🎓 Панель преподавателя', 'role:staff')]);
  if (staffRole === 'creator') {
    rows.push([
      callback('🛠 Панель создателя', testMode ? 'test:off' : 'role:staff'),
    ]);
  }
  rows.push([
    callback('ℹ️ Помощь', 'common:help'),
    callback('🆔 Мой ID', 'common:id'),
  ]);
  return Keyboard.inlineKeyboard(rows);
}

export function staffMenuKeyboard({ role }) {
  const rows = [
    [callback('📊 Получить отчёт', 'staff:report')],
    [callback('⏰ Настроить расписание', 'schedule:menu')],
    [callback(role === 'creator' ? '👥 Все дети' : '👥 Дети моего класса', 'children:staff:0')],
  ];
  if (role === 'teacher') rows.push([callback('👨‍👩‍👧 Режим родителя', 'role:parent')]);
  if (role === 'creator') {
    rows.push([callback('👨‍👩‍👧 Обычный режим родителя', 'role:parent')]);
    rows.push([callback('🧪 Тестовый режим родителя', 'test:on')]);
  }
  rows.push([
    callback('ℹ️ Помощь', 'common:help'),
    callback('🆔 Мой ID', 'common:id'),
  ]);
  return Keyboard.inlineKeyboard(rows);
}

export function childrenKeyboard(children, {
  page = 0,
  listType = 'mine',
  orderMode = false,
  pageSize = 8,
} = {}) {
  const start = page * pageSize;
  const visible = children.slice(start, start + pageSize);
  const rows = visible.map((child) => [
    callback(
      `${orderMode ? '🍽 ' : '👦 '}${child.child_name} · ${child.class_name}`,
      orderMode ? `child:order:${child.id}` : `child:view:${child.id}`,
    ),
  ]);
  const navigation = [];
  const mode = orderMode ? 'order' : listType;
  if (page > 0) navigation.push(callback('⬅️', `children:${mode}:${page - 1}`));
  if (start + pageSize < children.length) navigation.push(callback('➡️', `children:${mode}:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  if (listType === 'mine' && !orderMode) rows.push([callback('➕ Добавить ребёнка', 'child:add')]);
  rows.push([callback('🏠 В меню', 'menu:main')]);
  return Keyboard.inlineKeyboard(rows);
}

export function childActionsKeyboard(childId, { canOrder, canEditName, canChangeClass, canDelete }) {
  const rows = [];
  if (canOrder) rows.push([callback('🍽 Выбрать питание', `child:order:${childId}`)]);
  const editRow = [];
  if (canEditName) editRow.push(callback('✏️ Изменить ФИО', `child:name:${childId}`));
  if (canChangeClass) editRow.push(callback('🏫 Сменить класс', `child:class:${childId}`));
  if (editRow.length) rows.push(editRow);
  if (canDelete) rows.push([callback('🗑 Удалить ребёнка', `child:delete:${childId}`)]);
  rows.push([callback('⬅️ К списку', 'children:back:0')]);
  return Keyboard.inlineKeyboard(rows);
}

export function deleteConfirmationKeyboard(childId) {
  return Keyboard.inlineKeyboard([
    [callback('✅ Да, удалить', `child:delete-confirm:${childId}`)],
    [callback('Отмена', `child:view:${childId}`)],
  ]);
}

export function savedOrderKeyboard(childId) {
  return Keyboard.inlineKeyboard([
    [callback('✏️ Изменить заказ', `child:order:${childId}`)],
    [callback('👦 К ребёнку', `child:view:${childId}`)],
    [callback('🏠 В меню', 'menu:main')],
  ]);
}

export function backToMenuKeyboard() {
  return Keyboard.inlineKeyboard([[callback('🏠 В меню', 'menu:main')]]);
}

export function scheduleClassKeyboard(classes) {
  return Keyboard.inlineKeyboard([
    ...classes.map((className) => [
      callback(`🏫 ${className}`, `schedule:class:${className}`),
    ]),
    [callback('🏠 В меню', 'menu:main')],
  ]);
}

export function scheduleMenuKeyboard(className, { canChooseClass = false } = {}) {
  const suffix = `:${className}`;
  const rows = [
    [callback('🟢 Время начала', `schedule:edit:prompt${suffix}`)],
    [callback('🔔 Время напоминания', `schedule:edit:reminder${suffix}`)],
    [callback('🔴 Время окончания', `schedule:edit:deadline${suffix}`)],
  ];
  if (canChooseClass) rows.push([callback('⬅️ Выбрать другой класс', 'schedule:menu')]);
  rows.push([callback('🏠 В меню', 'menu:main')]);
  return Keyboard.inlineKeyboard([
    ...rows,
  ]);
}

export function scheduleEditKeyboard(field, minutes, className) {
  const adjusted = (delta) => (minutes + delta + 1440) % 1440;
  const suffix = `:${className}`;
  return Keyboard.inlineKeyboard([
    [
      callback('− 1 час', `schedule:adjust:${field}:${adjusted(-60)}${suffix}`),
      callback('− 15 мин', `schedule:adjust:${field}:${adjusted(-15)}${suffix}`),
    ],
    [
      callback('+ 15 мин', `schedule:adjust:${field}:${adjusted(15)}${suffix}`),
      callback('+ 1 час', `schedule:adjust:${field}:${adjusted(60)}${suffix}`),
    ],
    [callback('✅ Сохранить', `schedule:save:${field}:${minutes}${suffix}`)],
    [callback('⬅️ Назад', `schedule:class:${className}`)],
  ]);
}
