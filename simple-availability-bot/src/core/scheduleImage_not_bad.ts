import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { addMinutes, format } from 'date-fns';
import { uk } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { AvailabilitySlot, ScheduleSettings } from '../types';
import { dateToISO, toDateAtTime } from '../utils/time';

// --- КОНФІГУРАЦІЯ ШРИФТІВ ---
let fontsRegistered = false;
function registerCustomFonts() {
  if (fontsRegistered) return;

  const fontsDir = join(process.cwd(), 'fonts');
  try {
    const fontFiles = [
      'PlayfairDisplay-Regular.ttf',
      'PlayfairDisplay-Medium.ttf',
      'PlayfairDisplay-SemiBold.ttf',
      'PlayfairDisplay-Bold.ttf'
    ];
    
    fontFiles.forEach(file => {
      try {
        GlobalFonts.registerFromPath(join(fontsDir, file), 'Playfair Display');
      } catch (e) {
        // Ігноруємо, якщо файлу немає
      }
    });
    
    fontsRegistered = true;
  } catch (error) {
    console.error('⚠️ Font registration skipped/failed:', error);
  }
}

// --- КОНСТАНТИ ДИЗАЙНУ ---
const CANVAS_WIDTH = 1200;
const PADDING_X = 48; 
const PADDING_Y = 48; 

const HEADER_HEIGHT = 160; 
const DAY_HEADER_HEIGHT = 90;
const TIME_COLUMN_WIDTH = 90;
const COLUMN_GAP = 16;
const BASE_ROW_HEIGHT = 60; 
const GRID_MINUTE_STEP = 30; 

// --- ПАЛІТРА "PREMIUM WOOD" ---
const COLORS = {
  // Фон буде картинкою, але ці кольори для градієнтів та оверлеїв
  overlayTop: 'rgba(15, 10, 8, 0.92)',    // Much darker top
  overlayBottom: 'rgba(5, 2, 1, 0.98)',   // Almost black bottom
  
  text: {
    primary: '#ffffff',   // Pure white for max contrast
    secondary: '#9ca3af', // Cool grey
    accent: '#fbbf24',    // Amber
  },
  
  ui: {
    headerPill: 'rgba(255, 255, 255, 0.03)', // Very subtle
    border: 'rgba(255, 255, 255, 0.05)',
    gridLines: 'rgba(255, 255, 255, 0.03)'
  },

  slots: {
    available: {
      // Bright Lime/Green - Pops against dark
      start: '#bef264', // Lime 300
      end: '#84cc16',   // Lime 500
      shadow: 'rgba(132, 204, 22, 0.4)',
      text: '#0f172a'   // Dark text on bright slot
    },
    availableChan: {
      // Bright Cyan/Sky
      start: '#67e8f9', // Cyan 300
      end: '#06b6d4',   // Cyan 500
      shadow: 'rgba(6, 182, 212, 0.4)',
      text: '#0f172a'   // Dark text
    },
    booked: {
      // Invisible / Transparent
      bg: 'transparent', 
      border: 'transparent',
      text: 'transparent'
    }
  }
};

type SlotStatus = 'available' | 'available_with_chan' | 'booked';

interface TimeTick {
  timeString: string;
  label: string;
}

interface SlotCell {
  status: SlotStatus;
  rowIndex: number;
  slotStart: Date;
  slotEnd: Date;
  chanAvailable?: boolean;
}

interface SlotSegment {
  status: SlotStatus;
  startRow: number;
  endRow: number;
  slotStart: Date;
  slotEnd: Date;
  chanAvailable?: boolean;
}

export interface WeeklyScheduleImageResult {
  buffer: Buffer;
  stats: Record<SlotStatus, number>;
}

interface GenerateImageArgs {
  days: Date[];
  settings: ScheduleSettings;
  availability: AvailabilitySlot[];
  aggregateSlots?: boolean;
}

