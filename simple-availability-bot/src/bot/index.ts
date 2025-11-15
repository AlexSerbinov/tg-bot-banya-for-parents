import { Telegraf, Markup, Scenes, session } from 'telegraf';
import type { MiddlewareFn } from 'telegraf';
import { AppConfig, AvailabilitySlot } from '../types';
import { AvailabilityService } from '../services/availabilityService';
import { createAddSlotScene, ADD_SLOT_SCENE_ID } from './addSlotScene';
import { formatDate, toDateAtTime } from '../utils/time';
import { BotContext, BotSession } from './types';
import { UserStore } from '../storage/userStore';

type Mode = 'client' | 'admin';

const MODE_TOGGLE_ROW = ['🎫 Режим клієнта', '🛠 Режим адміністратора'];

const ADMIN_MENU = [
  ['➕ Додати слот', '🧹 Очистити день'],
  ['📋 Всі слоти', '🖼 Показати розклад'],
  ['📢 Розсилка'],
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

export function createBot(
  config: AppConfig,
  service: AvailabilityService,
  userStore: UserStore
) {
  const bot = new Telegraf<BotContext>(config.botToken);
  const stage = new Scenes.Stage<BotContext>([createAddSlotScene(service)]);

  bot.use(session());
  bot.use(async (ctx, next) => {
    if (ctx.from?.id) {
      await userStore.addUser({
        tgId: ctx.from.id,
        firstName: ctx.from.first_name ?? undefined,
        lastName: ctx.from.last_name ?? undefined,
        username: ctx.from.username ?? undefined,
      });
    }
    return next();
  });
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

  bot.command('broadcast', onlyAdmin(config, async (ctx) => {
    await startBroadcastFlow(ctx);
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
    await showSlotsOverview(ctx, service, config);
  }));

  bot.hears('🧹 Очистити день', onlyAdmin(config, async (ctx) => {
    await promptClearDay(ctx, service, config);
  }));

  bot.hears('📢 Розсилка', onlyAdmin(config, async (ctx) => {
    await startBroadcastFlow(ctx);
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

  bot.action('BROADCAST_CONFIRM', onlyAdminAction(config, async (ctx) => {
    const session = getBotSession(ctx);
    const draft = session.broadcastDraft;
    if (!draft) {
      await ctx.answerCbQuery('Немає тексту для розсилки');
      return;
    }
    session.broadcastDraft = undefined;

    await ctx.editMessageText('📤 Розсилка розпочата...');

    const users = await userStore.list();
    let success = 0;
    let failed = 0;
    const formatted =
      '🔥 Повідомлення від власників бані 🔥\n' +
      '━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      `${draft}\n\n` +
      '━━━━━━━━━━━━━━━━━━━━━━';

    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.tgId, formatted);
        success += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
      } catch (error) {
        console.error(`Failed to send broadcast to ${user.tgId}`, error);
        failed += 1;
      }
    }

    await ctx.editMessageText(
      `📢 Розсилка завершена\n\n✅ Надіслано: ${success}\n⚠️ З помилкою: ${failed}`
    );
    await ctx.answerCbQuery();
  }));

  bot.action('BROADCAST_CANCEL', onlyAdminAction(config, async (ctx) => {
    const session = getBotSession(ctx);
    session.broadcastDraft = undefined;
    session.awaitingBroadcast = false;
    await ctx.editMessageText('❌ Розсилку скасовано');
    await ctx.answerCbQuery();
  }));

  bot.on('text', async (ctx, next) => {
    const session = getBotSession(ctx);
    if (session.awaitingBroadcast) {
      const message = ctx.message.text.trim();
      session.broadcastDraft = message;
      session.awaitingBroadcast = false;

      const userCount = await userStore.count();
      await ctx.reply(
        [
          '📢 Попередній перегляд розсилки',
          '━━━━━━━━━━━━━━',
          message,
          '━━━━━━━━━━━━━━',
          `Буде надіслано ${userCount} користувачам.`,
          '',
          'Надіслати?'
        ].join('\n'),
        buildBroadcastConfirmKeyboard()
      );
      return;
    }

    await next();
  });

  bot.action('slot:back', onlyAdminAction(config, async (ctx) => {
    await showSlotsOverview(ctx, service, config, { edit: true });
    await ctx.answerCbQuery();
  }));

  bot.action(/^slot:view:(.+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const ok = await showSlotDetail(ctx, service, config, slotId);
    if (!ok) {
      await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
  }));

  bot.action(/^slot:delete:(.+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const removed = await service.removeSlot(slotId);
    if (!removed) {
      await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
      return;
    }
    await showSlotsOverview(ctx, service, config, { edit: true });
    await ctx.answerCbQuery('Слот видалено');
  }));

  bot.action(/^slot:toggle:(.+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    try {
      await service.toggleChanAvailability(slotId);
      const ok = await showSlotDetail(ctx, service, config, slotId, 'Статус чану змінено');
      if (!ok) {
        await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery();
    } catch (error) {
      await ctx.answerCbQuery('Не вдалося змінити слот', { show_alert: true });
    }
  }));

  bot.action(/^slot:edit:(.+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    await showStartSelection(ctx, service, config, slotId);
  }));

  bot.action(/^slot:edit:start:(.+):([0-9]{4})$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const startKey = ctx.match[2];
    const startTime = decodeTimeKey(startKey);
    await showEndSelection(ctx, service, config, slotId, startTime);
  }));

  bot.action(/^slot:edit:apply:(.+):([0-9]{4}):([0-9]{4})$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const startTime = decodeTimeKey(ctx.match[2]);
    const endTime = decodeTimeKey(ctx.match[3]);
    try {
      await service.updateSlotTimes(slotId, startTime, endTime);
      const ok = await showSlotDetail(ctx, service, config, slotId, 'Слот оновлено');
      if (!ok) {
        await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery();
    } catch (error) {
      await ctx.answerCbQuery(error instanceof Error ? error.message : 'Не вдалося оновити слот', {
        show_alert: true,
      });
    }
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

async function showSlotsOverview(
  ctx: BotContext,
  service: AvailabilityService,
  config: AppConfig,
  options: { edit?: boolean } = {}
) {
  const grouped = await service.listSlotsGrouped();
  if (!grouped.length) {
    if (options.edit) {
      await ctx.editMessageText('Поки що все зайнято.');
    } else {
      await ctx.reply('Поки що все зайнято.');
    }
    return;
  }

  const text = buildSlotListText(grouped, config);
  const keyboard = Markup.inlineKeyboard(buildSlotButtons(grouped, config));

  if (options.edit) {
    await ctx.editMessageText(text, { reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, keyboard);
  }
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

function buildSlotListText(
  grouped: Array<{ iso: string; slots: AvailabilitySlot[] }>,
  config: AppConfig
): string {
  const blocks = grouped.map((group) => {
    const dayLabel = formatAdminDate(group.iso, config);
    const slots = group.slots
      .map((slot) => `• ${slot.startTime} – ${slot.endTime}${slot.chanAvailable ? '' : ' (без чану)'}`)
      .join('\n');
    return `📅 ${dayLabel}\n${slots}`;
  });
  return ['Оберіть слот, щоб керувати ним:', '', ...blocks].join('\n');
}

function buildSlotButtons(
  grouped: Array<{ iso: string; slots: AvailabilitySlot[] }>,
  config: AppConfig
) {
  const rows = grouped.flatMap((group) =>
    group.slots.map((slot) => [
      Markup.button.callback(
        `${formatAdminDate(group.iso, config)} • ${slot.startTime} – ${slot.endTime}`,
        `slot:view:${slot.id}`
      ),
    ])
  );
  return rows;
}

async function showSlotDetail(
  ctx: BotContext,
  service: AvailabilityService,
  config: AppConfig,
  slotId: string,
  notice?: string
): Promise<boolean> {
  const slot = await service.getSlotById(slotId);
  if (!slot) {
    return false;
  }

  const text = formatSlotDetail(slot, config, notice);
  await ctx.editMessageText(text, {
    reply_markup: buildSlotActions(slot).reply_markup,
  });
  return true;
}

function buildSlotActions(slot: AvailabilitySlot) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Редагувати', `slot:edit:${slot.id}`)],
    [Markup.button.callback('🗑 Очистити', `slot:delete:${slot.id}`)],
    [
      Markup.button.callback(
        slot.chanAvailable ? '🚫 Вимкнути чан' : '✅ Увімкнути чан',
        `slot:toggle:${slot.id}`
      ),
    ],
    [Markup.button.callback('⬅️ Назад', 'slot:back')],
  ]);
}

function formatSlotDetail(slot: AvailabilitySlot, config: AppConfig, notice?: string): string {
  const lines = [
    notice ? `ℹ️ ${notice}` : null,
    `📅 ${formatAdminDate(slot.dateISO, config)}`,
    `⏱ ${slot.startTime} – ${slot.endTime}`,
    `🛁 Чан: ${slot.chanAvailable ? 'доступний' : 'недоступний'}`,
    '',
    'Оберіть дію нижче.',
  ].filter(Boolean);
  return lines.join('\n');
}

async function showStartSelection(
  ctx: BotContext,
  service: AvailabilityService,
  config: AppConfig,
  slotId: string
) {
  const slot = await service.getSlotById(slotId);
  if (!slot) {
    await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
    return;
  }
  const times = service.getTimeOptions();
  const rows = buildTimeSelectionKeyboard(times, slot.startTime, (time) =>
    `slot:edit:start:${slot.id}:${encodeTimeKey(time)}`
  );
  rows.push([Markup.button.callback('⬅️ Назад', `slot:view:${slot.id}`)]);
  const text = [
    '✏️ Редагування слота',
    `📅 ${formatAdminDate(slot.dateISO, config)}`,
    `Поточний діапазон: ${slot.startTime} – ${slot.endTime}`,
    '',
    'Оберіть новий час початку:',
  ].join('\n');
  await ctx.editMessageText(text, { reply_markup: Markup.inlineKeyboard(rows).reply_markup });
  await ctx.answerCbQuery();
}

async function showEndSelection(
  ctx: BotContext,
  service: AvailabilityService,
  config: AppConfig,
  slotId: string,
  startTime: string
) {
  const slot = await service.getSlotById(slotId);
  if (!slot) {
    await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
    return;
  }
  const times = service
    .getTimeOptions()
    .filter((time) => timeLabelToMinutes(time) > timeLabelToMinutes(startTime));
  if (!times.length) {
    await ctx.answerCbQuery('Немає можливих варіантів завершення', { show_alert: true });
    return;
  }
  const rows = times.map((time) => {
    const label = time === slot.endTime ? `✅ ${time}` : time;
    return [Markup.button.callback(label, `slot:edit:apply:${slot.id}:${encodeTimeKey(startTime)}:${encodeTimeKey(time)}`)];
  });
  rows.push([Markup.button.callback('⬅️ Назад', `slot:view:${slot.id}`)]);

  const text = [
    '✏️ Редагування слота',
    `📅 ${formatAdminDate(slot.dateISO, config)}`,
    `Новий початок: ${startTime}`,
    `Поточний кінець: ${slot.endTime}`,
    '',
    'Оберіть новий час завершення:',
  ].join('\n');

  await ctx.editMessageText(text, { reply_markup: Markup.inlineKeyboard(rows).reply_markup });
  await ctx.answerCbQuery();
}

function buildTimeSelectionKeyboard(times: string[], selected: string, buildData: (time: string) => string) {
  return times.map((time) => {
    const label = time === selected ? `✅ ${time}` : time;
    return [Markup.button.callback(label, buildData(time))];
  });
}

function encodeTimeKey(time: string): string {
  return time.replace(':', '');
}

function decodeTimeKey(key: string): string {
  return `${key.slice(0, 2)}:${key.slice(2)}`;
}

function timeLabelToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map((n) => parseInt(n, 10));
  return hours * 60 + minutes;
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

function getBotSession(ctx: BotContext): BotSession {
  return ctx.session as BotSession;
}

function buildBroadcastConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Відправити всім', 'BROADCAST_CONFIRM')],
    [Markup.button.callback('❌ Скасувати', 'BROADCAST_CANCEL')],
  ]);
}

async function startBroadcastFlow(ctx: BotContext) {
  const session = getBotSession(ctx);
  session.awaitingBroadcast = true;
  session.broadcastDraft = undefined;

  await ctx.reply(
    '📢 Введіть текст повідомлення для розсилки.\n' +
      'Воно буде показане всім користувачам, які колись писали цьому боту.'
  );
}
