import { Markup, Scenes } from 'telegraf';
import { AvailabilityService } from '../services/availabilityService';
import { BotContext } from './types';
import { toZonedTime } from 'date-fns-tz';
import { format } from 'date-fns';
import { PerfLogger } from '../utils/perfLogger';

const SCENE_ID = 'ADD_SLOT_SCENE';
const CANCEL_ACTION = 'slot:add:cancel';
const BACK_ACTION = 'slot:add:back';
const NEXT_WEEK_ACTION = 'slot:add:nextweek';
const PREV_WEEK_ACTION = 'slot:add:prevweek';
const FULL_DAY_ACTION = 'slot:add:fullday';
const CONFIRM_GAP_ACTION_PREFIX = 'slot:add:confirm_gap:';
const CONFIRM_OVERLAP_ACTION = 'slot:add:confirm_overlap';
const CANCEL_OVERLAP_ACTION = 'slot:add:cancel_overlap';
const CONFIRM_CHAN_WARNING_ACTION = 'slot:add:confirm_chan_warning';
const CONFIRM_EARLY_CHAN_ACTION = 'slot:add:confirm_early_chan';
const SKIP_CHAN_ACTION = 'slot:add:skip_chan';

interface AddBookingWizardState {
  dateISO?: string;
  dateLabel?: string;
  startTime?: string;
  endTime?: string;
  withChan?: boolean;
  forceChan?: boolean; // Додати чан навіть якщо вже зайнятий
  messageId?: number;
  weekOffset?: number;
  step?: 'date' | 'start' | 'end' | 'overlap' | 'chan' | 'chan_warning' | 'early_chan_warning'; // Внутрішній стан для відстеження UI
  overlappingIds?: string[]; // ID бронювань, що перекриваються
  overlappingInfo?: string; // Текст для відображення
  existingChanInfo?: string; // Інформація про існуючий чан
  isEarlyTime?: boolean; // Чи час раніше 13:00
}

