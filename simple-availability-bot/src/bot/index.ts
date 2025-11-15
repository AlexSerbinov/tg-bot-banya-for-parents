import { Telegraf, Markup, Scenes, session } from 'telegraf';
import type { MiddlewareFn } from 'telegraf';
import { AppConfig, AvailabilitySlot } from '../types';
import { AvailabilityService } from '../services/availabilityService';
import { createAddSlotScene, ADD_SLOT_SCENE_ID } from './addSlotScene';
import { formatDate, toDateAtTime, formatDateShort } from '../utils/time';
import { BotContext, BotSession } from './types';
import { UserStore } from '../storage/userStore';
import { SettingsStore } from '../storage/settingsStore';
import { toZonedTime } from 'date-fns-tz';
import { format } from 'date-fns';
import { uk } from 'date-fns/locale';

type Mode = 'client' | 'admin';

const ADMIN_MENU = [
  ['➕ Додати слот', '🧹 Очистити день'],
  ['📢 Розсилка', '🖼 Показати розклад'],
  ['⚙️ Налаштування'],
];

const CLIENT_MENU = [
  ['🗓 Показати розклад', 'ℹ️ Інформація'],
  ['📞 Контакти'],
];

export function createBot(
  config: AppConfig,
  service: AvailabilityService,
  userStore: UserStore,
  settingsStore: SettingsStore
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
    const clientInfo = await settingsStore.getClientInfoText();
    await ctx.reply(clientInfo);
    await ctx.reply(config.contactMessage);
  });

  bot.hears('🎫 Режим клієнта', async (ctx) => {
    await switchMode(ctx, 'client', config, settingsStore);
  });

  bot.hears('🛠 Режим адміністратора', async (ctx) => {
    await switchMode(ctx, 'admin', config, settingsStore);
  });

  bot.command('admin', onlyAdmin(config, async (ctx) => {
    await switchMode(ctx, 'admin', config, settingsStore);
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
    const session = getBotSession(ctx);
    session.scheduleWeekOffset = 0;
    await sendScheduleImageWithButton(ctx, service, 0, false, false);
  });

  bot.hears('ℹ️ Інформація', async (ctx) => {
    const clientInfo = await settingsStore.getClientInfoText();
    await ctx.reply(clientInfo);
  });

  bot.hears('📞 Контакти', async (ctx) => {
    await ctx.reply(config.contactMessage);
  });

  bot.hears('🖼 Показати розклад', onlyAdmin(config, async (ctx) => {
    const session = getBotSession(ctx);
    session.scheduleWeekOffset = 0;
    await sendScheduleImageWithButton(ctx, service, 0, false, true);
  }));

  bot.hears('➕ Додати слот', onlyAdmin(config, async (ctx) => {
    console.log('[➕ Додати слот] Button pressed');
    console.log('[➕ Додати слот] Current scene:', ctx.scene.current);
    await ctx.scene.enter(ADD_SLOT_SCENE_ID);
    console.log('[➕ Додати слот] Scene entered');
  }));

  bot.hears('🧹 Очистити день', onlyAdmin(config, async (ctx) => {
    console.log('[🧹 Очистити день] Button pressed');
    await promptClearDay(ctx, service, config);
  }));

  bot.hears('📢 Розсилка', onlyAdmin(config, async (ctx) => {
    await startBroadcastFlow(ctx);
  }));

  bot.hears('⚙️ Налаштування', onlyAdmin(config, async (ctx) => {
    await showSettingsMenu(ctx, settingsStore);
  }));

  bot.action('settings:show:clientinfo', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    const currentText = await settingsStore.getClientInfoText();
    await ctx.editMessageText(
      '📄 Інформаційний текст для клієнтів:\n\n' +
      '━━━━━━━━━━━━━━\n' +
      currentText + '\n' +
      '━━━━━━━━━━━━━━',
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Редагувати текст', 'settings:edit:clientinfo')],
        [Markup.button.callback('⬅️ Вийти в головне меню', 'settings:back')]
      ])
    );
  }));

  bot.action('settings:edit:clientinfo', onlyAdminAction(config, async (ctx) => {
    const session = getBotSession(ctx);
    session.editingSettings = 'clientInfoText';
    await ctx.answerCbQuery();
    // Залишаємо попередній текст і відправляємо нове повідомлення
    await ctx.reply(
      '✏️ Редагування інформаційного тексту для клієнтів\n\n' +
      'Надішліть новий текст одним повідомленням.',
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Назад до налаштувань', 'settings:back:to:text')],
        [Markup.button.callback('❌ Скасувати', 'settings:cancel:edit')]
      ])
    );
  }));

  bot.action('settings:back:to:text', onlyAdminAction(config, async (ctx) => {
    const session = getBotSession(ctx);
    session.editingSettings = undefined;
    await ctx.answerCbQuery();
    const currentText = await settingsStore.getClientInfoText();
    await ctx.reply(
      '📄 Інформаційний текст для клієнтів:\n\n' +
      '━━━━━━━━━━━━━━\n' +
      currentText + '\n' +
      '━━━━━━━━━━━━━━',
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Редагувати текст', 'settings:edit:clientinfo')],
        [Markup.button.callback('⬅️ Вийти в головне меню', 'settings:back')]
      ])
    );
  }));

  bot.action('settings:cancel:edit', onlyAdminAction(config, async (ctx) => {
    const session = getBotSession(ctx);
    session.editingSettings = undefined;
    await ctx.answerCbQuery('Скасовано');
    await ctx.editMessageText('❌ Редагування скасовано');
  }));

  bot.action('settings:back', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  }));

  bot.action(/^admin:clear:(\d{4}-\d{2}-\d{2})$/, onlyAdminAction(config, async (ctx) => {
    const iso = ctx.match[1];
    const removed = await service.clearDay(iso);
    await ctx.answerCbQuery(removed ? 'Прибрали' : 'Слотів не було');
    await ctx.editMessageText(
      removed
        ? `✅ Прибрано ${removed} слот(и) на ${formatAdminDate(iso, config)}`
        : `На ${formatAdminDate(iso, config)} й так нічого не було`
    );
  }));

  bot.action('admin:clear:cancel', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery('Скасовано');
    await ctx.editMessageText('Гаразд, нічого не чистимо 👍');
  }));

  bot.action('admin:clear:all', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '⚠️ Точно очистити всі дні?\n\nЦе видалить всі вільні слоти!',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Так, очистити все', 'admin:clear:all:confirm'),
          Markup.button.callback('❌ Ні, скасувати', 'admin:clear:cancel'),
        ],
      ])
    );
  }));

  bot.action('admin:clear:all:confirm', onlyAdminAction(config, async (ctx) => {
    const grouped = await service.listSlotsGrouped();
    let totalRemoved = 0;
    for (const group of grouped) {
      const removed = await service.clearDay(group.iso);
      totalRemoved += removed;
    }
    await ctx.answerCbQuery('Очищено');
    await ctx.editMessageText(
      totalRemoved > 0
        ? `✅ Прибрано всього ${totalRemoved} слот(ів) з усіх днів`
        : 'Слотів не було'
    );
  }));

  bot.action('slot:add:done', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  }));

  bot.action('admin:show:all:slots', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await showSlotsOverview(ctx, service, config);
  }));

  bot.action(/^schedule:week:(next|prev)$/, async (ctx) => {
    const direction = ctx.match[1];
    const session = getBotSession(ctx);
    const currentOffset = session.scheduleWeekOffset || 0;

    if (direction === 'next') {
      session.scheduleWeekOffset = currentOffset + 1;
    } else {
      session.scheduleWeekOffset = Math.max(0, currentOffset - 1);
    }

    await ctx.answerCbQuery();
    const showAllSlots = isAdmin(ctx.from?.id, config.adminIds);
    await sendScheduleImageWithButton(ctx, service, session.scheduleWeekOffset, true, showAllSlots);
  });

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
      '━━━━━━━━━━━━━━━\n\n' +
      `${draft}\n\n` +
      '━━━━━━━━━━━━━━━';

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

  bot.command('cancel', async (ctx) => {
    const session = getBotSession(ctx);
    if (session.editingSettings) {
      session.editingSettings = undefined;
      await ctx.reply('❌ Редагування скасовано');
      return;
    }
    if (session.awaitingBroadcast) {
      session.awaitingBroadcast = false;
      session.broadcastDraft = undefined;
      await ctx.reply('❌ Розсилку скасовано');
      return;
    }
    await ctx.reply('Немає активних операцій для скасування');
  });

  bot.on('text', async (ctx, next) => {
    const session = getBotSession(ctx);

    if (session.editingSettings === 'clientInfoText') {
      const newText = ctx.message.text.trim();
      await settingsStore.updateClientInfoText(newText);
      session.editingSettings = undefined;
      await ctx.reply(
        '✅ Інформаційний текст оновлено!\n\n' +
        'Тепер клієнти будуть бачити новий текст при натисканні "ℹ️ Інформація".'
      );
      return;
    }

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

  bot.action(/^slot:view:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const cbData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : 'N/A';
    console.log('[slot:view] Callback data:', cbData);
    console.log('[slot:view] Extracted slotId:', slotId);
    const ok = await showSlotDetail(ctx, service, config, slotId);
    if (!ok) {
      await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
  }));

  bot.action(/^slot:delete:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const removed = await service.removeSlot(slotId);
    if (!removed) {
      await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
      return;
    }
    await showSlotsOverview(ctx, service, config, { edit: true });
    await ctx.answerCbQuery('Слот видалено');
  }));

  bot.action(/^slot:toggle:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
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

  bot.action(/^slot:edit:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const cbData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : 'N/A';
    console.log('[slot:edit] Callback data:', cbData);
    console.log('[slot:edit] Extracted slotId:', slotId);
    await showStartSelection(ctx, service, config, slotId);
  }));

  bot.action(/^slot:edit:start:([^:]+):([0-9]{4})$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const startKey = ctx.match[2];
    const cbData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : 'N/A';
    console.log('[slot:edit:start] Received callback:', cbData);
    console.log('[slot:edit:start] Parsed slotId:', slotId);
    console.log('[slot:edit:start] Parsed startKey:', startKey);
    const startTime = decodeTimeKey(startKey);
    await showEndSelection(ctx, service, config, slotId, startTime);
  }));

  bot.action(/^slot:edit:apply:([^:]+):([0-9]{4}):([0-9]{4})$/, onlyAdminAction(config, async (ctx) => {
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

async function sendScheduleImageWithButton(
  ctx: BotContext,
  service: AvailabilityService,
  weekOffset = 0,
  edit = false,
  showAllSlotsButton = false
) {
  try {
    const result = await service.buildScheduleImage(weekOffset);

    // Отримуємо діапазон дат для caption
    const days = service.getScheduleDays(weekOffset);
    const firstDay = days[0];
    const lastDay = days[days.length - 1];

    // Форматуємо діапазон з абревіатурами днів тижня (2 букви)
    const firstDayOfWeek = format(toZonedTime(firstDay.date, service.timeZone), 'EEEEEE', { locale: uk }).toLowerCase();
    const lastDayOfWeek = format(toZonedTime(lastDay.date, service.timeZone), 'EEEEEE', { locale: uk }).toLowerCase();
    const dateRange = `${formatDateShort(firstDay.date, service.timeZone)}-${formatDateShort(lastDay.date, service.timeZone)}`;

    const caption = `Розклад (${firstDayOfWeek}-${lastDayOfWeek}, ${dateRange}) 👇`;

    const navButtons = [];
    if (weekOffset > 0) {
      navButtons.push(Markup.button.callback('⬅️ Попередній тиждень', 'schedule:week:prev'));
    }
    navButtons.push(Markup.button.callback('Наступний тиждень ➡️', 'schedule:week:next'));

    const keyboard = [navButtons];
    if (showAllSlotsButton) {
      keyboard.push([Markup.button.callback('📋 Показати всі слоти', 'admin:show:all:slots')]);
    }

    if (edit && ctx.callbackQuery && 'message' in ctx.callbackQuery && ctx.callbackQuery.message) {
      // Редагуємо медіа замість видалення повідомлення
      await ctx.editMessageMedia(
        {
          type: 'photo',
          media: { source: result.buffer },
          caption
        },
        {
          reply_markup: {
            inline_keyboard: keyboard
          }
        }
      );
    } else {
      await ctx.replyWithPhoto(
        { source: result.buffer },
        {
          caption,
          reply_markup: {
            inline_keyboard: keyboard
          }
        }
      );
    }
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
  const now = new Date();
  const upcoming = grouped
    .map((group) => ({
      iso: group.iso,
      slots: group.slots.filter((slot) => {
        const end = toDateAtTime(slot.dateISO, slot.endTime, service.timeZone);
        return end > now;
      }),
    }))
    .filter((group) => group.slots.length > 0);

  if (!upcoming.length) {
    const message = 'Поки що актуальних слотів немає.';
    if (options.edit) {
      await ctx.editMessageText(message);
    } else {
      await ctx.reply(message);
    }
    return;
  }

  const text = buildSlotListText(upcoming, config);
  const keyboard = Markup.inlineKeyboard(buildSlotButtons(upcoming, config));

  if (options.edit) {
    await ctx.editMessageText(text, { reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function promptClearDay(ctx: BotContext, service: AvailabilityService, config: AppConfig) {
  console.log('[promptClearDay] Function called');
  const grouped = await service.listSlotsGrouped();
  console.log('[promptClearDay] Found groups:', grouped.length);
  if (!grouped.length) {
    await ctx.reply('Немає що чистити 😉');
    return;
  }

  const buttons = grouped.map((group) =>
    Markup.button.callback(formatAdminDate(group.iso, config), `admin:clear:${group.iso}`)
  );

  const rows = splitIntoRows(buttons, 2);
  rows.push([Markup.button.callback('🗑 Очистити всі дні', 'admin:clear:all')]);
  rows.push([Markup.button.callback('❌ Скасувати', 'admin:clear:cancel')]);

  console.log('[promptClearDay] Sending reply with buttons');
  await ctx.reply(
    'Який день очистити від вільних слотів?',
    Markup.inlineKeyboard(rows)
  );
  console.log('[promptClearDay] Reply sent');
}

function buildSlotListText(
  grouped: Array<{ iso: string; slots: AvailabilitySlot[] }>,
  config: AppConfig
): string {
  const blocks = grouped.map((group) => {
    const dayLabel = formatAdminDate(group.iso, config);
    const slots = group.slots
      .map((slot) => {
        const chanStatus = slot.chanAvailable ? 'З чаном 🟢' : 'Без чану 🔴';
        return `• ${slot.startTime} – ${slot.endTime}\n${chanStatus}`;
      })
      .join('\n');
    return `📅 ${dayLabel}\n${slots}`;
  });
  return ['Оберіть слот, щоб керувати ним:', ...blocks].join('\n\n');
}

function buildSlotButtons(
  grouped: Array<{ iso: string; slots: AvailabilitySlot[] }>,
  config: AppConfig
) {
  return grouped.flatMap((group) =>
    group.slots.map((slot) => {
      const chanIcon = slot.chanAvailable ? ' 🛁' : '';
      return [
        Markup.button.callback(
          `${formatAdminDate(group.iso, config)} • ${slot.startTime} – ${slot.endTime}${chanIcon}`,
          `slot:view:${slot.id}`
        ),
      ];
    })
  );
}

async function showSlotDetail(
  ctx: BotContext,
  service: AvailabilityService,
  config: AppConfig,
  slotId: string,
  notice?: string
): Promise<boolean> {
  console.log('[showSlotDetail] Looking for slotId:', slotId);
  const slot = await service.getSlotById(slotId);
  console.log('[showSlotDetail] Found slot:', slot ? slot.id : 'NOT FOUND');
  if (!slot) {
    return false;
  }

  const chanStatus = slot.chanAvailable ? '🛁 З чаном 🟢' : '🛁 Без чану 🔴';
  const lines = [
    notice ? `ℹ️ ${notice}` : null,
    `📅 ${formatAdminDate(slot.dateISO, config)}`,
    `⏱ ${slot.startTime} – ${slot.endTime}`,
    chanStatus,
    '',
    'Оберіть дію нижче.',
  ].filter(Boolean);

  await ctx.editMessageText(lines.join('\n'), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Редагувати', `slot:edit:${slot.id}`)],
      [Markup.button.callback('🗑 Очистити', `slot:delete:${slot.id}`)],
      [
        Markup.button.callback(
          slot.chanAvailable ? '🚫 Вимкнути чан' : '✅ Увімкнути чан',
          `slot:toggle:${slot.id}`
        ),
      ],
      [Markup.button.callback('⬅️ Назад', 'slot:back')],
    ]).reply_markup,
  });
  return true;
}

async function showStartSelection(
  ctx: BotContext,
  service: AvailabilityService,
  config: AppConfig,
  slotId: string
) {
  console.log('[showStartSelection] Looking for slotId:', slotId);
  const slot = await service.getSlotById(slotId);
  console.log('[showStartSelection] Found slot:', slot ? slot.id : 'NOT FOUND');
  if (!slot) {
    await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
    return;
  }

  // Фільтруємо часи як при створенні слота
  const times = getAvailableTimesForEdit(service, slot.dateISO);

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
  console.log('[showEndSelection] Looking for slotId:', slotId);
  const slot = await service.getSlotById(slotId);
  console.log('[showEndSelection] Found slot:', slot ? slot.id : 'NOT FOUND');
  if (!slot) {
    await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
    return;
  }
  const step = service.getTimeStepMinutes();
  const startMinutes = timeLabelToMinutes(startTime);
  const minDurationMinutes = 120; // Мінімум 2 години
  const times = service
    .getEndTimeOptions()
    .filter((time) => timeLabelToMinutes(time) - startMinutes >= minDurationMinutes);
  if (!times.length) {
    await ctx.answerCbQuery('Немає можливих варіантів завершення', { show_alert: true });
    return;
  }
  const buttons = times.map((time) => {
    const label = time === slot.endTime ? `✅ ${time}` : time;
    return Markup.button.callback(label, `slot:edit:apply:${slot.id}:${encodeTimeKey(startTime)}:${encodeTimeKey(time)}`);
  });
  const rows = splitIntoRows(buttons, 3);
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
  const buttons = times.map((time) => {
    const label = time === selected ? `✅ ${time}` : time;
    return Markup.button.callback(label, buildData(time));
  });
  return splitIntoRows(buttons, 3);
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

function getAvailableTimesForEdit(service: AvailabilityService, dateISO: string): string[] {
  const allTimes = service.getTimeOptions();
  const timeZone = service.timeZone;

  // Отримуємо поточний час у часовій зоні
  const now = new Date();
  const zonedNow = toZonedTime(now, timeZone);
  const todayISO = format(zonedNow, 'yyyy-MM-dd');

  // Обмежуємо останній можливий час початку до 22:00
  const maxStartTime = '22:00';
  const maxStartMinutes = timeLabelToMinutes(maxStartTime);

  let filteredTimes = allTimes.filter((time) => timeLabelToMinutes(time) <= maxStartMinutes);

  // Якщо це сьогоднішній день - фільтруємо минулі часи
  if (dateISO === todayISO) {
    const currentHours = zonedNow.getHours();
    const currentMinutes = zonedNow.getMinutes();
    const currentTotalMinutes = currentHours * 60 + currentMinutes;

    filteredTimes = filteredTimes.filter((time) => {
      const timeMinutes = timeLabelToMinutes(time);
      return timeMinutes >= currentTotalMinutes;
    });
  }

  return filteredTimes;
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

async function switchMode(ctx: BotContext, mode: Mode, config: AppConfig, settingsStore: SettingsStore) {
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
    const clientInfo = await settingsStore.getClientInfoText();
    await ctx.reply(clientInfo);
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
  const rows: string[][] = [];

  // Показуємо тільки кнопку переключення на інший режим
  if (mode === 'admin') {
    rows.push(['🎫 Режим клієнта']);
    rows.push(...ADMIN_MENU);
  } else {
    rows.push(['🛠 Режим адміністратора']);
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

async function showSettingsMenu(ctx: BotContext, settingsStore: SettingsStore) {
  await ctx.reply(
    '⚙️ Налаштування бота\n\n' +
    'Оберіть опцію для налаштування:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📄 Показати інформаційний текст', 'settings:show:clientinfo')],
      [Markup.button.callback('❌ Закрити', 'settings:back')]
    ])
  );
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
async function ensureSceneLeft(ctx: BotContext) {
  if (ctx.scene && ctx.scene.current) {
    await ctx.scene.leave();
  }
}
