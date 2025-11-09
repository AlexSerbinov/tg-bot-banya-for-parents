import { Telegraf, Markup } from 'telegraf';
import { performance } from 'node:perf_hooks';
import type { Settings } from '@prisma/client';
import { BotContext, getSession, setSession } from '../middlewares';
import {
  getDateSelectionKeyboard,
  getDurationKeyboard,
  getSlotsKeyboard,
  getBookingConfirmKeyboard,
  getContactsKeyboard,
  getPhoneRequestKeyboard,
  getPhoneConfirmKeyboard,
  getMainMenuKeyboard,
  getAdminMenuKeyboard,
  getScheduleNavigationKeyboard,
  getBookingSubmittedKeyboard,
  getBookingKeyboard,
  getBookingKeyboardWithComment,
  getUserBookingsKeyboard,
  getBookingManagementUserKeyboard,
} from '../keyboards';
import {
  getNextDays,
  formatDate,
  formatTime,
  toDateAtTime,
  dateToISO,
} from '../../core/time';
import { generateSlots } from '../../core/rules';
import { getContactsMessage, getBookingPendingMessage, getWelcomeMessage, getAdminWelcomeMessage } from '../../core/notifications';
import prisma from '../../db/prismaClient';
import { config } from '../../config';
import { generateWeeklyScheduleImage } from '../../core/scheduleImage';

const MAX_WEEK_OFFSET = 4;

// Function to clean up old bookings (older than 1 hour after visit)
export async function cleanupOldBookings() {
  try {
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    const deletedBookings = await prisma.booking.deleteMany({
      where: {
        dateEnd: { lt: oneHourAgo },
        status: { in: ['CONFIRMED', 'CANCELLED'] }
      }
    });

    if (deletedBookings.count > 0) {
      console.log(`🧹 Cleaned up ${deletedBookings.count} old bookings`);
    }
  } catch (error) {
    console.error('Error cleaning up old bookings:', error);
  }
}

// Schedule cleanup to run every hour
setInterval(cleanupOldBookings, 60 * 60 * 1000); // Run every hour

