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
const CANVAS_WIDTH = 1400; // Increased for better spacing
const PADDING_X = 48; 
const PADDING_Y = 48; 

const HEADER_HEIGHT = 220; // Increased to prevent overlap
const DAY_HEADER_HEIGHT = 100; // Increased for breathing room
const TIME_COLUMN_WIDTH = 90;
const COLUMN_GAP = 20; // Increased gap
const BASE_ROW_HEIGHT = 60; 
const GRID_MINUTE_STEP = 30; 

// --- ПАЛІТРА "VILLAGE STYLE" ---
const COLORS = {
  // Фон
  overlay: 'rgba(20, 10, 5, 0.4)', // Легке затемнення дерева
  
  card: {
    bg: 'rgba(253, 251, 247, 0.65)', // Напівпрозорий папір (Parchment effect)
    shadow: 'rgba(0,0,0,0.5)'
  },

  text: {
    primary: '#3e2723',   // Dark Brown
    secondary: '#5d4037', // Medium Brown
    accent: '#d84315',    // Terracotta
    muted: '#8d6e63'      // Light Brown
  },
  
  ui: {
    headerPill: '#efebe9', // Beige pill for days
    border: '#e2d9d0',     // Light beige border
    gridLines: 'transparent'
  },

  slots: {
    available: {
      // Green (Banya)
      start: '#7cb342', 
      end: '#558b2f',   
      border: '#33691e',
      text: '#ffffff'
    },
    availableChan: {
      // Teal (Chan)
      start: '#26a69a', 
      end: '#00695c',   
      border: '#004d40',
      text: '#ffffff'
    },
    booked: {
      // Subtle Beige / Ghost
      bg: 'rgba(62, 39, 35, 0.08)', 
      border: '#d7ccc8',
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
  
  // 2. КАРТКА
  drawCard(ctx, CANVAS_WIDTH, layout.totalHeight);

  // 3. Контент (всередині картки)
  // Зміщуємо контент, бо тепер він всередині картки з паддінгами
  // Але layout вже враховує PADDING_X/Y, які ми використаємо як відступи всередині картки
  
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

  // --- ОВЕРЛЕЙ ---
  ctx.fillStyle = COLORS.overlay;
  ctx.fillRect(0, 0, width, height);
}

function drawCard(ctx: SKRSContext2D, width: number, height: number) {
  const cardX = 40;
  const cardY = 40;
  const cardW = width - 80;
  const cardH = height - 80;
  const radius = 24;

  ctx.save();
  // Shadow
  ctx.shadowColor = COLORS.card.shadow;
  ctx.shadowBlur = 50;
  ctx.shadowOffsetY = 20;
  
  ctx.fillStyle = COLORS.card.bg;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, radius);
  ctx.fill();
  ctx.restore();
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
  ctx.font = '400 28px Georgia, serif';
  ctx.fillStyle = COLORS.text.secondary;
  ctx.fillText('Період: ', PADDING_X, PADDING_Y + 80);
  
  const periodWidth = ctx.measureText('Період: ').width;
  ctx.fillStyle = COLORS.text.accent;
  ctx.font = '600 28px Georgia, serif';
  ctx.fillText(rangeLabel, PADDING_X + periodWidth, PADDING_Y + 80);

  ctx.font = '400 20px Georgia, serif'; 
  ctx.fillStyle = COLORS.text.muted;
  ctx.fillText(`Графік роботи: ${settings.dayOpenTime} – ${settings.dayCloseTime}`, PADDING_X, PADDING_Y + 120);

  // Divider line
  const dividerY = PADDING_Y + 150;
  ctx.beginPath();
  ctx.moveTo(PADDING_X, dividerY);
  ctx.lineTo(CANVAS_WIDTH - PADDING_X, dividerY);
  ctx.strokeStyle = COLORS.ui.border;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Legend - Moved below divider for clear separation
  drawLegend(ctx, PADDING_X, dividerY + 25);
  
  // Leaf Icon
  ctx.save();
  ctx.font = '100px serif'; // Larger icon
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = '#3e2723';
  ctx.fillText('🌿', CANVAS_WIDTH - PADDING_X - 80, PADDING_Y + 20);
  ctx.restore();
}

function drawLegend(ctx: SKRSContext2D, leftX: number, topY: number) {
  const items = [
    { color: COLORS.slots.available.start, label: 'Вільно (Баня)' },
    { color: COLORS.slots.availableChan.start, label: 'Вільно (Баня + Чан)' },
    { color: '#8d6e63', label: 'Зайнято' } 
  ];

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 24px "Playfair Display", Georgia, serif'; // Larger font

  let currentX = leftX;
  const centerY = topY;

  items.forEach((item) => {
    // Dot
    ctx.save();
    ctx.beginPath();
    ctx.arc(currentX + 12, centerY, 12, 0, Math.PI * 2); // Larger dot
    
    if (item.label.includes('Зайнято')) {
        ctx.fillStyle = item.color;
        ctx.globalAlpha = 0.5;
    } else {
        ctx.fillStyle = item.color;
    }
    ctx.fill();
    ctx.restore();
    
    // Label
    ctx.fillStyle = COLORS.text.primary;
    ctx.fillText(item.label, currentX + 35, centerY);
    
    const labelWidth = ctx.measureText(item.label).width;
    currentX += (labelWidth + 70); // More spacing
  });
}

function drawTimeColumn(
  ctx: SKRSContext2D, 
  ticks: TimeTick[], 
  layout: ReturnType<typeof calculateLayout>
) {
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '600 18px "Playfair Display", Georgia, serif'; 
  ctx.fillStyle = COLORS.text.muted;

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
    
    const dayName = formatDateInZone(day, timeZone, 'EEEEEE').toUpperCase();
    const dateNum = formatDateInZone(day, timeZone, 'd');

    const pillX = colX;
    const pillWidth = layout.colWidth;
    
    // Header background pill (Beige)
    ctx.fillStyle = COLORS.ui.headerPill;
    ctx.strokeStyle = '#d7ccc8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(pillX, startY, pillWidth, DAY_HEADER_HEIGHT - 10, 12);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    
    // 1. Day Name
    ctx.textBaseline = 'top';
    ctx.font = '700 14px Georgia, serif';
    ctx.fillStyle = '#795548'; // Brown
    ctx.fillText(dayName, centerX, startY + 12);

    // 2. Date Number
    ctx.font = '700 28px "Playfair Display", Georgia, serif';
    ctx.fillStyle = COLORS.text.primary;
    ctx.fillText(dateNum, centerX, startY + 32);
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
    // Booked - Subtle Beige Box
    ctx.fillStyle = COLORS.slots.booked.bg;
    ctx.strokeStyle = COLORS.slots.booked.border;
    ctx.setLineDash([4, 4]); // Dashed border
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.roundRect(x, drawY, layout.colWidth, drawHeight, radius);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]); // Reset dash

  } else {
    // Available - Gradient
    const isChan = segment.status === 'available_with_chan';
    const style = isChan ? COLORS.slots.availableChan : COLORS.slots.available;

    ctx.save();
    // Shadow
    ctx.shadowColor = 'rgba(0,0,0,0.1)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 4;
    
    const gradient = ctx.createLinearGradient(x, drawY, x, drawY + drawHeight);
    gradient.addColorStop(0, style.start);
    gradient.addColorStop(1, style.end);
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, drawY, layout.colWidth, drawHeight, radius);
    ctx.fill();
    ctx.restore(); 

    ctx.strokeStyle = style.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Labels
    const duration = getDurationMinutes(segment.slotStart, segment.slotEnd);
    const centerX = x + layout.colWidth / 2;
    const centerY = drawY + drawHeight / 2;

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Text Shadow for readability
    ctx.shadowColor = 'rgba(0,0,0,0.2)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;

    if (duration <= 60) {
      // Small slot: Compact layout
      ctx.font = '600 18px sans-serif';
      const timeLabel = `${formatTime(segment.slotStart)}-${formatTime(segment.slotEnd)}`;
      ctx.fillText(timeLabel, centerX, centerY - 8);
      
      ctx.font = '700 16px sans-serif';
      const labelText = isChan ? 'БАНЯ+ЧАН' : 'БАНЯ';
      ctx.fillText(labelText, centerX, centerY + 10);
    } else {
      // Large slot: Big & Bold
      ctx.textBaseline = 'bottom';
      ctx.font = '600 20px sans-serif';
      ctx.fillText(`${formatTime(segment.slotStart)} – ${formatTime(segment.slotEnd)}`, centerX, centerY - 10);
      
      ctx.textBaseline = 'top';
      ctx.font = '800 28px "Playfair Display", serif'; // Huge font for main status
      ctx.fillText('ВІЛЬНО', centerX, centerY - 5);

      if (drawHeight > 100) {
        ctx.font = '700 20px sans-serif'; // Larger subtitle
        const labelText = isChan ? 'БАНЯ + ЧАН' : 'БАНЯ';
        ctx.fillText(labelText, centerX, centerY + 28);
      }
    }
    
    ctx.shadowColor = 'transparent'; // Reset shadow
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
  ctx.fillStyle = COLORS.text.muted;
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

  const totalHeight = PADDING_Y + HEADER_HEIGHT + DAY_HEADER_HEIGHT + gridHeight + PADDING_Y + 40; // Extra padding for card

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