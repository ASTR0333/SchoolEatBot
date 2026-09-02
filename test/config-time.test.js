import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, reportScope } from '../src/config.js';
import { activeOrderTarget, formatDateRu, nextServiceDay } from '../src/time.js';

function env(overrides = {}) {
  return {
    MAX_BOT_TOKEN: 'test-token',
    CREATOR_USER_ID: '100',
    TEACHER_1_ID: '200',
    TEACHER_2_ID: '300',
    CLASS_1: '8мк',
    CLASS_2: '2б',
    PROMPT_TIME: '15:00',
    REMINDER_TIME: '16:30',
    DEADLINE_TIME: '17:00',
    ...overrides,
  };
}

test('пустые ID преподавателей допустимы', () => {
  const config = loadConfig(env({ TEACHER_1_ID: '', TEACHER_2_ID: '  ' }));
  assert.deepEqual(config.teacherAssignments, []);
  assert.deepEqual(config.reportRecipients, [[100, null]]);
});

test('создатель видит все классы, преподаватель только свой', () => {
  const config = loadConfig(env());
  assert.deepEqual(reportScope(config, 100), { allowed: true, className: null });
  assert.deepEqual(reportScope(config, 200), { allowed: true, className: '8МК' });
  assert.deepEqual(reportScope(config, 999), { allowed: false, className: null });
});

test('расписание валидируется', () => {
  assert.throws(
    () => loadConfig(env({ REMINDER_TIME: '14:00' })),
    /PROMPT_TIME < REMINDER_TIME < DEADLINE_TIME/,
  );
});

test('после пятницы следующий день питания — понедельник', () => {
  assert.equal(nextServiceDay('2026-09-04'), '2026-09-07');
});

test('окно заказа открыто до дедлайна и закрывается в дедлайн', () => {
  const config = loadConfig(env());
  assert.equal(activeOrderTarget(config, new Date('2026-08-31T13:45:00Z')), '2026-09-01');
  assert.equal(activeOrderTarget(config, new Date('2026-08-31T14:00:00Z')), null);
});

test('дата форматируется по-русски', () => {
  assert.equal(formatDateRu('2026-08-29'), '29 августа');
});
