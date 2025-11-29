import { toDateAtTime } from './src/utils/time';
import { AvailabilitySlot } from './src/types';

const tz = 'Europe/Kyiv';

// Симулюємо слот з файлу
const slot: AvailabilitySlot = {
  id: '5cb5c81cf9',
  dateISO: '2025-11-24',
  startTime: '09:00',
  endTime: '23:00',
  durationMinutes: 840,
  createdBy: 350985285,
  createdAt: '2025-11-23T21:42:42.437Z',
  chanAvailable: true,
};

console.log('Testing schedule generation with slot:');
console.log('Slot:', { dateISO: slot.dateISO, startTime: slot.startTime, endTime: slot.endTime });
console.log('');

// Конвертуємо як в groupAvailability
const start = toDateAtTime(slot.dateISO, slot.startTime, tz);
const end = toDateAtTime(slot.dateISO, slot.endTime, tz);

console.log('Converted to Date objects:');
console.log('Start:', start.toISOString(), '(UTC)');
console.log('End:', end.toISOString(), '(UTC)');
console.log('');

// Симулюємо timeTicks
const dayOpenTime = '09:00';
const dayCloseTime = '23:00';

function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToLabel(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60).toString().padStart(2, '0');
  const m = (totalMinutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

const openMinutes = timeToMinutes(dayOpenTime);
const closeMinutes = timeToMinutes(dayCloseTime);
const GRID_MINUTE_STEP = 30;

console.log('Time ticks (first few):');
for (let m = openMinutes; m <= Math.min(openMinutes + 180, closeMinutes); m += GRID_MINUTE_STEP) {
  const timeString = minutesToLabel(m);
  const tickDate = toDateAtTime(slot.dateISO, timeString, tz);

  // Перевіряємо, чи tick знаходиться в межах слоту
  const isInSlot = tickDate >= start && tickDate < end;

  console.log(`  ${timeString} -> ${tickDate.toISOString()} (${isInSlot ? 'IN SLOT ✓' : 'not in slot'})`);
}

console.log('');
console.log('Last few ticks:');
for (let m = Math.max(closeMinutes - 180, openMinutes); m <= closeMinutes; m += GRID_MINUTE_STEP) {
  const timeString = minutesToLabel(m);
  const tickDate = toDateAtTime(slot.dateISO, timeString, tz);

  const isInSlot = tickDate >= start && tickDate < end;

  console.log(`  ${timeString} -> ${tickDate.toISOString()} (${isInSlot ? 'IN SLOT ✓' : 'not in slot'})`);
}