export function registerCustomerHandlers(bot: Telegraf<BotContext>) {
  // View available slots
  bot.hears('📅 Переглянути вільні слоти', async (ctx) => {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.reply('Налаштування не знайдені. Спробуйте пізніше.');
      return;
    }

    try {
      const schedule = await buildWeeklySchedulePayload(0, settings);
      const caption = buildScheduleCaption(schedule.days, schedule.stats, settings.timeZone);
      const keyboard = getScheduleNavigationKeyboard(0, MAX_WEEK_OFFSET);

      // Перевіряємо, чи buffer не пустий
      if (schedule.buffer && schedule.buffer.length > 0) {
        await ctx.replyWithPhoto(
          { source: schedule.buffer },
          {
            caption,
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          }
        );
      } else {
        console.warn('Schedule image buffer is empty, sending text instead');
        const selectionDays = getNextDays(7, settings.timeZone);
        await ctx.reply('Не вдалося згенерувати візуальний розклад.\n\nОберіть дату:', getDateSelectionKeyboard(selectionDays, 0, MAX_WEEK_OFFSET));
      }
    } catch (error) {
      console.error('Failed to generate schedule image:', error);
      // Якщо не вдалося згенерувати картинку, показуємо список дат
      const selectionDays = getNextDays(7, settings.timeZone);
      await ctx.reply('Не вдалося згенерувати візуальний розклад.\n\nОберіть дату:', getDateSelectionKeyboard(selectionDays, 0, MAX_WEEK_OFFSET));
    }
  });

  bot.action(/^SCHEDULE_WEEK\|(\d+)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1], 10);
    if (Number.isNaN(offset) || offset < 0 || offset > MAX_WEEK_OFFSET) {
      await ctx.answerCbQuery('Цей тиждень недоступний');
      return;
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    try {
      const schedule = await buildWeeklySchedulePayload(offset, settings);
      const caption = buildScheduleCaption(schedule.days, schedule.stats, settings.timeZone);
      const keyboard = getScheduleNavigationKeyboard(offset, MAX_WEEK_OFFSET);

      await ctx.editMessageMedia(
        {
          type: 'photo',
          media: { source: schedule.buffer },
          caption,
          parse_mode: 'Markdown',
        },
        { reply_markup: keyboard.reply_markup }
      );
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Failed to paginate schedule image:', error);
      await ctx.answerCbQuery('Не вдалося оновити тиждень');
    }
  });

  bot.action('SHOW_DATES', async (ctx) => {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    const days = getNextDays(7, settings.timeZone);
    await ctx.reply('Оберіть дату:', getDateSelectionKeyboard(days, 0, MAX_WEEK_OFFSET));
    await ctx.answerCbQuery();
  });

  // Navigate weeks in date list
  bot.action(/^DATES_WEEK\|(\d+)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1], 10);
    if (Number.isNaN(offset) || offset < 0 || offset > MAX_WEEK_OFFSET) {
      await ctx.answerCbQuery('Цей тиждень недоступний');
      return;
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    const totalDays = getNextDays(7 * (offset + 1), settings.timeZone);
    const startIndex = offset * 7;
    const days = totalDays.slice(startIndex, startIndex + 7);

    await ctx.editMessageText(
      'Оберіть дату:',
      getDateSelectionKeyboard(days, offset, MAX_WEEK_OFFSET)
    );
    await ctx.answerCbQuery();
  });

  // Show contacts
  bot.hears('📞 Контакти власників', async (ctx) => {
    await ctx.reply(getContactsMessage(), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '« Назад', callback_data: 'BACK_TO_MAIN' }],
        ],
      },
    });
  });

  // Date selection callback
  bot.action(/^DATE:(.+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });

    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    const durations = settings.allowedDurations
      .split(',')
      .map((n) => parseInt(n.trim(), 10));

    const dayDate = toDateAtTime(dateISO, '12:00', settings.timeZone);

    await ctx.editMessageText(
      `📅 Дата: ${formatDate(dayDate, settings.timeZone)}\n\nОберіть тривалість:`,
      getDurationKeyboard(dateISO, durations)
    );
    await ctx.answerCbQuery();
  });

  // Duration selection callback
  bot.action(/^DUR:(.+):(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const duration = parseInt(ctx.match[2], 10);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    // Get bookings for that day
    const dayStart = toDateAtTime(dateISO, '00:00', settings.timeZone);
    const dayEnd = toDateAtTime(dateISO, '23:59', settings.timeZone);

    const bookings = await prisma.booking.findMany({
      where: {
        dateStart: { gte: dayStart, lte: dayEnd },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });

    const slots = generateSlots(dateISO, settings, bookings);
    const relevantSlots = slots.filter((s) => s.durationHours === duration);

    if (relevantSlots.length === 0) {
      try {
        await ctx.editMessageText(
          `❌ На жаль, немає вільних слотів на ${formatDate(
            new Date(dateISO),
            config.timeZone
          )} тривалістю ${duration} год.\n\nОберіть іншу тривалість або дату.`,
          getDurationKeyboard(dateISO, settings.allowedDurations.split(',').map(Number))
        );
      } catch (error) {
        // Якщо не вдалося відредагувати повідомлення (наприклад, воно вже змінене),
        // надсилаємо нове повідомлення
        await ctx.reply(
          `❌ На жаль, немає вільних слотів на ${formatDate(
            new Date(dateISO),
            config.timeZone
          )} тривалістю ${duration} год.\n\nОберіть іншу тривалість або дату.`,
          getDurationKeyboard(dateISO, settings.allowedDurations.split(',').map(Number))
        );
      }
      await ctx.answerCbQuery();
      return;
    }

    const slotDayDate = toDateAtTime(dateISO, '12:00', settings.timeZone);

    await ctx.editMessageText(
      `Вільні слоти на ${formatDate(slotDayDate, settings.timeZone)} (${duration} год):`,
      getSlotsKeyboard(relevantSlots, dateISO, duration, settings.timeZone, 0)
    );
    await ctx.answerCbQuery();
  });

  // Slot selection callback
  bot.action(/^SLOT\|(.+)\|(.+)\|(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const time = ctx.match[2];
    const duration = parseInt(ctx.match[3], 10);

    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);
    const user = await prisma.user.findUnique({ where: { tgId } });

    // Store booking data in session
    session.bookingData = { dateISO, time, duration };
    setSession(tgId, session);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    console.log('SLOT DEBUG:', { dateISO, time, duration, tz: settings.timeZone });
    const slotStart = toDateAtTime(dateISO, time, settings.timeZone);
    console.log('SLOT START:', slotStart);

    // Якщо у користувача вже є номер телефону, показуємо підтвердження номера
    if (user?.phone) {
      await ctx.editMessageText(
        `📅 Дата: ${formatDate(slotStart, settings.timeZone)}
⏱ Час: ${time} (${duration} год)

📱 Ваш номер телефону: ${user.phone}

Бажаєте залишити цей номер чи ввести новий?`,
        getPhoneConfirmKeyboard(dateISO, time, duration)
      );
      await ctx.answerCbQuery();
    } else {
      // Якщо немає телефону, запитуємо його
      await ctx.deleteMessage();
      await ctx.reply(
        `📅 Дата: ${formatDate(slotStart, settings.timeZone)}
⏱ Час: ${time} (${duration} год)

📱 Будь ласка, вкажіть ваш номер телефону для зв'язку

👇 Поділіться номером телефону у формі нижче 👇`,
        getPhoneRequestKeyboard(dateISO, time, duration)
      );
      await ctx.answerCbQuery();
    }
  });

  // Confirm booking
  bot.action(/^CONFIRM_BOOKING\|(.+)\|(.+)\|(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const time = ctx.match[2];
    const duration = parseInt(ctx.match[3], 10);

    const tgId = ctx.from.id.toString();
    const user = await prisma.user.findUnique({ where: { tgId } });
    const session = getSession(tgId);

    if (!user) {
      await ctx.answerCbQuery('Помилка користувача');
      return;
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    // Create booking
    const start = toDateAtTime(dateISO, time, settings.timeZone);
    const end = new Date(start.getTime() + duration * 60 * 60 * 1000);

    // Check for conflicts
    const conflicts = await prisma.booking.findMany({
      where: {
        status: { in: ['PENDING', 'CONFIRMED'] },
        OR: [
          {
            AND: [
              { dateStart: { lte: start } },
              { dateEnd: { gt: start } },
            ],
          },
          {
            AND: [
              { dateStart: { lt: end } },
              { dateEnd: { gte: end } },
            ],
          },
          {
            AND: [
              { dateStart: { gte: start } },
              { dateEnd: { lte: end } },
            ],
          },
        ],
      },
    });

    if (conflicts.length > 0) {
      await ctx.editMessageText(
        '❌ Цей слот вже зайнятий. Будь ласка, оберіть інший час.'
      );
      await ctx.answerCbQuery('Слот зайнятий');
      return;
    }

    // Отримуємо коментар з сесії, якщо є
    const comment = session.bookingData?.comment || null;

    const booking = await prisma.booking.create({
      data: {
        dateStart: start,
        dateEnd: end,
        durationMin: duration * 60,
        status: 'PENDING',
        source: 'BOT',
        customerName: user.name || ctx.from.first_name,
        customerPhone: user.phone,
        tgCustomerId: tgId,
        note: comment,
      },
    });

    // Скидаємо стан сесії
    session.awaitingComment = false;
    session.bookingData = undefined;
    setSession(tgId, session);

    await ctx.editMessageText(
      getBookingPendingMessage(booking, config.timeZone),
      comment ? getBookingKeyboardWithComment(booking.id) : getBookingSubmittedKeyboard(booking.id)
    );
    await ctx.answerCbQuery('✅ Заявку створено!');

    // Notify all admins
    await notifyAdmins(bot, booking);
  });

  // Cancel booking (customer cancels their pending booking)
  bot.action(/^CANCEL_BOOKING:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const tgId = ctx.from.id.toString();

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) {
        await ctx.answerCbQuery('❌ Бронювання не знайдено');
        return;
      }

      // Перевіряємо, що це бронювання належить цьому користувачу
      if (booking.tgCustomerId !== tgId) {
        await ctx.answerCbQuery('❌ Це не ваше бронювання');
        return;
      }

      // Можна скасувати тільки заявки зі статусом PENDING
      if (booking.status !== 'PENDING') {
        await ctx.answerCbQuery('❌ Можна скасувати тільки заявки, що очікують підтвердження');
        return;
      }

      // Скасовуємо бронювання
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'CANCELLED' },
      });

      await ctx.editMessageText(
        `❌ Заявку скасовано\n\n` +
        `📅 Дата: ${formatDate(booking.dateStart, config.timeZone)}, ${formatTime(booking.dateStart, config.timeZone)}\n` +
        `⏱ Тривалість: ${Math.floor(booking.durationMin / 60)} год\n\n` +
        `Ви можете створити нову заявку через головне меню.`
      );
      await ctx.answerCbQuery('✅ Заявку скасовано');

      // Можливо повідомити адмінів про скасування
      // (опціонально, поки що пропустимо)
    } catch (error) {
      console.error('Error cancelling booking:', error);
      await ctx.answerCbQuery('❌ Помилка при скасуванні');
    }
  });

  // Edit booking (customer edits their pending booking)
  bot.action(/^EDIT_BOOKING:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const tgId = ctx.from.id.toString();

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) {
        await ctx.answerCbQuery('❌ Бронювання не знайдено');
        return;
      }

      // Перевіряємо, що це бронювання належить цьому користувачу
      if (booking.tgCustomerId !== tgId) {
        await ctx.answerCbQuery('❌ Це не ваше бронювання');
        return;
      }

      // Можна редагувати тільки заявки зі статусом PENDING
      if (booking.status !== 'PENDING') {
        await ctx.answerCbQuery('❌ Можна редагувати тільки заявки, що очікують підтвердження');
        return;
      }

      await ctx.answerCbQuery('🔄 Скасовую стару заявку та перенаправляю до вибору нового часу...');

      // Скасовуємо старе бронювання
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'CANCELLED' },
      });

      // Повідомляємо користувача та пропонуємо обрати новий час
      await ctx.editMessageText(
        `✏️ Стару заявку скасовано. Оберіть новий час для бронювання.\n\n` +
        `Попередня заявка:\n` +
        `📅 Дата: ${formatDate(booking.dateStart, config.timeZone)}, ${formatTime(booking.dateStart, config.timeZone)}\n` +
        `⏱ Тривалість: ${Math.floor(booking.durationMin / 60)} год`
      );

      // Запускаємо процес вибору нового часу
      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!settings) {
        await ctx.reply('Помилка налаштувань');
        return;
      }

      // Показуємо візуальний розклад
      const days = getNextDays(7, settings.timeZone);
      const start = performance.now();

      const bookings = await prisma.booking.findMany({
        where: {
          dateStart: { gte: days[0], lt: days[days.length - 1] },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      });

      try {
        const image = generateWeeklyScheduleImage({
          days,
          settings,
          bookings,
        });
        const end = performance.now();
        console.log(
          `[ScheduleImage] offset=0 bookings=${bookings.length} fetched=${Math.round(end - start)}ms range=${dateToISO(days[0])}..${dateToISO(days[days.length - 1])}`
        );

        await ctx.replyWithPhoto(
          { source: image.buffer },
          {
            caption: 'Оберіть вільний час для бронювання:',
            ...getScheduleNavigationKeyboard(0, MAX_WEEK_OFFSET),
          }
        );
      } catch (error) {
        console.error('Failed to generate schedule image:', error);
        await ctx.reply(
          'Оберіть дату:',
          getDateSelectionKeyboard(days, 0, MAX_WEEK_OFFSET)
        );
      }
    } catch (error) {
      console.error('Error editing booking:', error);
      await ctx.answerCbQuery('❌ Помилка при редагуванні');
    }
  });

  // Pagination
  bot.action(/^PAGE:(.+):(\d+):(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const duration = parseInt(ctx.match[2], 10);
    const page = parseInt(ctx.match[3], 10);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    const dayStart = toDateAtTime(dateISO, '00:00', settings.timeZone);
    const dayEnd = toDateAtTime(dateISO, '23:59', settings.timeZone);

    const bookings = await prisma.booking.findMany({
      where: {
        dateStart: { gte: dayStart, lte: dayEnd },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });

    const slots = generateSlots(dateISO, settings, bookings);
    const relevantSlots = slots.filter((s) => s.durationHours === duration);

    const pageDayDate = toDateAtTime(dateISO, '12:00', settings.timeZone);

    await ctx.editMessageText(
      `Вільні слоти на ${formatDate(pageDayDate, settings.timeZone)} (${duration} год):`,
      getSlotsKeyboard(relevantSlots, dateISO, duration, settings.timeZone, page)
    );
    await ctx.answerCbQuery();
  });

  // Keep phone - proceed to comment
  bot.action(/^KEEP_PHONE\|(.+)\|(.+)\|(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const time = ctx.match[2];
    const duration = parseInt(ctx.match[3], 10);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    const slotStart = toDateAtTime(dateISO, time, settings.timeZone);

    // Показуємо підтвердження з опціональним коментарем
    await ctx.editMessageText(
      `📅 Дата: ${formatDate(slotStart, settings.timeZone)}
⏱ Час: ${time} (${duration} год)

💬 Бажаєте залишити коментар власникам?`,
      getBookingConfirmKeyboard(dateISO, time, duration)
    );
    await ctx.answerCbQuery();
  });

  // Change phone - request new phone
  bot.action(/^CHANGE_PHONE\|(.+)\|(.+)\|(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const time = ctx.match[2];
    const duration = parseInt(ctx.match[3], 10);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    const slotStart = toDateAtTime(dateISO, time, settings.timeZone);

    await ctx.deleteMessage();
    await ctx.reply(
      `📅 Дата: ${formatDate(slotStart, settings.timeZone)}
⏱ Час: ${time} (${duration} год)

📱 Будь ласка, вкажіть ваш номер телефону для зв'язку

👇 Поділіться номером телефону у формі нижче 👇`,
      getPhoneRequestKeyboard(dateISO, time, duration)
    );
    await ctx.answerCbQuery();
  });

  // Handle contact sharing
  bot.on('contact', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    // Перевіряємо чи є дані про бронювання в сесії
    if (!session.bookingData) {
      await ctx.reply('Помилка: дані про бронювання не знайдено. Будь ласка, почніть спочатку.');
      return;
    }

    const { dateISO, time, duration } = session.bookingData;
    const phone = ctx.message.contact.phone_number;

    // Зберігаємо номер телефону
    await prisma.user.update({
      where: { tgId },
      data: { phone },
    });

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.reply('Помилка налаштувань');
      return;
    }

    const slotStart = toDateAtTime(dateISO, time, settings.timeZone);

    // Показуємо підтвердження з опціональним коментарем
    await ctx.reply(
      `✅ Дякуємо! Номер збережено.

📅 Дата: ${formatDate(slotStart, settings.timeZone)}
⏱ Час: ${time} (${duration} год)

💬 Бажаєте залишити коментар власникам?`,
      getBookingConfirmKeyboard(dateISO, time, duration)
    );
  });

  // Add comment - request comment input
  bot.action(/^ADD_COMMENT\|(.+)\|(.+)\|(\d+)$/, async (ctx) => {
    const dateISO = ctx.match[1];
    const time = ctx.match[2];
    const duration = parseInt(ctx.match[3], 10);

    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);
    session.awaitingComment = true;
    setSession(tgId, session);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      await ctx.answerCbQuery('Помилка налаштувань');
      return;
    }

    const slotStart = toDateAtTime(dateISO, time, settings.timeZone);

    await ctx.editMessageText(
      `📅 Дата: ${formatDate(slotStart, settings.timeZone)}
⏱ Час: ${time} (${duration} год)

💬 Введіть ваш коментар для власників:

👇 Напишіть повідомлення нижче 👇`
    );
    await ctx.answerCbQuery();
  });

  // Handle "Back to slots" button after phone request
  bot.hears('« Назад до вибору слотів', async (ctx) => {
    const days = getNextDays(7, config.timeZone);
    await ctx.reply('Оберіть дату:', getDateSelectionKeyboard(days, 0, MAX_WEEK_OFFSET));
  });

  // Handle comment input
  bot.on('text', async (ctx, next) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    // Перевіряємо чи очікується коментар
    if (session.awaitingComment && session.bookingData) {
      const comment = ctx.message.text;
      const { dateISO, time, duration } = session.bookingData;

      // Зберігаємо коментар в сесії
      session.bookingData.comment = comment;
      session.awaitingComment = false;
      setSession(tgId, session);

      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!settings) {
        await ctx.reply('Помилка налаштувань');
        return;
      }

      const slotStart = toDateAtTime(dateISO, time, settings.timeZone);

      // Показуємо підтвердження з коментарем
      await ctx.reply(
        `✅ Коментар збережено!

📅 Дата: ${formatDate(slotStart, settings.timeZone)}
⏱ Час: ${time} (${duration} год)
💬 Коментар: ${comment}

Підтвердити бронювання?`,
        getBookingConfirmKeyboard(dateISO, time, duration)
      );
      return;
    }

    // Передаємо далі, якщо не очікується коментар
    await next();
  });

  // Back to main
  bot.action('BACK_TO_MAIN', async (ctx) => {
    console.log('🏠 DEBUG: BACK_TO_MAIN button pressed by user:', ctx.from?.id);
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    // Перевіряємо, чи це повідомлення про заявку (має callback_data з EDIT_BOOKING або CANCEL_BOOKING)
    const message = ctx.callbackQuery.message as any;
    const isBookingMessage = message && message.reply_markup &&
      message.reply_markup.inline_keyboard &&
      message.reply_markup.inline_keyboard.some((row: any) =>
        row.some((button: any) =>
          button.callback_data &&
          (button.callback_data.startsWith('EDIT_BOOKING:') || button.callback_data.startsWith('CANCEL_BOOKING:'))
        )
      );

    // Якщо це повідомлення про заявку, редагуємо його, видаляючи кнопку "Головне меню"
    if (isBookingMessage) {
      const bookingId = message.reply_markup.inline_keyboard
        .flat()
        .find((button: any) => button.callback_data && button.callback_data.startsWith('EDIT_BOOKING:'))?.callback_data?.split(':')[1];

      if (bookingId) {
        // Визначаємо, чи є коментар (перевіряємо текст кнопки)
        const hasComment = message.reply_markup.inline_keyboard
          .flat()
          .some((button: any) => button.text && button.text.includes('Змінити коментар'));

        // Використовуємо відповідну клавіатуру
        const keyboard = getBookingKeyboard(bookingId);

        await ctx.editMessageReplyMarkup(keyboard.reply_markup);
      }
    }

    // Показуємо відповідне меню залежно від ролі
    if (session.isAdmin && !session.forceCustomerMode) {
      await ctx.reply(getAdminWelcomeMessage(), getAdminMenuKeyboard());
    } else {
      await ctx.reply(getWelcomeMessage(), getMainMenuKeyboard());
    }

    await ctx.answerCbQuery();
  });

  // Back to bookings list
  bot.action('BACK_TO_BOOKINGS', async (ctx) => {
    console.log('🔙 DEBUG: BACK_TO_BOOKINGS button pressed by user:', ctx.from?.id);
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const bookings = await prisma.booking.findMany({
        where: { tgCustomerId: String(tgId) },
        orderBy: { dateStart: 'desc' },
        take: 10,
      });

      const formattedBookings = bookings.map(booking => ({
        id: booking.id,
        date: formatDate(booking.dateStart, config.timeZone),
        time: formatTime(booking.dateStart, config.timeZone),
        status: booking.status,
        note: booking.note,
        duration: Math.round((booking.dateEnd.getTime() - booking.dateStart.getTime()) / (1000 * 60 * 60))
      }));

      await ctx.editMessageText('📋 **Ваші бронювання**', {
        reply_markup: getUserBookingsKeyboard(formattedBookings).reply_markup,
        parse_mode: 'Markdown'
      });
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error returning to bookings:', error);
      await ctx.editMessageText('Виникла помилка. Спробуйте пізніше.');
      await ctx.answerCbQuery();
    }
  });

  // Back to date selection
  bot.action('BACK_TO_DATE', async (ctx) => {
    const days = getNextDays(7, config.timeZone);
    await ctx.editMessageText('Оберіть дату:', getDateSelectionKeyboard(days, 0, MAX_WEEK_OFFSET));
    await ctx.answerCbQuery();
  });

  // View user bookings
  bot.hears('📋 Мої бронювання', async (ctx) => {
    console.log('🔍 DEBUG: "📋 Мої бронювання" button pressed');
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);

      const bookings = await prisma.booking.findMany({
        where: {
          tgCustomerId: String(tgId),
          // Показуємо тільки бронювання, що ще не закінчились або закінчились менше ніж годину тому
          dateEnd: { gte: oneHourAgo }
        },
        orderBy: { dateStart: 'asc' }, // Від найближчих до найдальніших
        take: 10, // Показувати максимум 10 бронювань
      });

      if (bookings.length === 0) {
        await ctx.reply('У вас поки що немає бронювань.\n\nВи можете створити нове бронювання через меню "📅 Переглянути вільні слоти".');
        return;
      }

      const message = `📋 **Ваші бронювання**\n\nЗнайдено ${bookings.length} бронювань(я) (показуються актуальні та майбутні):`;
      const formattedBookings = bookings.map(booking => ({
        id: booking.id,
        date: formatDate(booking.dateStart, config.timeZone),
        time: formatTime(booking.dateStart, config.timeZone),
        status: booking.status,
        note: booking.note,
        duration: Math.round((booking.dateEnd.getTime() - booking.dateStart.getTime()) / (1000 * 60 * 60))
      }));

      await ctx.reply(message, {
        reply_markup: getUserBookingsKeyboard(formattedBookings).reply_markup,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      console.error('Error fetching user bookings:', error);
      await ctx.reply('Виникла помилка при завантаженні бронювань. Спробуйте пізніше.');
    }
  });

  // Handle individual booking management
  bot.action(/^MANAGE_BOOKING:(.+)$/, async (ctx) => {
    console.log('🔍 DEBUG: MANAGE_BOOKING button pressed for booking:', ctx.match[1]);
    const bookingId = ctx.match[1];
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking || booking.tgCustomerId !== String(tgId)) {
        console.log('❌ Booking not found or access denied for user:', tgId);
        await ctx.reply('Бронювання не знайдено або у вас немає доступу.');
        return;
      }

      console.log(`📋 Showing booking details: ID=${booking.id}, Status=${booking.status}, Date=${formatDate(booking.dateStart, config.timeZone)} ${formatTime(booking.dateStart, config.timeZone)}`);

      const statusText = booking.status === 'CONFIRMED' ? '✅ Підтверджено' :
                        booking.status === 'PENDING' ? '⏳ Очікує підтвердження' :
                        booking.status === 'CANCELLED' ? '❌ Скасовано' : '📝 Створено';

      let message = `📋 **Деталі бронювання**\n\n`;
      message += `📅 Дата: ${formatDate(booking.dateStart, config.timeZone)}\n`;
      message += `⏰ Час: ${formatTime(booking.dateStart, config.timeZone)}\n`;
      message += `⏱ Тривалість: ${Math.round((booking.dateEnd.getTime() - booking.dateStart.getTime()) / (1000 * 60 * 60))} год\n`;
      message += `📊 Статус: ${statusText}\n`;
      if (booking.note) {
        message += `💬 Коментар: ${booking.note}\n`;
      }

      const formattedBooking = {
        id: booking.id,
        date: formatDate(booking.dateStart, config.timeZone),
        time: formatTime(booking.dateStart, config.timeZone),
        status: booking.status,
        note: booking.note,
        duration: Math.round((booking.dateEnd.getTime() - booking.dateStart.getTime()) / (1000 * 60 * 60))
      };

      await ctx.reply(message, {
        reply_markup: getBookingManagementUserKeyboard(formattedBooking).reply_markup,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      console.error('Error managing booking:', error);
      await ctx.reply('Виникла помилка. Спробуйте пізніше.');
    }
  });

  // Refresh bookings list
  bot.action('REFRESH_BOOKINGS', async (ctx) => {
    console.log('🔄 DEBUG: REFRESH_BOOKINGS button pressed by user:', ctx.from?.id);
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);

      const bookings = await prisma.booking.findMany({
        where: {
          tgCustomerId: String(tgId),
          // Показуємо тільки бронювання, що ще не закінчились або закінчились менше ніж годину тому
          dateEnd: { gte: oneHourAgo }
        },
        orderBy: { dateStart: 'asc' }, // Від найближчих до найдальніших
        take: 10, // Показувати максимум 10 бронювань
      });

      const formattedBookings = bookings.map(booking => ({
        id: booking.id,
        date: formatDate(booking.dateStart, config.timeZone),
        time: formatTime(booking.dateStart, config.timeZone),
        status: booking.status,
        note: booking.note,
        duration: Math.round((booking.dateEnd.getTime() - booking.dateStart.getTime()) / (1000 * 60 * 60))
      }));

      await ctx.reply('🔄 Оновлено!', {
        reply_markup: getUserBookingsKeyboard(formattedBookings).reply_markup,
      });
    } catch (error) {
      console.error('Error refreshing bookings:', error);
      await ctx.reply('Виникла помилка при оновленні. Спробуйте пізніше.');
    }
  });

  // Edit booking time
  bot.action(/^EDIT_TIME:(.+)$/, async (ctx) => {
    console.log('✏️ DEBUG: EDIT_TIME button pressed for booking:', ctx.match[1]);
    const bookingId = ctx.match[1];
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking || booking.tgCustomerId !== String(tgId)) {
        await ctx.reply('Бронювання не знайдено або у вас немає доступу.');
        return;
      }

      if (booking.status === 'CANCELLED') {
        await ctx.reply('Не можна змінити час скасованого бронювання.');
        return;
      }

      // Redirect to date selection for rescheduling
      const days = getNextDays(7, config.timeZone);
      await ctx.editMessageText(
        `📅 Оберіть нову дату для бронювання:\n\nПоточне бронювання: ${formatDate(booking.dateStart, config.timeZone)} ${formatTime(booking.dateStart, config.timeZone)}`,
        getDateSelectionKeyboard(days, 0, MAX_WEEK_OFFSET)
      );
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error editing booking time:', error);
      await ctx.reply('Виникла помилка. Спробуйте пізніше.');
    }
  });

  // Add comment to booking
  bot.action(/^ADD_COMMENT:(.+)$/, async (ctx) => {
    console.log('🔍 DEBUG: ADD_COMMENT button pressed for booking:', ctx.match[1]);
    const bookingId = ctx.match[1];
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking || booking.tgCustomerId !== String(tgId)) {
        await ctx.reply('Бронювання не знайдено або у вас немає доступу.');
        return;
      }

      await ctx.editMessageText(
        '💬 Введіть коментар до бронювання (максимум 200 символів):',
        Markup.inlineKeyboard([
          [Markup.button.callback('❌ Скасувати', `MANAGE_BOOKING:${bookingId}`)]
        ])
      );
      await ctx.answerCbQuery();

      // Set up listener for comment
      ctx.session = ctx.session || {};
      ctx.session.awaitingComment = true;
      ctx.session.pendingRejectionBookingId = bookingId;
    } catch (error) {
      console.error('Error adding comment:', error);
      await ctx.reply('Виникла помилка. Спробуйте пізніше.');
    }
  });

  // Edit comment
  bot.action(/^EDIT_COMMENT:(.+)$/, async (ctx) => {
    console.log('🔍 DEBUG: EDIT_COMMENT button pressed for booking:', ctx.match[1]);
    const bookingId = ctx.match[1];
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking || booking.tgCustomerId !== String(tgId)) {
        await ctx.reply('Бронювання не знайдено або у вас немає доступу.');
        return;
      }

      const currentComment = booking.note || '(немає коментаря)';
      await ctx.editMessageText(
        `💬 Редагування коментаря:\n\nПоточний коментар: ${currentComment}\n\nВведіть новий коментар (максимум 200 символів):`,
        Markup.inlineKeyboard([
          [Markup.button.callback('❌ Скасувати', `MANAGE_BOOKING:${bookingId}`)]
        ])
      );
      await ctx.answerCbQuery();

      // Set up listener for comment edit
      ctx.session = ctx.session || {};
      ctx.session.awaitingComment = true;
      ctx.session.pendingRejectionBookingId = bookingId;
    } catch (error) {
      console.error('Error editing comment:', error);
      await ctx.reply('Виникла помилка. Спробуйте пізніше.');
    }
  });

  // Cancel booking
  bot.action(/^CANCEL_BOOKING:(.+)$/, async (ctx) => {
    console.log('🔍 DEBUG: CANCEL_BOOKING button pressed for booking:', ctx.match[1]);
    const bookingId = ctx.match[1];
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking || booking.tgCustomerId !== String(tgId)) {
        await ctx.reply('Бронювання не знайдено або у вас немає доступу.');
        return;
      }

      if (booking.status === 'CANCELLED') {
        await ctx.reply('Це бронювання вже скасовано.');
        return;
      }

      // Update booking status to cancelled
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'CANCELLED' }
      });

      await ctx.editMessageText(
        '❌ Бронювання успішно скасовано.\n\nЯкщо ви хочете створити нове бронювання, використовуйте меню "📅 Переглянути вільні слота".',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Створити нову заявку', `REBOOK:${bookingId}`)],
          [Markup.button.callback('🔙 Назад до списку', 'BACK_TO_BOOKINGS')],
          [Markup.button.callback('🏠 Головне меню', 'BACK_TO_MAIN')]
        ])
      );
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error cancelling booking:', error);
      await ctx.reply('Виникла помилка при скасуванні бронювання. Спробуйте пізніше.');
    }
  });

  // Rebook cancelled booking
  bot.action(/^REBOOK:(.+)$/, async (ctx) => {
    console.log('🔄 DEBUG: REBOOK button pressed for booking:', ctx.match[1]);
    const bookingId = ctx.match[1];
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking || booking.tgCustomerId !== String(tgId)) {
        await ctx.reply('Бронювання не знайдено або у вас немає доступу.');
        return;
      }

      // Redirect to date selection for new booking
      const days = getNextDays(7, config.timeZone);
      await ctx.editMessageText(
        '📅 Оберіть дату для нового бронювання:',
        getDateSelectionKeyboard(days, 0, MAX_WEEK_OFFSET)
      );
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error rebooking:', error);
      await ctx.reply('Виникла помилка. Спробуйте пізніше.');
    }
  });

  // Delete cancelled booking from history
  bot.action(/^DELETE_BOOKING:(.+)$/, async (ctx) => {
    console.log('🗑️ DEBUG: DELETE_BOOKING button pressed for booking:', ctx.match[1]);
    const bookingId = ctx.match[1];
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking || booking.tgCustomerId !== String(tgId)) {
        await ctx.reply('Бронювання не знайдено або у вас немає доступу.');
        return;
      }

      if (booking.status !== 'CANCELLED') {
        await ctx.reply('Видалити з історії можна тільки скасовані бронювання.');
        return;
      }

      // Delete the booking from database
      await prisma.booking.delete({
        where: { id: bookingId }
      });

      await ctx.editMessageText(
        '🗑️ Бронювання успішно видалено з історії.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Оновити список', 'REFRESH_BOOKINGS')],
          [Markup.button.callback('🔙 Назад до списку', 'BACK_TO_BOOKINGS')],
          [Markup.button.callback('🏠 Головне меню', 'BACK_TO_MAIN')]
        ])
      );
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error deleting booking:', error);
      await ctx.reply('Виникла помилка при видаленні бронювання. Спробуйте пізніше.');
    }
  });

  // Handle text messages for comments
  bot.on('text', async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    try {
      const session = ctx.session as any;
      const message = ctx.message.text;

      // Handle adding new comment
      if (session?.pendingRejectionBookingId && session?.awaitingComment) {
        const bookingId = session.pendingRejectionBookingId;

        if (message.length > 200) {
          await ctx.reply('Коментар занадто довгий. Максимальна довжина - 200 символів.');
          return;
        }

        await prisma.booking.update({
          where: { id: bookingId },
          data: { note: message }
        });

        await ctx.reply('✅ Коментар успішно додано!');

        // Clear session state
        session.pendingRejectionBookingId = undefined;
        session.awaitingComment = false;

        // Show updated booking details
        const booking = await prisma.booking.findUnique({
          where: { id: bookingId },
        });

        if (booking) {
          const statusText = booking.status === 'CONFIRMED' ? '✅ Підтверджено' :
                            booking.status === 'PENDING' ? '⏳ Очікує підтвердження' :
                            booking.status === 'CANCELLED' ? '❌ Скасовано' : '📝 Створено';

          let response = `📋 **Оновлені деталі бронювання**\n\n`;
          response += `📅 Дата: ${formatDate(booking.dateStart, config.timeZone)}\n`;
          response += `⏰ Час: ${formatTime(booking.dateStart, config.timeZone)}\n`;
          response += `⏱ Тривалість: ${Math.round((booking.dateEnd.getTime() - booking.dateStart.getTime()) / (1000 * 60 * 60))} год\n`;
          response += `📊 Статус: ${statusText}\n`;
          response += `💬 Коментар: ${booking.note}\n`;

          const formattedBooking = {
            id: booking.id,
            date: formatDate(booking.dateStart, config.timeZone),
            time: formatTime(booking.dateStart, config.timeZone),
            status: booking.status,
            note: booking.note,
            duration: Math.round((booking.dateEnd.getTime() - booking.dateStart.getTime()) / (1000 * 60 * 60))
          };

          await ctx.reply(response, {
            reply_markup: getBookingManagementUserKeyboard(formattedBooking).reply_markup,
            parse_mode: 'Markdown'
          });
        }
      }
    } catch (error) {
      console.error('Error handling text message:', error);
      await ctx.reply('Виникла помилка. Спробуйте пізніше.');
    }
  });
}