export function createAddSlotScene(
  service: AvailabilityService,
  onShowSchedule?: (ctx: BotContext) => Promise<void>,
  onShowBookings?: (ctx: BotContext) => Promise<void>
) {
  return new Scenes.WizardScene<BotContext>(
    SCENE_ID,
    // Єдиний крок - обробляє всі callback'и
    async (ctx) => {
      const end = PerfLogger.start('WIZARD: Main Handler');
      try {
        const state = getState(ctx);

        // Якщо це не callback (текстове повідомлення)
        if (!('callback_query' in ctx.update)) {
          const isFirstEntry = state.step === undefined;

          // Ініціалізація при першому вході в сцену
          if (isFirstEntry) {
            state.step = 'date';
            state.weekOffset = 0;
            return showDateSelection(ctx, service, state);
          }

          // Якщо вже в сцені - перевіряємо чи це кнопка головного меню
          if ('message' in ctx.update && 'text' in ctx.update.message) {
            const text = ctx.update.message.text;

            // Показати розклад - обробляємо і виходимо
            if (text === '🖼 Показати розклад') {
              await ctx.scene.leave();
              if (onShowSchedule) {
                await onShowSchedule(ctx);
              }
              return;
            }

            // Показати зайняті слоти - обробляємо і виходимо
            if (text === '📋 Показати зайняті слоти') {
              await ctx.scene.leave();
              if (onShowBookings) {
                await onShowBookings(ctx);
              }
              return;
            }

            // Інші кнопки меню або команди - просто виходимо
            const otherMenuButtons = [
              '📋 Інформація',
              '📞 Контакти',
              '➕ Додати бронювання',
              '📅 Переглянути бронювання',
              '🗑 Очистити день',
              '📢 Розсилка',
              '🎫 Режим клієнта',
              '🛠 Режим адміністратора',
            ];

            if (otherMenuButtons.includes(text) || text.startsWith('/')) {
              await ctx.scene.leave();
              await ctx.reply('❌ Бронювання скасовано');
              return;
            }
          }

          // Невідомий текст - ігноруємо
          return;
        }

        // Ініціалізація для callback (на випадок якщо сесія втрачена)
        if (state.step === undefined) {
          state.step = 'date';
          state.weekOffset = 0;
        }

        const data = readCallbackData(ctx);
        if (!data) {
          await ctx.answerCbQuery();
          return;
        }

        // Глобальні дії
        if (data === CANCEL_ACTION) {
          await handleCancel(ctx, state);
          return ctx.scene.leave();
        }

        // Навігація тижнями (для вибору дати)
        if (data === NEXT_WEEK_ACTION) {
          state.weekOffset = (state.weekOffset || 0) + 1;
          await ctx.answerCbQuery();
          return showDateSelection(ctx, service, state);
        }

        if (data === PREV_WEEK_ACTION) {
          state.weekOffset = Math.max(0, (state.weekOffset || 0) - 1);
          await ctx.answerCbQuery();
          return showDateSelection(ctx, service, state);
        }

        // Кнопка "Назад" - залежить від поточного стану
        if (data === BACK_ACTION) {
          await ctx.answerCbQuery();
          if (state.step === 'start') {
            state.dateISO = undefined;
            state.dateLabel = undefined;
            state.step = 'date';
            return showDateSelection(ctx, service, state);
          }
          if (state.step === 'end') {
            state.startTime = undefined;
            state.step = 'start';
            return showStartTimeSelection(ctx, service, state);
          }
          if (state.step === 'overlap') {
            state.endTime = undefined;
            state.overlappingIds = undefined;
            state.overlappingInfo = undefined;
            state.step = 'end';
            return showEndTimeSelection(ctx, service, state);
          }
          if (state.step === 'chan') {
            state.endTime = undefined;
            state.step = 'end';
            return showEndTimeSelection(ctx, service, state);
          }
          if (state.step === 'chan_warning') {
            state.existingChanInfo = undefined;
            state.step = 'chan';
            return showChanSelection(ctx, service, state);
          }
          if (state.step === 'early_chan_warning') {
            state.isEarlyTime = undefined;
            state.step = 'chan';
            return showChanSelection(ctx, service, state);
          }
          // За замовчуванням - до вибору дати
          state.step = 'date';
          return showDateSelection(ctx, service, state);
        }

        // === ВИБІР ДАТИ ===
        const dateMatch = data.match(/^slot:add:date:(.+)$/);
        if (dateMatch) {
          const iso = dateMatch[1];
          const day = service.getScheduleDays(state.weekOffset).find(d => d.iso === iso);
          state.dateISO = iso;
          state.dateLabel = day?.label || iso;
          state.step = 'start';
          await ctx.answerCbQuery();
          return showStartTimeSelection(ctx, service, state);
        }

        // === ВЕСЬ ДЕНЬ ===
        if (data === FULL_DAY_ACTION) {
          return handleFullDay(ctx, service, state);
        }

        // === ВИБІР ЧАСУ ПОЧАТКУ ===
        const startMatch = data.match(/^slot:add:start:(\d{2}:\d{2})$/);
        if (startMatch) {
          state.startTime = startMatch[1];
          state.step = 'end';
          await ctx.answerCbQuery();
          return showEndTimeSelection(ctx, service, state);
        }

        // === ПІДТВЕРДЖЕННЯ GAP ===
        if (data.startsWith(CONFIRM_GAP_ACTION_PREFIX)) {
          const endTime = data.replace(CONFIRM_GAP_ACTION_PREFIX, '');
          state.endTime = endTime;
          state.step = 'chan';
          await ctx.answerCbQuery();
          return showChanSelection(ctx, service, state);
        }

        // === ВИБІР ЧАСУ ЗАКІНЧЕННЯ ===
        const endMatch = data.match(/^slot:add:end:(\d{2}:\d{2})$/);
        if (endMatch) {
          const endTime = endMatch[1];
          state.endTime = endTime;

          // Перевірка перекриття з існуючими бронюваннями
          const overlapping = await service.findOverlappingBookings(state.dateISO!, state.startTime!, endTime);
          if (overlapping.length > 0) {
            state.overlappingIds = overlapping.map(b => b.id);
            state.overlappingInfo = overlapping
              .map(b => `• ${b.startTime} – ${b.endTime}${b.withChan ? ' (з чаном 🛁)' : ''}`)
              .join('\n');
            state.step = 'overlap';
            await ctx.answerCbQuery('⚠️ Знайдено перекриття');
            return showOverlapWarning(ctx, state);
          }

          // Перевірка gaps
          const hasBadGaps = await service.checkGaps(state.dateISO!, state.startTime!, endTime);
          if (hasBadGaps) {
            await ctx.answerCbQuery('⚠️ Увага: малий проміжок часу');
            return showGapWarning(ctx, state, endTime);
          }

          state.step = 'chan';
          await ctx.answerCbQuery();
          return showChanSelection(ctx, service, state);
        }

        // === ПІДТВЕРДЖЕННЯ ПЕРЕКРИТТЯ ===
        if (data === CONFIRM_OVERLAP_ACTION) {
          await ctx.answerCbQuery('Перезаписую...');
          state.step = 'chan';
          return showChanSelection(ctx, service, state);
        }

        if (data === CANCEL_OVERLAP_ACTION) {
          state.endTime = undefined;
          state.overlappingIds = undefined;
          state.overlappingInfo = undefined;
          state.step = 'end';
          await ctx.answerCbQuery();
          return showEndTimeSelection(ctx, service, state);
        }

        // === ВИБІР ЧАНУ ===
        const chanMatch = data.match(/^slot:add:chan:(yes|no)$/);
        if (chanMatch) {
          const wantsChan = chanMatch[1] === 'yes';

          // Якщо хочуть чан - перевіряємо обмеження
          if (wantsChan) {
            // Перевірка раннього часу (до 13:00)
            const startMinutes = timeToMinutes(state.startTime!);
            const chanStartMinutes = 13 * 60; // 13:00
            if (startMinutes < chanStartMinutes) {
              state.isEarlyTime = true;
              state.step = 'early_chan_warning';
              await ctx.answerCbQuery('⚠️ Ранній час');
              return showEarlyChanWarning(ctx, state);
            }

            // Перевірка чи чан вже зайнятий
            const chanInfo = await service.getChanBookingForDay(state.dateISO!);
            if (chanInfo) {
              // Чан вже є - показуємо попередження
              state.existingChanInfo = `${chanInfo.startTime} – ${chanInfo.endTime}`;
              state.step = 'chan_warning';
              await ctx.answerCbQuery('⚠️ Чан вже зайнятий');
              return showChanWarning(ctx, state);
            }
          }

          state.withChan = wantsChan;
          await ctx.answerCbQuery();
          return saveBooking(ctx, service, state);
        }

        // === ПІДТВЕРДЖЕННЯ ПОПЕРЕДЖЕННЯ ПРО ЧАН (вже зайнятий) ===
        if (data === CONFIRM_CHAN_WARNING_ACTION) {
          state.withChan = true;
          state.forceChan = true; // Дозволяємо додати чан навіть якщо вже зайнятий
          await ctx.answerCbQuery('Додаю з чаном...');
          return saveBooking(ctx, service, state);
        }

        // === ПІДТВЕРДЖЕННЯ РАННЬОГО ЧАНУ ===
        if (data === CONFIRM_EARLY_CHAN_ACTION) {
          // Перевіряємо чи чан вже зайнятий на цей день
          const chanInfo = await service.getChanBookingForDay(state.dateISO!);
          if (chanInfo) {
            state.existingChanInfo = `${chanInfo.startTime} – ${chanInfo.endTime}`;
            state.step = 'chan_warning';
            await ctx.answerCbQuery('⚠️ Чан вже зайнятий');
            return showChanWarning(ctx, state);
          }

          state.withChan = true;
          state.forceChan = true; // Дозволяємо ранній чан
          await ctx.answerCbQuery('Додаю з чаном...');
          return saveBooking(ctx, service, state);
        }

        if (data === SKIP_CHAN_ACTION) {
          state.withChan = false;
          state.forceChan = false;
          await ctx.answerCbQuery();
          return saveBooking(ctx, service, state);
        }

        // Невідомий callback
        console.log('[WIZARD] Unknown callback:', data, 'Current step:', state.step);
        await ctx.answerCbQuery('Невідома дія', { show_alert: false });
      } finally {
        end();
      }
    }
  );
}

