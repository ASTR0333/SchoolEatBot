const TIMEZONE = 'Europe/Moscow';

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`В .env не указана обязательная переменная ${name}`);
  }
  return value;
}

function parseUserId(value, name, { optional = false } = {}) {
  const normalized = value?.trim();
  if (!normalized && optional) return null;
  if (!/^\d+$/.test(normalized ?? '')) {
    throw new Error(`${name} должен содержать числовой MAX user_id`);
  }
  const result = Number(normalized);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} содержит некорректный MAX user_id`);
  }
  return result;
}

function parseClass(value, name) {
  const normalized = required({ [name]: value }, name).toUpperCase();
  return normalized;
}

function parseClock(value, name) {
  const normalized = required({ [name]: value }, name);
  const match = /^(\d{2}):(\d{2})$/.exec(normalized);
  if (!match) throw new Error(`${name} должен быть в формате ЧЧ:ММ`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`${name} содержит некорректное время`);
  }
  return { value: normalized, minutes: hour * 60 + minute };
}

export function loadConfig(env = process.env) {
  const prompt = parseClock(env.PROMPT_TIME ?? '15:00', 'PROMPT_TIME');
  const reminder = parseClock(env.REMINDER_TIME ?? '16:30', 'REMINDER_TIME');
  const deadline = parseClock(env.DEADLINE_TIME ?? '17:00', 'DEADLINE_TIME');
  if (!(prompt.minutes < reminder.minutes && reminder.minutes < deadline.minutes)) {
    throw new Error('Должно выполняться PROMPT_TIME < REMINDER_TIME < DEADLINE_TIME');
  }

  const class1 = parseClass(env.CLASS_1 ?? '8МК', 'CLASS_1');
  const class2 = parseClass(env.CLASS_2 ?? '2Б', 'CLASS_2');
  const creatorUserId = parseUserId(required(env, 'CREATOR_USER_ID'), 'CREATOR_USER_ID');
  const teacher1Id = parseUserId(env.TEACHER_1_ID, 'TEACHER_1_ID', { optional: true });
  const teacher2Id = parseUserId(env.TEACHER_2_ID, 'TEACHER_2_ID', { optional: true });

  const teacherAssignments = [
    [teacher1Id, class1],
    [teacher2Id, class2],
  ].filter(([userId]) => userId !== null);

  const reportRecipients = [[creatorUserId, null]];
  const seen = new Set([creatorUserId]);
  for (const [userId, className] of teacherAssignments) {
    if (!seen.has(userId)) {
      reportRecipients.push([userId, className]);
      seen.add(userId);
    }
  }

  return Object.freeze({
    token: required(env, 'MAX_BOT_TOKEN'),
    creatorUserId,
    teacherAssignments,
    reportRecipients,
    classes: [...new Set([class1, class2])],
    class1,
    class2,
    promptTime: prompt.value,
    reminderTime: reminder.value,
    deadlineTime: deadline.value,
    promptMinutes: prompt.minutes,
    reminderMinutes: reminder.minutes,
    deadlineMinutes: deadline.minutes,
    timezone: TIMEZONE,
  });
}

export function reportScope(config, userId) {
  if (userId === config.creatorUserId) return { allowed: true, className: null };
  const assignment = config.teacherAssignments.find(([teacherId]) => teacherId === userId);
  return assignment
    ? { allowed: true, className: assignment[1] }
    : { allowed: false, className: null };
}