export async function generateAvailabilityImage({
  days,
  settings,
  availability,
  aggregateSlots = true,
}: GenerateImageArgs): Promise<WeeklyScheduleImageResult> {
  registerCustomFonts();
  const perfStart = performance.now();

  if (!days.length) {
    throw new Error('Не передано жодного дня');
  }

  const timeTicks = buildTimeTicks(settings.dayOpenTime, settings.dayCloseTime);
  const layout = calculateLayout(days.length, timeTicks.length);
  
  const canvas = createCanvas(CANVAS_WIDTH, layout.totalHeight);
  const ctx = canvas.getContext('2d');

  // 1. ФОН (Дерево + Оверлей)
  await drawWoodBackground(ctx, CANVAS_WIDTH, layout.totalHeight);
  
  // 2. Контент
  drawHeaderSection(ctx, days, settings, layout);
  drawTimeColumn(ctx, timeTicks, layout);
  drawDayHeaders(ctx, days, layout, settings.timeZone);
  
  // 3. Обрахунок слотів
  const availabilityByDay = groupAvailability(availability, settings.timeZone);
  const now = new Date();
  const dayCells = days.map(() => [] as SlotCell[]);
  const stats: Record<SlotStatus, number> = { available: 0, available_with_chan: 0, booked: 0 };

  days.forEach((day, colIndex) => {
    const iso = dateToISO(day);
    timeTicks.forEach((tick, rowIndex) => {
      if (rowIndex === timeTicks.length - 1) return;

      const status = resolveSlotStatus(iso, tick.timeString, settings, availabilityByDay, now);
      stats[status] += 1;

      const slotStart = toDateAtTime(iso, tick.timeString, settings.timeZone);
      const slotEnd = addMinutes(slotStart, GRID_MINUTE_STEP);
      
      const slotInfo = (availabilityByDay.get(iso) ?? []).find(
        (entry) => slotStart >= entry.start && slotEnd <= entry.end
      );
      
      const chanAvailable = status === 'booked' ? undefined : slotInfo?.chanAvailable;

      dayCells[colIndex].push({
        status,
        rowIndex,
        slotStart,
        slotEnd,
        chanAvailable
      });
    });
  });

  // 4. Малювання слотів
  dayCells.forEach((cells, colIndex) => {
    const colX = layout.gridX + colIndex * (layout.colWidth + COLUMN_GAP);
    if (aggregateSlots) {
      const segments = buildSegments(cells);
      segments.forEach(segment => {
        drawSlotSegment(ctx, segment, colX, layout);
      });
    }
  });

  drawFooter(ctx, layout);

  const buffer = canvas.toBuffer('image/png');
  console.log(`🖼 Schedule (Woody) generated in ${(performance.now() - perfStart).toFixed(1)}ms`);
  
  return { buffer, stats };
}

// --- ФУНКЦІЇ МАЛЮВАННЯ ---

async function drawWoodBackground(ctx: SKRSContext2D, width: number, height: number) {
  try {
    // Шлях до картинки. ПЕРЕКОНАЙСЯ, що файл background.JPG є в папці img
    // Якщо ім'я файлу інше - зміни його тут
    const bgPath = join(process.cwd(), 'img', 'background.JPG'); 
    
    const image = await loadImage(bgPath);
    
    // Малюємо зображення, розтягуючи на весь канвас
    // Можна використати drawImage так, щоб зберегти пропорції (object-cover),
    // але для текстури розтягування зазвичай ок.
    ctx.drawImage(image, 0, 0, width, height);

  } catch (error) {
    console.warn('⚠️ Failed to load wood background, using gradient fallback:', error);
    const fallback = ctx.createLinearGradient(0, 0, width, height);
    fallback.addColorStop(0, '#2e1005'); // Dark wood
    fallback.addColorStop(1, '#1a0a03');
    ctx.fillStyle = fallback;
    ctx.fillRect(0, 0, width, height);
  }

  // --- ОВЕРЛЕЙ (Vignette + Darkening) ---
  // Це критично важливо для читабельності тексту на текстурі
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  
  // Зверху світліше, щоб було видно кільця дерева
  gradient.addColorStop(0, COLORS.overlayTop); 
  // В зоні заголовка трохи темнішаємо
  gradient.addColorStop(0.2, 'rgba(20, 10, 5, 0.85)');
  // Внизу (де таблиця) дуже темно, щоб контраст був максимальний
  gradient.addColorStop(1, COLORS.overlayBottom);
  
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Додаємо трохи "шуму" або рамку для стилю
  ctx.strokeStyle = COLORS.ui.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, width - 40, height - 40);
}