// === UI ФУНКЦІЇ ===

async function showDateSelection(ctx: BotContext, service: AvailabilityService, state: AddBookingWizardState) {
  const text = 'Крок 1/4. Оберіть день для бронювання 📅';
  const keyboard = buildDaysKeyboard(service, state.weekOffset || 0);

  if (state.messageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId, undefined, text, keyboard);
    } catch (e) {
      const msg = await ctx.reply(text, keyboard);
      state.messageId = msg.message_id;
    }
  } else {
    const msg = await ctx.reply(text, keyboard);
    state.messageId = msg.message_id;
  }
}

async function showStartTimeSelection(ctx: BotContext, service: AvailabilityService, state: AddBookingWizardState) {
  // Отримуємо бронювання на цей день для позначення зайнятих слотів
  const bookings = await service.listBookingsGrouped();
  const dayBookings = bookings.find(g => g.iso === state.dateISO)?.bookings || [];

  // Перевіряємо чи є слоти з чаном та без
  const hasWithChan = dayBookings.some(b => b.withChan);
  const hasWithoutChan = dayBookings.some(b => !b.withChan);

  const legendParts: string[] = [];
  if (hasWithoutChan) legendParts.push('🟡 - зайнято без чану');
  if (hasWithChan) legendParts.push('🔵 - зайнято з чаном');

  const text = [
    'Крок 2/4. Оберіть час початку бронювання ⏰',
    '',
    `📅 День: ${state.dateLabel}`,
    legendParts.length > 0 ? legendParts.join(', ') : '',
  ].filter(Boolean).join('\n');

  const keyboard = buildStartTimesKeyboard(service, state.dateISO!, dayBookings);

  try {
    await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, text, keyboard);
  } catch (e) {
    console.error('Failed to edit message:', e);
    const msg = await ctx.reply(text, keyboard);
    state.messageId = msg.message_id;
  }
}