type ScheduleStats = Record<'available' | 'booked' | 'cleaning' | 'tight' | 'past', number>;

async function buildWeeklySchedulePayload(
  offset: number,
  settings: Settings
): Promise<{ days: Date[]; buffer: Buffer; stats: ScheduleStats }> {
  const tz = settings.timeZone;
  const totalDays = getNextDays(7 * (offset + 1), tz);
  const startIndex = offset * 7;
  const days = totalDays.slice(startIndex, startIndex + 7);

  if (days.length === 0) {
    throw new Error(`Недостатньо даних для тижня offset=${offset}`);
  }

  const firstDayISO = dateToISO(days[0]);
  const lastDayISO = dateToISO(days[days.length - 1]);
  const rangeStart = toDateAtTime(firstDayISO, '00:00', tz);
  const rangeEnd = toDateAtTime(lastDayISO, '23:59', tz);

  const bookingsFetchStart = performance.now();
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ['PENDING', 'CONFIRMED'] },
      dateStart: { lt: rangeEnd },
      dateEnd: { gt: rangeStart },
    },
  });
  const bookingsDuration = Math.round(performance.now() - bookingsFetchStart);
  console.log(
    `[ScheduleImage] offset=${offset} bookings=${bookings.length} fetched=${bookingsDuration}ms range=${firstDayISO}..${lastDayISO}`
  );

  const renderStart = performance.now();
  const image = generateWeeklyScheduleImage({
    days,
    settings,
    bookings,
  });
  const renderDuration = Math.round(performance.now() - renderStart);
  console.log(
    `[ScheduleImage] offset=${offset} render=${renderDuration}ms range=${firstDayISO}..${lastDayISO}`
  );

  return {
    days,
    buffer: image.buffer,
    stats: image.stats as ScheduleStats,
  };
}

function buildScheduleCaption(days: Date[], stats: ScheduleStats, tz: string): string {
  const startLabel = formatDate(days[0], tz);
  const endLabel = formatDate(days[days.length - 1], tz);

  return `*${startLabel} – ${endLabel}*`;
}

async function notifyAdmins(bot: Telegraf<BotContext>, booking: any) {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN' },
  });

  const { getBookingRequestMessage } = await import('../../core/notifications');
  const { getApprovalKeyboard } = await import('../keyboards');

  // Не надсилаємо повідомлення адміну, який сам створив заявку
  const adminsToNotify = admins.filter(admin => admin.tgId !== booking.tgCustomerId);

  for (const admin of adminsToNotify) {
    try {
      await bot.telegram.sendMessage(
        admin.tgId,
        getBookingRequestMessage(booking, config.timeZone),
        getApprovalKeyboard(booking.id)
      );
    } catch (error) {
      console.error(`Failed to notify admin ${admin.tgId}:`, error);
    }
  }
}
