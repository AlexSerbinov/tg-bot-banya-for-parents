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

  getScheduleDays(weekOffset = 0): { date: Date; iso: string; label: string }[] {
    const days = this.computeDisplayDays(weekOffset);
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
    return Array.from(grouped.entries())
      .sort(([isoA], [isoB]) => isoA.localeCompare(isoB))
      .map(([iso, daySlots]) => ({
        iso,
        slots: daySlots.sort((a, b) => a.startTime.localeCompare(b.startTime)),
      }));
  }

  async listAllSlots(): Promise<AvailabilitySlot[]> {
    const grouped = await this.listSlotsGrouped();
    return grouped.flatMap((entry) => entry.slots);
  }

  async getSlotById(id: string): Promise<AvailabilitySlot | undefined> {
    const slots = await this.store.list();
    console.log('[getSlotById] Looking for id:', id);
    console.log('[getSlotById] Available slot IDs:', slots.map(s => s.id).join(', '));
    const found = slots.find((slot) => slot.id === id);
    console.log('[getSlotById] Result:', found ? 'FOUND' : 'NOT FOUND');
    return found;
  }

  async removeSlot(slotId: string): Promise<boolean> {
    return this.store.remove(slotId);
  }

  async updateSlotTimes(slotId: string, startTime: string, endTime: string): Promise<AvailabilitySlot> {
    this.assertTimeFormat(startTime);
    this.assertTimeFormat(endTime);
    this.assertMinuteStep(startTime);
    this.assertMinuteStep(endTime);

    const slot = await this.getSlotById(slotId);
    if (!slot) {
      throw new Error('Слот не знайдено');
    }

    const slotStart = toDateAtTime(slot.dateISO, startTime, this.timeZone);
    const slotEnd = toDateAtTime(slot.dateISO, endTime, this.timeZone);
    if (slotEnd <= slotStart) {
      throw new Error('Кінець має бути пізніше початку');
    }

    const dayOpen = toDateAtTime(slot.dateISO, this.schedule.dayOpenTime, this.timeZone);
    const dayClose = toDateAtTime(slot.dateISO, this.schedule.dayCloseTime, this.timeZone);
    if (slotStart < dayOpen || slotEnd > dayClose) {
      throw new Error('Слот виходить за межі дня');
    }

    const daySlots = await this.store.listByDate(slot.dateISO);
    const overlaps = daySlots.some((other) => {
      if (other.id === slotId) return false;
      const otherStart = toDateAtTime(other.dateISO, other.startTime, this.timeZone);
      const otherEnd = toDateAtTime(other.dateISO, other.endTime, this.timeZone);
      return rangesOverlap(slotStart, slotEnd, otherStart, otherEnd);
    });

    if (overlaps) {
      throw new Error('Слот перетинається з іншим');
    }

    slot.startTime = startTime;
    slot.endTime = endTime;
    slot.durationMinutes = differenceInMinutes(slotEnd, slotStart);

    const updated = daySlots.map((other) => (other.id === slotId ? slot : other));
    await this.store.setSlotsForDate(slot.dateISO, updated);
    return slot;
  }

  async toggleChanAvailability(slotId: string): Promise<AvailabilitySlot> {
    const slot = await this.getSlotById(slotId);
    if (!slot) {
      throw new Error('Слот не знайдено');
    }
    slot.chanAvailable = !slot.chanAvailable;
    const daySlots = await this.store.listByDate(slot.dateISO);
    const updated = daySlots.map((other) => (other.id === slotId ? slot : other));
    await this.store.setSlotsForDate(slot.dateISO, updated);
    return slot;
  }

  async addSlotRange(payload: SlotCreationPayload): Promise<AvailabilitySlot> {
    this.assertTimeFormat(payload.startTime);
    this.assertTimeFormat(payload.endTime);
    this.assertMinuteStep(payload.startTime);
    this.assertMinuteStep(payload.endTime);

    const minuteStep = this.getMinuteStep();
    const slotStart = toDateAtTime(payload.dateISO, payload.startTime, this.timeZone);
    const explicitEnd = toDateAtTime(payload.dateISO, payload.endTime, this.timeZone);
    if (explicitEnd <= slotStart) {
      throw new Error('Час завершення має бути пізнішим за початок');
    }

    const selectedDuration = differenceInMinutes(explicitEnd, slotStart);
    if (selectedDuration < minuteStep) {
      throw new Error(`Мінімальна тривалість — ${minuteStep} хв.`);
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
      chanAvailable: payload.chanAvailable ?? true,
    };

    await this.store.setSlotsForDate(payload.dateISO, [...keep, slot]);
    return slot;
  }

  async clearDay(dateISO: string): Promise<number> {
    return this.store.clearDay(dateISO);
  }

  async buildScheduleImage(weekOffset = 0) {
    const daysMeta = this.getScheduleDays(weekOffset);
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
    const step = this.getMinuteStep();

    const options: string[] = [];
    for (let value = openMinutes; value < closeMinutes; value += step) {
      options.push(minutesToLabel(value));
    }
    return options;
  }

  getEndTimeOptions(): string[] {
    const openMinutes = timeToMinutes(this.schedule.dayOpenTime);
    const closeMinutes = timeToMinutes(this.schedule.dayCloseTime);
    const step = this.getMinuteStep();

    const options: string[] = [];
    // Для часу закінчення включаємо час закриття (23:00)
    for (let value = openMinutes; value <= closeMinutes; value += step) {
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
    const step = this.getMinuteStep();
    if (minutes % step !== 0) {
      throw new Error(`Використовуйте крок ${step} хвилин`);
    }
  }

  getTimeStepMinutes(): number {
    return this.getMinuteStep();
  }

  private getMinuteStep(): number {
    const configured = Number(this.schedule.slotStepMinutes) || 30;
    return Math.min(30, Math.max(5, configured));
  }

  private computeDisplayDays(weekOffset = 0): Date[] {
    const nowZoned = toZonedTime(new Date(), this.timeZone);
    const todayIso = formatDateISO(new Date(), this.timeZone);
    let startDate = toDateAtTime(todayIso, '00:00', this.timeZone);
    if (nowZoned.getHours() >= 22) {
      startDate = addDays(startDate, 1);
    }

    // Додаємо зміщення по тижнях (7 днів)
    startDate = addDays(startDate, weekOffset * 7);

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