async function showEndTimeSelection(ctx: BotContext, service: AvailabilityService, state: AddBookingWizardState) {
  const endOptions = getEndTimeOptions(service, state.startTime!);

  if (endOptions.length === 0) {
    await ctx.answerCbQuery('Немає доступних варіантів закінчення', { show_alert: true });
    return;
  }

  // Отримуємо бронювання на цей день для позначення зайнятих слотів
  const bookings = await service.listBookingsGrouped();
  const dayBookings = bookings.find(g => g.iso === state.dateISO)?.bookings || [];

  // Перевіряємо чи є слоти з чаном та без
  const hasWithChan = dayBookings.some(b => b.withChan);
  const hasWithoutChan = dayBookings.some(b => !b.withChan);

  const legendParts: string[] = [];
  if (hasWithoutChan) legendParts.push('🟡 - зайнято без чану');
  if (hasWithChan) legendParts.push('🔵 - зайнято з чаном');

  const text = [
    'Крок 3/4. Оберіть час закінчення ⏰',
    '',
    `📅 День: ${state.dateLabel}`,
    `🕐 Початок: ${state.startTime}`,
    legendParts.length > 0 ? legendParts.join(', ') : '',
  ].filter(Boolean).join('\n');

  const keyboard = buildEndTimesKeyboard(endOptions, dayBookings);

  try {
    await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, text, keyboard);
  } catch (e) {
    console.error('Failed to edit message:', e);
    const msg = await ctx.reply(text, keyboard);
    state.messageId = msg.message_id;
  }
}

