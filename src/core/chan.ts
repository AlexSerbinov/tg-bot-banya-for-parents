import type { Booking, Settings } from '@prisma/client';
import { toDateAtTime } from './time';

export type ChanWindowType = 'startOfDay' | 'midDay' | 'endOfDay';

export interface ChanWindow {
  start: Date;
  end: Date;
  type: ChanWindowType;
}

export interface DayDescriptor {
  iso: string;
}

const MIN_CHAN_PREP_GAP_MIN = 5 * 60; // 5 годин

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function diffMinutes(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

/**
 * Розраховує 5+ годинні вікна між бронюваннями (та на краях дня).
 */
export function computeChanWindowsByDay(
  days: DayDescriptor[],
  bookings: Booking[],
  settings: Settings
): Map<string, ChanWindow[]> {
  const map = new Map<string, ChanWindow[]>();

  for (const day of days) {
    const dayOpen = toDateAtTime(day.iso, settings.dayOpenTime, settings.timeZone);
    const dayClose = toDateAtTime(day.iso, settings.dayCloseTime, settings.timeZone);

    const dayBookings = bookings
      .filter((b) => rangesOverlap(dayOpen, dayClose, b.dateStart, b.dateEnd))
      .sort((a, b) => a.dateStart.getTime() - b.dateStart.getTime());

    const windows: ChanWindow[] = [];

    // Початок дня
    if (dayBookings.length === 0) {
      if (diffMinutes(dayClose, dayOpen) >= MIN_CHAN_PREP_GAP_MIN) {
        windows.push({ start: dayOpen, end: dayClose, type: 'startOfDay' });
      }
    } else {
      const first = dayBookings[0];
      if (diffMinutes(first.dateStart, dayOpen) >= MIN_CHAN_PREP_GAP_MIN) {
        windows.push({ start: dayOpen, end: first.dateStart, type: 'startOfDay' });
      }
    }

    // Між бронюваннями
    for (let i = 0; i < dayBookings.length - 1; i++) {
      const left = dayBookings[i];
      const right = dayBookings[i + 1];
      const gap = diffMinutes(right.dateStart, left.dateEnd);
      if (gap >= MIN_CHAN_PREP_GAP_MIN) {
        windows.push({ start: left.dateEnd, end: right.dateStart, type: 'midDay' });
      }
    }

    // Кінець дня
    if (dayBookings.length >= 1) {
      const last = dayBookings[dayBookings.length - 1];
      if (diffMinutes(dayClose, last.dateEnd) >= MIN_CHAN_PREP_GAP_MIN) {
        windows.push({ start: last.dateEnd, end: dayClose, type: 'endOfDay' });
      }
    }

    if (windows.length) {
      map.set(day.iso, windows);
    }
  }
  return map;
}

/**
 * Перевіряє, що слот [slotStart, slotEnd) потрапляє у startOfDay-вікно для чану.
 */
export function isWithinStartOfDayChanWindow(
  iso: string,
  slotStart: Date,
  slotEnd: Date,
  windowsByDay: Map<string, ChanWindow[]>
): boolean {
  const windows = windowsByDay.get(iso);
  if (!windows) return false;
  return windows.some(
    (w) =>
      w.type === 'startOfDay' &&
      !(slotEnd <= w.start || slotStart >= w.end)
  );
}

