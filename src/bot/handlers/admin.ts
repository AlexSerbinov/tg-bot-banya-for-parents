import { Telegraf } from 'telegraf';
import { BotContext, getSession, setSession } from '../middlewares';
import {
  getBookingConfirmedMessage,
  getBookingRejectedMessage,
} from '../../core/notifications';
import { formatDateTime, formatDate, formatTime, getNextDays, dateToISO, parseISODate } from '../../core/time';
import { getApprovalKeyboard, getRejectionReasonKeyboard, getAdminDateSelectionKeyboard, getAdminDurationKeyboard, getAdminTimeSelectionKeyboard, getAdminBookingConfirmKeyboard } from '../keyboards';
import prisma from '../../db/prismaClient';
import { config } from '../../config';
import { getAvailableSlots } from '../../core/rules';
import { Markup } from 'telegraf';

export function registerAdminHandlers(bot: Telegraf<BotContext>) {
  // Show pending bookings
  bot.hears('📋 Заявки (нові)', async (ctx) => {
    const pendingBookings = await prisma.booking.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    if (pendingBookings.length === 0) {
      await ctx.reply('✅ Немає нових заявок');
      return;
    }

    await ctx.reply(`Знайдено ${pendingBookings.length} нових заявок:`);

    for (const booking of pendingBookings) {
      let message = `🆕 Заявка #${booking.id.slice(0, 8)}

📅 Дата: ${formatDateTime(booking.dateStart, config.timeZone)}
⏱ Тривалість: ${Math.floor(booking.durationMin / 60)} год
👤 Клієнт: ${booking.customerName || 'Не вказано'}
📞 Телефон: ${booking.customerPhone || 'Не вказано'}
📝 Джерело: ${booking.source}`;

      if (booking.note) {
        message += `\n💬 Коментар: ${booking.note}`;
      }

      message += `\n\nОберіть дію:`;

      await ctx.reply(message, getApprovalKeyboard(booking.id));
    }
  });

  // Show all bookings
  bot.hears('📊 Список бронювань', async (ctx) => {
    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ['PENDING', 'CONFIRMED'] },
        dateStart: { gte: new Date() },
      },
      orderBy: { dateStart: 'asc' },
      take: 20,
    });

    if (bookings.length === 0) {
      await ctx.reply('📭 Немає активних бронювань');
      return;
    }

    let message = `📊 Активні бронювання (${bookings.length}):\n\n`;

    for (const booking of bookings) {
      const status =
        booking.status === 'CONFIRMED' ? '✅' : booking.status === 'PENDING' ? '⏳' : '❌';
      const startTime = formatTime(booking.dateStart, config.timeZone);
      const endTime = formatTime(booking.dateEnd, config.timeZone);
      message += `${status} ${formatDate(booking.dateStart, config.timeZone)}, ${startTime} - ${endTime}\n`;
      message += `   ${booking.customerName || 'Не вказано'} - ${
        booking.customerPhone || 'Не вказано'
      }\n\n`;
    }

    await ctx.reply(message);
  });

  // Approve booking
  bot.action(/^APPROVE:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) {
        await ctx.answerCbQuery('Бронювання не знайдено');
        return;
      }

      if (booking.status !== 'PENDING') {
        await ctx.answerCbQuery('Бронювання вже оброблено');
        await ctx.editMessageText(`❌ Бронювання вже ${booking.status}`);
        return;
      }

      // Check for conflicts
      const conflicts = await prisma.booking.findMany({
        where: {
          id: { not: bookingId },
          status: { in: ['CONFIRMED'] },
          OR: [
            {
              AND: [
                { dateStart: { lte: booking.dateStart } },
                { dateEnd: { gt: booking.dateStart } },
              ],
            },
            {
              AND: [
                { dateStart: { lt: booking.dateEnd } },
                { dateEnd: { gte: booking.dateEnd } },
              ],
            },
          ],
        },
      });

      if (conflicts.length > 0) {
        await ctx.answerCbQuery('Конфлікт з іншим бронюванням!');
        await ctx.editMessageText(
          `❌ Не можу підтвердити: конфлікт з іншим бронюванням.\n\nОновіть список заявок.`
        );
        return;
      }

      // Confirm booking
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'CONFIRMED' },
      });

      await ctx.answerCbQuery('✅ Підтверджено!');
      await ctx.editMessageText(
        `✅ Бронювання підтверджено!\n\n${formatDateTime(
          booking.dateStart,
          config.timeZone
        )} (${Math.floor(booking.durationMin / 60)} год)`
      );

      // Notify customer
      if (booking.tgCustomerId) {
        try {
          await bot.telegram.sendMessage(
            booking.tgCustomerId,
            getBookingConfirmedMessage(booking, config.timeZone)
          );
        } catch (error) {
          console.error('Failed to notify customer:', error);
        }
      }
    } catch (error) {
      console.error('Error approving booking:', error);
      await ctx.answerCbQuery('Помилка при підтвердженні');
    }
  });

  // Ask for rejection reason
  bot.action(/^REJECT_ASK:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) {
        await ctx.answerCbQuery('Бронювання не знайдено');
        return;
      }

      if (booking.status !== 'PENDING') {
        await ctx.answerCbQuery('Бронювання вже оброблено');
        return;
      }

      await ctx.editMessageText(
        `❌ Відхилення бронювання

📅 Дата: ${formatDateTime(booking.dateStart, config.timeZone)}
⏱ Тривалість: ${Math.floor(booking.durationMin / 60)} год
👤 Клієнт: ${booking.customerName || 'Не вказано'}

Вкажіть причину відмови:`,
        getRejectionReasonKeyboard(bookingId)
      );
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error asking rejection reason:', error);
      await ctx.answerCbQuery('Помилка');
    }
  });

  // Reject with predefined reason
  bot.action(/^REJECT_REASON:(.+):(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const reasonCode = ctx.match[2];

    // Перетворюємо код причини у повний текст
    const reasonMap: Record<string, string> = {
      'busy': 'Час вже зайнятий',
      'maintenance': 'Технічні роботи',
    };
    const reason = reasonMap[reasonCode] || reasonCode;

    await rejectBookingWithReason(bot, ctx, bookingId, reason);
  });

  // Reject with custom reason
  bot.action(/^REJECT_CUSTOM:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    // Зберігаємо ID бронювання для подальшого використання
    session.awaitingInput = 'rejection_reason';
    session.pendingRejectionBookingId = bookingId;
    setSession(tgId, session);

    await ctx.editMessageText(
      `📝 Введіть причину відмови для клієнта:

(Наприклад: "На жаль, у цей час заплановані технічні роботи")`
    );
    await ctx.answerCbQuery();
  });

  // Back to approval keyboard
  bot.action(/^BACK_TO_APPROVAL:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) {
        await ctx.answerCbQuery('Бронювання не знайдено');
        return;
      }

      await ctx.editMessageText(
        `🆕 Заявка #${booking.id.slice(0, 8)}

📅 Дата: ${formatDateTime(booking.dateStart, config.timeZone)}
⏱ Тривалість: ${Math.floor(booking.durationMin / 60)} год
👤 Клієнт: ${booking.customerName || 'Не вказано'}
📞 Телефон: ${booking.customerPhone || 'Не вказано'}
📝 Джерело: ${booking.source}

Оберіть дію:`,
        getApprovalKeyboard(booking.id)
      );
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error going back to approval:', error);
      await ctx.answerCbQuery('Помилка');
    }
  });

  // Add manual booking - Start flow
  bot.hears('➕ Додати бронювання', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    // Очищуємо попередні дані
    session.adminBookingData = {};
    setSession(tgId, session);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.reply('Помилка завантаження налаштувань');
      return;
    }

    const days = getNextDays(7, settings.timeZone);

    await ctx.reply(
      '➕ Додати бронювання\n\n📅 Крок 1: Оберіть дату',
      getAdminDateSelectionKeyboard(days, 0, 4)
    );
  });

  // Admin manual booking - Week navigation
  bot.action(/^ADMIN_DATES_WEEK\|(\d+)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1], 10);
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });

    if (!settings) {
      await ctx.answerCbQuery('Помилка завантаження налаштувань');
      return;
    }

    const totalDays = getNextDays(7 * (offset + 1), settings.timeZone);
    const startIndex = offset * 7;
    const days = totalDays.slice(startIndex, startIndex + 7);

    await ctx.editMessageText(
      '➕ Додати бронювання\n\n📅 Крок 1: Оберіть дату',
      getAdminDateSelectionKeyboard(days, offset, 4)
    );
    await ctx.answerCbQuery();
  });

  // Admin manual booking - Date selected
  bot.action(/^ADMIN_DATE:(.+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    if (!session.adminBookingData) {
      session.adminBookingData = {};
    }
    session.adminBookingData.dateISO = dateISO;
    setSession(tgId, session);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка');
      return;
    }

    const durations = settings.allowedDurations.split(',').map(d => parseInt(d.trim(), 10));
    const date = parseISODate(dateISO);

    await ctx.editMessageText(
      `➕ Додати бронювання\n\n📅 Дата: ${formatDate(date, settings.timeZone)}\n\n⏱ Крок 2: Оберіть тривалість`,
      getAdminDurationKeyboard(dateISO, durations)
    );
    await ctx.answerCbQuery();
  });

  // Admin manual booking - Duration selected
  bot.action(/^ADMIN_DUR:(.+):(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const duration = parseInt(ctx.match[2], 10);
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    if (!session.adminBookingData) {
      session.adminBookingData = {};
    }
    session.adminBookingData.dateISO = dateISO;
    session.adminBookingData.duration = duration;
    setSession(tgId, session);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка');
      return;
    }

    const date = parseISODate(dateISO);

    await ctx.editMessageText(
      `➕ Додати бронювання\n\n📅 Дата: ${formatDate(date, settings.timeZone)}\n⏱ Тривалість: ${duration} год\n\n🕐 Крок 3: Оберіть час`,
      getAdminTimeSelectionKeyboard(dateISO, duration)
    );
    await ctx.answerCbQuery();
  });

  // Admin manual booking - Time selected
  bot.action(/^ADMIN_TIME:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2}):(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const time = ctx.match[2];
    const duration = parseInt(ctx.match[3], 10);
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    if (!session.adminBookingData) {
      session.adminBookingData = {};
    }
    session.adminBookingData.dateISO = dateISO;
    session.adminBookingData.duration = duration;
    session.adminBookingData.time = time;
    setSession(tgId, session);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка');
      return;
    }

    const date = parseISODate(dateISO);

    // Запитуємо ім'я клієнта
    session.awaitingInput = 'admin_customer_name';
    setSession(tgId, session);

    await ctx.editMessageText(
      `➕ Додати бронювання\n\n📅 Дата: ${formatDate(date, settings.timeZone)}\n⏱ Час: ${time} (${duration} год)\n\n👤 Крок 4: Введіть ім'я клієнта\n\n👇 Напишіть ім'я нижче 👇`
    );
    await ctx.answerCbQuery();
  });

  // Admin manual booking - Cancel
  bot.action('ADMIN_CANCEL', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    session.adminBookingData = undefined;
    session.awaitingInput = undefined;
    setSession(tgId, session);

    await ctx.editMessageText('❌ Додавання бронювання скасовано');
    await ctx.answerCbQuery();
  });

  // Admin manual booking - Back to date
  bot.action('ADMIN_BACK_TO_DATE', async (ctx) => {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка');
      return;
    }

    const days = getNextDays(7, settings.timeZone);

    await ctx.editMessageText(
      '➕ Додати бронювання\n\n📅 Крок 1: Оберіть дату',
      getAdminDateSelectionKeyboard(days, 0, 4)
    );
    await ctx.answerCbQuery();
  });

  // Admin manual booking - Back to time
  bot.action('ADMIN_BACK_TO_TIME', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    if (!session.adminBookingData?.dateISO || !session.adminBookingData?.duration) {
      await ctx.answerCbQuery('Помилка: дані відсутні');
      return;
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка');
      return;
    }

    const { dateISO, duration } = session.adminBookingData;
    const date = parseISODate(dateISO);

    await ctx.editMessageText(
      `➕ Додати бронювання\n\n📅 Дата: ${formatDate(date, settings.timeZone)}\n⏱ Тривалість: ${duration} год\n\n🕐 Крок 3: Оберіть час`,
      getAdminTimeSelectionKeyboard(dateISO, duration)
    );
    await ctx.answerCbQuery();
  });

  // Admin manual booking - Confirm and create
  bot.action('ADMIN_CONFIRM_CREATE', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    if (!session.adminBookingData?.dateISO || !session.adminBookingData?.time || !session.adminBookingData?.duration || !session.adminBookingData?.customerName || !session.adminBookingData?.customerPhone) {
      await ctx.answerCbQuery('Помилка: неповні дані');
      return;
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка');
      return;
    }

    try {
      const { dateISO, time, duration, customerName, customerPhone } = session.adminBookingData;

      // Створюємо дати початку та кінця
      const [hours, minutes] = time.split(':').map(Number);
      const dateStart = parseISODate(dateISO);
      dateStart.setHours(hours, minutes, 0, 0);

      const dateEnd = new Date(dateStart);
      dateEnd.setHours(dateStart.getHours() + duration);

      // Створюємо бронювання зі статусом CONFIRMED
      const booking = await prisma.booking.create({
        data: {
          dateStart,
          dateEnd,
          durationMin: duration * 60,
          status: 'CONFIRMED',
          source: 'ADMIN_MANUAL',
          customerName,
          customerPhone,
          tgCustomerId: null, // Адмін додає вручну, без Telegram ID
        },
      });

      // Очищаємо сесію
      session.adminBookingData = undefined;
      session.awaitingInput = undefined;
      setSession(tgId, session);

      await ctx.editMessageText(
        `✅ Бронювання створено!\n\n📅 Дата: ${formatDate(dateStart, settings.timeZone)}\n⏱ Час: ${time} - ${formatTime(dateEnd, settings.timeZone)}\n👤 Клієнт: ${customerName}\n📞 Телефон: ${customerPhone}`
      );
      await ctx.answerCbQuery('✅ Готово!');
    } catch (error) {
      console.error('Error creating manual booking:', error);
      await ctx.answerCbQuery('Помилка при створенні бронювання');
    }
  });

  // Settings (simplified for MVP)
  bot.hears('⚙️ Налаштування', async (ctx) => {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });

    if (!settings) {
      await ctx.reply('Помилка завантаження налаштувань');
      return;
    }

    const message = `⚙️ Поточні налаштування:

📅 Робочі дні: ${settings.workingDays}
🕐 Початок роботи: ${settings.dayOpenTime}
🕐 Кінець роботи: ${settings.dayCloseTime}
⏱ Доступні тривалості: ${settings.allowedDurations} год
🧹 Буфер прибирання: ${settings.cleaningBufferMin} хв
🌍 Часова зона: ${settings.timeZone}

Редагування налаштувань буде доступне у наступній версії.`;

    await ctx.reply(message);
  });

  // Broadcast - start broadcast flow
  bot.hears('📢 Розсилка', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    // Встановлюємо стан очікування тексту розсилки
    session.awaitingInput = 'broadcast_message';
    setSession(tgId, session);

    await ctx.reply(
      `📢 Розсилка повідомлень\n\n` +
      `Введіть текст повідомлення, яке буде надіслано всім користувачам бота:\n\n` +
      `💡 Наприклад: "Вільний слот сьогодні о 18:00! Встигніть забронювати 🔥"`
    );
  });

  // Handle custom rejection reason input
  bot.on('text', async (ctx, next) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    // Admin manual booking - customer name input
    if (session.awaitingInput === 'admin_customer_name') {
      const customerName = ctx.message.text.trim();

      if (!session.adminBookingData) {
        session.adminBookingData = {};
      }
      session.adminBookingData.customerName = customerName;

      // Тепер запитуємо телефон
      session.awaitingInput = 'admin_customer_phone';
      setSession(tgId, session);

      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!settings) {
        await ctx.reply('Помилка завантаження налаштувань');
        return;
      }

      const { dateISO, time, duration } = session.adminBookingData;
      const date = parseISODate(dateISO!);

      await ctx.reply(
        `➕ Додати бронювання\n\n📅 Дата: ${formatDate(date, settings.timeZone)}\n⏱ Час: ${time} (${duration} год)\n👤 Ім'я: ${customerName}\n\n📞 Крок 5: Введіть телефон клієнта\n\n👇 Напишіть телефон нижче 👇`
      );
      return;
    }

    // Admin manual booking - customer phone input
    if (session.awaitingInput === 'admin_customer_phone') {
      const customerPhone = ctx.message.text.trim();

      if (!session.adminBookingData) {
        await ctx.reply('Помилка: дані бронювання відсутні');
        return;
      }

      session.adminBookingData.customerPhone = customerPhone;
      session.awaitingInput = undefined;
      setSession(tgId, session);

      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!settings) {
        await ctx.reply('Помилка завантаження налаштувань');
        return;
      }

      const { dateISO, time, duration, customerName } = session.adminBookingData;
      const date = parseISODate(dateISO!);

      // Показуємо підтвердження
      await ctx.reply(
        `➕ Додати бронювання\n\n📋 Перевірте дані:\n\n📅 Дата: ${formatDate(date, settings.timeZone)}\n⏱ Час: ${time} (${duration} год)\n👤 Ім'я: ${customerName}\n📞 Телефон: ${customerPhone}\n\n✅ Все правильно?`,
        getAdminBookingConfirmKeyboard()
      );
      return;
    }

    // Broadcast message input
    if (session.awaitingInput === 'broadcast_message') {
      const message = ctx.message.text;

      // Зберігаємо текст розсилки
      session.broadcastMessage = message;
      session.awaitingInput = undefined;
      setSession(tgId, session);

      // Показуємо попередній перегляд
      const { getBroadcastConfirmKeyboard } = await import('../keyboards');

      // Отримуємо кількість користувачів
      const userCount = await prisma.user.count();

      await ctx.reply(
        `📢 Попередній перегляд розсилки\n\n` +
        `Повідомлення:\n━━━━━━━━━━━━━━\n${message}\n━━━━━━━━━━━━━━\n\n` +
        `👥 Буде надіслано ${userCount} користувачам\n\n` +
        `Підтвердіть відправку:`,
        getBroadcastConfirmKeyboard()
      );
      return;
    }

    if (session.awaitingInput === 'rejection_reason' && session.pendingRejectionBookingId) {
      const reason = ctx.message.text;
      const bookingId = session.pendingRejectionBookingId;

      // Скидаємо стан
      session.awaitingInput = undefined;
      session.pendingRejectionBookingId = undefined;
      setSession(tgId, session);

      await rejectBookingWithReason(bot, ctx, bookingId, reason);
      return;
    }

    // Передаємо далі
    await next();
  });

  // Confirm broadcast
  bot.action('BROADCAST_CONFIRM', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    if (!session.broadcastMessage) {
      await ctx.answerCbQuery('Помилка: текст розсилки не знайдено');
      return;
    }

    const message = session.broadcastMessage;

    // Очищаємо сесію
    session.broadcastMessage = undefined;
    setSession(tgId, session);

    await ctx.editMessageText('📤 Розсилка розпочата...');

    // Отримуємо всіх користувачів
    const users = await prisma.user.findMany();

    let successCount = 0;
    let errorCount = 0;

    // Відправляємо повідомлення всім користувачам
    const formattedMessage =
      `🔥 Повідомлення від власників «Баня» 🔥\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${message}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━`;

    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.tgId, formattedMessage);
        successCount++;

        // Невелика затримка, щоб не перевантажити API
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`Failed to send to user ${user.tgId}:`, error);
        errorCount++;
      }
    }

    // Показуємо статистику
    await ctx.reply(
      `✅ Розсилка завершена!\n\n` +
      `📊 Статистика:\n` +
      `✅ Успішно надіслано: ${successCount}\n` +
      `❌ Помилок: ${errorCount}\n` +
      `👥 Всього користувачів: ${users.length}`
    );
  });

  // Cancel broadcast
  bot.action('BROADCAST_CANCEL', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    // Очищаємо сесію
    session.broadcastMessage = undefined;
    setSession(tgId, session);

    await ctx.editMessageText('❌ Розсилку скасовано');
  });
}

