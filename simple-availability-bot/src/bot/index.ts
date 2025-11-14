import { Telegraf, Markup, Scenes, session } from 'telegraf';
import type { MiddlewareFn } from 'telegraf';
import { AppConfig } from '../types';
import { AvailabilityService } from '../services/availabilityService';
import { createAddSlotScene, ADD_SLOT_SCENE_ID } from './addSlotScene';
import { formatDate, toDateAtTime } from '../utils/time';
import { BotContext } from './types';

type Mode = 'client' | 'admin';

const MODE_TOGGLE_ROW = ['🎫 Режим клієнта', '🛠 Режим адміністратора'];

const ADMIN_MENU = [
  ['➕ Додати слот', '🧹 Очистити день'],
  ['📋 Всі слоти', '🖼 Показати розклад'],
];

const CLIENT_MENU = [
  ['🗓 Показати розклад', 'ℹ️ Інформація'],
  ['📞 Контакти'],
];

const CLIENT_INFO_TEXT = [
  'Ласкаво просимо до нашої бані «Болотня»! 🌿',
  '• Вартість — 500 грн/год',
  '• Мінімальний час бронювання — 2 години',
  '• Чан — +1000 грн (одноразово)',
  'Усі години автоматично вважаються зайнятими, окрім тих, що ми відкрили як вільні.',
].join('\n');

export function createBot(config: AppConfig, service: AvailabilityService) {
  const bot = new Telegraf<BotContext>(config.botToken);
  const stage = new Scenes.Stage<BotContext>([createAddSlotScene(service)]);

  bot.use(session());
  bot.use(stage.middleware());

  bot.start(async (ctx) => {
    const initialMode: Mode = isAdmin(ctx.from?.id, config.adminIds) ? 'admin' : 'client';
    getBotSession(ctx).mode = initialMode;

    if (initialMode === 'admin') {
      await ctx.reply(
        'Вітаю! Режим адміністратора активований. Користуйтеся кнопками нижче.',
        buildKeyboard('admin')
      );
      return;
    }

    await ctx.reply(
      'Привіт! Це бот із розкладом нашої бані. Обирайте потрібний режим нижче 👇',
      buildKeyboard('client')
    );
    await sendScheduleImage(ctx, service, 'Ось актуальний розклад 👇');
    await ctx.reply(CLIENT_INFO_TEXT);
    await ctx.reply(config.contactMessage);
  });

  bot.hears('🎫 Режим клієнта', async (ctx) => {
    await switchMode(ctx, 'client', config);
  });

  bot.hears('🛠 Режим адміністратора', async (ctx) => {
    await switchMode(ctx, 'admin', config);
  });

  bot.command('admin', onlyAdmin(config, async (ctx) => {
    await switchMode(ctx, 'admin', config);
  }));

  bot.command('schedule', async (ctx) => {
    await sendScheduleImage(ctx, service);
  });

  bot.command('summary', async (ctx) => {
    const summary = await service.buildAvailableSummary();
    await ctx.reply(summary);
  });

  bot.command('addslot', onlyAdmin(config, (ctx) => ctx.scene.enter(ADD_SLOT_SCENE_ID)));

  bot.hears('🗓 Показати розклад', async (ctx) => {
    await sendScheduleImage(ctx, service);
  });

  bot.hears('ℹ️ Інформація', async (ctx) => {
    await ctx.reply(CLIENT_INFO_TEXT);
  });

  bot.hears('📞 Контакти', async (ctx) => {
    await ctx.reply(config.contactMessage);
  });

  bot.hears('🖼 Показати розклад', onlyAdmin(config, async (ctx) => {
    await sendScheduleImage(ctx, service);
  }));

  bot.hears('➕ Додати слот', onlyAdmin(config, (ctx) => ctx.scene.enter(ADD_SLOT_SCENE_ID)));

  bot.hears('📋 Всі слоти', onlyAdmin(config, async (ctx) => {
    await sendSlotsList(ctx, service, config);
  }));

  bot.hears('🧹 Очистити день', onlyAdmin(config, async (ctx) => {
    await promptClearDay(ctx, service, config);
  }));

  bot.action(/^admin:clear:(.+)$/, onlyAdminAction(config, async (ctx) => {
    const iso = ctx.match[1];
    const removed = await service.clearDay(iso);
    await ctx.answerCbQuery(removed ? 'Прибрали' : 'Слотів не було');
    await ctx.editMessageText(
      removed
        ? `Прибрано ${removed} слот(и) на ${formatAdminDate(iso, config)}`
        : `На ${formatAdminDate(iso, config)} й так нічого не було`
    );
  }));

  bot.action('admin:clear:cancel', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery('Скасовано');
    await ctx.editMessageText('Гаразд, нічого не чистимо 👍');
  }));

  bot.catch((error) => {
    console.error('Bot error:', error);
  });

  return bot;
}

