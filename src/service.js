import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { reportScope } from './config.js';
import {
  backToMenuKeyboard,
  childActionsKeyboard,
  childrenKeyboard,
  classKeyboard,
  deleteConfirmationKeyboard,
  orderKeyboard,
  parentMenuKeyboard,
  savedOrderKeyboard,
  scheduleClassKeyboard,
  scheduleEditKeyboard,
  scheduleMenuKeyboard,
  staffMenuKeyboard,
} from './keyboards.js';
import { buildReport } from './reports.js';
import { activeOrderTarget, formatDateRu, isValidIsoDate, localNow, nextServiceDay } from './time.js';

const ORDER_CHOICES = {
  breakfast: [true, false],
  lunch: [false, true],
  both: [true, true],
  none: [false, false],
};

const SCHEDULE_FIELDS = {
  prompt: ['Время начала заказов', 'promptTime', 'promptMinutes'],
  reminder: ['Время напоминания', 'reminderTime', 'reminderMinutes'],
  deadline: ['Время окончания заказов', 'deadlineTime', 'deadlineMinutes'],
};

function clockToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToClock(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export class BotService {
  constructor(config, database, api) {
    this.config = config;
    this.database = database;
    this.api = api;
    this.updateContext = new AsyncLocalStorage();
  }

  withUpdateContext(ctx, next) {
    if (ctx.updateType !== 'message_callback') {
      return this.updateContext.run({ messageId: null }, () => next());
    }
    const answerOnCallback = ctx.answerOnCallback.bind(ctx);
    // Ответ отправляется вместе с новым содержимым при первом вызове sendMessage.
    // Вызовы в обработчиках только отмечают место логического подтверждения.
    ctx.answerOnCallback = async () => undefined;
    return this.updateContext.run(
      { messageId: ctx.messageId, answerOnCallback, answered: false },
      () => next(),
    );
  }

  roleFor(userId) {
    if (userId === this.config.creatorUserId) return { name: 'creator', className: null };
    const assignment = this.config.teacherAssignments.find(([teacherId]) => teacherId === userId);
    return assignment
      ? { name: 'teacher', className: assignment[1] }
      : { name: 'parent', className: null };
  }

  scheduleSettingKey(className, field) {
    return `schedule:${className}:${field}_time`;
  }

  getSchedule(className = this.config.classes[0]) {
    const keys = Object.fromEntries(
      Object.keys(SCHEDULE_FIELDS).map((field) => [field, this.scheduleSettingKey(className, field)]),
    );
    const stored = this.database.getSettings(Object.values(keys));
    const promptTime = stored[keys.prompt] ?? this.config.promptTime;
    const reminderTime = stored[keys.reminder] ?? this.config.reminderTime;
    const deadlineTime = stored[keys.deadline] ?? this.config.deadlineTime;
    return {
      className,
      promptTime,
      reminderTime,
      deadlineTime,
      promptMinutes: clockToMinutes(promptTime),
      reminderMinutes: clockToMinutes(reminderTime),
      deadlineMinutes: clockToMinutes(deadlineTime),
    };
  }

  runtimeConfig(className = this.config.classes[0]) {
    return { ...this.config, ...this.getSchedule(className) };
  }

  activeTarget(now = new Date(), className = this.config.classes[0]) {
    return activeOrderTarget(this.runtimeConfig(className), now);
  }

  activeTargetFor(userId, now = new Date(), className = null) {
    const parent = this.database.getParent(userId);
    if (this.roleFor(userId).name === 'creator' && parent?.view_mode === 'test') {
      return nextServiceDay(localNow(this.config.timezone, now).date);
    }
    if (className !== null) return this.activeTarget(now, className);
    const classes = new Set(this.database.childrenForParent(userId).map((child) => child.class_name));
    for (const candidate of classes) {
      const target = this.activeTarget(now, candidate);
      if (target) return target;
    }
    return null;
  }

  scheduleClassFor(userId, requestedClassName = null) {
    const role = this.roleFor(userId);
    if (role.name === 'teacher') {
      return requestedClassName === null || requestedClassName === role.className
        ? role.className
        : null;
    }
    if (role.name === 'creator' && this.config.classes.includes(requestedClassName)) {
      return requestedClassName;
    }
    return null;
  }

  schedulesText(classNames) {
    return classNames.map((className) => {
      const schedule = this.getSchedule(className);
      return `${className}: ${schedule.promptTime}–${schedule.deadlineTime}, напоминание ${schedule.reminderTime}`;
    }).join('\n');
  }

  ensureParent(ctx) {
    if (!ctx.user?.user_id || ctx.user.is_bot) return null;
    return this.database.upsertParent(ctx.user, ctx.chatId ?? ctx.user.user_id);
  }

  async handleBotStarted(ctx) {
    const parent = this.ensureParent(ctx);
    if (parent) await this.sendMenu(parent.user_id, { greeting: true });
  }

  handleBotStopped(ctx) {
    if (ctx.user?.user_id) this.database.markParentInactive(Number(ctx.user.user_id));
  }

  async handleId(ctx) {
    const parent = this.ensureParent(ctx);
    if (parent) {
      await this.sendMessage(
        parent.user_id,
        `Ваш MAX user_id: ${parent.user_id}`,
        backToMenuKeyboard(),
      );
    }
  }

  async handleHelp(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const role = this.roleFor(parent.user_id).name;
    let text =
      'Команды:\n/start или /menu — открыть меню\n/list — список детей\n' +
      '/id — узнать свой MAX user_id\n/help — показать справку';
    if (role === 'teacher') {
      text += '\n/report [ГГГГ-ММ-ДД] — отчёт по классу\n/role — сменить роль преподаватель/родитель';
    } else if (role === 'creator') {
      text += '\n/report [ГГГГ-ММ-ДД] — отдельные отчёты по классам' +
        '\n/role — переключить панель создатель/родитель' +
        '\n/test — тестировать заказы в любое время';
    }
    await this.sendMessage(parent.user_id, text, backToMenuKeyboard());
  }

  async handleMenu(ctx, { greeting = false } = {}) {
    const parent = this.ensureParent(ctx);
    if (parent) await this.sendMenu(parent.user_id, { greeting });
  }

  async handleList(ctx) {
    const parent = this.ensureParent(ctx);
    if (parent) await this.sendChildrenList(parent.user_id);
  }

  async handleReport(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const text = String(ctx.message?.body?.text ?? '').trim();
    await this.sendManualReport(parent.user_id, text);
  }

  async handleRole(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    if (!this.isStaff(parent.user_id)) {
      await this.sendMessage(parent.user_id, 'Команда смены роли доступна только сотрудникам.');
      return;
    }
    this.database.setViewMode(parent.user_id, parent.view_mode === 'parent' ? null : 'parent');
    await this.sendMenu(parent.user_id);
  }

  async handleTest(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    if (this.roleFor(parent.user_id).name !== 'creator') {
      await this.sendMessage(parent.user_id, 'Тестовый режим доступен только создателю бота.');
      return;
    }
    this.database.setViewMode(parent.user_id, parent.view_mode === 'test' ? null : 'test');
    await this.sendMenu(parent.user_id);
  }

  async handleMessage(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const text = String(ctx.message?.body?.text ?? '').trim();
    if (parent.state?.startsWith('awaiting_name:')) {
      await this.saveChildName(parent.user_id, parent.state, text);
      return;
    }
    await this.sendMenu(parent.user_id);
  }

  async handleClassAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    await this.selectClass(
      parent.user_id,
      ctx.match?.[1] ?? '',
      Number(ctx.match?.[2]),
      ctx.match?.[3] ?? '',
    );
  }

  async handleMainMenuAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    await this.sendMenu(parent.user_id);
  }

  async handleCommonAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    if (ctx.match?.[1] === 'id') {
      await this.sendMessage(
        parent.user_id,
        `Ваш MAX user_id: ${parent.user_id}`,
        backToMenuKeyboard(),
      );
    } else {
      await this.handleHelp(ctx);
    }
  }

  async handleChildrenAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    const type = ctx.match?.[1] ?? 'mine';
    const page = Number(ctx.match?.[2] ?? 0);
    await this.sendChildrenList(parent.user_id, { type, page });
  }

  async handleAddChildAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    await this.startAddChild(parent.user_id);
  }

  async handleChildViewAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    await this.sendChildCard(parent.user_id, Number(ctx.match?.[1]));
  }

  async handleChildOrderAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    await this.sendOrderPrompt(parent.user_id, { childId: Number(ctx.match?.[1]) });
  }

  async handleChildNameAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const childId = Number(ctx.match?.[1]);
    if (!this.canManageChild(parent.user_id, childId)) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'У вас нет доступа к этому ребёнку.', backToMenuKeyboard());
      return;
    }
    this.database.setParentState(parent.user_id, `awaiting_name:edit:${childId}`);
    await ctx.answerOnCallback({});
    await this.sendMessage(parent.user_id, 'Напишите новые фамилию и имя ребёнка одним сообщением.');
  }

  async handleChildClassAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const childId = Number(ctx.match?.[1]);
    if (!this.canChangeChildClass(parent.user_id, childId)) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'У вас нет доступа к смене класса.', backToMenuKeyboard());
      return;
    }
    await ctx.answerOnCallback({});
    await this.sendMessage(
      parent.user_id,
      'Выберите новый класс ребёнка:',
      classKeyboard(this.config.classes, { action: 'edit', childId }),
    );
  }

  async handleChildDeleteAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const childId = Number(ctx.match?.[1]);
    const child = this.accessibleChild(parent.user_id, childId);
    if (!child) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'Ребёнок не найден или у вас нет доступа.', backToMenuKeyboard());
      return;
    }
    await ctx.answerOnCallback({});
    await this.sendMessage(
      parent.user_id,
      `Удалить ребёнка «${child.child_name}» вместе со всеми его заказами?`,
      deleteConfirmationKeyboard(childId),
    );
  }

  async handleChildDeleteConfirmAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const childId = Number(ctx.match?.[1]);
    if (!this.canManageChild(parent.user_id, childId)) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'У вас нет доступа к этому ребёнку.', backToMenuKeyboard());
      return;
    }
    this.database.deleteChild(childId);
    await ctx.answerOnCallback({});
    await this.sendChildrenList(parent.user_id);
  }

  async handleOrderAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    await this.saveOrder(
      parent.user_id,
      Number(ctx.match?.[1]),
      ctx.match?.[2],
      ctx.match?.[3],
    );
  }

  async handleStaffReportAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    await ctx.answerOnCallback({});
    const role = this.roleFor(parent.user_id);
    await this.sendMessage(
      parent.user_id,
      role.name === 'creator'
        ? 'Формирую два отдельных отчёта по классам…'
        : `Формирую отчёт класса ${role.className}…`,
      backToMenuKeyboard(),
    );
    await this.sendManualReport(parent.user_id, '/report');
  }

  async handleRoleAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const role = this.roleFor(parent.user_id).name;
    if (role === 'parent') {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'Смена роли доступна только сотрудникам.', backToMenuKeyboard());
      return;
    }
    this.database.setViewMode(parent.user_id, ctx.match?.[1] === 'parent' ? 'parent' : null);
    await ctx.answerOnCallback({});
    await this.sendMenu(parent.user_id);
  }

  async handleTestAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    if (this.roleFor(parent.user_id).name !== 'creator') {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'Тестовый режим доступен только создателю.', backToMenuKeyboard());
      return;
    }
    this.database.setViewMode(parent.user_id, ctx.match?.[1] === 'on' ? 'test' : null);
    await ctx.answerOnCallback({});
    await this.sendMenu(parent.user_id);
  }

  async handleScheduleMenuAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    if (!this.isStaff(parent.user_id)) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'Настройка расписания доступна только сотрудникам.', backToMenuKeyboard());
      return;
    }
    await ctx.answerOnCallback({});
    await this.sendScheduleMenu(parent.user_id);
  }

  async handleScheduleClassAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const className = this.scheduleClassFor(parent.user_id, ctx.match?.[1] ?? '');
    if (!className) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'У вас нет доступа к расписанию этого класса.', backToMenuKeyboard());
      return;
    }
    await ctx.answerOnCallback({});
    await this.sendScheduleMenu(parent.user_id, className);
  }

  async handleScheduleEditAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const className = this.scheduleClassFor(parent.user_id, ctx.match?.[2] ?? null);
    if (!className) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'У вас нет доступа к расписанию этого класса.', backToMenuKeyboard());
      return;
    }
    await ctx.answerOnCallback({});
    await this.sendScheduleEditor(parent.user_id, ctx.match?.[1], className);
  }

  async handleScheduleAdjustAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const className = this.scheduleClassFor(parent.user_id, ctx.match?.[3] ?? null);
    if (!className) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'У вас нет доступа к расписанию этого класса.', backToMenuKeyboard());
      return;
    }
    await ctx.answerOnCallback({});
    await this.sendScheduleEditor(
      parent.user_id,
      ctx.match?.[1],
      className,
      Number(ctx.match?.[2]),
    );
  }

  async handleScheduleSaveAction(ctx) {
    const parent = this.ensureParent(ctx);
    if (!parent) return;
    const className = this.scheduleClassFor(parent.user_id, ctx.match?.[3] ?? null);
    if (!className) {
      await ctx.answerOnCallback({});
      await this.sendMessage(parent.user_id, 'У вас нет доступа к расписанию этого класса.', backToMenuKeyboard());
      return;
    }
    await ctx.answerOnCallback({});
    await this.saveScheduleField(
      parent.user_id,
      ctx.match?.[1],
      Number(ctx.match?.[2]),
      className,
    );
  }

  async handleUnknownAction(ctx) {
    const parent = this.ensureParent(ctx);
    await ctx.answerOnCallback({});
    if (parent) {
      await this.sendMessage(parent.user_id, 'Эта кнопка уже неактуальна.', backToMenuKeyboard());
    }
  }

  async sendMessage(userId, text, attachment = null, extra = {}) {
    const { forceNew = false, ...apiExtra } = extra;
    const context = this.updateContext.getStore();
    const messageId = forceNew ? null : context?.messageId;
    const editBody = {
      ...apiExtra,
      text,
      attachments: attachment ? [attachment] : [],
    };
    if (!forceNew && context?.answerOnCallback && !context.answered) {
      context.answered = true;
      try {
        return await context.answerOnCallback({ message: editBody });
      } catch (error) {
        console.error('Не удалось ответить на нажатие кнопки новым содержимым', error);
      }
    }
    if (messageId && this.api.editMessage) {
      try {
        return await this.api.editMessage(messageId, editBody);
      } catch (error) {
        console.error(`Не удалось отредактировать сообщение ${messageId}`, error);
      }
    }
    const attachments = attachment ? [attachment] : undefined;
    return this.api.sendMessageToUser(userId, text, { ...apiExtra, attachments });
  }

  isStaff(userId) {
    return this.roleFor(userId).name !== 'parent';
  }

  accessibleChild(userId, childId) {
    const child = this.database.getChild(childId);
    if (!child) return null;
    const role = this.roleFor(userId);
    const parent = this.database.getParent(userId);
    const parentView = ['parent', 'test'].includes(parent?.view_mode);
    if (role.name === 'creator' && !parentView) return child;
    if (role.name === 'teacher' && parent?.view_mode !== 'parent' && role.className === child.class_name) {
      return child;
    }
    return child.parent_user_id === userId ? child : null;
  }

  canManageChild(userId, childId) {
    return this.accessibleChild(userId, childId) !== null;
  }

  canChangeChildClass(userId, childId) {
    const child = this.database.getChild(childId);
    if (!child) return false;
    const role = this.roleFor(userId);
    const mode = this.database.getParent(userId)?.view_mode;
    if (role.name === 'creator' && !['parent', 'test'].includes(mode)) return true;
    const parentView = role.name === 'parent' || ['parent', 'test'].includes(mode);
    return child.parent_user_id === userId && parentView;
  }

  async startAddChild(userId) {
    await this.sendMessage(
      userId,
      'Выберите класс ребёнка:',
      classKeyboard(this.config.classes, { action: 'add' }),
    );
  }

  async selectClass(userId, action, childId, rawClassName) {
    const className = rawClassName.trim().toUpperCase();
    if (!this.config.classes.includes(className)) {
      await this.sendMessage(userId, 'Такого класса нет. Выберите вариант из списка.');
      return;
    }
    if (action === 'edit') {
      if (!this.canChangeChildClass(userId, childId)) {
        await this.sendMessage(userId, 'У вас нет доступа к этому ребёнку.');
        return;
      }
      this.database.updateChildClass(childId, className);
      await this.sendMessage(userId, `Класс изменён на ${className}.`);
      await this.sendChildCard(userId, childId);
      return;
    }
    this.database.setParentState(userId, `awaiting_name:add:${className}`);
    await this.sendMessage(
      userId,
      `Класс ${className} выбран. Напишите фамилию и имя ребёнка одним сообщением.`,
    );
  }

  async saveChildName(userId, state, text) {
    const name = text.split(/\s+/).filter(Boolean).join(' ');
    if (text.startsWith('/') || name.length < 3 || name.length > 200 || name.split(' ').length < 2) {
      await this.sendMessage(userId, 'Пожалуйста, напишите фамилию и имя ребёнка одним сообщением.');
      return;
    }
    const [, action, value] = state.split(':');
    if (action === 'add') {
      const child = this.database.addChild(userId, name, value);
      this.database.setParentState(userId, null);
      await this.sendMessage(userId, `Ребёнок сохранён: ${name}, класс ${value}.`);
      await this.sendChildCard(userId, child.id);
      return;
    }
    const childId = Number(value);
    if (!this.canManageChild(userId, childId)) {
      this.database.setParentState(userId, null);
      await this.sendMessage(userId, 'У вас нет доступа к этому ребёнку.');
      return;
    }
    this.database.updateChildName(childId, name);
    this.database.setParentState(userId, null);
    await this.sendMessage(userId, `ФИО изменено: ${name}.`);
    await this.sendChildCard(userId, childId);
  }

  async sendMenu(userId, { greeting = false } = {}) {
    const parent = this.database.getParent(userId);
    if (!parent) return;
    if (parent.state) {
      this.database.setParentState(userId, null);
      parent.state = null;
    }
    const role = this.roleFor(userId);
    const isParentView = role.name === 'parent' || parent.view_mode === 'parent' || parent.view_mode === 'test';
    if (!isParentView) {
      const text = role.name === 'teacher'
        ? `Панель преподавателя класса ${role.className}. Здесь можно управлять детьми своего класса и получить отчёт.`
        : 'Панель создателя. Отчёты формируются отдельно по каждому классу. Здесь также доступны все дети, расписание и тестовый режим.';
      const scheduleText = this.schedulesText(
        role.name === 'teacher' ? [role.className] : this.config.classes,
      );
      await this.sendMessage(
        userId,
        `${greeting ? 'Здравствуйте!\n\n' : ''}${text}\n\n` +
          `Расписание заказов:\n${scheduleText}.`,
        staffMenuKeyboard({ role: role.name }),
      );
      return;
    }

    const children = this.database.childrenForParent(userId);
    const childClasses = [...new Set(children.map((child) => child.class_name))];
    const scheduleText = childClasses.length
      ? this.schedulesText(childClasses)
      : 'появится после добавления ребёнка';
    const testText = parent.view_mode === 'test' ? '\n🧪 Тестовый режим: заказ доступен в любое время.' : '';
    await this.sendMessage(
      userId,
      `${greeting ? 'Здравствуйте!\n\n' : ''}Детей в списке: ${children.length}.` +
        `\nРасписание заказов:\n${scheduleText}.` +
        testText,
      parentMenuKeyboard({
        canOrder: this.activeTargetFor(userId) !== null && children.length > 0,
        staffRole: role.name === 'parent' ? null : role.name,
        testMode: parent.view_mode === 'test',
      }),
    );
  }

  childrenForList(userId, type) {
    const role = this.roleFor(userId);
    if (type === 'staff' && role.name === 'creator') return this.database.allChildren();
    if (type === 'staff' && role.name === 'teacher') return this.database.childrenForClass(role.className);
    return this.database.childrenForParent(userId);
  }

  async sendChildrenList(userId, { type = null, page = 0 } = {}) {
    const parent = this.database.getParent(userId);
    if (parent?.state) {
      this.database.setParentState(userId, null);
      parent.state = null;
    }
    const role = this.roleFor(userId);
    const staffView = role.name !== 'parent' && !['parent', 'test'].includes(parent?.view_mode);
    const requestedType = type === 'back' || type === null ? (staffView ? 'staff' : 'mine') : type;
    const orderMode = requestedType === 'order';
    const listType = orderMode ? 'mine' : requestedType;
    if (listType === 'staff' && !staffView) {
      await this.sendMessage(userId, 'У вас нет доступа к служебному списку.');
      return;
    }
    let children = this.childrenForList(userId, listType);
    if (orderMode) {
      children = children.filter((child) => this.activeTargetFor(userId, new Date(), child.class_name));
    }
    const title = orderMode
      ? 'Выберите ребёнка для заказа:'
      : listType === 'staff'
        ? role.name === 'creator' ? 'Все дети:' : `Дети класса ${role.className}:`
        : 'Ваши дети:';
    await this.sendMessage(
      userId,
      children.length ? title : `${title}\nСписок пока пуст.`,
      childrenKeyboard(children, { page: Math.max(0, page), listType, orderMode }),
    );
  }

  async sendChildCard(userId, childId) {
    const child = this.accessibleChild(userId, childId);
    if (!child) {
      await this.sendMessage(userId, 'Ребёнок не найден или у вас нет доступа.');
      return;
    }
    const target = this.activeTargetFor(userId, new Date(), child.class_name);
    const order = target ? this.database.getOrder(child.id, target) : null;
    let text = `👦 ${child.child_name}\n🏫 Класс: ${child.class_name}`;
    if (target) {
      text += order
        ? `\n\nЗаказ на ${formatDateRu(target)}: ${this.orderLabel(order.breakfast, order.lunch)}.`
        : `\n\nЗаказ на ${formatDateRu(target)} ещё не выбран.`;
    }
    const role = this.roleFor(userId);
    await this.sendMessage(
      userId,
      text,
      childActionsKeyboard(child.id, {
        canOrder: target !== null,
        canEditName: true,
        canChangeClass: this.canChangeChildClass(userId, child.id),
        canDelete: role.name === 'creator' || role.name === 'teacher' || child.parent_user_id === userId,
      }),
    );
  }

  async sendOrderPrompt(userId, { childId = null, reminder = false, className = null } = {}) {
    if (childId === null && className !== null) {
      const target = this.activeTargetFor(userId, new Date(), className);
      if (!target) return;
      const children = this.database.childrenForParent(userId).filter(
        (child) => child.class_name === className && !this.database.getOrder(child.id, target),
      );
      for (const child of children) {
        await this.sendOrderPrompt(userId, { childId: child.id, reminder });
      }
      return;
    }
    if (childId === null) {
      if (!this.activeTargetFor(userId)) {
        await this.sendMessage(userId, 'Сейчас заказ закрыт для всех классов ваших детей.');
        return;
      }
      await this.sendChildrenList(userId, { type: 'order' });
      return;
    }
    const child = this.accessibleChild(userId, childId);
    if (!child) {
      await this.sendMessage(userId, 'Ребёнок не найден или у вас нет доступа.');
      return;
    }
    const schedule = this.getSchedule(child.class_name);
    const target = this.activeTargetFor(userId, new Date(), child.class_name);
    if (!target) {
      await this.sendMessage(
        userId,
        `Сейчас заказ закрыт. Выбор доступен с ${schedule.promptTime} до ${schedule.deadlineTime}.`,
      );
      return;
    }
    await this.sendMessage(
      userId,
      `${reminder ? 'Напоминаю: ' : ''}что заказываем для ${child.child_name} на ${formatDateRu(target)}?\n` +
        `Изменить решение можно до ${schedule.deadlineTime}.`,
      orderKeyboard(child.id, target),
    );
  }

  async saveOrder(userId, childId, target, choice) {
    if (!isValidIsoDate(target ?? '') || !(choice in ORDER_CHOICES)) {
      await this.sendMessage(userId, 'Эта кнопка некорректна или уже неактуальна.');
      return;
    }
    const child = this.accessibleChild(userId, childId);
    if (!child) {
      await this.sendMessage(userId, 'Ребёнок не найден или у вас нет доступа.');
      return;
    }
    if (target !== this.activeTargetFor(userId, new Date(), child.class_name)) {
      await this.sendMessage(userId, 'Время изменения этого заказа уже закончилось. Откройте /menu.');
      return;
    }
    const [breakfast, lunch] = ORDER_CHOICES[choice];
    this.database.saveOrder(childId, target, breakfast, lunch);
    await this.sendMessage(
      userId,
      `Готово. Для ${child.child_name} на ${formatDateRu(target)} выбрано: ` +
        `${this.orderLabel(breakfast, lunch)}.`,
      savedOrderKeyboard(childId),
    );
  }

  orderLabel(breakfast, lunch) {
    if (breakfast && lunch) return 'завтрак и обед';
    if (breakfast) return 'завтрак';
    if (lunch) return 'обед';
    return 'ничего не заказывать';
  }

  async sendScheduleMenu(userId, requestedClassName = null) {
    const role = this.roleFor(userId);
    if (role.name === 'creator' && requestedClassName === null) {
      await this.sendMessage(
        userId,
        'Для какого класса настроить расписание?',
        scheduleClassKeyboard(this.config.classes),
      );
      return;
    }
    const className = this.scheduleClassFor(userId, requestedClassName);
    if (!className) {
      await this.sendMessage(userId, 'У вас нет доступа к настройке расписания.', backToMenuKeyboard());
      return;
    }
    const schedule = this.getSchedule(className);
    await this.sendMessage(
      userId,
      `Расписание класса ${className}:\n🟢 Начало: ${schedule.promptTime}\n` +
        `🔔 Напоминание: ${schedule.reminderTime}\n🔴 Окончание: ${schedule.deadlineTime}`,
      scheduleMenuKeyboard(className, { canChooseClass: role.name === 'creator' }),
    );
  }

  async sendScheduleEditor(userId, field, className, minutes = null) {
    if (!(field in SCHEDULE_FIELDS)) {
      await this.sendMessage(userId, 'Неизвестная настройка расписания.');
      return;
    }
    const [label, , minutesKey] = SCHEDULE_FIELDS[field];
    const value = Number.isInteger(minutes) && minutes >= 0 && minutes < 1440
      ? minutes
      : this.getSchedule(className)[minutesKey];
    await this.sendMessage(
      userId,
      `Класс ${className}. ${label}: ${minutesToClock(value)}. ` +
        'Измените кнопками и нажмите «Сохранить».',
      scheduleEditKeyboard(field, value, className),
    );
  }

  async saveScheduleField(userId, field, minutes, requestedClassName = null) {
    if (!(field in SCHEDULE_FIELDS) || !Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) {
      await this.sendMessage(userId, 'Некорректное время.');
      return;
    }
    const className = this.scheduleClassFor(userId, requestedClassName);
    if (!className) {
      await this.sendMessage(userId, 'У вас нет доступа к расписанию этого класса.', backToMenuKeyboard());
      return;
    }
    const [, timeKey, minutesKey] = SCHEDULE_FIELDS[field];
    const next = {
      ...this.getSchedule(className),
      [timeKey]: minutesToClock(minutes),
      [minutesKey]: minutes,
    };
    if (!(next.promptMinutes < next.reminderMinutes && next.reminderMinutes < next.deadlineMinutes)) {
      await this.sendMessage(
        userId,
        'Не сохранено: начало должно быть раньше напоминания, а напоминание — раньше окончания.',
      );
      await this.sendScheduleEditor(userId, field, className, minutes);
      return;
    }
    this.database.setSetting(this.scheduleSettingKey(className, field), minutesToClock(minutes));
    await this.sendMessage(
      userId,
      `Расписание класса ${className} сохранено. Новое время применяется сразу.`,
    );
    await this.sendScheduleMenu(userId, className);
  }

  async sendManualReport(userId, command) {
    const scope = reportScope(this.config, userId);
    if (!scope.allowed) {
      await this.sendMessage(userId, 'Отчёт доступен только создателю и преподавателям.');
      return;
    }
    const requestedDate = command.split(/\s+/, 2)[1];
    if (requestedDate && !isValidIsoDate(requestedDate)) {
      await this.sendMessage(userId, 'Дата должна быть в формате ГГГГ-ММ-ДД.');
      return;
    }
    const target = requestedDate ?? this.activeTarget() ?? nextServiceDay(localNow(this.config.timezone).date);
    if (scope.className) {
      await this.sendReportTo(userId, target, scope.className);
      return;
    }
    for (const className of this.config.classes) {
      await this.sendReportTo(userId, target, className);
    }
  }

  async sendReportTo(userId, target, className = null) {
    const rows = this.database.reportRows(target, className);
    const content = await buildReport(target, rows);
    const classSuffix = className ? `_${className.replace(/[^\p{L}\p{N}-]+/gu, '_')}` : '';
    const filename = `orders${classSuffix}_${target}.xlsx`;
    const directory = await mkdtemp(join(tmpdir(), 'school-eat-report-'));
    const path = join(directory, filename);
    try {
      await writeFile(path, content);
      const attachment = await this.api.uploadFile({ source: path, timeout: 120_000 });
      const scopeText = className ? ` для класса ${className}` : ' по всем классам';
      await this.sendFileWithRetry(
        userId,
        `Итоговый заказ${scopeText} на ${formatDateRu(target)}.`,
        attachment.toJson(),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async sendFileWithRetry(userId, text, attachment) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.sendMessage(userId, text, attachment, { forceNew: true });
        return;
      } catch (error) {
        if (!String(error).includes('attachment.not.ready') || attempt === 4) throw error;
        await delay(2 ** attempt * 1000);
      }
    }
  }
}
