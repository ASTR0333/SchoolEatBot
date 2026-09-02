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

    await service.withUpdateContext(
      { updateType: 'message_callback', messageId: 'message-1' },
      () => service.sendChildrenList(777),
    );

    assert.equal(api.messages.length, 0);
    assert.equal(api.editedMessages.length, 1);
    assert.equal(api.editedMessages[0].messageId, 'message-1');
    assert.match(api.editedMessages[0].text, /Ваши дети/);
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

    assert.deepEqual(callbackAnswer, { notification: 'Класс выбран' });
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
    assert.match(api.messages[0].text, /общий отчёт/);
    assert.match(api.messages[1].text, /класса 8МК/);
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

test('создатель сохраняет новое расписание, родителю это запрещено', async () => {
  await fixture(async ({ service, database }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.upsertParent({ user_id: 777, name: 'Родитель' }, 777);
    await service.saveScheduleField(100, 'prompt', 14 * 60);
    assert.equal(service.getSchedule().promptTime, '14:00');
    assert.equal(service.isStaff(777), false);
  });
});

test('тестовый режим создателя открывает заказ вне обычного окна', async () => {
  await fixture(async ({ service, database }) => {
    database.upsertParent({ user_id: 100, name: 'Создатель' }, 100);
    database.setViewMode(100, 'test');
    const outsideWindow = new Date('2026-09-01T08:00:00Z');
    assert.equal(service.activeTarget(outsideWindow), null);
    assert.equal(service.activeTargetFor(100, outsideWindow), '2026-09-02');
  });
});

test('планировщик отправляет создателю общий отчёт, преподавателю — свой', async () => {
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
    { userId: 100, target: '2026-09-03', className: null },
    { userId: 200, target: '2026-09-03', className: '8МК' },
  ]);
});