async function showGapWarning(ctx: BotContext, state: AddBookingWizardState, endTime: string) {
  const text = [
    '⚠️ Увага!',
    'Це бронювання залишить вікно менше 2 годин.',
    'Це може ускладнити продаж сусідніх слотів.',
    '',
    'Ви впевнені, що хочете продовжити?'
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Так, залишити як є', `${CONFIRM_GAP_ACTION_PREFIX}${endTime}`)],
    [Markup.button.callback('⬅️ Ні, змінити час', BACK_ACTION)]
  ]);

  try {
    await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, text, keyboard);
  } catch (e) {
    await ctx.reply(text, keyboard);
  }
}

async function showOverlapWarning(ctx: BotContext, state: AddBookingWizardState) {
  const text = [
    '⚠️ Увага: перекриття!',
    '',
    'Вже є бронювання на цей час:',
    state.overlappingInfo,
    '',
    `Ваш новий слот: ${state.startTime} – ${state.endTime}`,
    '',
    '❓ Бажаєте перезаписати існуючі бронювання?',
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Так, перезаписати', CONFIRM_OVERLAP_ACTION)],
    [Markup.button.callback('❌ Ні, скасувати', CANCEL_OVERLAP_ACTION)],
    [Markup.button.callback('⬅️ Змінити час', BACK_ACTION)]
  ]);

  try {
    await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, text, keyboard);
  } catch (e) {
    await ctx.reply(text, keyboard);
  }
}

async function showChanSelection(ctx: BotContext, service: AvailabilityService, state: AddBookingWizardState) {
  // Перевіряємо чи є якісь обмеження (тільки для розігріву, не для раннього часу - він тепер дозволений з попередженням)
  const chanCheck = await service.isChanHeatingPossible(state.dateISO!, state.startTime!);

  // Якщо чан неможливий через розігрів (не через ранній час і не через зайнятість) - показуємо причину і пропонуємо зберегти без чану
  const isHeatingProblem = !chanCheck.possible &&
    chanCheck.reason !== 'Чан вже заброньовано на цей день' &&
    chanCheck.reason !== 'Чан доступний тільки з 13:00';

  if (isHeatingProblem) {
    const text = [
      'Крок 4/4. Чан недоступний 🛁',
      '',
      `📅 День: ${state.dateLabel}`,
      `⏰ Час: ${state.startTime} – ${state.endTime}`,
      '',
      `⚠️ ${chanCheck.reason}`,
      '',
      'Зберегти бронювання без чану?',
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Так, зберегти без чану', SKIP_CHAN_ACTION)],
      [Markup.button.callback('⬅️ Назад', BACK_ACTION)],
      [Markup.button.callback('❌ Скасувати', CANCEL_ACTION)]
    ]);

    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, text, keyboard);
    } catch (e) {
      const msg = await ctx.reply(text, keyboard);
      state.messageId = msg.message_id;
    }
    return;
  }

  const text = [
    'Крок 4/4. Це бронювання з чаном? 🛁',
    '',
    `📅 День: ${state.dateLabel}`,
    `⏰ Час: ${state.startTime} – ${state.endTime}`,
  ].join('\n');

  const keyboard = buildChanAvailabilityKeyboard();

  try {
    await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, text, keyboard);
  } catch (e) {
    console.error('Failed to edit message:', e);
    const msg = await ctx.reply(text, keyboard);
    state.messageId = msg.message_id;
  }
}

async function showChanWarning(ctx: BotContext, state: AddBookingWizardState) {
  const text = [
    '⚠️ Сьогодні вже є чан',
    '',
    `Чан на: ${state.existingChanInfo}`,
    '',
    `Додати чан і на це бронювання?`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Так, додати', CONFIRM_CHAN_WARNING_ACTION),
      Markup.button.callback('❌ Без чану', SKIP_CHAN_ACTION),
    ],
    [Markup.button.callback('⬅️ Назад', BACK_ACTION)]
  ]);

  try {
    await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, text, keyboard);
  } catch (e) {
    await ctx.reply(text, keyboard);
  }
}

