const RU_MONTHS = [
  '',
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

const formatterCache = new Map();

function formatter(timezone) {
  if (!formatterCache.has(timezone)) {
    formatterCache.set(
      timezone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    );
  }
  return formatterCache.get(timezone);
}

export function localNow(timezone, now = new Date()) {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isSchoolDay(value) {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

export function nextServiceDay(value) {
  let target = addDays(value, 1);
  while (!isSchoolDay(target)) target = addDays(target, 1);
  return target;
}

export function activeOrderTarget(config, now = new Date()) {
  const local = localNow(config.timezone, now);
  if (!isSchoolDay(local.date)) return null;
  if (local.minutes < config.promptMinutes || local.minutes >= config.deadlineMinutes) return null;
  return nextServiceDay(local.date);
}

export function formatDateRu(value) {
  const [, month, day] = value.split('-').map(Number);
  return `${day} ${RU_MONTHS[month]}`;
}
