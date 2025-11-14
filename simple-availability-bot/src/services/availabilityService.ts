import { addDays, addMinutes, differenceInMinutes } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { randomUUID } from 'node:crypto';
import { AvailabilityStore } from '../storage/availabilityStore';
import {
  AppConfig,
  AvailabilitySlot,
  ScheduleSettings,
  SlotCreationPayload,
} from '../types';
import { dateToISO, toDateAtTime, formatDate, formatDateISO, formatTime } from '../utils/time';
import { generateAvailabilityImage } from '../core/scheduleImage';

export class AvailabilityService {
  constructor(
    private readonly store: AvailabilityStore,
    private readonly config: AppConfig
  ) {}

  get schedule(): ScheduleSettings {
    return this.config.schedule;
  }

  get timeZone(): string {
    return this.config.schedule.timeZone;
  }

  getScheduleDays(): { date: Date; iso: string; label: string }[] {
    const days = this.computeDisplayDays();
    return days.map((date) => ({
      date,
      iso: dateToISO(date),
      label: formatDate(date, this.timeZone),
    }));
  }

  async listSlotsGrouped(): Promise<Array<{ iso: string; slots: AvailabilitySlot[] }>> {
    const slots = await this.store.list();
    const grouped = new Map<string, AvailabilitySlot[]>();
    slots.forEach((slot) => {
      if (!grouped.has(slot.dateISO)) {
        grouped.set(slot.dateISO, []);
      }
      grouped.get(slot.dateISO)!.push(slot);
    });
    return Array.from(grouped.entries()).map(([iso, daySlots]) => ({
      iso,
      slots: daySlots.sort((a, b) => a.startTime.localeCompare(b.startTime)),
    }));
  }

  async addSlotRange(payload: SlotCreationPayload): Promise<AvailabilitySlot> {
    this.assertTimeFormat(payload.startTime);
    this.assertTimeFormat(payload.endTime);
    this.assertMinuteStep(payload.startTime);
    this.assertMinuteStep(payload.endTime);

    const slotStart = toDateAtTime(payload.dateISO, payload.startTime, this.timeZone);
    const explicitEnd = toDateAtTime(payload.dateISO, payload.endTime, this.timeZone);
    if (explicitEnd <= slotStart) {
      throw new Error('Час завершення має бути пізнішим за початок');
    }

    const minDurationMinutes = this.getMinimumDurationMinutes();
    const selectedDuration = differenceInMinutes(explicitEnd, slotStart);
    if (selectedDuration < minDurationMinutes) {
      const hours = (minDurationMinutes / 60).toFixed(0);
      throw new Error(`Мінімальна тривалість — ${hours} год.`);
    }

    const dayOpen = toDateAtTime(payload.dateISO, this.schedule.dayOpenTime, this.timeZone);
    const dayClose = toDateAtTime(payload.dateISO, this.schedule.dayCloseTime, this.timeZone);

    if (slotStart < dayOpen) {
      throw new Error('Слот починається раніше відкриття дня');
    }

    if (explicitEnd > dayClose) {
      throw new Error('Слот виходить за межі робочого дня');
    }

    const existing = await this.store.listByDate(payload.dateISO);
    let mergedStart = slotStart;
    let mergedEnd = explicitEnd;
    const keep: AvailabilitySlot[] = [];

    existing.forEach((slot) => {
      const existingStart = toDateAtTime(slot.dateISO, slot.startTime, this.timeZone);
      const existingEnd = toDateAtTime(slot.dateISO, slot.endTime, this.timeZone);
      if (rangesTouchOrOverlap(mergedStart, mergedEnd, existingStart, existingEnd)) {
        mergedStart = new Date(Math.min(mergedStart.getTime(), existingStart.getTime()));
        mergedEnd = new Date(Math.max(mergedEnd.getTime(), existingEnd.getTime()));
        return;
      }
      keep.push(slot);
    });

    const durationMinutes = differenceInMinutes(mergedEnd, mergedStart);

    const slot: AvailabilitySlot = {
      id: generateId(),
      dateISO: payload.dateISO,
      startTime: formatTime(mergedStart, this.timeZone),
      endTime: formatTime(mergedEnd, this.timeZone),
      durationMinutes,
      createdBy: payload.createdBy,
      createdAt: new Date().toISOString(),
      note: payload.note?.trim() || undefined,
    };

    await this.store.setSlotsForDate(payload.dateISO, [...keep, slot]);
    return slot;
  }