function drawHeaderSection(
  ctx: SKRSContext2D, 
  days: Date[], 
  settings: ScheduleSettings,
  layout: ReturnType<typeof calculateLayout>
) {
  const rangeLabel = formatRange(days, settings.timeZone);
  
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  
  // Тінь для тексту, щоб він відривався від фону
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 15;
  ctx.shadowOffsetY = 4;

  // Заголовок
  ctx.font = '700 52px "Playfair Display", Georgia, serif';
  ctx.fillStyle = COLORS.text.primary;
  ctx.fillText('Вільні години бані', PADDING_X, PADDING_Y);

  // Скидаємо сильну тінь
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;

  // Subtitle
  ctx.font = '400 24px "Inter", sans-serif';
  ctx.fillStyle = COLORS.text.secondary;
  ctx.fillText('Період: ', PADDING_X, PADDING_Y + 70);
  
  const periodWidth = ctx.measureText('Період: ').width;
  ctx.fillStyle = COLORS.text.primary;
  ctx.fillText(rangeLabel, PADDING_X + periodWidth, PADDING_Y + 70);

  ctx.font = '500 18px "Inter", sans-serif'; 
  ctx.fillStyle = COLORS.text.secondary;
  ctx.fillText(`Графік роботи: ${settings.dayOpenTime} – ${settings.dayCloseTime}`, PADDING_X, PADDING_Y + 105);

  ctx.shadowColor = 'transparent'; // Reset shadow
  
  // Legend moved to top right
  drawLegend(ctx, CANVAS_WIDTH - PADDING_X, PADDING_Y + 10);
}

function drawLegend(ctx: SKRSContext2D, rightX: number, topY: number) {
  const items = [
    { color: COLORS.slots.available.end, label: 'Баня' },
    { color: COLORS.slots.availableChan.end, label: 'Баня + Чан' },
    // Removed "Booked" from legend as it's now invisible
  ];

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '600 18px "Inter", sans-serif';

  let currentX = rightX;
  const centerY = topY + 10;

  items.reverse().forEach((item) => {
    // Label
    ctx.fillStyle = COLORS.text.secondary;
    ctx.fillText(item.label, currentX, centerY);
    const labelWidth = ctx.measureText(item.label).width;
    
    // Dot
    ctx.save();
    ctx.shadowColor = item.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(currentX - labelWidth - 12, centerY, 6, 0, Math.PI * 2);
    ctx.fillStyle = item.color;
    ctx.fill();
    ctx.restore();
    
    currentX -= (labelWidth + 40);
  });
}

function drawTimeColumn(
  ctx: SKRSContext2D, 
  ticks: TimeTick[], 
  layout: ReturnType<typeof calculateLayout>
) {
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '500 20px "Inter", sans-serif'; 
  ctx.fillStyle = COLORS.text.secondary;

  const rowHeight = layout.rowHeight;

  ticks.forEach((tick, idx) => {
    if (tick.label) {
      const y = layout.gridY + (idx * rowHeight); 
      // Додаємо ледь помітну лінію на всю ширину
      ctx.save();
      ctx.strokeStyle = COLORS.ui.gridLines;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PADDING_X + TIME_COLUMN_WIDTH, y);
      ctx.lineTo(CANVAS_WIDTH - PADDING_X, y);
      ctx.stroke();
      ctx.restore();

      ctx.fillText(tick.label, PADDING_X + TIME_COLUMN_WIDTH - 24, y);
    }
  });
}

function drawDayHeaders(
  ctx: SKRSContext2D,
  days: Date[],
  layout: ReturnType<typeof calculateLayout>,
  timeZone: string
) {
  const startY = layout.gridY - DAY_HEADER_HEIGHT;

  days.forEach((day, index) => {
    const colX = layout.gridX + index * (layout.colWidth + COLUMN_GAP);
    const centerX = colX + layout.colWidth / 2;
    
    // Stacked Header:
    // DAY (ПН)
    // DATE (24)
    // MONTH (лис)
    
    const dayName = formatDateInZone(day, timeZone, 'EEEEEE').toUpperCase();
    const dateNum = formatDateInZone(day, timeZone, 'd');
    const monthName = formatDateInZone(day, timeZone, 'MMM').toLowerCase();

    const pillX = colX;
    const pillWidth = layout.colWidth;
    
    // Subtle header background
    ctx.fillStyle = COLORS.ui.headerPill;
    ctx.beginPath();
    ctx.roundRect(pillX, startY, pillWidth, DAY_HEADER_HEIGHT - 10, 12);
    ctx.fill();

    ctx.textAlign = 'center';
    
    // 1. Day Name
    ctx.textBaseline = 'top';
    ctx.font = '600 13px "Inter", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(dayName, centerX, startY + 12);

    // 2. Date Number
    ctx.font = '700 28px "Inter", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(dateNum, centerX, startY + 32);

    // 3. Month
    ctx.font = '500 14px "Inter", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(monthName, centerX, startY + 64);
  });
}

