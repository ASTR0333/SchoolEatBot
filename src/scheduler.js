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
      const local = localNow(config.timezone, now);
      if (!isSchoolDay(local.date)) return;
      const target = nextServiceDay(local.date);

      for (const className of config.classes) {
        const schedule = this.service.getSchedule?.(className) ?? config;
        if (local.minutes >= schedule.promptMinutes && local.minutes < schedule.reminderMinutes) {
          await this.sendPrompts(target, className);
        } else if (local.minutes >= schedule.reminderMinutes && local.minutes < schedule.deadlineMinutes) {
          await this.sendReminders(target, className);
        } else if (local.minutes >= schedule.deadlineMinutes) {
          await this.sendReports(target, className);
        }
      }
    } catch (error) {
      console.error('Ошибка плановой задачи', error);
    } finally {
      this.running = false;
    }
  }

  async sendPrompts(target, className) {
    for (const userId of this.service.database.registeredParentIds(target, className)) {
      const key = `prompt:${target}:${className}:${userId}`;
      if (this.service.database.deliveryExists(key)) continue;
      try {
        await this.service.sendOrderPrompt(userId, { className });
        this.service.database.recordDelivery(key);
      } catch (error) {
        console.error(`Не удалось отправить выбор питания пользователю ${userId}`, error);
      }
    }
  }

  async sendReminders(target, className) {
    for (const userId of this.service.database.registeredParentIds(target, className)) {
      const key = `reminder:${target}:${className}:${userId}`;
      if (this.service.database.deliveryExists(key)) continue;
      try {
        await this.service.sendOrderPrompt(userId, { reminder: true, className });
        this.service.database.recordDelivery(key);
      } catch (error) {
        console.error(`Не удалось отправить напоминание пользователю ${userId}`, error);
      }
    }
  }

  async sendReports(target, onlyClassName = null) {
    for (const [userId, className] of this.service.config.reportRecipients) {
      if (onlyClassName !== null && className !== onlyClassName) continue;
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
