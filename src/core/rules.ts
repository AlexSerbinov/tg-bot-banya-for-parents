import { addMinutes, isBefore, isAfter, isEqual } from 'date-fns';
import { Booking, Settings } from '@prisma/client';
import { toDateAtTime } from './time';

export interface Slot {
  start: Date;
  end: Date;
  durationHours: number;
}

export function generateSlots(
  dateISO: string,
  settings: Settings,
  bookings: Booking[]
): Slot[] {
  const tz = settings.timeZone;
  const open = toDateAtTime(dateISO, settings.dayOpenTime, tz);
  const close = toDateAtTime(dateISO, settings.dayCloseTime, tz);
  const now = new Date(); // Поточний час в UTC

  const stepMin = 30;
  const buffer = settings.cleaningBufferMin;
  const durations = settings.allowedDurations
    .split(',')
    .map((n) => parseInt(n.trim(), 10));

  const results: Slot[] = [];

  // Filter relevant bookings (PENDING or CONFIRMED)
  const relevantBookings = bookings.filter(
    (b) => b.status === 'PENDING' || b.status === 'CONFIRMED'
  );

  for (const durationHours of durations) {
    let currentStart = open;

    while (isBefore(currentStart, close)) {
      const slotEnd = addMinutes(currentStart, durationHours * 60);
      const slotEndWithBuffer = addMinutes(slotEnd, buffer);

      // Check if slot end is within working hours
      if (isAfter(slotEnd, close) || isEqual(slotEnd, close)) {
        break;
      }

      // Skip slots that are in the past
      if (isBefore(currentStart, now) || isEqual(currentStart, now)) {
        currentStart = addMinutes(currentStart, stepMin);
        continue;
      }

      // Check for conflicts
      const hasConflict = relevantBookings.some((b) => {
        const conflict = overlapsWithBuffer(
          currentStart,
          slotEnd,
          b.dateStart,
          b.dateEnd,
          buffer
        );

        // Debug logging for conflicts
        if (conflict) {
          console.log(`CONFLICT: Slot ${currentStart.toISOString()}-${slotEnd.toISOString()} conflicts with booking ${b.dateStart.toISOString()}-${b.dateEnd.toISOString()} (buffer: ${buffer}min)`);
        }

        return conflict;
      });

      if (!hasConflict) {
        results.push({
          start: currentStart,
          end: slotEnd,
          durationHours,
        });
      }

      currentStart = addMinutes(currentStart, stepMin);
    }
  }

  // Sort by start time
  return results.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function overlapsWithBuffer(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
  bufferMin: number
): boolean {
  const aEndWithBuffer = addMinutes(aEnd, bufferMin);
  const bEndWithBuffer = addMinutes(bEnd, bufferMin);

  // Check if ranges overlap including buffer BEFORE and AFTER
  // Новий слот не може починатися раніше ніж через буфер після закінчення існуючого
  // і не може закінчуватися пізніше ніж за буфер до початку існуючого
  return isBefore(aStart, bEndWithBuffer) && isBefore(bStart, aEndWithBuffer);
}

export function hasConflict(
  start: Date,
  end: Date,
  bookings: Booking[],
  bufferMin: number,
  excludeId?: string
): boolean {
  const relevantBookings = bookings.filter(
    (b) =>
      (b.status === 'PENDING' || b.status === 'CONFIRMED') &&
      b.id !== excludeId
  );

  return relevantBookings.some((b) =>
    overlapsWithBuffer(start, end, b.dateStart, b.dateEnd, bufferMin)
  );
}