function drawSlotSegment(
  ctx: SKRSContext2D,
  segment: SlotSegment,
  x: number,
  layout: ReturnType<typeof calculateLayout>
) {
  const rowCount = segment.endRow - segment.startRow;
  const height = rowCount * layout.rowHeight;
  const y = layout.gridY + segment.startRow * layout.rowHeight;
  
  const GAP = 4; 
  const drawHeight = height - GAP;
  const drawY = y + GAP / 2;
  const radius = 8; // Менш округлі кути для "суворого" стилю


  if (segment.status === 'booked') {
    // Do NOTHING for booked slots. 
    // This creates negative space which is much cleaner.
    return;
  } else {
    // Available - Vibrant Nature colors
    const isChan = segment.status === 'available_with_chan';
    const style = isChan ? COLORS.slots.availableChan : COLORS.slots.available;

    ctx.save();
    ctx.shadowColor = style.shadow;
    ctx.shadowBlur = 15;
    ctx.shadowOffsetY = 5;
    
    const gradient = ctx.createLinearGradient(x, drawY, x + layout.colWidth, drawY + drawHeight);
    gradient.addColorStop(0, style.start);
    gradient.addColorStop(1, style.end);
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, drawY, layout.colWidth, drawHeight, radius);
    ctx.fill();
    ctx.restore(); 

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Labels
    const duration = getDurationMinutes(segment.slotStart, segment.slotEnd);
    const centerX = x + layout.colWidth / 2;
    const centerY = drawY + drawHeight / 2;

    ctx.fillStyle = COLORS.slots.available.text; // Dark text
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (duration <= 60) {
      ctx.font = '700 16px sans-serif';
      const timeLabel = `${formatTime(segment.slotStart)} - ${formatTime(segment.slotEnd)}`;
      ctx.fillText(timeLabel, centerX, centerY);
    } else {
      ctx.textBaseline = 'bottom';
      ctx.font = '700 22px sans-serif';
      ctx.fillText(formatTime(segment.slotStart), centerX, centerY - 3);
      
      ctx.textBaseline = 'top';
      ctx.font = '500 16px sans-serif';
      ctx.globalAlpha = 0.9;
      ctx.fillText(formatTime(segment.slotEnd), centerX, centerY + 3);
      ctx.globalAlpha = 1;

      if (drawHeight > 130) {
        ctx.font = 'bold 11px sans-serif';
        const labelText = isChan ? 'БАНЯ + ЧАН' : 'ВІЛЬНО';
        
        const textWidth = ctx.measureText(labelText).width;
        const pad = 8;
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath();
        ctx.roundRect(centerX - textWidth/2 - pad, drawY + drawHeight - 28, textWidth + pad*2, 20, 6);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.fillText(labelText, centerX, drawY + drawHeight - 28 + 5);
      }
    }
  }
}

function drawFooter(ctx: SKRSContext2D, layout: ReturnType<typeof calculateLayout>) {
  const y = layout.totalHeight - 24;
  
  // Line
  ctx.beginPath();
  ctx.moveTo(PADDING_X, y - 20);
  ctx.lineTo(CANVAS_WIDTH - PADDING_X, y - 20);
  ctx.strokeStyle = COLORS.ui.border;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.font = '400 14px sans-serif';
  ctx.fillStyle = 'rgba(214, 211, 209, 0.5)'; // Warm grey semi-transparent
  ctx.fillText('@simple_availability_bot', PADDING_X, y);

  ctx.textAlign = 'right';
  ctx.fillText(`Згенеровано: ${format(new Date(), 'dd.MM HH:mm')}`, CANVAS_WIDTH - PADDING_X, y);
}

// --- HELPER LOGIC ---

