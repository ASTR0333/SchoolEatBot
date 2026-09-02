import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import ExcelJS from 'exceljs';

import { Database } from '../src/database.js';
import { buildReport } from '../src/reports.js';

async function withDatabase(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'school-eat-test-'));
  const database = new Database(join(directory, 'bot.db'));
  try {
    await callback(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('база сохраняет родителей и фильтрует отчёт по классу', async () => {
  await withDatabase(async (database) => {
    database.upsertParent({ user_id: 1, name: 'Первый' }, 1);
    database.upsertParent({ user_id: 2, name: 'Второй' }, 2);
    const first = database.addChild(1, 'Иванов Иван', '8МК');
    database.addChild(2, 'Петров Пётр', '2Б');
    database.saveOrder(first.id, '2026-09-03', true, false);

    assert.deepEqual(database.reportRows('2026-09-03', '8МК'), [
      { className: '8МК', childName: 'Иванов Иван', breakfast: true, lunch: false },
    ]);
    assert.equal(database.reportRows('2026-09-03').length, 2);
  });
});

test('один родитель может добавить детей из обоих классов', async () => {
  await withDatabase(async (database) => {
    database.upsertParent({ user_id: 1, name: 'Родитель' }, 1);
    database.addChild(1, 'Иванов Иван', '8МК');
    database.addChild(1, 'Петров Пётр', '2Б');

    assert.deepEqual(
      database.childrenForParent(1).map((child) => [child.child_name, child.class_name]),
      [['Петров Пётр', '2Б'], ['Иванов Иван', '8МК']],
    );
  });
});

test('получатели напоминаний фильтруются по классу', async () => {
  await withDatabase(async (database) => {
    database.upsertParent({ user_id: 1, name: 'Оба класса' }, 1);
    database.upsertParent({ user_id: 2, name: 'Только второй класс' }, 2);
    const first = database.addChild(1, 'Иванов Иван', '8МК');
    database.addChild(1, 'Петров Пётр', '2Б');
    database.addChild(2, 'Сидоров Семён', '2Б');
    database.saveOrder(first.id, '2026-09-03', true, false);

    assert.deepEqual(database.registeredParentIds('2026-09-03', '8МК'), []);
    assert.deepEqual(database.registeredParentIds('2026-09-03', '2Б'), [1, 2]);
  });
});

test('старая тестовая схема очищается при переходе на новую модель', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'school-eat-legacy-'));
  const path = join(directory, 'bot.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE parents (
      user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, display_name TEXT NOT NULL,
      child_name TEXT, class_name TEXT, state TEXT, active INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO parents VALUES (1, 1, 'Тест', 'Старый Ребёнок', '8МК', NULL, 1, 'x', 'x');
  `);
  legacy.close();

  const database = new Database(path);
  try {
    assert.deepEqual(database.allChildren(), []);
    assert.equal(database.getSettings(['schema_version']).schema_version, '2');
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('удаление ребёнка удаляет и его заказы', async () => {
  await withDatabase(async (database) => {
    database.upsertParent({ user_id: 1, name: 'Родитель' }, 1);
    const child = database.addChild(1, 'Иванов Иван', '8МК');
    database.saveOrder(child.id, '2026-09-03', true, true);

    assert.equal(database.deleteChild(child.id), true);
    assert.equal(database.getChild(child.id), null);
    assert.equal(database.getOrder(child.id, '2026-09-03'), null);
  });
});

test('Excel содержит нужные колонки и отметки', async () => {
  const content = await buildReport('2026-09-03', [
    { className: '8МК', childName: 'Иванов Иван', breakfast: true, lunch: false },
    { className: '2Б', childName: 'Петров Пётр', breakfast: true, lunch: true },
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content);
  const sheet = workbook.getWorksheet('Заказы');

  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Класс', 'ФИО', 'Завтрак', 'Обед']);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['2Б', 'Петров Пётр', '✓', '✓']);
  assert.deepEqual(sheet.getRow(3).values.slice(1), ['8МК', 'Иванов Иван', '✓', '—']);
});

test('пустой Excel остаётся валидным', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildReport('2026-09-03', []));
  assert.equal(workbook.getWorksheet('Заказы').getCell('B2').value, 'Нет зарегистрированных учеников');
});
