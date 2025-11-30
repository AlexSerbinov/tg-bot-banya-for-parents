import { addDays, addMinutes, differenceInMinutes, isBefore, isAfter, isEqual } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { randomUUID } from 'node:crypto';
import { AvailabilityStore } from '../storage/availabilityStore';
import {
  AppConfig,
  Booking,
  ScheduleSettings,
  BookingCreationPayload,
} from '../types';
import { dateToISO, toDateAtTime, formatDate, formatDateISO, formatTime } from '../utils/time';
import { generateAvailabilityImage } from '../core/scheduleImage';
import { PerfLogger } from '../utils/perfLogger';

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

  async listBookingsGrouped(): Promise<Array<{ iso: string; bookings: Booking[] }>> {
    const end = PerfLogger.start('SERVICE: listBookingsGrouped');
    try {
      const bookings = await this.store.list();
      const grouped = new Map<string, Booking[]>();
      bookings.forEach((booking) => {
        if (!grouped.has(booking.dateISO)) {
          grouped.set(booking.dateISO, []);
        }
        grouped.get(booking.dateISO)!.push(booking);
      });
      return Array.from(grouped.entries())
        .sort(([isoA], [isoB]) => isoA.localeCompare(isoB))
        .map(([iso, dayBookings]) => ({
          iso,
          bookings: dayBookings.sort((a, b) => a.startTime.localeCompare(b.startTime)),
        }));
    } finally {
      end();
    }
  }

  async listAllBookings(): Promise<Booking[]> {
    const grouped = await this.listBookingsGrouped();
    return grouped.flatMap((entry) => entry.bookings);
  }

  async getBookingById(id: string): Promise<Booking | undefined> {
    const bookings = await this.store.list();
    return bookings.find((b) => b.id === id);
  }

  async removeBooking(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  async updateBookingTimes(id: string, startTime: string, endTime: string): Promise<Booking> {
    this.assertTimeFormat(startTime);
    this.assertTimeFormat(endTime);
    this.assertMinuteStep(startTime);
    this.assertMinuteStep(endTime);

    const booking = await this.getBookingById(id);
    if (!booking) {
      throw new Error('Бронювання не знайдено');
    }

    const start = toDateAtTime(booking.dateISO, startTime, this.timeZone);
    const end = toDateAtTime(booking.dateISO, endTime, this.timeZone);
    if (end <= start) {
      throw new Error('Кінець має бути пізніше початку');
    }

    const dayOpen = toDateAtTime(booking.dateISO, this.schedule.dayOpenTime, this.timeZone);
    const dayClose = toDateAtTime(booking.dateISO, this.schedule.dayCloseTime, this.timeZone);
    if (start < dayOpen || end > dayClose) {
      throw new Error('Час виходить за межі робочого дня');
    }

    const dayBookings = await this.store.listByDate(booking.dateISO);
    const overlaps = dayBookings.some((other) => {
      if (other.id === id) return false;
      const otherStart = toDateAtTime(other.dateISO, other.startTime, this.timeZone);
      const otherEnd = toDateAtTime(other.dateISO, other.endTime, this.timeZone);
      return rangesOverlap(start, end, otherStart, otherEnd);
    });

    if (overlaps) {
      throw new Error('Цей час перетинається з іншим бронюванням');
    }

    // Chan validation тепер обробляється в UI з попередженням

    booking.startTime = startTime;
    booking.endTime = endTime;
    booking.durationMinutes = differenceInMinutes(end, start);

    const updated = dayBookings.map((other) => (other.id === id ? booking : other));
    await this.store.setSlotsForDate(booking.dateISO, updated);
    return booking;
  }

  /**
   * Повертає бронювання з чаном на вказаний день (якщо є).
   */
  async getChanBookingForDay(dateISO: string): Promise<Booking | null> {
    const dayBookings = await this.store.listByDate(dateISO);
    return dayBookings.find(b => b.withChan) || null;
  }

  /**
   * Перевіряє можливість увімкнення чану для бронювання.
   * Повертає інформацію про конфлікт якщо чан вже зайнятий.
   */
  async checkChanConflict(id: string): Promise<{ canEnable: boolean; conflictBooking?: Booking; reason?: string }> {
    const booking = await this.getBookingById(id);
    if (!booking) {
      return { canEnable: false, reason: 'Бронювання не знайдено' };
    }

    // Якщо чан вже увімкнений - завжди можна вимкнути
    if (booking.withChan) {
      return { canEnable: true };
    }

    // Перевірка часу
    const start = toDateAtTime(booking.dateISO, booking.startTime, this.timeZone);
    const chanStartLimit = toDateAtTime(booking.dateISO, '13:00', this.timeZone);
    if (start < chanStartLimit) {
      return { canEnable: false, reason: 'Бронювання починається раніше 13:00' };
    }

    // Перевірка чи чан вже зайнятий
    const dayBookings = await this.store.listByDate(booking.dateISO);
    const conflictBooking = dayBookings.find(b => b.id !== id && b.withChan);
    if (conflictBooking) {
      return { canEnable: false, conflictBooking };
    }

    return { canEnable: true };
  }

  async toggleChanStatus(id: string, force = false): Promise<Booking> {
    const booking = await this.getBookingById(id);
    if (!booking) {
      throw new Error('Бронювання не знайдено');
    }

    const dayBookings = await this.store.listByDate(booking.dateISO);

    if (!booking.withChan) {
        // Trying to enable Chan
        // 1. Check time (skip if force - дозволяємо ранній чан)
        if (!force) {
            const start = toDateAtTime(booking.dateISO, booking.startTime, this.timeZone);
            const chanStartLimit = toDateAtTime(booking.dateISO, '13:00', this.timeZone);
            if (start < chanStartLimit) {
                throw new Error('Не можна додати чан: бронювання починається раніше 13:00');
            }
        }

        // 2. Check if already booked (skip if force - дозволяємо кілька чанів на день)
        if (!force) {
            const conflictBooking = dayBookings.find(b => b.id !== id && b.withChan);
            if (conflictBooking) {
                throw new Error('Не можна додати чан: він вже заброньований на цей день');
            }
        }
        // При force=true просто додаємо чан, інші бронювання не чіпаємо
    }

    booking.withChan = !booking.withChan;
    const updated = dayBookings.map((other) => (other.id === id ? booking : other));
    await this.store.setSlotsForDate(booking.dateISO, updated);
    return booking;
  }

  async addBooking(payload: BookingCreationPayload): Promise<Booking> {
    const end = PerfLogger.start('SERVICE: addBooking');
    try {
      this.assertTimeFormat(payload.startTime);
      this.assertTimeFormat(payload.endTime);
      this.assertMinuteStep(payload.startTime);
      this.assertMinuteStep(payload.endTime);

      const minuteStep = this.getMinuteStep();
      const start = toDateAtTime(payload.dateISO, payload.startTime, this.timeZone);
      const end = toDateAtTime(payload.dateISO, payload.endTime, this.timeZone);

      if (end <= start) {
        throw new Error('Час завершення має бути пізнішим за початок');
      }

      const duration = differenceInMinutes(end, start);
      if (duration < minuteStep) {
        throw new Error(`Мінімальна тривалість — ${minuteStep} хв.`);
      }

      const dayOpen = toDateAtTime(payload.dateISO, this.schedule.dayOpenTime, this.timeZone);
      const dayClose = toDateAtTime(payload.dateISO, this.schedule.dayCloseTime, this.timeZone);

      if (start < dayOpen) {
        throw new Error('Бронювання починається раніше відкриття');
      }
      if (end > dayClose) {
        throw new Error('Бронювання виходить за межі робочого дня');
      }

      const existing = await this.store.listByDate(payload.dateISO);

      // 1. Check overlaps
      const overlaps = existing.some(b => {
          const bStart = toDateAtTime(b.dateISO, b.startTime, this.timeZone);
          const bEnd = toDateAtTime(b.dateISO, b.endTime, this.timeZone);
          return rangesOverlap(start, end, bStart, bEnd);
      });

      if (overlaps) {
          throw new Error('Цей час вже зайнято');
      }

      // 2. Check Chan rules
      if (payload.withChan) {
          const chanStartLimit = toDateAtTime(payload.dateISO, '13:00', this.timeZone);

          // Перевірка раннього часу (пропускаємо якщо forceChan)
          if (!payload.forceChan && start < chanStartLimit) {
              throw new Error('Чан доступний тільки з 13:00');
          }

          // Перевірка зайнятості чану (пропускаємо якщо forceChan)
          if (!payload.forceChan) {
              const chanAlreadyBooked = existing.some(b => b.withChan);
              if (chanAlreadyBooked) {
                  throw new Error('Чан вже заброньовано на цей день');
              }
          }
      }

      const booking: Booking = {
        id: generateId(),
        dateISO: payload.dateISO,
        startTime: payload.startTime,
        endTime: payload.endTime,
        durationMinutes: duration,
        createdBy: payload.createdBy,
        createdAt: new Date().toISOString(),
        note: payload.note?.trim() || undefined,
        withChan: payload.withChan ?? false,
      };

      await this.store.add(booking);
      return booking;
    } finally {
      end();
    }
  }

  async clearDay(dateISO: string): Promise<number> {
    return this.store.clearDay(dateISO);
  }

  /**
   * Знаходить всі бронювання, що перекриваються з вказаним часовим діапазоном.
   * Використовується для попередження користувача перед перезаписом.
   */
  async findOverlappingBookings(dateISO: string, startTime: string, endTime: string): Promise<Booking[]> {
    const existing = await this.store.listByDate(dateISO);
    const start = toDateAtTime(dateISO, startTime, this.timeZone);
    const end = toDateAtTime(dateISO, endTime, this.timeZone);

    return existing.filter(b => {
      const bStart = toDateAtTime(b.dateISO, b.startTime, this.timeZone);
      const bEnd = toDateAtTime(b.dateISO, b.endTime, this.timeZone);
      return rangesOverlap(start, end, bStart, bEnd);
    });
  }

  /**
   * Видаляє вказані бронювання та створює нове замість них.
   * Використовується для перезапису перекриваючих слотів.
   */
  async replaceBookings(bookingIdsToDelete: string[], newPayload: BookingCreationPayload): Promise<Booking> {
    // 1. Видаляємо старі бронювання
    for (const id of bookingIdsToDelete) {
      await this.store.remove(id);
    }

    // 2. Створюємо нове бронювання (без перевірки перекриття, бо вже видалили)
    this.assertTimeFormat(newPayload.startTime);
    this.assertTimeFormat(newPayload.endTime);
    this.assertMinuteStep(newPayload.startTime);
    this.assertMinuteStep(newPayload.endTime);

    const start = toDateAtTime(newPayload.dateISO, newPayload.startTime, this.timeZone);
    const end = toDateAtTime(newPayload.dateISO, newPayload.endTime, this.timeZone);

    if (end <= start) {
      throw new Error('Час завершення має бути пізнішим за початок');
    }

    const duration = differenceInMinutes(end, start);

    const dayOpen = toDateAtTime(newPayload.dateISO, this.schedule.dayOpenTime, this.timeZone);
    const dayClose = toDateAtTime(newPayload.dateISO, this.schedule.dayCloseTime, this.timeZone);

    if (start < dayOpen) {
      throw new Error('Бронювання починається раніше відкриття');
    }
    if (end > dayClose) {
      throw new Error('Бронювання виходить за межі робочого дня');
    }

    // Chan validation
    if (newPayload.withChan) {
      const chanStartLimit = toDateAtTime(newPayload.dateISO, '13:00', this.timeZone);

      // Перевірка раннього часу (пропускаємо якщо forceChan)
      if (!newPayload.forceChan && start < chanStartLimit) {
        throw new Error('Чан доступний тільки з 13:00');
      }

      // Check if chan is booked by OTHER bookings (not the ones we're deleting)
      // Skip this check if forceChan is true
      if (!newPayload.forceChan) {
        const remaining = await this.store.listByDate(newPayload.dateISO);
        const chanBookedByOther = remaining.some(b => !bookingIdsToDelete.includes(b.id) && b.withChan);
        if (chanBookedByOther) {
          throw new Error('Чан вже заброньовано на цей день');
        }
      }
    }

    const booking: Booking = {
      id: generateId(),
      dateISO: newPayload.dateISO,
      startTime: newPayload.startTime,
      endTime: newPayload.endTime,
      durationMinutes: duration,
      createdBy: newPayload.createdBy,
      createdAt: new Date().toISOString(),
      note: newPayload.note?.trim() || undefined,
      withChan: newPayload.withChan ?? false,
    };

    await this.store.add(booking);
    return booking;
  }

  // --- Free Slots Logic ---

  async getFreeSlots(dateISO: string): Promise<Array<{ start: string; end: string; chanAvailable: boolean }>> {
      const bookings = await this.store.listByDate(dateISO);
      const dayOpen = toDateAtTime(dateISO, this.schedule.dayOpenTime, this.timeZone);
      const dayClose = toDateAtTime(dateISO, this.schedule.dayCloseTime, this.timeZone);
      const chanStartLimit = toDateAtTime(dateISO, '13:00', this.timeZone);

      // Sort bookings by time
      const sortedBookings = bookings.sort((a, b) => a.startTime.localeCompare(b.startTime));

      // Calculate free ranges
      const freeRanges: Array<{ start: Date; end: Date }> = [];
      let currentPointer = dayOpen;

      for (const booking of sortedBookings) {
          const bStart = toDateAtTime(dateISO, booking.startTime, this.timeZone);
          const bEnd = toDateAtTime(dateISO, booking.endTime, this.timeZone);

          if (currentPointer < bStart) {
              freeRanges.push({ start: currentPointer, end: bStart });
          }
          if (bEnd > currentPointer) {
              currentPointer = bEnd;
          }
      }

      if (currentPointer < dayClose) {
          freeRanges.push({ start: currentPointer, end: dayClose });
      }

      // Determine Chan availability for the day
      // Chan is available IF:
      // 1. No booking has withChan === true
      const chanBooked = bookings.some(b => b.withChan);

      return freeRanges.map(range => {
          // Chan is available for this specific range IF:
          // 1. Chan is not booked for the day
          // 2. Range starts >= 13:00 (or at least overlaps significantly? Let's say starts >= 13:00 for simplicity, or just check if range allows booking >= 13:00)
          // Actually, the user sees "Free (with Chan)" if they CAN book Chan.
          // They can book Chan if:
          // - Chan not booked today
          // - Time slot allows booking >= 13:00.
          
          // Let's simplify: The slot is "Chan Available" if the range *intersects* with 13:00+ AND Chan is not booked.
          // But wait, if I have a free slot 09:00-14:00.
          // 09:00-13:00 is "No Chan".
          // 13:00-14:00 is "With Chan".
          // Should I split the free slot?
          // The visualizer might need split slots.
          // For now, let's just return the ranges and a flag if Chan is generally available for the day.
          // Actually, let's split the ranges if they cross 13:00 boundary, to make it easier for UI.
          
          return {
              start: formatTime(range.start, this.timeZone),
              end: formatTime(range.end, this.timeZone),
              chanAvailable: !chanBooked && (range.end > chanStartLimit) // Rough check, refined in UI/Image
          };
      });
  }

  async buildScheduleImage(weekOffset = 0, showUnavailableSlots = true) {
    const end = PerfLogger.start('SERVICE: buildScheduleImage');
    try {
      const daysMeta = this.getScheduleDays(weekOffset);
      const days = daysMeta.map((meta) => meta.date);

      const bookings = await this.store.list();
      return generateAvailabilityImage({
        days,
        settings: this.schedule,
        bookings,
        showUnavailableSlots,
      });
    } finally {
      end();
    }
  }

  async buildAvailableSummary(limit = 5): Promise<string> {
    // This needs to find FREE slots now.
    // This is expensive to calculate for many days.
    // Let's just look at the next 7 days.
    const days = this.getScheduleDays(0);
    const allFree: string[] = [];
    
    for (const day of days) {
        const free = await this.getFreeSlots(day.iso);
        for (const slot of free) {
            allFree.push(`• ${day.label}: ${slot.start} – ${slot.end}${slot.chanAvailable ? ' (з чаном 🛁)' : ''}`);
            if (allFree.length >= limit) break;
        }
        if (allFree.length >= limit) break;
    }

    if (!allFree.length) {
      return 'Наразі вільного часу немає. Спробуйте пізніше 🙏';
    }

    return `Ось найближчі вільні вікна:\n${allFree.join('\n')}`;
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
    
    // If it's late, maybe skip today? Logic from before:
    // if (nowZoned.getHours() >= 22) { startDate = addDays(startDate, 1); }
    // Let's keep it.
    if (nowZoned.getHours() >= 22) {
      startDate = addDays(startDate, 1);
    }

    startDate = addDays(startDate, weekOffset * 7);

    return Array.from({ length: this.schedule.scheduleDays }, (_, idx) =>
      addDays(startDate, idx)
    );
  }


  // --- Helper Logic for Chan & Gaps ---

  async isChanHeatingPossible(dateISO: string, startTime: string): Promise<{ possible: boolean; reason?: string }> {
    const end = PerfLogger.start('SERVICE: isChanHeatingPossible');
    try {
      const start = toDateAtTime(dateISO, startTime, this.timeZone);
      const chanStartLimit = toDateAtTime(dateISO, '13:00', this.timeZone);

      // 1. Time Check
      if (start < chanStartLimit) {
        return { possible: false, reason: 'Чан доступний тільки з 13:00' };
      }

      const bookings = await this.store.listByDate(dateISO);

      // 2. Already Booked Check
      const chanBooked = bookings.some(b => b.withChan);
      if (chanBooked) {
        return { possible: false, reason: 'Чан вже заброньовано на цей день' };
      }

      // 3. Heating Check (6 hours before start must be free of bookings)
      // We need a continuous 6h block ending at startTime where NO booking exists.
      // Actually, simpler: Does any booking overlap with [start - 6h, start]?
      // Note: Overlap means (bookingStart < intervalEnd) && (bookingEnd > intervalStart).
      // intervalStart = start - 6h
      // intervalEnd = start
      
      const heatingStart = addMinutes(start, -360); // -6 hours
      const heatingEnd = start;

      const blockingBooking = bookings.find(b => {
         const bStart = toDateAtTime(b.dateISO, b.startTime, this.timeZone);
         const bEnd = toDateAtTime(b.dateISO, b.endTime, this.timeZone);
         return rangesOverlap(heatingStart, heatingEnd, bStart, bEnd);
      });

      if (blockingBooking) {
         return { 
           possible: false, 
           reason: `Немає часу на розігрів (потрібно 6 годин без гостей перед чаном). Заважає бронювання ${blockingBooking.startTime}-${blockingBooking.endTime}` 
         };
      }

      return { possible: true };
    } finally {
      end();
    }
  }

  async checkGaps(dateISO: string, startTime: string, endTime: string): Promise<boolean> {
    const endLog = PerfLogger.start('SERVICE: checkGaps');
    try {
      const bookings = await this.store.listByDate(dateISO);
      const start = toDateAtTime(dateISO, startTime, this.timeZone);
      const end = toDateAtTime(dateISO, endTime, this.timeZone);
      
      // Sort bookings
      const sorted = [...bookings].sort((a, b) => a.startTime.localeCompare(b.startTime));
      
      // Find neighbors
      let prevEnd = toDateAtTime(dateISO, this.schedule.dayOpenTime, this.timeZone);
      let nextStart = toDateAtTime(dateISO, this.schedule.dayCloseTime, this.timeZone);

      for (const b of sorted) {
          const bStart = toDateAtTime(dateISO, b.startTime, this.timeZone);
          const bEnd = toDateAtTime(dateISO, b.endTime, this.timeZone);
          
          if (bEnd <= start) {
              if (bEnd > prevEnd) prevEnd = bEnd;
          }
          
          if (bStart >= end) {
              if (bStart < nextStart) nextStart = bStart;
              break; // Found the immediate next
          }
      }

      // Якщо бронювання закінчується о 22:00 або пізніше - це останній слот дня,
      // не перевіряємо gaps взагалі (немає сенсу попереджати)
      const endOfUsefulDay = toDateAtTime(dateISO, '22:00', this.timeZone);
      if (end >= endOfUsefulDay) {
        return false;
      }

      // Check gap before
      const gapBefore = differenceInMinutes(start, prevEnd);
      if (gapBefore > 0 && gapBefore < 120) return true; // Gap < 2 hours

      // Check gap after
      const gapAfter = differenceInMinutes(nextStart, end);
      if (gapAfter > 0 && gapAfter < 120) return true; // Gap < 2 hours

      return false;
    } finally {
      endLog();
    }
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

function generateId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}