async function rejectBookingWithReason(
  bot: Telegraf<BotContext>,
  ctx: any,
  bookingId: string,
  reason: string
) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      await ctx.reply('❌ Бронювання не знайдено');
      return;
    }

    if (booking.status !== 'PENDING') {
      await ctx.reply('⚠️ Бронювання вже оброблено');
      return;
    }

    // Відхиляємо бронювання
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'REJECTED' },
    });

    await ctx.reply(
      `❌ Бронювання відхилено

📅 Дата: ${formatDateTime(booking.dateStart, config.timeZone)}
⏱ Тривалість: ${Math.floor(booking.durationMin / 60)} год
💬 Причина: ${reason}`
    );

    // Надсилаємо повідомлення клієнту з причиною
    if (booking.tgCustomerId) {
      try {
        await bot.telegram.sendMessage(
          booking.tgCustomerId,
          `❌ На жаль, вашу заявку відхилено

📅 Дата: ${formatDateTime(booking.dateStart, config.timeZone)}
⏱ Тривалість: ${Math.floor(booking.durationMin / 60)} год

💬 Причина: ${reason}

Будь ласка, оберіть інший час або зв'яжіться з нами:
📞 ${config.contacts.svitlana.name}: ${config.contacts.svitlana.phone}
📞 ${config.contacts.stanislav.name}: ${config.contacts.stanislav.phone}`
        );
      } catch (error) {
        console.error('Failed to notify customer about rejection:', error);
      }
    }
  } catch (error) {
    console.error('Error rejecting booking with reason:', error);
    await ctx.reply('❌ Помилка при відхиленні бронювання');
  }
}
