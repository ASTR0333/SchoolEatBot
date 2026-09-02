import 'dotenv/config';

import { Bot } from '@maxhub/max-bot-api';

import { loadConfig } from './config.js';
import { Database } from './database.js';
import { DailyScheduler } from './scheduler.js';
import { BotService } from './service.js';

const config = loadConfig();
const database = new Database();
const bot = new Bot(config.token);
const service = new BotService(config, database, bot.api);
const scheduler = new DailyScheduler(service);

bot.use((ctx, next) => service.withUpdateContext(ctx, next));
bot.on('bot_started', (ctx) => service.handleBotStarted(ctx));
bot.on('bot_stopped', (ctx) => service.handleBotStopped(ctx));
bot.command('start', (ctx) => service.handleMenu(ctx, { greeting: true }));
bot.command('menu', (ctx) => service.handleMenu(ctx));
bot.command('id', (ctx) => service.handleId(ctx));
bot.command('help', (ctx) => service.handleHelp(ctx));
bot.command('list', (ctx) => service.handleList(ctx));
bot.command(/^report(?:\s+.*)?$/u, (ctx) => service.handleReport(ctx));
bot.command('role', (ctx) => service.handleRole(ctx));
bot.command('test', (ctx) => service.handleTest(ctx));

bot.action(/^class:(add|edit):(\d+):(.+)$/u, (ctx) => service.handleClassAction(ctx));
bot.action('menu:main', (ctx) => service.handleMainMenuAction(ctx));
bot.action(/^common:(help|id)$/u, (ctx) => service.handleCommonAction(ctx));
bot.action(/^children:(mine|staff|order|back):(\d+)$/u, (ctx) => service.handleChildrenAction(ctx));
bot.action('child:add', (ctx) => service.handleAddChildAction(ctx));
bot.action(/^child:view:(\d+)$/u, (ctx) => service.handleChildViewAction(ctx));
bot.action(/^child:order:(\d+)$/u, (ctx) => service.handleChildOrderAction(ctx));
bot.action(/^child:name:(\d+)$/u, (ctx) => service.handleChildNameAction(ctx));
bot.action(/^child:class:(\d+)$/u, (ctx) => service.handleChildClassAction(ctx));
bot.action(/^child:delete:(\d+)$/u, (ctx) => service.handleChildDeleteAction(ctx));
bot.action(/^child:delete-confirm:(\d+)$/u, (ctx) => service.handleChildDeleteConfirmAction(ctx));
bot.action(/^order:(\d+):(\d{4}-\d{2}-\d{2}):(breakfast|lunch|both|none)$/u, (ctx) =>
  service.handleOrderAction(ctx),
);
bot.action('staff:report', (ctx) => service.handleStaffReportAction(ctx));
bot.action(/^role:(parent|staff)$/u, (ctx) => service.handleRoleAction(ctx));
bot.action(/^test:(on|off)$/u, (ctx) => service.handleTestAction(ctx));
bot.action('schedule:menu', (ctx) => service.handleScheduleMenuAction(ctx));
bot.action(/^schedule:class:(.+)$/u, (ctx) => service.handleScheduleClassAction(ctx));
bot.action(/^schedule:edit:(prompt|reminder|deadline):(.+)$/u, (ctx) =>
  service.handleScheduleEditAction(ctx),
);
bot.action(/^schedule:adjust:(prompt|reminder|deadline):(\d+):(.+)$/u, (ctx) =>
  service.handleScheduleAdjustAction(ctx),
);
bot.action(/^schedule:save:(prompt|reminder|deadline):(\d+):(.+)$/u, (ctx) =>
  service.handleScheduleSaveAction(ctx),
);
bot.on('message_callback', (ctx) => service.handleUnknownAction(ctx));
bot.on('message_created', (ctx) => service.handleMessage(ctx));

bot.catch((error, ctx) => {
  console.error(`Ошибка обработки события ${ctx.updateType}`, error);
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  console.log('Останавливаю бота...');
  scheduler.stop();
  bot.stopPolling();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const botInfo = await bot.api.getMyInfo();
  bot.botInfo = botInfo;
  await bot.api.setMyCommands([
    { name: 'start', description: 'Открыть меню' },
    { name: 'menu', description: 'Открыть меню' },
    { name: 'list', description: 'Показать список детей' },
    { name: 'id', description: 'Показать мой MAX user ID' },
    { name: 'help', description: 'Показать справку' },
  ]);
  console.log(`Подключён MAX-бот @${botInfo.username ?? botInfo.name} (${botInfo.user_id})`);
  scheduler.start();
  await bot.start({
    mode: 'polling',
    options: {
      allowedUpdates: ['message_created', 'message_callback', 'bot_started', 'bot_stopped'],
      retry: true,
    },
  });
} catch (error) {
  console.error('Не удалось запустить MAX-бота', error);
  process.exitCode = 1;
} finally {
  scheduler.stop();
  database.close();
}
