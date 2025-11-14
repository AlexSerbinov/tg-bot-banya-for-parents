import type { Booking, Settings } from '@prisma/client';
import { generateSlots, type Slot } from './rules';
import { computeChanWindowsByDay, isWithinStartOfDayChanWindow } from './chan';

/**
 * Обгортка над generateSlots: додає прапорець chanAvailable
 * тільки для слотів, що потрапляють у 5+ год startOfDay-вікно (Чан).
 */
export function generateSlotsWithChan(
  dateISO: string,
  settings: Settings,
  bookings: Booking[]
): Slot[] {
  const slots = generateSlots(dateISO, settings, bookings);

  const relevant = bookings.filter((b) =>
    ['PENDING', 'CONFIRMED', 'COMPLETED'].includes(b.status as any)
  );

  const chanWindowsByDay = computeChanWindowsByDay(
    [{ iso: dateISO }],
    relevant as any,
    settings
  );

  return slots.map((s) => {
    const chanAvailable = isWithinStartOfDayChanWindow(
      dateISO,
      s.start,
      s.end,
      chanWindowsByDay
    );
    return { ...s, chanAvailable };
  });
}

