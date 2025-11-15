import { Markup, Scenes } from 'telegraf';
import { AvailabilityService } from '../services/availabilityService';
import { BotContext } from './types';
import { toZonedTime } from 'date-fns-tz';
import { format } from 'date-fns';

const SCENE_ID = 'ADD_SLOT_SCENE';
const CANCEL_ACTION = 'slot:add:cancel';
const BACK_ACTION = 'slot:add:back';
const NEXT_WEEK_ACTION = 'slot:add:nextweek';
const PREV_WEEK_ACTION = 'slot:add:prevweek';

interface AddSlotWizardState {
  dateISO?: string;
  dateLabel?: string;
  startTime?: string;
  endTime?: string;
  chanAvailable?: boolean;
  messageId?: number;
  weekOffset?: number;
}

export function createAddSlotScene(service: AvailabilityService) {
  return new Scenes.WizardScene<BotContext>(
    SCENE_ID,
    // Крок 1: Вибір дня
    async (ctx) => {
      const state = getState(ctx);
      if (state.weekOffset === undefined) {
        state.weekOffset = 0;
      }
      const text = 'Крок 1/4. Оберіть день 📅';

      if (state.messageId) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat!.id,
            state.messageId,
            undefined,
            text,
            buildDaysKeyboard(service, state.weekOffset)
          );
        } catch (e) {
          const msg = await ctx.reply(text, buildDaysKeyboard(service, state.weekOffset));
          state.messageId = msg.message_id;
        }
      } else {
        const msg = await ctx.reply(text, buildDaysKeyboard(service, state.weekOffset));
        state.messageId = msg.message_id;
      }

      return ctx.wizard.next();
    },
    // Крок 2: Вибір часу початку
    async (ctx) => {
      if (!('callback_query' in ctx.update)) {
        await ctx.scene.leave();
        return;
      }

      const data = readCallbackData(ctx);
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }

      const state = getState(ctx);

      if (data === CANCEL_ACTION) {
        await handleCancel(ctx, state);
        return ctx.scene.leave();
      }

      if (data === BACK_ACTION) {
        await ctx.answerCbQuery();
        return ctx.wizard.selectStep(0);
      }

      if (data === NEXT_WEEK_ACTION) {
        state.weekOffset = (state.weekOffset || 0) + 1;
        await ctx.answerCbQuery();
        return ctx.wizard.selectStep(0);
      }

      if (data === PREV_WEEK_ACTION) {
        state.weekOffset = Math.max(0, (state.weekOffset || 0) - 1);
        await ctx.answerCbQuery();
        return ctx.wizard.selectStep(0);
      }

      const match = data.match(/^slot:add:date:(.+)$/);
      if (!match) {
        await ctx.answerCbQuery('Скористайтеся кнопками 👇', { show_alert: false });
        return;
      }

      const iso = match[1];
      const day = service.getScheduleDays().find(d => d.iso === iso);
      state.dateISO = iso;
      state.dateLabel = day?.label || iso;

      await ctx.answerCbQuery();

      const text = [
        'Крок 2/4. Оберіть час початку ⏰',
        '',
        `📅 День: ${state.dateLabel}`,
      ].join('\n');

      try {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          state.messageId!,
          undefined,
          text,
          buildStartTimesKeyboard(service, iso)
        );
      } catch (e) {
        console.error('Failed to edit message:', e);
      }

      return ctx.wizard.next();
    },
    // Крок 3: Вибір часу закінчення
    async (ctx) => {
      if (!('callback_query' in ctx.update)) {
        await ctx.scene.leave();
        return;
      }

      const data = readCallbackData(ctx);
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }

      const state = getState(ctx);

      if (data === CANCEL_ACTION) {
        await handleCancel(ctx, state);
        return ctx.scene.leave();
      }

      if (data === BACK_ACTION) {
        await ctx.answerCbQuery();
        return ctx.wizard.selectStep(1);
      }

      const match = data.match(/^slot:add:start:(\d{2}:\d{2})$/);
      if (!match) {
        await ctx.answerCbQuery('Обираємо з меню 👇', { show_alert: false });
        return;
      }

      state.startTime = match[1];
      await ctx.answerCbQuery();

      const options = getEndTimeOptions(service, state.startTime);
      if (!options.length) {
        await ctx.answerCbQuery('Не вистачає часу після цієї години', { show_alert: true });
        return;
      }

      const text = [
        'Крок 3/4. Оберіть час закінчення 🏁',
        '',
        `📅 День: ${state.dateLabel}`,
        `⏰ Початок: ${state.startTime}`,
      ].join('\n');

      try {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          state.messageId!,
          undefined,
          text,
          buildEndTimesKeyboard(options)
        );
      } catch (e) {
        console.error('Failed to edit message:', e);
      }

      return ctx.wizard.next();
    },
    // Крок 4: Вибір доступності чану
    async (ctx) => {
      if (!('callback_query' in ctx.update)) {
        await ctx.scene.leave();
        return;
      }

      const data = readCallbackData(ctx);
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }

      const state = getState(ctx);

      if (data === CANCEL_ACTION) {
        await handleCancel(ctx, state);
        return ctx.scene.leave();
      }

      if (data === BACK_ACTION) {
        await ctx.answerCbQuery();
        return ctx.wizard.selectStep(2);
      }

      const match = data.match(/^slot:add:end:(\d{2}:\d{2})$/);
      if (!match) {
        await ctx.answerCbQuery('Користуйтесь кнопками нижче ⬇️', { show_alert: false });
        return;
      }

      state.endTime = match[1];
      await ctx.answerCbQuery();

      const text = [
        'Крок 4/4. Чи буде доступний чан? 🛁',
        '',
        `📅 День: ${state.dateLabel}`,
        `⏰ Час: ${state.startTime} – ${state.endTime}`,
      ].join('\n');

      try {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          state.messageId!,
          undefined,
          text,
          buildChanAvailabilityKeyboard()
        );
      } catch (e) {
        console.error('Failed to edit message:', e);
      }

      return ctx.wizard.next();
    },
    // Крок 5: Збереження
    async (ctx) => {
      if (!('callback_query' in ctx.update)) {
        await ctx.scene.leave();
        return;
      }

      const data = readCallbackData(ctx);
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }

      const state = getState(ctx);

      if (data === CANCEL_ACTION) {
        await handleCancel(ctx, state);
        return ctx.scene.leave();
      }

      if (data === BACK_ACTION) {
        await ctx.answerCbQuery();
        return ctx.wizard.selectStep(3);
      }

      const match = data.match(/^slot:add:chan:(yes|no)$/);
      if (!match) {
        await ctx.answerCbQuery('Оберіть з варіантів нижче ⬇️', { show_alert: false });
        return;
      }

      state.chanAvailable = match[1] === 'yes';

      const { dateISO, startTime, endTime, chanAvailable } = state;
      if (!dateISO || !startTime || !endTime || chanAvailable === undefined) {
        await ctx.answerCbQuery('Щось пішло не так 🙏', { show_alert: true });
        return ctx.scene.leave();
      }

      try {
        const slot = await service.addSlotRange({
          dateISO,
          startTime,
          endTime,
          createdBy: ctx.from?.id ?? 0,
          chanAvailable,
        });

        await ctx.answerCbQuery('Готово ✅');

        // Редагуємо повідомлення на фінальний результат
        const resultText = [
          '✅ Слот створено!',
          '',
          `📅 ${slot.dateISO}`,
          `⏱ ${slot.startTime} – ${slot.endTime}`,
          `🛁 Чан: ${slot.chanAvailable ? 'доступний' : 'недоступний'}`,
          `⏳ Тривалість: ${(slot.durationMinutes / 60).toFixed(1)} год.`,
        ].join('\n');

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('✏️ Редагувати', `slot:edit:${slot.id}`),
            Markup.button.callback('🗑 Видалити', `slot:delete:${slot.id}`)
          ],
          [
            Markup.button.callback('🏠 Головне меню', 'slot:add:done')
          ]
        ]);

        try {
          await ctx.telegram.editMessageText(
            ctx.chat!.id,
            state.messageId!,
            undefined,
            resultText,
            keyboard
          );
        } catch (e) {
          await ctx.reply(resultText, keyboard);
        }
      } catch (error) {
        await ctx.answerCbQuery('Помилка ⛔️', { show_alert: true });
        const errorText = error instanceof Error ? error.message : 'Не вдалося зберегти слот';
        try {
          await ctx.telegram.editMessageText(
            ctx.chat!.id,
            state.messageId!,
            undefined,
            `❌ ${errorText}`
          );
        } catch (e) {
          await ctx.reply(`❌ ${errorText}`);
        }
        return;
      }

      return ctx.scene.leave();
    }
  );
}

