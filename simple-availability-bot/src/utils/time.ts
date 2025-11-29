import { format, addDays, startOfDay } from 'date-fns';
import { uk } from 'date-fns/locale';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

export function toDateAtTime(dateISO: string, timeStr: string, tz: string): Date {
  // Handle 24:00 as 00:00 of the next day
  if (timeStr === '24:00') {
    const nextDay = addDays(new Date(dateISO), 1);
    const nextDayISO = format(nextDay, 'yyyy-MM-dd');
    const dateTimeStr = `${nextDayISO}T00:00:00`;
    return fromZonedTime(dateTimeStr, tz);
  }

  // Construct a string that looks like "2024-11-24T09:00:00"
  const dateTimeStr = `${dateISO}T${timeStr}:00`;
  // fromZonedTime takes a date string (or Date) and a time zone,
  // and returns a Date object (UTC) representing that wall-clock time in that zone.
  return fromZonedTime(dateTimeStr, tz);
}

export function formatDate(date: Date, tz: string): string {
  const zonedDate = toZonedTime(date, tz);
  return format(zonedDate, 'EEEEEE, d MMM', { locale: uk });
}

export function formatTime(date: Date, tz: string): string {
  const zonedDate = toZonedTime(date, tz);
  return format(zonedDate, 'HH:mm');
}

export function formatDateISO(date: Date, tz: string): string {
  const zonedDate = toZonedTime(date, tz);
  return format(zonedDate, 'yyyy-MM-dd');
}

export function formatDateTime(date: Date, tz: string): string {
  return `${formatDate(date, tz)}, ${formatTime(date, tz)}`;
}

export function getNextDays(count: number, tz: string): Date[] {
  const now = toZonedTime(new Date(), tz);
  const today = startOfDay(now);
  return Array.from({ length: count }, (_, i) => addDays(today, i));
}

export function dateToISO(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function formatDateShort(date: Date, tz: string): string {
  const zonedDate = toZonedTime(date, tz);
  return format(zonedDate, 'dd.MM');
}