async function showEarlyChanWarning(ctx: BotContext, state: AddBookingWizardState) {
  const text = [
    '⚠️ Ранній час для чану',
    '',
    `📅 День: ${state.dateLabel}`,
    `⏰ Час: ${state.startTime} – ${state.endTime}`,
    '',
    'Зазвичай чан доступний з 13:00.',
    'Ви впевнені, що хочете бронювання з чаном на такий ранній час?',
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Так, з чаном', CONFIRM_EARLY_CHAN_ACTION),
      Markup.button.callback('❌ Без чану', SKIP_CHAN_ACTION),
    ],
    [Markup.button.callback('⬅️ Назад', BACK_ACTION)]
  ]);

  try {
    await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, text, keyboard);
  } catch (e) {
    await ctx.reply(text, keyboard);
  }
}

async function handleFullDay(ctx: BotContext, service: AvailabilityService, state: AddBookingWizardState) {
  const { dateISO, dateLabel } = state;
  if (!dateISO) {
    await ctx.answerCbQuery('Помилка: день не обрано', { show_alert: true });
    return ctx.scene.leave();
  }

  try {
    await ctx.answerCbQuery('Бронюю весь день...');

    // 1. 09:00-13:00 (No Chan)
    const booking1 = await service.addBooking({
      dateISO,
      startTime: '09:00',
      endTime: '13:00',
      createdBy: ctx.from?.id ?? 0,
      withChan: false,
    });

    // 2. 13:00-24:00 (With Chan)
    const booking2 = await service.addBooking({
      dateISO,
      startTime: '13:00',
      endTime: '24:00',
      createdBy: ctx.from?.id ?? 0,
      withChan: true,
    });

    const resultText = [
      '✅ Заброньовано весь день!',
      '',
      `📅 ${dateLabel}`,
      '',
      '1️⃣ Ранок:',
      `⏱ ${booking1.startTime} – ${booking1.endTime}`,
      `🛁 Чан: ні (топиться)`,
      '',
      '2️⃣ День/Вечір:',
      `⏱ ${booking2.startTime} – ${booking2.endTime}`,
      `🛁 Чан: так`,
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Додати ще бронювання', 'slot:add:another')],
      [Markup.button.callback('🖼 Показати розклад', 'slot:show:schedule')],
      [Markup.button.callback('🏠 Головне меню', 'slot:add:done')]
    ]);

    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, resultText, keyboard);
    } catch (e) {
      await ctx.reply(resultText, keyboard);
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : 'Не вдалося створити бронювання';
    await ctx.answerCbQuery(errorText, { show_alert: true });
    return;
  }

  return ctx.scene.leave();
}

