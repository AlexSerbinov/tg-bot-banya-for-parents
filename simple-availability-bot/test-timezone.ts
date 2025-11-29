import { toDateAtTime, formatTime } from './src/utils/time';

const tz = 'Europe/Kyiv';
const dateISO = '2025-11-24';
const timeStr = '09:00';

console.log('Testing timezone conversion:');
console.log('Input:', { dateISO, timeStr, tz });

const date = toDateAtTime(dateISO, timeStr, tz);
console.log('Date object:', date);
console.log('Date ISO string:', date.toISOString());

const formattedTime = formatTime(date, tz);
console.log('Formatted time:', formattedTime);

console.log('\n---');
console.log('Expected: 09:00');
console.log('Got:', formattedTime);
console.log('Match:', formattedTime === '09:00' ? '✅ OK' : '❌ FAIL');