function calculateLayout(daysCount: number, timeTicksCount: number) {
  const rowsCount = timeTicksCount - 1; 
  const gridHeight = rowsCount * (BASE_ROW_HEIGHT * (GRID_MINUTE_STEP / 60));
  
  const availableWidth = CANVAS_WIDTH - (PADDING_X * 2) - TIME_COLUMN_WIDTH;
  const colWidth = (availableWidth - (COLUMN_GAP * (daysCount - 1))) / daysCount;

  const totalHeight = PADDING_Y + HEADER_HEIGHT + DAY_HEADER_HEIGHT + gridHeight + PADDING_Y;

  return {
    totalHeight,
    gridX: PADDING_X + TIME_COLUMN_WIDTH,
    gridY: PADDING_Y + HEADER_HEIGHT + DAY_HEADER_HEIGHT,
    colWidth,
    rowHeight: BASE_ROW_HEIGHT * (GRID_MINUTE_STEP / 60)
  };
}

function buildTimeTicks(openTime: string, closeTime: string): TimeTick[] {
  const openMinutes = timeToMinutes(openTime);
  const closeMinutes = timeToMinutes(closeTime);
  const ticks: TimeTick[] = [];
  
  for (let m = openMinutes; m <= closeMinutes; m += GRID_MINUTE_STEP) {
    ticks.push({
      timeString: minutesToLabel(m),
      label: m % 60 === 0 ? minutesToLabel(m) : '' 
    });
  }
  return ticks;
}

function groupAvailability(availability: AvailabilitySlot[], timeZone: string) {
  const map = new Map<string, Array<{ start: Date; end: Date; chanAvailable: boolean }>>();
  availability.forEach((slot) => {
    const start = toDateAtTime(slot.dateISO, slot.startTime, timeZone);
    const end = toDateAtTime(slot.dateISO, slot.endTime, timeZone);
    if (!map.has(slot.dateISO)) map.set(slot.dateISO, []);
    map.get(slot.dateISO)!.push({ start, end, chanAvailable: slot.chanAvailable !== false });
  });
  return map;
}

function resolveSlotStatus(
  iso: string,
  timeStr: string,
  settings: ScheduleSettings,
  availability: Map<string, Array<{ start: Date; end: Date; chanAvailable: boolean }>>,
  now: Date
): SlotStatus {
  const slotStart = toDateAtTime(iso, timeStr, settings.timeZone);
  const slotEnd = addMinutes(slotStart, GRID_MINUTE_STEP);

  if (slotEnd <= now) return 'booked';

  const slots = availability.get(iso) ?? [];
  const freeSlot = slots.find((entry) => slotStart >= entry.start && slotEnd <= entry.end);

  if (!freeSlot) return 'booked';
  return freeSlot.chanAvailable ? 'available_with_chan' : 'available';
}

function buildSegments(cells: SlotCell[]): SlotSegment[] {
  const segments: SlotSegment[] = [];
  let current: SlotSegment | null = null;

  cells.forEach((cell) => {
    if (current && current.status === cell.status && current.chanAvailable === cell.chanAvailable) {
      current.endRow = cell.rowIndex + 1;
      current.slotEnd = cell.slotEnd;
      return;
    }
    if (current) segments.push(current);
    
    current = {
      status: cell.status,
      startRow: cell.rowIndex,
      endRow: cell.rowIndex + 1,
      slotStart: cell.slotStart,
      slotEnd: cell.slotEnd,
      chanAvailable: cell.chanAvailable,
    };
  });
  if (current) segments.push(current);
  return segments;
}

// --- UTILS ---
function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToLabel(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60).toString().padStart(2, '0');
  const m = (totalMinutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatRange(days: Date[], timeZone: string): string {
  if (days.length === 1) return formatDateInZone(days[0], timeZone, 'd MMM');
  const f = formatDateInZone(days[0], timeZone, 'd MMM');
  const l = formatDateInZone(days[days.length - 1], timeZone, 'd MMM');
  return `${f} – ${l}`;
}

function formatDateInZone(date: Date, timeZone: string, pattern: string): string {
  const zoned = toZonedTime(date, timeZone);
  return format(zoned, pattern, { locale: uk });
}

function formatTime(date: Date): string {
  return format(date, 'HH:mm');
}

function getDurationMinutes(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 60000;
}