  async clearDay(dateISO: string): Promise<number> {
    return this.store.clearDay(dateISO);
  }

  async removeSlot(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  async buildScheduleImage() {
    const daysMeta = this.getScheduleDays();
    const days = daysMeta.map((meta) => meta.date);
    const availability = await this.store.list();
    return generateAvailabilityImage({
      days,
      settings: this.schedule,
      availability,
    });
  }

  async buildAvailableSummary(limit = 5): Promise<string> {
    const slots = await this.store.list();
    if (!slots.length) {
      return 'Наразі вільних слотів немає. Спробуйте трохи пізніше 🙏';
    }

    const items = slots.slice(0, limit).map((slot) => {
      const start = toDateAtTime(slot.dateISO, slot.startTime, this.timeZone);
      const end = toDateAtTime(slot.dateISO, slot.endTime, this.timeZone);
      return `• ${formatDate(start, this.timeZone)}: ${formatTime(start, this.timeZone)} – ${formatTime(
        end,
        this.timeZone
      )}`;
    });

    return `Ось найближчі вільні вікна:\n${items.join('\n')}`;
  }

  async describeDayAvailability(dateISO: string): Promise<string> {
    const slots = await this.store.listByDate(dateISO);
    if (!slots.length) {
      return 'На цей день ще не додавали вільних годин.';
    }

    const lines = slots
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .map((slot) => `• ${slot.startTime} – ${slot.endTime}`);
    return `Вже відкрито:\n${lines.join('\n')}`;
  }

  getTimeOptions(): string[] {
    const openMinutes = timeToMinutes(this.schedule.dayOpenTime);
    const closeMinutes = timeToMinutes(this.schedule.dayCloseTime);
    const step = Math.max(15, this.schedule.slotStepMinutes);

    const options: string[] = [];
    for (let value = openMinutes; value < closeMinutes; value += step) {
      options.push(minutesToLabel(value));
    }
    return options;
  }

  private assertTimeFormat(time: string) {
    if (!/^\d{2}:\d{2}$/.test(time)) {
      throw new Error('Очікуваний формат часу HH:mm');
    }
  }

  private assertMinuteStep(time: string) {
    const [, minutesStr] = time.split(':');
    const minutes = Number(minutesStr);
    if (!Number.isFinite(minutes)) return;
    const step = Math.max(5, this.schedule.slotStepMinutes);
    if (minutes % step !== 0) {
      throw new Error(`Використовуйте крок ${step} хвилин`);
    }
  }

  private getMinimumDurationMinutes(): number {
    const allowed = this.config.schedule.allowedDurationsHours;
    if (allowed.length) {
      return Math.min(...allowed) * 60;
    }
    return 120;
  }

  private computeDisplayDays(): Date[] {
    const nowZoned = toZonedTime(new Date(), this.timeZone);
    const todayIso = formatDateISO(new Date(), this.timeZone);
    let startDate = toDateAtTime(todayIso, '00:00', this.timeZone);
    if (nowZoned.getHours() >= 22) {
      startDate = addDays(startDate, 1);
    }

    return Array.from({ length: this.schedule.scheduleDays }, (_, idx) =>
      addDays(startDate, idx)
    );
  }
}

function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map((n) => parseInt(n, 10));
  return hours * 60 + minutes;
}

function minutesToLabel(totalMinutes: number): string {
  const hrs = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, '0');
  const mins = (totalMinutes % 60).toString().padStart(2, '0');
  return `${hrs}:${mins}`;
}

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function rangesTouchOrOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function generateId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}