async function saveBooking(ctx: BotContext, service: AvailabilityService, state: AddBookingWizardState) {
  const { dateISO, dateLabel, startTime, endTime, withChan, forceChan, overlappingIds } = state;
  if (!dateISO || !startTime || !endTime || withChan === undefined) {
    await ctx.answerCbQuery('Щось пішло не так 🙏', { show_alert: true });
    return ctx.scene.leave();
  }

  try {
    let booking;
    const payload = {
      dateISO,
      startTime,
      endTime,
      createdBy: ctx.from?.id ?? 0,
      withChan,
      forceChan: forceChan || false,
    };

    // Якщо є перекриваючі бронювання - замінюємо їх
    if (overlappingIds && overlappingIds.length > 0) {
      booking = await service.replaceBookings(overlappingIds, payload);
    } else {
      booking = await service.addBooking(payload);
    }

    await ctx.answerCbQuery('Готово ✅');

    const replacedText = overlappingIds && overlappingIds.length > 0
      ? `\n🔄 Замінено ${overlappingIds.length} бронювання`
      : '';

    const resultText = [
      '✅ Бронювання додано!',
      '',
      `📅 ${dateLabel}`,
      `⏱ ${booking.startTime} – ${booking.endTime}`,
      `🛁 Чан: ${booking.withChan ? 'так' : 'ні'}`,
      `⏳ Тривалість: ${(booking.durationMinutes / 60).toFixed(1)} год.${replacedText}`,
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✏️ Редагувати', `slot:edit:${booking.id}`),
        Markup.button.callback('🗑 Видалити', `slot:delete:${booking.id}`)
      ],
      [Markup.button.callback('🖼 Показати розклад', 'slot:show:schedule')],
      [Markup.button.callback('🏠 Головне меню', 'slot:add:done')]
    ]);

    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, resultText, keyboard);
    } catch (e) {
      await ctx.reply(resultText, keyboard);
    }
  } catch (error) {
    await ctx.answerCbQuery('Помилка ⛔️', { show_alert: true });
    const errorText = error instanceof Error ? error.message : 'Не вдалося зберегти';
    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId!, undefined, `❌ ${errorText}`);
    } catch (e) {
      await ctx.reply(`❌ ${errorText}`);
    }
    return;
  }

  return ctx.scene.leave();
}

async function handleCancel(ctx: BotContext, state: AddBookingWizardState) {
  await ctx.answerCbQuery('Скасовано');

  try {
    if (state.messageId) {
      await ctx.telegram.editMessageText(ctx.chat!.id, state.messageId, undefined, '❌ Скасовано');
    }
  } catch (e) {
    await ctx.reply('❌ Скасовано');
  }
}

// === KEYBOARD BUILDERS ===

function buildDaysKeyboard(service: AvailabilityService, weekOffset = 0) {
  const days = service.getScheduleDays(weekOffset);
  const buttons = days.map((day) =>
    Markup.button.callback(day.label, `slot:add:date:${day.iso}`)
  );
  const rows = splitIntoRows(buttons, 2);

  const navButtons = [];
  if (weekOffset > 0) {
    navButtons.push(Markup.button.callback('⬅️ Попередній тиждень', PREV_WEEK_ACTION));
  }
  navButtons.push(Markup.button.callback('Наступний тиждень ➡️', NEXT_WEEK_ACTION));

  if (navButtons.length > 0) {
    rows.push(navButtons);
  }

  rows.push([Markup.button.callback('❌ Скасувати', CANCEL_ACTION)]);
  return Markup.inlineKeyboard(rows);
}

function buildStartTimesKeyboard(service: AvailabilityService, dateISO: string, dayBookings: Array<{ startTime: string; endTime: string; withChan?: boolean }> = []) {
  const times = getAvailableStartTimes(service, dateISO);

  // Функція для перевірки чи час входить в зайнятий слот та чи є там чан
  const getTimeStatus = (time: string): { busy: boolean; withChan: boolean } => {
    const timeMinutes = timeToMinutes(time);
    for (const booking of dayBookings) {
      const startMinutes = timeToMinutes(booking.startTime);
      const endMinutes = timeToMinutes(booking.endTime);
      // Час зайнятий якщо він >= start і < end бронювання
      if (timeMinutes >= startMinutes && timeMinutes < endMinutes) {
        return { busy: true, withChan: booking.withChan || false };
      }
    }
    return { busy: false, withChan: false };
  };

  const buttons = times.map((time) => {
    const status = getTimeStatus(time);
    let label = time;
    if (status.busy) {
      label = status.withChan ? `🔵 ${time}` : `🟡 ${time}`;
    }
    return Markup.button.callback(label, `slot:add:start:${time}`);
  });
  const rows = splitIntoRows(buttons, 3);

  const { dayOpenTime, dayCloseTime } = service.schedule;
  rows.unshift([Markup.button.callback(`⚡️ Весь день (${dayOpenTime} - ${dayCloseTime})`, FULL_DAY_ACTION)]);

  rows.push([
    Markup.button.callback('⬅️ Назад', BACK_ACTION),
    Markup.button.callback('❌ Скасувати', CANCEL_ACTION)
  ]);
  return Markup.inlineKeyboard(rows);
}

