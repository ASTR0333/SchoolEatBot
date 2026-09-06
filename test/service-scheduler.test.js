import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { Database } from '../src/database.js';
import { DailyScheduler } from '../src/scheduler.js';
import { BotService } from '../src/service.js';

function config(overrides = {}) {
  return loadConfig({
    MAX_BOT_TOKEN: 'test-token',
    CREATOR_USER_ID: '100',
    TEACHER_1_ID: '200',
    TEACHER_2_ID: '',
    CLASS_1: '8МК',
    CLASS_2: '2Б',
    PROMPT_TIME: '15:00',
    REMINDER_TIME: '16:30',
    DEADLINE_TIME: '17:00',
    ...overrides,
  });
}

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'school-eat-service-'));
  const database = new Database(join(directory, 'bot.db'));
  const api = {
    messages: [],
    editedMessages: [],
    async sendMessageToUser(userId, text, extra) {
      this.messages.push({ userId, text, extra });
    },
    async editMessage(messageId, extra) {
      this.editedMessages.push({ messageId, ...extra });
    },
  };
  const service = new BotService(config(), database, api);
  try {
    await callback({ service, database, api });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('команда ID возвращает ID пользователя', async () => {
  await fixture(async ({ service, api }) => {
    await service.handleId({ user: { user_id: 777, name: 'Тест' }, chatId: 777 });
    assert.equal(api.messages[0].text, 'Ваш MAX user_id: 777');
  });
});

test('нажатие кнопки редактирует текущее сообщение вместо отправки нового', async () => {
  await fixture(async ({ service, database, api }) => {
    database.upsertParent({ user_id: 777, name: 'Родитель' }, 777);
    database.addChild(777, 'Иванов Иван', '8МК');

    let callbackAnswer;
    await service.withUpdateContext(
      {
        updateType: 'message_callback',
        messageId: 'message-1',
        async answerOnCallback(answer) {
          callbackAnswer = answer;
        },
      },
      () => service.sendChildrenList(777),
    );

    assert.equal(api.messages.length, 0);
    assert.equal(api.editedMessages.length, 0);
    assert.match(callbackAnswer.message.text, /Ваши дети/);
  });
});

test('нажатие класса подтверждается и переводит к вводу ФИО нового ребёнка', async () => {
  await fixture(async ({ service, database, api }) => {
    let callbackAnswer;
    await service.handleClassAction({
      user: { user_id: 777, name: 'Родитель' },
      chatId: 777,
      match: ['class:add:0:8МК', 'add', '0', '8МК'],
      async answerOnCallback(answer) {
        callbackAnswer = answer;
      },
    });

    assert.deepEqual(callbackAnswer, {});
    assert.equal(database.getParent(777).state, 'awaiting_name:add:8МК');
    assert.match(api.messages.at(-1).text, /Напишите фамилию и имя ребёнка/);
  });
});

test('панели сотрудников не требуют профиль ребёнка', async () => {
  await fixture(async ({ service, database, api }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.upsertParent({ user_id: 200, name: 'Учитель' }, 200);
    await service.sendMenu(100);
    await service.sendMenu(200);
    assert.match(api.messages[0].text, /отдельно по каждому классу/);
    assert.match(api.messages[1].text, /класса 8МК/);
  });
});

test('после выбора класса старая клавиатура удаляется из сообщения', async () => {
  await fixture(async ({ service, api }) => {
    let callbackAnswer;
    const ctx = {
      updateType: 'message_callback',
      messageId: 'message-with-classes',
      user: { user_id: 777, name: 'Родитель' },
      chatId: 777,
      match: ['class:add:0:8МК', 'add', '0', '8МК'],
      async answerOnCallback(answer) {
        callbackAnswer = answer;
      },
    };
    await service.withUpdateContext(ctx, () => service.handleClassAction(ctx));

    assert.equal(api.editedMessages.length, 0);
    assert.deepEqual(callbackAnswer.message.attachments, []);
    assert.match(callbackAnswer.message.text, /Напишите фамилию и имя ребёнка/);
  });
});

test('создатель получает два отдельных отчёта, преподаватель — только свой', async () => {
  await fixture(async ({ service, database }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.upsertParent({ user_id: 200, name: 'Учитель' }, 200);
    const sent = [];
    service.sendReportTo = async (userId, target, className) => {
      sent.push({ userId, target, className });
    };

    await service.sendManualReport(100, '/report 2026-09-03');
    await service.sendManualReport(200, '/report 2026-09-03');

    assert.deepEqual(sent, [
      { userId: 100, target: '2026-09-03', className: '8МК' },
      { userId: 100, target: '2026-09-03', className: '2Б' },
      { userId: 200, target: '2026-09-03', className: '8МК' },
    ]);
  });
});

test('обычный родитель не видит служебные команды в справке', async () => {
  await fixture(async ({ service, api }) => {
    await service.handleHelp({ user: { user_id: 777, name: 'Родитель' }, chatId: 777 });
    assert.doesNotMatch(api.messages[0].text, /report|role|test/);
    assert.match(api.messages[0].text, /\/list/);
  });
});

test('преподаватель управляет только детьми своего класса', async () => {
  await fixture(async ({ service, database }) => {
    database.upsertParent({ user_id: 200, name: 'Учитель' }, 200);
    database.upsertParent({ user_id: 777, name: 'Родитель' }, 777);
    const ownClass = database.addChild(777, 'Иванов Иван', '8МК');
    const otherClass = database.addChild(777, 'Петров Пётр', '2Б');

    assert.equal(service.canManageChild(200, ownClass.id), true);
    assert.equal(service.canManageChild(200, otherClass.id), false);
  });
});

test('преподаватель может перейти в роль родителя и видеть своих детей обоих классов', async () => {
  await fixture(async ({ service, database }) => {
    database.upsertParent({ user_id: 200, name: 'Учитель' }, 200);
    const first = database.addChild(200, 'Иванов Иван', '8МК');
    const second = database.addChild(200, 'Петров Пётр', '2Б');
    database.setViewMode(200, 'parent');

    assert.equal(service.canManageChild(200, first.id), true);
    assert.equal(service.canManageChild(200, second.id), true);
    assert.equal(database.childrenForParent(200).length, 2);
  });
});

test('права управления не теряются при переключении интерфейса', async () => {
  await fixture(async ({ service, database }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.upsertParent({ user_id: 200, name: 'Учитель' }, 200);
    database.upsertParent({ user_id: 777, name: 'Первый родитель' }, 777);
    database.upsertParent({ user_id: 888, name: 'Второй родитель' }, 888);
    const firstClass = database.addChild(777, 'Иванов Иван', '8МК');
    const secondClass = database.addChild(888, 'Петров Пётр', '2Б');
    const creatorChild = database.addChild(100, 'Сидоров Семён', '2Б');

    assert.equal(service.canManageChild(777, firstClass.id), true);
    assert.equal(service.canManageChild(777, secondClass.id), false);
    assert.equal(service.canManageChild(200, firstClass.id), true);
    assert.equal(service.canManageChild(200, secondClass.id), false);
    assert.equal(service.childPermissions(200, firstClass.id).canOrder, false);
    assert.equal(service.canManageChild(100, firstClass.id), true);
    assert.equal(service.canManageChild(100, secondClass.id), true);
    assert.equal(service.childPermissions(100, firstClass.id).canOrder, false);
    assert.equal(service.childPermissions(777, firstClass.id).canOrder, true);

    database.setViewMode(100, 'parent');
    assert.equal(service.canManageChild(100, creatorChild.id), true);
    assert.equal(service.canManageChild(100, firstClass.id), true);
    database.setViewMode(200, 'parent');
    assert.equal(service.canManageChild(200, firstClass.id), true);
  });
});

test('создатель всегда остаётся в служебной панели', async () => {
  await fixture(async ({ service, database, api }) => {
    const creator = database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    await service.handleRole({ user: { user_id: 100, name: 'Создатель' }, chatId: 100 });
    assert.equal(database.getParent(creator.user_id).view_mode, null);
    assert.match(api.messages.at(-1).text, /Панель создателя/);

    await service.handleTest({ user: { user_id: 100, name: 'Создатель' }, chatId: 100 });
    assert.equal(database.getParent(creator.user_id).view_mode, null);
    assert.match(api.messages.at(-1).text, /Панель создателя/);
  });
});

test('расписания классов независимы, преподаватель меняет только свой класс', async () => {
  await fixture(async ({ service, database }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.upsertParent({ user_id: 200, name: 'Учитель' }, 200);
    database.upsertParent({ user_id: 777, name: 'Родитель' }, 777);

    await service.saveScheduleField(100, 'prompt', 14 * 60, '2Б');
    assert.equal(service.getSchedule('2Б').promptTime, '14:00');
    assert.equal(service.getSchedule('8МК').promptTime, '15:00');

    await service.saveScheduleField(200, 'deadline', 16 * 60 + 45, '8МК');
    assert.equal(service.getSchedule('8МК').deadlineTime, '16:45');
    assert.equal(service.getSchedule('2Б').deadlineTime, '17:00');

    await service.saveScheduleField(200, 'deadline', 17 * 60 + 30, '2Б');
    assert.equal(service.getSchedule('2Б').deadlineTime, '17:00');
    assert.equal(service.isStaff(777), false);
  });
});

test('создатель сначала выбирает класс, преподаватель сразу видит свой', async () => {
  await fixture(async ({ service, database, api }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.upsertParent({ user_id: 200, name: 'Учитель' }, 200);

    await service.sendScheduleMenu(100);
    await service.sendScheduleMenu(200);

    assert.match(api.messages[0].text, /Для какого класса/);
    assert.match(api.messages[1].text, /Расписание класса 8МК/);
  });
});

test('UI расписания: создатель выбирает класс, преподаватель меняет только свой, родитель не допущен', async () => {
  await fixture(async ({ service, database, api }) => {
    const callback = (userId, match) => ({
      user: { user_id: userId, name: `Пользователь ${userId}` },
      chatId: userId,
      match,
      async answerOnCallback() {},
    });

    await service.handleScheduleMenuAction(callback(100, ['schedule:menu']));
    assert.match(api.messages.at(-1).text, /Для какого класса/);
    await service.handleScheduleClassAction(callback(100, ['schedule:class:2Б', '2Б']));
    assert.match(api.messages.at(-1).text, /Расписание класса 2Б/);
    await service.handleScheduleSaveAction(
      callback(100, ['schedule:save:prompt:840:2Б', 'prompt', '840', '2Б']),
    );
    assert.equal(service.getSchedule('2Б').promptTime, '14:00');
    assert.equal(database.getClassSchedule('2Б').updated_by, 100);

    await service.handleScheduleSaveAction(
      callback(200, ['schedule:save:reminder:960:8МК', 'reminder', '960', '8МК']),
    );
    assert.equal(service.getSchedule('8МК').reminderTime, '16:00');
    assert.equal(database.getClassSchedule('8МК').updated_by, 200);

    await service.handleScheduleSaveAction(
      callback(200, ['schedule:save:reminder:930:2Б', 'reminder', '930', '2Б']),
    );
    assert.equal(service.getSchedule('2Б').reminderTime, '16:30');
    assert.match(api.messages.at(-1).text, /нет доступа/);

    await service.handleScheduleMenuAction(callback(777, ['schedule:menu']));
    assert.match(api.messages.at(-1).text, /только сотрудникам/);
  });
});

test('создатель с устаревшим родительским режимом всё равно видит расписание и всех детей', async () => {
  await fixture(async ({ service, database, api }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.upsertParent({ user_id: 777, name: 'Родитель' }, 777);
    database.addChild(777, 'Иванов Иван', '8МК');
    database.setViewMode(100, 'parent');

    await service.sendMenu(100);
    assert.equal(database.getParent(100).view_mode, null);
    assert.match(api.messages.at(-1).text, /Панель создателя/);
    assert.match(api.messages.at(-1).text, /Расписание заказов/);

    await service.sendChildrenList(100, { type: 'mine' });
    assert.match(api.messages.at(-1).text, /Все дети/);
  });
});

test('родитель видит расписание каждого ребёнка, а окна и напоминания срабатывают по классу', async () => {
  await fixture(async ({ service, database, api }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.upsertParent({ user_id: 200, name: 'Учитель' }, 200);
    database.upsertParent({ user_id: 777, name: 'Родитель' }, 777);
    database.addChild(777, 'Иванов Иван', '8МК');
    database.addChild(777, 'Петров Пётр', '2Б');

    await service.saveScheduleField(200, 'prompt', 8 * 60, '8МК');
    await service.saveScheduleField(200, 'reminder', 8 * 60 + 30, '8МК');
    await service.saveScheduleField(200, 'deadline', 9 * 60, '8МК');
    await service.saveScheduleField(100, 'prompt', 15 * 60, '2Б');
    await service.saveScheduleField(100, 'reminder', 16 * 60, '2Б');
    await service.saveScheduleField(100, 'deadline', 17 * 60, '2Б');

    await service.sendMenu(777);
    assert.match(api.messages.at(-1).text, /8МК: 08:00–09:00, напоминание 08:30/);
    assert.match(api.messages.at(-1).text, /2Б: 15:00–17:00, напоминание 16:00/);

    const morning = new Date('2026-09-07T05:15:00Z');
    const reminder = new Date('2026-09-07T05:45:00Z');
    const afternoon = new Date('2026-09-07T12:15:00Z');
    assert.equal(service.activeTargetFor(777, morning, '8МК'), '2026-09-08');
    assert.equal(service.activeTargetFor(777, morning, '2Б'), null);
    assert.equal(service.activeTargetFor(777, afternoon, '8МК'), null);
    assert.equal(service.activeTargetFor(777, afternoon, '2Б'), '2026-09-08');

    api.messages.length = 0;
    service.sendReportTo = async () => {};
    const scheduler = new DailyScheduler(service);
    await scheduler.tick(morning);
    await scheduler.tick(reminder);
    await scheduler.tick(afternoon);

    assert.equal(api.messages.length, 3);
    assert.match(api.messages[0].text, /Иванов Иван/);
    assert.doesNotMatch(api.messages[0].text, /Напоминаю/);
    assert.match(api.messages[1].text, /Напоминаю.+Иванов Иван/s);
    assert.match(api.messages[2].text, /Петров Пётр/);
    assert.equal(database.deliveryExists('prompt:2026-09-08:8МК:777'), true);
    assert.equal(database.deliveryExists('reminder:2026-09-08:8МК:777'), true);
    assert.equal(database.deliveryExists('prompt:2026-09-08:2Б:777'), true);
  });
});

test('планировщик отправляет создателю два отчёта, преподавателю — свой', async () => {
  const sent = [];
  const fakeService = {
    config: config(),
    database: {
      deliveryExists: () => false,
      recordDelivery: () => {},
    },
    async sendReportTo(userId, target, className) {
      sent.push({ userId, target, className });
    },
  };
  const scheduler = new DailyScheduler(fakeService);
  await scheduler.sendReports('2026-09-03');
  assert.deepEqual(sent, [
    { userId: 100, target: '2026-09-03', className: '8МК' },
    { userId: 100, target: '2026-09-03', className: '2Б' },
    { userId: 200, target: '2026-09-03', className: '8МК' },
  ]);
});

test('планировщик учитывает время каждого класса отдельно', async () => {
  const prompted = [];
  const fakeService = {
    config: config(),
    getSchedule(className) {
      return className === '8МК'
        ? { promptMinutes: 15 * 60, reminderMinutes: 16 * 60, deadlineMinutes: 17 * 60 }
        : { promptMinutes: 16 * 60, reminderMinutes: 17 * 60, deadlineMinutes: 18 * 60 };
    },
    database: {
      registeredParentIds: () => [777],
      deliveryExists: () => false,
      recordDelivery: () => {},
    },
    async sendOrderPrompt(userId, options) {
      prompted.push({ userId, ...options });
    },
    async sendReportTo() {},
  };
  const scheduler = new DailyScheduler(fakeService);

  await scheduler.tick(new Date('2026-09-02T12:15:00Z'));

  assert.deepEqual(prompted, [{
    userId: 777,
    className: '8МК',
    now: new Date('2026-09-02T12:15:00Z'),
  }]);
});
