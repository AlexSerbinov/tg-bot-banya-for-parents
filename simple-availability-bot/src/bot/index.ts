import { Telegraf, Markup, Scenes, session } from 'telegraf';
import type { MiddlewareFn } from 'telegraf';
import { AppConfig, Booking } from '../types';
import { AvailabilityService } from '../services/availabilityService';
import { createAddSlotScene, ADD_SLOT_SCENE_ID } from './addSlotScene';
import { formatDate, toDateAtTime, formatDateShort } from '../utils/time';
import { BotContext, BotSession } from './types';
import { UserStore } from '../storage/userStore';
import { SettingsStore } from '../storage/settingsStore';
import { toZonedTime } from 'date-fns-tz';
import { format } from 'date-fns';
import { uk } from 'date-fns/locale';
import { PerfLogger } from '../utils/perfLogger';

type Mode = 'client' | 'admin';

const ADMIN_MENU = [
  ['➕ Додати бронювання'],
  ['🖼 Показати розклад', '📋 Показати зайняті слоти'],
  ['📢 Розсилка', '⚙️ Налаштування'],
];

const CLIENT_MENU = [
  ['🖼 Показати розклад', 'ℹ️ Інформація та ціни'],
  ['📞 Контакти'],
];

export function createBot(
  config: AppConfig,
  service: AvailabilityService,
  userStore: UserStore,
  settingsStore: SettingsStore
) {
  const bot = new Telegraf<BotContext>(config.botToken);
  const stage = new Scenes.Stage<BotContext>([
    createAddSlotScene(
      service,
      async (ctx) => {
        try {
          await sendScheduleImageWithButton(ctx, service, settingsStore, 0, false, true);
        } catch (error) {
          console.error('addSlot callback error:', error);
          await ctx.reply('Не вдалося завантажити розклад. Спробуйте ще раз 🙏');
        }
      },
      async (ctx) => {
        try {
          await showBookingsOverview(ctx, service, config);
        } catch (error) {
          console.error('addSlot showBookings callback error:', error);
          await ctx.reply('Не вдалося завантажити слоти. Спробуйте ще раз 🙏');
        }
      },
      async (ctx) => {
        try {
          await startBroadcastFlow(ctx);
        } catch (error) {
          console.error('addSlot broadcast callback error:', error);
          await ctx.reply('Не вдалося відкрити розсилку. Спробуйте ще раз 🙏');
        }
      },
      async (ctx) => {
        try {
          await showSettingsMenu(ctx, settingsStore);
        } catch (error) {
          console.error('addSlot settings callback error:', error);
          await ctx.reply('Не вдалося відкрити налаштування. Спробуйте ще раз 🙏');
        }
      }
    )
  ]);

  bot.use(session());

  // Global performance logging middleware
  bot.use(async (ctx, next) => {
    const updateType = ctx.updateType;
    let label = `UPDATE: ${updateType}`;

    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      label = `ACTION: ${ctx.callbackQuery.data}`;
    } else if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text;
      if (text.startsWith('/')) {
        label = `CMD: ${text.split(' ')[0]}`;
      } else {
        label = `TEXT: ${text.substring(0, 30)}${text.length > 30 ? '...' : ''}`;
      }
    }

    const end = PerfLogger.start(label);
    try {
      await next();
    } finally {
      end();
    }
  });

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
    const end = PerfLogger.start('CMD: /start');
    try {
      console.log('[/start] Command received');
      const initialMode: Mode = isAdmin(ctx.from?.id, config.adminIds) ? 'admin' : 'client';
      getBotSession(ctx).mode = initialMode;

      if (initialMode === 'admin') {
        console.log('[/start] Admin mode');
        await ctx.reply(
          'Вітаю! Режим адміністратора активований. Користуйтеся кнопками нижче.',
          buildKeyboard('admin')
        );
        return;
      }

      console.log('[/start] Client mode - sending welcome');
      await ctx.reply(
        'Ласкаво просимо до нашої бані в Болотні! 🌿',
        buildKeyboard('client')
      );
      console.log('[/start] Client mode - sending info');
      const clientInfo = await settingsStore.getClientInfoText();
      await ctx.reply(clientInfo, Markup.inlineKeyboard([
        [Markup.button.callback('🖼 Показати розклад', 'client:show:schedule')]
      ]));
      console.log('[/start] Completed');
    } finally {
      end();
    }
  });

  // Приховані команди для переключення режимів
  bot.command('admin721966', onlyAdmin(config, async (ctx) => {
    await switchMode(ctx, 'admin', config, settingsStore);
  }));

  bot.command('client721966', onlyAdmin(config, async (ctx) => {
    await switchMode(ctx, 'client', config, settingsStore);
  }));

  bot.command('broadcast', onlyAdmin(config, async (ctx) => {
    await startBroadcastFlow(ctx);
  }));

  bot.command('schedule', async (ctx) => {
    await sendScheduleImage(ctx, service, config, settingsStore);
  });

  bot.command('summary', async (ctx) => {
    const summary = await service.buildAvailableSummary();
    await ctx.reply(summary);
  });

  bot.command('addbooking', onlyAdmin(config, (ctx) => ctx.scene.enter(ADD_SLOT_SCENE_ID)));

  bot.hears('ℹ️ Інформація та ціни', async (ctx) => {
    const clientInfo = await settingsStore.getClientInfoText();
    await ctx.reply(clientInfo, Markup.inlineKeyboard([
      [Markup.button.callback('🖼 Показати розклад', 'client:show:schedule')]
    ]));
  });

  bot.action('client:show:schedule', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getBotSession(ctx);
    session.scheduleWeekOffset = 0;
    try {
      await sendScheduleImageWithButton(ctx, service, settingsStore, 0, false, false);
    } catch (error) {
      console.error('client:show:schedule error:', error);
      await ctx.reply('Не вдалося завантажити розклад. Спробуйте ще раз 🙏');
    }
  });

  bot.hears('📞 Контакти', async (ctx) => {
    await ctx.reply(config.contactMessage);
  });

  bot.hears('🖼 Показати розклад', async (ctx) => {
    const end = PerfLogger.start('HEARS: 🖼 Показати розклад');
    try {
      const session = getBotSession(ctx);
      session.scheduleWeekOffset = 0;
      const showAllSlots = isAdmin(ctx.from?.id, config.adminIds);
      await sendScheduleImageWithButton(ctx, service, settingsStore, 0, false, showAllSlots);
    } catch (error) {
      console.error('hears schedule error:', error);
      await ctx.reply('Не вдалося завантажити розклад. Спробуйте ще раз 🙏');
    } finally {
      end();
    }
  });

  bot.hears('➕ Додати бронювання', onlyAdmin(config, async (ctx) => {
    const end = PerfLogger.start('HEARS: ➕ Додати бронювання');
    try {
      console.log('[➕ Додати бронювання] Button pressed');
      console.log('[➕ Додати бронювання] Current scene:', ctx.scene.current);
      await ctx.scene.enter(ADD_SLOT_SCENE_ID);
      console.log('[➕ Додати бронювання] Scene entered');
    } finally {
      end();
    }
  }));

  // Backward compatibility for users with old keyboard
  bot.hears('➕ Додати слот', onlyAdmin(config, async (ctx) => {
    console.log('[➕ Додати слот] Old button pressed');
    await ctx.reply('Оновлюю меню...', buildKeyboard('admin'));
    await ctx.scene.enter(ADD_SLOT_SCENE_ID);
  }));

  bot.hears('🧹 Очистити день', onlyAdmin(config, async (ctx) => {
    console.log('[🧹 Очистити день] Button pressed');
    await promptClearDay(ctx, service, config);
  }));

  bot.hears('📋 Показати зайняті слоти', onlyAdmin(config, async (ctx) => {
    console.log('[📋 Показати зайняті слоти] Button pressed');
    await showBookingsOverview(ctx, service, config);
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
      currentText + '\n',
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
      currentText + '\n',
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

  bot.action('settings:toggle:unavailable', onlyAdminAction(config, async (ctx) => {
    const newValue = await settingsStore.toggleShowUnavailableSlots();
    await ctx.answerCbQuery(newValue ? 'Показуються' : 'Приховані');
    await showSettingsMenu(ctx, settingsStore, true);
  }));

  bot.action(/^admin:clear:(\d{4}-\d{2}-\d{2})$/, onlyAdminAction(config, async (ctx) => {
    const iso = ctx.match[1];
    await ctx.answerCbQuery();

    // Отримуємо бронювання на цей день
    const grouped = await service.listBookingsGrouped();
    const dayGroup = grouped.find((g) => g.iso === iso);
    const slots = dayGroup?.bookings ?? [];

    // Формуємо список бронювань
    let slotsList = '';
    if (slots.length > 0) {
      slotsList = '\n\nБронювання на цей день:\n' + slots.map((s) => `• ${s.startTime} – ${s.endTime}`).join('\n');
    }

    // Кнопки для видалення окремих слотів
    const slotButtons = slots.map((s) =>
      [Markup.button.callback(`🗑 Видалити ${s.startTime} – ${s.endTime}`, `slot:delete:${s.id}`)]
    );

    await ctx.editMessageText(
      `⚠️ Бажаєте очистити ${formatAdminDate(iso, config)}?${slotsList}\n\nЦе видалить всі бронювання на цей день.`,
      Markup.inlineKeyboard([
        ...slotButtons,
        [
          Markup.button.callback('✅ Очистити день', `admin:clear:confirm:${iso}`),
          Markup.button.callback('❌ Скасувати', 'admin:clear:cancel'),
        ],
      ])
    );
  }));

  bot.action('admin:clear:cancel', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery('Скасовано');
    await ctx.editMessageText('Гаразд, нічого не чистимо 👍');
  }));

  // Підтвердження очищення конкретного дня
  bot.action(/^admin:clear:confirm:(\d{4}-\d{2}-\d{2})$/, onlyAdminAction(config, async (ctx) => {
    const iso = ctx.match[1];
    const removed = await service.clearDay(iso);
    await ctx.answerCbQuery(removed ? 'Очищено' : 'Слотів не було');
    await ctx.editMessageText(
      removed
        ? `✅ Прибрано ${removed} слот(и) на ${formatAdminDate(iso, config)}`
        : `На ${formatAdminDate(iso, config)} й так нічого не було`
    );
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
    const grouped = await service.listBookingsGrouped();
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

  bot.action('admin:clear:day:select', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    const grouped = await service.listBookingsGrouped();

    // Фільтруємо минулі дні (як в showBookingsOverview)
    const now = new Date();
    const upcoming = grouped
      .map((group) => ({
        iso: group.iso,
        bookings: group.bookings.filter((slot) => {
          const end = toDateAtTime(slot.dateISO, slot.endTime, service.timeZone);
          return end > now;
        }),
      }))
      .filter((group) => group.bookings.length > 0);

    if (!upcoming.length) {
      await ctx.editMessageText('Немає що чистити 😉');
      return;
    }

    const buttons = upcoming.map((group) =>
      Markup.button.callback(formatAdminDate(group.iso, config), `admin:clear:day:${group.iso}`)
    );
    const rows = splitIntoRows(buttons, 2);
    rows.push([Markup.button.callback('⬅️ Назад', 'admin:show:all:bookings')]);

    await ctx.editMessageText(
      'Який день очистити від бронювань?',
      Markup.inlineKeyboard(rows)
    );
  }));

  bot.action(/^admin:clear:day:(\d{4}-\d{2}-\d{2})$/, onlyAdminAction(config, async (ctx) => {
    const iso = ctx.match[1];
    await ctx.answerCbQuery();

    // Отримуємо бронювання на цей день
    const grouped = await service.listBookingsGrouped();
    const dayGroup = grouped.find((g) => g.iso === iso);
    const slots = dayGroup?.bookings ?? [];

    // Формуємо список бронювань
    let slotsList = '';
    if (slots.length > 0) {
      slotsList = '\n\nБронювання на цей день:\n' + slots.map((s) => `• ${s.startTime} – ${s.endTime}`).join('\n');
    }

    // Кнопки для видалення окремих слотів
    const slotButtons = slots.map((s) =>
      [Markup.button.callback(`🗑 Видалити ${s.startTime} – ${s.endTime}`, `slot:delete:${s.id}`)]
    );

    await ctx.editMessageText(
      `⚠️ Бажаєте очистити ${formatAdminDate(iso, config)}?${slotsList}\n\nЦе видалить всі бронювання на цей день.`,
      Markup.inlineKeyboard([
        ...slotButtons,
        [
          Markup.button.callback('✅ Очистити день', `admin:clear:day:confirm:${iso}`),
          Markup.button.callback('❌ Скасувати', 'admin:clear:day:select'),
        ],
      ])
    );
  }));

  bot.action(/^admin:clear:day:confirm:(\d{4}-\d{2}-\d{2})$/, onlyAdminAction(config, async (ctx) => {
    const iso = ctx.match[1];
    const removed = await service.clearDay(iso);
    await ctx.answerCbQuery(removed ? 'Очищено' : 'Слотів не було');
    // Повертаємось до списку слотів
    await showBookingsOverview(ctx, service, config, { edit: true });
  }));

  bot.action('admin:clear:all:bookings', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '⚠️ Точно очистити всі бронювання?\n\nЦе видалить всі бронювання!',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Так, очистити все', 'admin:clear:all:bookings:confirm'),
          Markup.button.callback('❌ Ні, скасувати', 'admin:clear:all:bookings:cancel'),
        ],
      ])
    );
  }));

  bot.action('admin:clear:all:bookings:confirm', onlyAdminAction(config, async (ctx) => {
    const grouped = await service.listBookingsGrouped();
    let totalRemoved = 0;
    for (const group of grouped) {
      const removed = await service.clearDay(group.iso);
      totalRemoved += removed;
    }
    await ctx.answerCbQuery('Очищено');
    await ctx.editMessageText(
      totalRemoved > 0
        ? `✅ Прибрано всього ${totalRemoved} слот(ів)`
        : 'Слотів не було'
    );
  }));

  bot.action('admin:clear:all:bookings:cancel', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery('Скасовано');
    await showBookingsOverview(ctx, service, config, { edit: true });
  }));

  bot.action('slot:add:done', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  }));

  bot.action('slot:add:another', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.scene.enter(ADD_SLOT_SCENE_ID);
  }));

  bot.action('slot:show:schedule', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    const session = getBotSession(ctx);
    session.scheduleWeekOffset = 0;
    try {
      await sendScheduleImageWithButton(ctx, service, settingsStore, 0, false, true);
    } catch (error) {
      console.error('slot:show:schedule error:', error);
      await ctx.reply('Не вдалося завантажити розклад. Спробуйте ще раз 🙏');
    }
  }));

  bot.action('admin:show:all:bookings', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await showBookingsOverview(ctx, service, config);
  }));

  // Backward compatibility for old buttons
  bot.action('admin:show:all:slots', onlyAdminAction(config, async (ctx) => {
    await ctx.answerCbQuery();
    await showBookingsOverview(ctx, service, config);
  }));

  bot.action('schedule:refresh', async (ctx) => {
    const end = PerfLogger.start('ACTION: schedule:refresh');
    try {
      const session = getBotSession(ctx);
      const currentOffset = session.scheduleWeekOffset || 0;
      // Не робимо answerCbQuery тут - зробимо після результату
      const result = await sendScheduleImageWithButton(ctx, service, settingsStore, currentOffset, true, false);
      if (result === 'not_modified') {
        await ctx.answerCbQuery('Розклад актуальний ✓');
      } else {
        await ctx.answerCbQuery('Оновлено ✓');
      }
    } catch (error) {
      console.error('schedule:refresh error:', error);
      await ctx.answerCbQuery('Помилка оновлення');
    } finally {
      end();
    }
  });

  bot.action(/^schedule:week:(next|prev)$/, async (ctx) => {
    const end = PerfLogger.start(`ACTION: schedule:week:${ctx.match[1]}`);
    try {
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
      await sendScheduleImageWithButton(ctx, service, settingsStore, session.scheduleWeekOffset, true, showAllSlots);
    } catch (error) {
      console.error('schedule:week error:', error);
      await ctx.reply('Не вдалося завантажити розклад. Спробуйте ще раз 🙏');
    } finally {
      end();
    }
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
      '🔥 Повідомлення від власників бані в Болотні 🔥\n' +
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
        'Тепер клієнти будуть бачити новий текст при натисканні "ℹ️ Інформація та ціни".'
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
    await showBookingsOverview(ctx, service, config, { edit: true });
    await ctx.answerCbQuery();
  }));

  bot.action(/^slot:view:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const cbData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : 'N/A';
    console.log('[slot:view] Callback data:', cbData);
    console.log('[slot:view] Extracted slotId:', slotId);
    const ok = await showBookingDetail(ctx, service, config, slotId);
    if (!ok) {
      await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
  }));

  bot.action(/^slot:delete:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const removed = await service.removeBooking(slotId);
    if (!removed) {
      await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
      return;
    }
    await showBookingsOverview(ctx, service, config, { edit: true });
    await ctx.answerCbQuery('Слот видалено');
  }));

  bot.action(/^slot:toggle:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];

    // Перевіряємо чи є конфлікт
    const check = await service.checkChanConflict(slotId);

    if (!check.canEnable && check.reason) {
      // Перевіряємо чи це ранній час (до 13:00) - показуємо попередження
      if (check.reason.includes('13:00') || check.reason.includes('раніше')) {
        const slot = await service.getBookingById(slotId);
        if (slot) {
          await ctx.answerCbQuery();
          await ctx.editMessageText(
            `⚠️ Ранній час для чану\n\n` +
            `📅 ${formatAdminDate(slot.dateISO, config)}\n` +
            `⏰ ${slot.startTime} – ${slot.endTime}\n\n` +
            `Зазвичай чан доступний з 13:00.\n` +
            `Ви впевнені, що хочете додати чан на такий ранній час?`,
            Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ Так, додати чан', `slot:toggle:early:${slotId}`),
                Markup.button.callback('🟡 Ні, без чану', `slot:view:${slotId}`),
              ],
            ])
          );
          return;
        }
      }
      // Інша помилка - показуємо як alert
      await ctx.answerCbQuery(check.reason, { show_alert: true });
      return;
    }

    if (!check.canEnable && check.conflictBooking) {
      // Попередження про інше бронювання з чаном - але дозволяємо додати
      const conflict = check.conflictBooking;
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `⚠️ Сьогодні вже є чан\n\n` +
        `Чан на: ${conflict.startTime} – ${conflict.endTime}\n\n` +
        `Додати чан і на це бронювання?`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Так, додати', `slot:toggle:confirm:${slotId}`),
            Markup.button.callback('❌ Залишити без чану', `slot:view:${slotId}`),
          ],
        ])
      );
      return;
    }

    // Немає конфліктів - просто toggle
    try {
      await service.toggleChanStatus(slotId);
      const ok = await showBookingDetail(ctx, service, config, slotId, 'Статус чану змінено');
      if (!ok) {
        await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery();
    } catch (error) {
      await ctx.answerCbQuery(error instanceof Error ? error.message : 'Не вдалося змінити слот', { show_alert: true });
    }
  }));

  bot.action(/^slot:toggle:confirm:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    try {
      await service.toggleChanStatus(slotId, true); // force = true
      const ok = await showBookingDetail(ctx, service, config, slotId, 'Чан перенесено');
      if (!ok) {
        await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery('Чан перенесено');
    } catch (error) {
      await ctx.answerCbQuery(error instanceof Error ? error.message : 'Не вдалося змінити слот', { show_alert: true });
    }
  }));

  // Підтвердження чану на ранній час (до 13:00)
  bot.action(/^slot:toggle:early:([^:]+)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    try {
      await service.toggleChanStatus(slotId, true); // force = true для раннього часу
      const ok = await showBookingDetail(ctx, service, config, slotId, 'Чан додано');
      if (!ok) {
        await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery('Чан додано');
    } catch (error) {
      await ctx.answerCbQuery(error instanceof Error ? error.message : 'Не вдалося змінити слот', { show_alert: true });
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

  // Після вибору нового часу - показуємо вибір чану
  bot.action(/^slot:edit:apply:([^:]+):([0-9]{4}):([0-9]{4})$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const startKey = ctx.match[2];
    const endKey = ctx.match[3];
    const startTime = decodeTimeKey(startKey);
    const endTime = decodeTimeKey(endKey);

    const slot = await service.getBookingById(slotId);
    if (!slot) {
      await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
      return;
    }

    // Перевіряємо чи чан можливий для нового часу (тільки проблеми з розігрівом блокують)
    const chanCheck = await service.isChanHeatingPossible(slot.dateISO, startTime);
    const isHeatingProblem = !chanCheck.possible &&
      chanCheck.reason !== 'Чан вже заброньовано на цей день' &&
      chanCheck.reason !== 'Чан доступний тільки з 13:00';

    await ctx.answerCbQuery();

    const text = [
      '✏️ Редагування слота',
      `📅 ${formatAdminDate(slot.dateISO, config)}`,
      `⏱ Новий час: ${startTime} – ${endTime}`,
      '',
      isHeatingProblem ? `⚠️ ${chanCheck.reason}` : 'Чи це бронювання з чаном? 🛁',
    ].join('\n');

    const buttons = [];
    if (!isHeatingProblem) {
      buttons.push([
        Markup.button.callback('🔵 Так, з чаном', `slot:edit:final:${slotId}:${startKey}:${endKey}:yes`),
        Markup.button.callback('🟡 Без чану', `slot:edit:final:${slotId}:${startKey}:${endKey}:no`),
      ]);
    } else {
      buttons.push([
        Markup.button.callback('✅ Зберегти без чану', `slot:edit:final:${slotId}:${startKey}:${endKey}:no`),
      ]);
    }
    buttons.push([Markup.button.callback('⬅️ Назад', `slot:edit:start:${slotId}:${startKey}`)]);

    await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
  }));

  // Фінальне застосування змін з чаном
  bot.action(/^slot:edit:final:([^:]+):([0-9]{4}):([0-9]{4}):(yes|no)$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const startKey = ctx.match[2];
    const endKey = ctx.match[3];
    const startTime = decodeTimeKey(startKey);
    const endTime = decodeTimeKey(endKey);
    const withChan = ctx.match[4] === 'yes';

    // Якщо хочуть чан на ранній час - показуємо попередження
    if (withChan) {
      const startMinutes = timeLabelToMinutes(startTime);
      const chanStartMinutes = 13 * 60; // 13:00
      if (startMinutes < chanStartMinutes) {
        const slot = await service.getBookingById(slotId);
        if (!slot) {
          await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
          return;
        }

        await ctx.answerCbQuery();
        const text = [
          '⚠️ Ранній час для чану',
          '',
          `📅 ${formatAdminDate(slot.dateISO, config)}`,
          `⏰ Час: ${startTime} – ${endTime}`,
          '',
          'Зазвичай чан доступний з 13:00.',
          'Ви впевнені, що хочете бронювання з чаном на такий ранній час?',
        ].join('\n');

        await ctx.editMessageText(text, Markup.inlineKeyboard([
          [
            Markup.button.callback('🔵 Так, з чаном', `slot:edit:confirm:early:${slotId}:${startKey}:${endKey}`),
            Markup.button.callback('🟡 Без чану', `slot:edit:final:${slotId}:${startKey}:${endKey}:no`),
          ],
          [Markup.button.callback('⬅️ Назад', `slot:edit:apply:${slotId}:${startKey}:${endKey}`)],
        ]));
        return;
      }
    }

    try {
      // Оновлюємо час та чан
      await service.updateBookingTimes(slotId, startTime, endTime);
      if (withChan) {
        // Якщо хочуть чан - перевіряємо і додаємо
        const slot = await service.getBookingById(slotId);
        if (slot && !slot.withChan) {
          await service.toggleChanStatus(slotId, true); // force = true
        }
      } else {
        // Якщо не хочуть чан - прибираємо
        const slot = await service.getBookingById(slotId);
        if (slot && slot.withChan) {
          await service.toggleChanStatus(slotId);
        }
      }

      const ok = await showBookingDetail(ctx, service, config, slotId, 'Бронювання оновлено');
      if (!ok) {
        await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery('Збережено');
    } catch (error) {
      await ctx.answerCbQuery(error instanceof Error ? error.message : 'Не вдалося оновити слот', {
        show_alert: true,
      });
    }
  }));

  // Підтвердження раннього чану при редагуванні
  bot.action(/^slot:edit:confirm:early:([^:]+):([0-9]{4}):([0-9]{4})$/, onlyAdminAction(config, async (ctx) => {
    const slotId = ctx.match[1];
    const startTime = decodeTimeKey(ctx.match[2]);
    const endTime = decodeTimeKey(ctx.match[3]);

    try {
      // Оновлюємо час
      await service.updateBookingTimes(slotId, startTime, endTime);
      // Додаємо чан з force = true (для раннього часу)
      const slot = await service.getBookingById(slotId);
      if (slot && !slot.withChan) {
        await service.toggleChanStatus(slotId, true);
      }

      const ok = await showBookingDetail(ctx, service, config, slotId, 'Бронювання оновлено');
      if (!ok) {
        await ctx.answerCbQuery('Слот не знайдено', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery('Збережено');
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
  config: AppConfig,
  settingsStore: SettingsStore,
  caption = 'Актуальний розклад 👇'
) {
  const end = PerfLogger.start('FUNC: sendScheduleImage');
  try {
    const showUnavailable = await settingsStore.getShowUnavailableSlots();
    const result = await service.buildScheduleImage(0, showUnavailable);
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
  } finally {
    end();
  }
}

async function sendScheduleImageWithButton(
  ctx: BotContext,
  service: AvailabilityService,
  settingsStore: SettingsStore,
  weekOffset = 0,
  edit = false,
  showAllSlotsButton = false
): Promise<'success' | 'not_modified'> {
  const end = PerfLogger.start('FUNC: sendScheduleImageWithButton');
  try {
    const showUnavailable = await settingsStore.getShowUnavailableSlots();
    const result = await service.buildScheduleImage(weekOffset, showUnavailable);

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
      keyboard.push([Markup.button.callback('📋 Показати всі зайняті слоти', 'admin:show:all:bookings')]);
    } else {
      // Для клієнтів - кнопка оновити
      keyboard.push([Markup.button.callback('🔄 Оновити розклад', 'schedule:refresh')]);
    }

    if (edit && ctx.callbackQuery && 'message' in ctx.callbackQuery && ctx.callbackQuery.message) {
      // Редагуємо медіа замість видалення повідомлення
      try {
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
      } catch (editError: unknown) {
        // Перевіряємо чи це помилка "message is not modified"
        const errorMessage = editError instanceof Error ? editError.message : String(editError);
        if (errorMessage.includes('message is not modified')) {
          return 'not_modified';
        }
        throw editError;
      }
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
    return 'success';
  } catch (error) {
    console.error('Failed to send schedule image', error);
    throw error;
  } finally {
    end();
  }
}

async function showBookingsOverview(
  ctx: BotContext,
  service: AvailabilityService,
  config: AppConfig,
  options: { edit?: boolean } = {}
) {
  const end = PerfLogger.start('FUNC: showBookingsOverview');
  const grouped = await service.listBookingsGrouped();
  console.log(`[showBookingsOverview] Got ${grouped.length} groups`);
  const now = new Date();
  const upcoming = grouped
    .map((group) => ({
      iso: group.iso,
      bookings: group.bookings.filter((slot) => {
        const end = toDateAtTime(slot.dateISO, slot.endTime, service.timeZone);
        return end > now;
      }),
    }))
    .filter((group) => group.bookings.length > 0);

  if (!upcoming.length) {
    const message = 'Поки що актуальних бронювань немає.';
    if (options.edit) {
      await ctx.editMessageText(message);
    } else {
      await ctx.reply(message);
    }
    return;
  }

  const text = buildBookingListText(upcoming, config);
  const keyboard = Markup.inlineKeyboard(buildBookingButtons(upcoming, config));

  if (options.edit) {
    await ctx.editMessageText(text, { reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, keyboard);
  }
  end();
}

async function promptClearDay(ctx: BotContext, service: AvailabilityService, config: AppConfig) {
  console.log('[promptClearDay] Function called');
  const grouped = await service.listBookingsGrouped();
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
    'Який день очистити від бронювань?',
    Markup.inlineKeyboard(rows)
  );
  console.log('[promptClearDay] Reply sent');
}

function buildBookingListText(
  grouped: Array<{ iso: string; bookings: Booking[] }>,
  config: AppConfig
): string {
  const blocks = grouped.map((group) => {
    const dayLabel = formatAdminDate(group.iso, config);
    const slots = group.bookings
      .map((slot) => {
        const chanStatus = slot.withChan ? 'З чаном 🔵' : 'Без чану 🟡';
        return `• ${slot.startTime} – ${slot.endTime}\n${chanStatus}`;
      })
      .join('\n');
    return `📅 ${dayLabel}\n${slots}`;
  });
  return ['Оберіть бронювання, щоб керувати ним:', ...blocks].join('\n\n');
}

function buildBookingButtons(
  grouped: Array<{ iso: string; bookings: Booking[] }>,
  config: AppConfig
) {
  const slotButtons = grouped.flatMap((group) =>
    group.bookings.map((slot) => {
      const chanIcon = slot.withChan ? ' 🔵' : ' 🟡';
      return [
        Markup.button.callback(
          `${formatAdminDate(group.iso, config)} • ${slot.startTime} – ${slot.endTime}${chanIcon}`,
          `slot:view:${slot.id}`
        ),
      ];
    })
  );

  // Додаємо кнопки дій внизу
  slotButtons.push([
    Markup.button.callback('🧹 Очистити день', 'admin:clear:day:select'),
    Markup.button.callback('🗑 Видалити всі ', 'admin:clear:all:bookings')
  ]);

  return slotButtons;
}

async function showBookingDetail(
  ctx: BotContext,
  service: AvailabilityService,
  config: AppConfig,
  slotId: string,
  notice?: string
): Promise<boolean> {
  console.log('[showBookingDetail] Looking for slotId:', slotId);
  const slot = await service.getBookingById(slotId);
  console.log('[showBookingDetail] Found slot:', slot ? slot.id : 'NOT FOUND');
  if (!slot) {
    return false;
  }

  const chanStatus = slot.withChan ? '🛁 З чаном 🔵' : '🛁 Без чану 🟡';
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
      [Markup.button.callback('🗑 Видалити', `slot:delete:${slot.id}`)],
      [
        Markup.button.callback(
          slot.withChan ? '🛁 Прибрати чан' : '🛁 Додати чан',
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
  const slot = await service.getBookingById(slotId);
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
  const slot = await service.getBookingById(slotId);
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

async function showSettingsMenu(ctx: BotContext, settingsStore: SettingsStore, edit = false) {
  const showUnavailable = await settingsStore.getShowUnavailableSlots();
  // Кнопка як екшн - показуємо що можна зробити
  const unavailableLabel = showUnavailable
    ? '👁 Не показувати недоступні слоти на графіку'
    : '👁 Показувати недоступні слоти на графіку';

  const text = '⚙️ Налаштування бота\n\n' +
    'Оберіть опцію для налаштування:';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📄 Показати інформаційний текст', 'settings:show:clientinfo')],
    [Markup.button.callback(unavailableLabel, 'settings:toggle:unavailable')],
    [Markup.button.callback('❌ Закрити', 'settings:back')]
  ]);

  if (edit) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function startBroadcastFlow(ctx: BotContext) {
  const session = getBotSession(ctx);
  session.awaitingBroadcast = true;
  session.broadcastDraft = undefined;

  await ctx.reply(
    '📢 Введіть текст повідомлення для розсилки.\n' +
      'Воно буде показане всім користувачам, які колись писали цьому боту..\n' +
      '\n' +
      '(Просто напишіть повідомлення у формі нижче і відправте як звичайне повідомлення)'
  );
}
async function ensureSceneLeft(ctx: BotContext) {
  if (ctx.scene && ctx.scene.current) {
    await ctx.scene.leave();
  }
}
