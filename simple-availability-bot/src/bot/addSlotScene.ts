import { Markup, Scenes } from 'telegraf';
import { AvailabilityService } from '../services/availabilityService';
import { BotContext } from './types';

const SCENE_ID = 'ADD_SLOT_SCENE';
const CANCEL_ACTION = 'slot:add:cancel';

interface AddSlotWizardState {
  dateISO?: string;
  startTime?: string;
  endTime?: string;
}

export function createAddSlotScene(service: AvailabilityService) {
  return new Scenes.WizardScene<BotContext>(
    SCENE_ID,
    async (ctx) => {
      await ctx.reply(
        'Крок 1/3. Оберіть день, де треба позначити вільний час 👇',
        buildDaysKeyboard(service)
      );
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (!('callback_query' in ctx.update)) {
        await ctx.reply('Натисніть кнопку нижче ⬇️');
        return;
      }

      const data = readCallbackData(ctx);
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }
      if (data === CANCEL_ACTION) {
        await handleCancel(ctx);
        return ctx.scene.leave();
      }

      const match = data.match(/^slot:add:date:(.+)$/);
      if (!match) {
        await ctx.answerCbQuery('Скористайтеся кнопками 👇', { show_alert: false });
        return;
      }

      const iso = match[1];
      const state = getState(ctx);
      state.dateISO = iso;
      await ctx.answerCbQuery('День обрано ✅');

      const summary = await service.describeDayAvailability(iso);
      await ctx.reply(summary);

      await ctx.reply(
        'Крок 2/3. Оберіть ПОЧАТОК вільного проміжку ⏰',
        buildStartTimesKeyboard(service)
      );
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (!('callback_query' in ctx.update)) {
        await ctx.reply('Будь ласка, оберіть час за допомогою кнопок.');
        return;
      }

      const data = readCallbackData(ctx);
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }
      if (data === CANCEL_ACTION) {
        await handleCancel(ctx);
        return ctx.scene.leave();
      }

      const match = data.match(/^slot:add:start:(\d{2}:\d{2})$/);
      if (!match) {
        await ctx.answerCbQuery('Обираємо з меню 👇', { show_alert: false });
        return;
      }

      const state = getState(ctx);
      state.startTime = match[1];
      await ctx.answerCbQuery('Початок зафіксовано ✅');

      const options = getEndTimeOptions(service, state.startTime);
      if (!options.length) {
        await ctx.reply('Не вистачає часу після цієї години. Оберіть інший початок ⏮️');
        return;
      }

      await ctx.reply(
        'Крок 3/3. Оберіть ЗАКІНЧЕННЯ проміжку 🏁',
        buildEndTimesKeyboard(options)
      );
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (!('callback_query' in ctx.update)) {
        await ctx.reply('Оберіть час завершення за допомогою кнопок ⬇️');
        return;
      }

      const data = readCallbackData(ctx);
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }
      if (data === CANCEL_ACTION) {
        await handleCancel(ctx);
        return ctx.scene.leave();
      }

      const match = data.match(/^slot:add:end:(\d{2}:\d{2})$/);
      if (!match) {
        await ctx.answerCbQuery('Користуйтесь кнопками нижче ⬇️', { show_alert: false });
        return;
      }

      const state = getState(ctx);
      state.endTime = match[1];

      const { dateISO, startTime, endTime } = state;
      if (!dateISO || !startTime || !endTime) {
        await ctx.answerCbQuery('Щось пішло не так, спробуйте спочатку 🙏', { show_alert: true });
        return ctx.scene.leave();
      }

      try {
        const slot = await service.addSlotRange({
          dateISO,
          startTime,
          endTime,
          createdBy: ctx.from?.id ?? 0,
        });

        await ctx.answerCbQuery('Готово ✅');
        await ctx.reply(
          [
            'Оновили вільний проміжок:',
            `📅 ${slot.dateISO}`,
            `⏱ ${slot.startTime} – ${slot.endTime}`,
            `Тривалість: ${(slot.durationMinutes / 60).toFixed(1)} год.`,
          ].join('\n')
        );
      } catch (error) {
        await ctx.answerCbQuery('Помилка ⛔️', { show_alert: false });
        await ctx.reply(
          error instanceof Error ? error.message : 'Не вдалося зберегти слот. Спробуйте ще.'
        );
        return;
      }

      await ctx.reply('Готово! Можете додати ще один проміжок або повернутися до меню.');
      return ctx.scene.leave();
    }
  );
}

async function handleCancel(ctx: Scenes.WizardContext) {
  await ctx.answerCbQuery('Скасовано');
  await ctx.reply('Добре, нічого не зберігаємо. Поверніться в меню /admin');
}

function buildDaysKeyboard(service: AvailabilityService) {
  const days = service.getScheduleDays();
  const buttons = days.map((day) =>
    Markup.button.callback(day.label, `slot:add:date:${day.iso}`)
  );
  return Markup.inlineKeyboard(splitIntoRows(buttons, 2).concat([cancelRow()]));
}

function buildStartTimesKeyboard(service: AvailabilityService) {
  const times = service.getTimeOptions();
  const buttons = times.map((time) => Markup.button.callback(time, `slot:add:start:${time}`));
  return Markup.inlineKeyboard(splitIntoRows(buttons, 3).concat([cancelRow()]));
}

function getEndTimeOptions(service: AvailabilityService, startTime: string): string[] {
  const startMinutes = timeToMinutes(startTime);
  const minDurationMinutes = getMinimumDurationMinutes(service);
  return service
    .getTimeOptions()
    .filter((time) => timeToMinutes(time) - startMinutes >= minDurationMinutes);
}

function buildEndTimesKeyboard(options: string[]) {
  const buttons = options.map((time) => Markup.button.callback(`${time}`, `slot:add:end:${time}`));
  return Markup.inlineKeyboard(splitIntoRows(buttons, 3).concat([cancelRow()]));
}

function splitIntoRows<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function cancelRow() {
  return [Markup.button.callback('❌ Скасувати', CANCEL_ACTION)];
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

function getMinimumDurationMinutes(service: AvailabilityService): number {
  const allowed = service.schedule.allowedDurationsHours;
  const minHours = allowed.length ? Math.min(...allowed) : 2;
  return minHours * 60;
}

export { SCENE_ID as ADD_SLOT_SCENE_ID };