function isAdmin(userId: number | undefined, adminIds: number[]): boolean {
  if (!userId) return false;
  return adminIds.includes(userId);
}

function onlyAdmin(config: AppConfig, handler: MiddlewareFn<BotContext>) {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    if (!isAdmin(ctx.from?.id, config.adminIds)) {
      await ctx.reply('Доступно лише адміністраторам 🙈');
      return;
    }
    return handler(ctx, next);
  };
}

function onlyAdminAction(
  config: AppConfig,
  handler: MiddlewareFn<BotContext & { match: RegExpExecArray }>
) {
  return async (ctx: BotContext & { match: RegExpExecArray }, next: () => Promise<void>) => {
    if (!isAdmin(ctx.from?.id, config.adminIds)) {
      await ctx.answerCbQuery('Нема доступу', { show_alert: true });
      return;
    }
    return handler(ctx, next);
  };
}

async function sendScheduleImage(
  ctx: BotContext,
  service: AvailabilityService,
  caption = 'Актуальний розклад 👇'
) {
  try {
    const result = await service.buildScheduleImage();
    const keyboard = buildKeyboard(getMode(ctx));
    await ctx.replyWithPhoto(
      { source: result.buffer },
      {
        caption,
        ...keyboard,
      }
    );
  } catch (error) {
    console.error('Failed to send schedule image', error);
    await ctx.reply('Не вдалося згенерувати картинку. Спробуйте пізніше 🙏');
  }
}

async function sendSlotsList(ctx: BotContext, service: AvailabilityService, config: AppConfig) {
  const grouped = await service.listSlotsGrouped();
  if (!grouped.length) {
    await ctx.reply('Поки що все зайнято.');
    return;
  }

  const lines = grouped.map((group) => {
    const dayLabel = formatAdminDate(group.iso, config);
    const slotsText = group.slots
      .map((slot) => `• ${slot.startTime} – ${slot.endTime}`)
      .join('\n');
    return `📅 ${dayLabel}\n${slotsText}`;
  });

  await ctx.reply(lines.join('\n\n'));
}

async function promptClearDay(ctx: BotContext, service: AvailabilityService, config: AppConfig) {
  const grouped = await service.listSlotsGrouped();
  if (!grouped.length) {
    await ctx.reply('Немає що чистити 😉');
    return;
  }

  const buttons = grouped.map((group) =>
    Markup.button.callback(formatAdminDate(group.iso, config), `admin:clear:${group.iso}`)
  );

  await ctx.reply(
    'Який день очистити від вільних слотів?',
    Markup.inlineKeyboard(splitIntoRows(buttons, 2).concat([[Markup.button.callback('Скасувати', 'admin:clear:cancel')]]))
  );
}

function splitIntoRows<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function formatAdminDate(dateISO: string, config: AppConfig): string {
  const date = toDateAtTime(dateISO, '00:00', config.schedule.timeZone);
  return formatDate(date, config.schedule.timeZone);
}

async function switchMode(ctx: BotContext, mode: Mode, config: AppConfig) {
  if (mode === 'admin' && !isAdmin(ctx.from?.id, config.adminIds)) {
    await ctx.reply('Режим адміністратора доступний тільки власникам.');
    return;
  }
  getBotSession(ctx).mode = mode;
  const text =
    mode === 'admin'
      ? 'Режим адміністратора активовано. Можете керувати слотами нижче.'
      : 'Режим клієнта активовано. Бачите розклад і контакти для бронювання.';

  await ctx.reply(text, buildKeyboard(mode));
  if (mode === 'client') {
    await ctx.reply(CLIENT_INFO_TEXT);
  }
}

function getMode(ctx: BotContext): Mode {
  const session = getBotSession(ctx);
  if (!session.mode) {
    session.mode = 'client';
  }
  return session.mode;
}

function buildKeyboard(mode: Mode) {
  const rows: string[][] = [MODE_TOGGLE_ROW];
  if (mode === 'admin') {
    rows.push(...ADMIN_MENU);
  } else {
    rows.push(...CLIENT_MENU);
  }
  return Markup.keyboard(rows).resize();
}

function getBotSession(ctx: BotContext) {
  return ctx.session as typeof ctx.session & { mode?: Mode };
}
