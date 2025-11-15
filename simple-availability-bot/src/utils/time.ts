import { format, parse, addDays, startOfDay } from 'date-fns';
import { uk } from 'date-fns/locale';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export function toDateAtTime(dateISO: string, timeStr: string, tz: string): Date {
  const [hours, minutes] = timeStr.split(':').map((n) => parseInt(n, 10));
  const date = parse(dateISO, 'yyyy-MM-dd', new Date());
  date.setHours(hours, minutes, 0, 0);
  return fromZonedTime(date, tz);
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