function buildEndTimesKeyboard(options: string[], dayBookings: Array<{ startTime: string; endTime: string; withChan?: boolean }> = []) {
  // Функція для перевірки чи час входить в зайнятий слот та чи є там чан
  const getTimeStatus = (time: string): { busy: boolean; withChan: boolean } => {
    const timeMinutes = timeToMinutes(time);
    for (const booking of dayBookings) {
      const startMinutes = timeToMinutes(booking.startTime);
      const endMinutes = timeToMinutes(booking.endTime);
      // Час зайнятий якщо він > start і <= end бронювання (для end time)
      if (timeMinutes > startMinutes && timeMinutes <= endMinutes) {
        return { busy: true, withChan: booking.withChan || false };
      }
    }
    return { busy: false, withChan: false };
  };

  const buttons = options.map((time) => {
    const status = getTimeStatus(time);
    let label = time;
    if (status.busy) {
      label = status.withChan ? `🔵 ${time}` : `🟡 ${time}`;
    }
    return Markup.button.callback(label, `slot:add:end:${time}`);
  });
  const rows = splitIntoRows(buttons, 3);
  rows.push([
    Markup.button.callback('⬅️ Назад', BACK_ACTION),
    Markup.button.callback('❌ Скасувати', CANCEL_ACTION)
  ]);
  return Markup.inlineKeyboard(rows);
}

function buildChanAvailabilityKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Так, з чаном', 'slot:add:chan:yes'),
      Markup.button.callback('❌ Ні, без чану', 'slot:add:chan:no'),
    ],
    [
      Markup.button.callback('⬅️ Назад', BACK_ACTION),
      Markup.button.callback('❌ Скасувати', CANCEL_ACTION)
    ]
  ]);
}

// === HELPER FUNCTIONS ===

function getAvailableStartTimes(service: AvailabilityService, dateISO: string): string[] {
  const allTimes = service.getTimeOptions();
  const timeZone = service.timeZone;

  const now = new Date();
  const zonedNow = toZonedTime(now, timeZone);
  const todayISO = format(zonedNow, 'yyyy-MM-dd');

  // Максимальний час початку = dayCloseTime - мін. тривалість (2 години)
  const dayCloseMinutes = timeToMinutes(service.schedule.dayCloseTime);
  const minDurationMinutes = 120;
  const maxStartMinutes = dayCloseMinutes - minDurationMinutes;

  let filteredTimes = allTimes.filter((time) => timeToMinutes(time) <= maxStartMinutes);

  if (dateISO === todayISO) {
    const currentHours = zonedNow.getHours();
    const currentMinutes = zonedNow.getMinutes();
    const currentTotalMinutes = currentHours * 60 + currentMinutes;

    filteredTimes = filteredTimes.filter((time) => {
      const timeMinutes = timeToMinutes(time);
      return timeMinutes >= currentTotalMinutes;
    });
  }

  return filteredTimes;
}

function getEndTimeOptions(service: AvailabilityService, startTime: string): string[] {
  const startMinutes = timeToMinutes(startTime);
  const minDurationMinutes = 120; // Мінімум 2 години
  return service
    .getEndTimeOptions()
    .filter((time) => timeToMinutes(time) - startMinutes >= minDurationMinutes);
}

function splitIntoRows<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function getState(ctx: BotContext): AddBookingWizardState {
  return ctx.wizard.state as AddBookingWizardState;
}

function readCallbackData(ctx: BotContext): string | null {
  const query = ctx.callbackQuery;
  if (query && 'data' in query && typeof query.data === 'string') {
    return query.data;
  }
  return null;
}

function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map((n) => parseInt(n, 10));
  return hours * 60 + minutes;
}

export { SCENE_ID as ADD_SLOT_SCENE_ID };
