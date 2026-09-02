import { isSchoolDay, localNow, nextServiceDay } from './time.js';

export class DailyScheduler {
  constructor(service, intervalMilliseconds = 30_000) {
    this.service = service;
    this.intervalMilliseconds = intervalMilliseconds;
    this.running = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMilliseconds);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const { config } = this.service;
      const schedule = this.service.getSchedule?.() ?? config;
      const local = localNow(config.timezone, now);
      if (!isSchoolDay(local.date)) return;
      const target = nextServiceDay(local.date);

      if (local.minutes >= schedule.promptMinutes && local.minutes < schedule.reminderMinutes) {
        await this.sendPrompts(target);
      } else if (local.minutes >= schedule.reminderMinutes && local.minutes < schedule.deadlineMinutes) {
        await this.sendReminders(target);
      } else if (local.minutes >= schedule.deadlineMinutes) {
        await this.sendReports(target);
      }
    } catch (error) {
      console.error('Ошибка плановой задачи', error);
    } finally {
      this.running = false;
    }
  }

  async sendPrompts(target) {
    for (const userId of this.service.database.registeredParentIds(target)) {
      const key = `prompt:${target}:${userId}`;
      if (this.service.database.deliveryExists(key)) continue;
      try {
        await this.service.sendOrderPrompt(userId);
        this.service.database.recordDelivery(key);
      } catch (error) {
        console.error(`Не удалось отправить выбор питания пользователю ${userId}`, error);
      }
    }
  }

  async sendReminders(target) {
    for (const userId of this.service.database.registeredParentIds(target)) {
      const key = `reminder:${target}:${userId}`;
      if (this.service.database.deliveryExists(key)) continue;
      try {
        await this.service.sendOrderPrompt(userId, { reminder: true });
        this.service.database.recordDelivery(key);
      } catch (error) {
        console.error(`Не удалось отправить напоминание пользователю ${userId}`, error);
      }
    }
  }

  async sendReports(target) {
    for (const [userId, className] of this.service.config.reportRecipients) {
      const key = `report:js:${target}:${userId}:${className ?? 'all'}`;
      if (this.service.database.deliveryExists(key)) continue;
      try {
        await this.service.sendReportTo(userId, target, className);
        this.service.database.recordDelivery(key);
      } catch (error) {
        console.error(`Не удалось отправить отчёт пользователю ${userId}`, error);
      }
    }
  }
}
