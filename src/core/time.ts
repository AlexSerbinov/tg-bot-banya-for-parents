import { format, parse, addDays, startOfDay, isSameDay } from 'date-fns';
import { uk } from 'date-fns/locale';
import { zonedTimeToUtc, utcToZonedTime } from 'date-fns-tz';

export function toDateAtTime(dateISO: string, timeStr: string, tz: string): Date {
  const [hours, minutes] = timeStr.split(':').map((n) => parseInt(n, 10));
  const date = parse(dateISO, 'yyyy-MM-dd', new Date());
  date.setHours(hours, minutes, 0, 0);
  return zonedTimeToUtc(date, tz);
}

export function formatDate(date: Date, tz: string): string {
  const zonedDate = utcToZonedTime(date, tz);
  return format(zonedDate, 'EEE, d MMM', { locale: uk });
}

export function formatTime(date: Date, tz: string): string {
  const zonedDate = utcToZonedTime(date, tz);
  return format(zonedDate, 'HH:mm');
}

export function formatDateISO(date: Date, tz: string): string {
  const zonedDate = utcToZonedTime(date, tz);
  return format(zonedDate, 'yyyy-MM-dd');
}

export function formatDateTime(date: Date, tz: string): string {
  return `${formatDate(date, tz)}, ${formatTime(date, tz)}`;
}

export function getNextDays(count: number, tz: string): Date[] {
  const now = utcToZonedTime(new Date(), tz);
  const today = startOfDay(now);
  return Array.from({ length: count }, (_, i) => addDays(today, i));
}

export function dateToISO(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function parseISODate(dateISO: string): Date {
  return parse(dateISO, 'yyyy-MM-dd', new Date());
}

export function isTodayOrFuture(dateISO: string, tz: string): boolean {
  const checkDate = parse(dateISO, 'yyyy-MM-dd', new Date());
  const now = utcToZonedTime(new Date(), tz);
  const today = startOfDay(now);
  return checkDate >= today;
}

export function getDayName(dateISO: string): string {
  const date = parse(dateISO, 'yyyy-MM-dd', new Date());
  return format(date, 'EEEE', { locale: uk });
}