async function handleCancel(ctx: Scenes.WizardContext, state: AddSlotWizardState) {
  await ctx.answerCbQuery('Скасовано');

  try {
    if (state.messageId) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        state.messageId,
        undefined,
        '❌ Скасовано'
      );
    }
  } catch (e) {
    await ctx.reply('❌ Скасовано');
  }
}

function buildDaysKeyboard(service: AvailabilityService, weekOffset = 0) {
  const days = service.getScheduleDays(weekOffset);
  const buttons = days.map((day) =>
    Markup.button.callback(day.label, `slot:add:date:${day.iso}`)
  );
  const rows = splitIntoRows(buttons, 2);

  // Додаємо кнопки навігації
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

function buildStartTimesKeyboard(service: AvailabilityService, dateISO: string) {
  const times = getAvailableStartTimes(service, dateISO);
  const buttons = times.map((time) => Markup.button.callback(time, `slot:add:start:${time}`));
  const rows = splitIntoRows(buttons, 3);
  rows.push([
    Markup.button.callback('⬅️ Назад', BACK_ACTION),
    Markup.button.callback('❌ Скасувати', CANCEL_ACTION)
  ]);
  return Markup.inlineKeyboard(rows);
}

function getAvailableStartTimes(service: AvailabilityService, dateISO: string): string[] {
  const allTimes = service.getTimeOptions();
  const timeZone = service.timeZone;

  const now = new Date();
  const zonedNow = toZonedTime(now, timeZone);
  const todayISO = format(zonedNow, 'yyyy-MM-dd');

  const maxStartTime = '22:00';
  const maxStartMinutes = timeToMinutes(maxStartTime);

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

function buildEndTimesKeyboard(options: string[]) {
  const buttons = options.map((time) => Markup.button.callback(`${time}`, `slot:add:end:${time}`));
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
      Markup.button.callback('✅ Чан доступний', 'slot:add:chan:yes'),
      Markup.button.callback('❌ Чан недоступний', 'slot:add:chan:no'),
    ],
    [
      Markup.button.callback('⬅️ Назад', BACK_ACTION),
      Markup.button.callback('❌ Скасувати', CANCEL_ACTION)
    ]
  ]);
}

function splitIntoRows<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function getState(ctx: BotContext): AddSlotWizardState {
  return ctx.wizard.state as AddSlotWizardState;
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
