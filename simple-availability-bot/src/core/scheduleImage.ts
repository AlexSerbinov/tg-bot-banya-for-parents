import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { addMinutes, format } from 'date-fns';
import { uk } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { Booking, ScheduleSettings } from '../types';
import { dateToISO, toDateAtTime } from '../utils/time';
import { PerfLogger } from '../utils/perfLogger';

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
const CANVAS_WIDTH = 1400;
const PADDING_X = 48; 
const PADDING_Y = 48; 

const HEADER_HEIGHT = 260; // Increased for larger text
const DAY_HEADER_HEIGHT = 120; // Increased for larger pills
const TIME_COLUMN_WIDTH = 100; // Slightly wider
const COLUMN_GAP = 24; // Wider gap
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
      // Bright Lime (Modern)
      start: '#bef264', 
      end: '#84cc16',   
      shadow: 'rgba(132, 204, 22, 0.4)',
      text: '#0f172a' // Dark text
    },
    availableChan: {
      // Bright Cyan (Modern)
      start: '#67e8f9', 
      end: '#06b6d4',   
      shadow: 'rgba(6, 182, 212, 0.4)',
      text: '#0f172a' // Dark text
    },
    booked: {
      // Subtle Beige (Village)
      bg: 'rgba(62, 39, 35, 0.08)', 
      border: 'rgba(255, 255, 255, 0.1)', // Barely visible
      text: 'transparent'
    }
  }
};

type SlotStatus = 'available' | 'available_with_chan' | 'booked' | 'available_mixed';

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
  status: SlotStatus | 'mixed';
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
  bookings: Booking[];
  aggregateSlots?: boolean;
}

export async function generateAvailabilityImage({
  days,
  settings,
  bookings,
  aggregateSlots = true,
}: GenerateImageArgs): Promise<WeeklyScheduleImageResult> {
  const end = PerfLogger.start('IMAGE: generateAvailabilityImage');
  try {
    registerCustomFonts();

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
  const bookingsByDay = groupBookings(bookings, settings.timeZone);
  const now = new Date();
  const dayCells = days.map(() => [] as SlotCell[]);
  const stats: Record<SlotStatus, number> = { available: 0, available_with_chan: 0, booked: 0, available_mixed: 0 };

  days.forEach((day, colIndex) => {
    const iso = dateToISO(day);
    timeTicks.forEach((tick, rowIndex) => {
      if (rowIndex === timeTicks.length - 1) return;

      const status = resolveSlotStatus(iso, tick.timeString, settings, bookingsByDay, now);
      stats[status] += 1;

      const slotStart = toDateAtTime(iso, tick.timeString, settings.timeZone);
      const slotEnd = addMinutes(slotStart, GRID_MINUTE_STEP);
      
      const chanAvailable = status === 'available_with_chan';

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
        drawSlotSegment(ctx, segment, colX, layout, settings.timeZone);
      });
    }
  });

  drawFooter(ctx, layout);

    const buffer = canvas.toBuffer('image/png');
    
    return { buffer, stats };
  } finally {
    end();
  }
}

// --- ФУНКЦІЇ МАЛЮВАННЯ ---

async function drawWoodBackground(ctx: SKRSContext2D, width: number, height: number) {
  const end = PerfLogger.start('IMAGE: drawWoodBackground');
  try {
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

    ctx.strokeStyle = COLORS.ui.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(20, 20, width - 40, height - 40);
  } finally {
    end();
  }
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
  ctx.font = '700 60px "Playfair Display", Georgia, serif';
  ctx.fillStyle = COLORS.text.primary;
  ctx.fillText('Вільні години бані', PADDING_X, PADDING_Y);

  // Скидаємо сильну тінь
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;

  // Subtitle
  ctx.font = '400 32px "Inter", sans-serif';
  ctx.fillStyle = COLORS.text.secondary;
  ctx.fillText('Період: ', PADDING_X, PADDING_Y + 80);
  
  const periodWidth = ctx.measureText('Період: ').width;
  ctx.fillStyle = COLORS.text.primary;
  ctx.fillText(rangeLabel, PADDING_X + periodWidth, PADDING_Y + 80);

  ctx.font = '500 24px "Inter", sans-serif'; 
  ctx.fillStyle = COLORS.text.secondary;
  ctx.fillText(`Графік роботи: ${settings.dayOpenTime} – ${settings.dayCloseTime}`, PADDING_X, PADDING_Y + 125);

  ctx.shadowColor = 'transparent'; // Reset shadow
  
  // Legend moved to top right (below header)
  drawLegend(ctx, PADDING_X, PADDING_Y + 170);
}

function drawLegend(ctx: SKRSContext2D, leftX: number, topY: number) {
  const items = [
    { color: COLORS.slots.available.end, label: 'Вільно - лише баня без чану' },
    { color: COLORS.slots.availableChan.end, label: 'Вільно - баня і чан' },
    { color: 'rgba(127, 29, 29, 0.9)', label: 'Зайнято' }
  ];

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 30px "Inter", sans-serif'; // Larger font

  let currentX = leftX;
  const centerY = topY;

  items.forEach((item) => {
    // Dot
    ctx.save();
    ctx.shadowColor = item.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(currentX + 16, centerY, 16, 0, Math.PI * 2); // Larger dot (16px radius)
    ctx.fillStyle = item.color;
    if (item.label === 'Зайнято') ctx.globalAlpha = 0.5;
    ctx.fill();
    ctx.restore();
    
    // Label
    ctx.fillStyle = COLORS.text.secondary;
    ctx.fillText(item.label, currentX + 45, centerY);
    
    const labelWidth = ctx.measureText(item.label).width;
    currentX += (labelWidth + 80); // More spacing
  });
}

function drawTimeColumn(
  ctx: SKRSContext2D, 
  ticks: TimeTick[], 
  layout: ReturnType<typeof calculateLayout>
) {
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '500 32px "Inter", sans-serif'; // Larger time font (32px)
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
    ctx.font = '600 18px "Inter", sans-serif'; // Larger
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(dayName, centerX, startY + 16);

    // 2. Date Number
    ctx.font = '700 36px "Inter", sans-serif'; // Larger
    ctx.fillStyle = '#ffffff';
    ctx.fillText(dateNum, centerX, startY + 42);

    // 3. Month
    ctx.font = '500 16px "Inter", sans-serif'; // Larger
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(monthName, centerX, startY + 82);
  });
}

function drawSlotSegment(
  ctx: SKRSContext2D,
  segment: SlotSegment,
  x: number,
  layout: ReturnType<typeof calculateLayout>,
  timeZone: string
) {
  const rowCount = segment.endRow - segment.startRow;
  const height = rowCount * layout.rowHeight;
  const y = layout.gridY + segment.startRow * layout.rowHeight;
  
  const GAP = 4; 
  const drawHeight = height - GAP;
  const drawY = y + GAP / 2;
  const radius = 8; // Менш округлі кути для "суворого" стилю


  if (segment.status === 'booked') {
    // Booked - Subtle Beige Box (Village Style)
    // Booked - Red/Dark "Unavailable" style
    ctx.fillStyle = 'rgba(127, 29, 29, 0.9)'; // Dark Red
    ctx.strokeStyle = 'rgba(254, 202, 202, 0.3)'; // Light Red border
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.roundRect(x, drawY, layout.colWidth, drawHeight, radius);
    ctx.fill();
    ctx.stroke();

    // Text "НЕДОСТУПНО"
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    if (drawHeight > 30) {
      ctx.font = '700 16px "Inter", sans-serif';
      const centerX = x + layout.colWidth / 2;
      const centerY = drawY + drawHeight / 2;
      ctx.fillText('НЕДОСТУПНО', centerX, centerY);
    } 

  } else {
    // Available or Mixed
    ctx.save();
    
    // Determine gradient colors
    let gradient;
    if (segment.status === 'mixed') {
      // Gradient from Green (No Chan) to Blue (With Chan)
      // Transition happens around 12:00 - 13:00
      
      // Calculate relative position of 12:00 and 13:00 within the segment
      const segmentStart = segment.slotStart.getTime();
      const segmentEnd = segment.slotEnd.getTime();
      const duration = segmentEnd - segmentStart;
      
      // Get 12:00 and 13:00 timestamps for this day
      // We can use toDateAtTime helper but we need the date string.
      // Let's extract date from segment.slotStart
      const dateISO = dateToISO(segment.slotStart);
      const t12 = toDateAtTime(dateISO, '12:00', timeZone).getTime();
      const t13 = toDateAtTime(dateISO, '13:00', timeZone).getTime();

      const startRel = Math.max(0, Math.min(1, (t12 - segmentStart) / duration));
      const endRel = Math.max(0, Math.min(1, (t13 - segmentStart) / duration));
      
      gradient = ctx.createLinearGradient(x, drawY, x, drawY + drawHeight);
      
      // Start with Green
      gradient.addColorStop(0, COLORS.slots.available.start);
      if (startRel > 0) {
          gradient.addColorStop(startRel, COLORS.slots.available.end);
      }
      
      // Transition to Blue
      if (endRel < 1) {
          gradient.addColorStop(endRel, COLORS.slots.availableChan.start);
      }
      gradient.addColorStop(1, COLORS.slots.availableChan.end);
      
      ctx.shadowColor = COLORS.slots.availableChan.shadow; // Use blue shadow for mixed

    } else {
      // Standard single color
      const isChan = segment.status === 'available_with_chan';
      const style = isChan ? COLORS.slots.availableChan : COLORS.slots.available;
      
      gradient = ctx.createLinearGradient(x, drawY, x, drawY + drawHeight);
      gradient.addColorStop(0, style.start);
      gradient.addColorStop(1, style.end);
      
      ctx.shadowColor = style.shadow;
    }

    ctx.shadowBlur = 15;
    ctx.shadowOffsetY = 5;
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, drawY, layout.colWidth, drawHeight, radius);
    ctx.fill();
    ctx.restore(); 

    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Labels
    const duration = getDurationMinutes(segment.slotStart, segment.slotEnd);
    const centerX = x + layout.colWidth / 2;
    const centerY = drawY + drawHeight / 2;

    // Determine text color - usually dark for available slots
    ctx.fillStyle = COLORS.slots.available.text; 
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (duration <= 60) {
      ctx.font = '700 22px sans-serif'; 
      const timeLabel = `${formatTime(segment.slotStart, timeZone)}-${formatTime(segment.slotEnd, timeZone)}`;
      ctx.fillText(timeLabel, centerX, centerY - 10);
      
      ctx.font = '800 20px sans-serif'; 
      let labelText = 'БАНЯ';
      if (segment.status === 'available_with_chan') labelText = 'БАНЯ+ЧАН';
      if (segment.status === 'mixed') labelText = 'ВІЛЬНО';
      ctx.fillText(labelText, centerX, centerY + 12);
    } else {
      // Large slots (> 60 mins)
      
      if (segment.status === 'mixed') {
         // MIXED SLOT: Text at Top & Bottom. Time in Center.
         
         // 1. Draw Time in Center
         ctx.textBaseline = 'bottom';
         ctx.font = '700 24px sans-serif'; 
         ctx.fillText(formatTime(segment.slotStart, timeZone), centerX, centerY - 5);
         
         ctx.textBaseline = 'top';
         ctx.font = '600 22px sans-serif'; 
         ctx.globalAlpha = 0.8;
         ctx.fillText(formatTime(segment.slotEnd, timeZone), centerX, centerY + 5);
         ctx.globalAlpha = 1;

         // 2. Draw Labels (Top & Bottom)
         if (drawHeight > 200) { // Only if enough space
            ctx.font = '800 24px sans-serif';
            ctx.fillStyle = '#0f172a'; // Dark text
            
            // Top label (Green part)
            ctx.textBaseline = 'top';
            ctx.fillText('ВІЛЬНО', centerX, drawY + 20);
            ctx.font = '600 18px sans-serif';
            ctx.fillText('(БЕЗ ЧАНУ)', centerX, drawY + 50);

            // Bottom label (Blue part)
            ctx.textBaseline = 'bottom';
            ctx.font = '600 18px sans-serif';
            ctx.fillText('(З ЧАНОМ)', centerX, drawY + drawHeight - 20);
            ctx.font = '800 24px sans-serif';
            ctx.fillText('ВІЛЬНО', centerX, drawY + drawHeight - 45);
         }

      } else {
         // STANDARD SLOT: Text in Center. Time at Top (Single Line).
         
         // 1. Draw Time at Top (Single Line)
         ctx.fillStyle = COLORS.slots.available.text;
         ctx.textAlign = 'center';
         ctx.textBaseline = 'middle';
         
         ctx.font = '700 22px sans-serif'; 
         const timeLabel = `${formatTime(segment.slotStart, timeZone)} – ${formatTime(segment.slotEnd, timeZone)}`;
         ctx.fillText(timeLabel, centerX, drawY + 20);

         // 2. Draw Labels in Center
         // Available height for text: drawHeight - 40px (time)
         // We need about 60px for two lines of text.
         // So drawHeight > 100 is a good threshold.
         
         if (drawHeight > 90) {
            let fontSize = 32;
            ctx.font = `800 ${fontSize}px sans-serif`;
            
            let mainText = 'ВІЛЬНО';
            let subText = '(БЕЗ ЧАНУ)';
            
            if (segment.status === 'available_with_chan') {
               mainText = 'ВІЛЬНО';
               subText = '(З ЧАНОМ)';
            }

            // Dynamic scaling
            const maxWidth = layout.colWidth - 16;
            while (ctx.measureText(mainText).width > maxWidth && fontSize > 18) {
               fontSize -= 2;
               ctx.font = `800 ${fontSize}px sans-serif`;
            }

            // Center Y for text block
            // We want the text block to be centered in the remaining space? 
            // Or just centered in the slot, but pushed down slightly?
            // Center of slot is centerY.
            // Time is at Top.
            // So we can just center the text at centerY + 10?
            
            ctx.textBaseline = 'middle';
            // Draw Main Text
            ctx.fillText(mainText, centerX, centerY - 5);
            
            // Draw Sub Text
            ctx.font = '600 18px sans-serif'; // Slightly smaller subtext
            ctx.fillText(subText, centerX, centerY + 20);
         }
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

function groupBookings(bookings: Booking[], timeZone: string) {
  const map = new Map<string, Array<{ start: Date; end: Date; withChan: boolean }>>();
  bookings.forEach((booking) => {
    const start = toDateAtTime(booking.dateISO, booking.startTime, timeZone);
    const end = toDateAtTime(booking.dateISO, booking.endTime, timeZone);
    if (!map.has(booking.dateISO)) map.set(booking.dateISO, []);
    map.get(booking.dateISO)!.push({ start, end, withChan: booking.withChan });
  });
  return map;
}

function resolveSlotStatus(
  iso: string,
  timeStr: string,
  settings: ScheduleSettings,
  bookings: Map<string, Array<{ start: Date; end: Date; withChan: boolean }>>,
  now: Date
): SlotStatus {
  const slotStart = toDateAtTime(iso, timeStr, settings.timeZone);
  const slotEnd = addMinutes(slotStart, GRID_MINUTE_STEP);

  if (slotEnd <= now) return 'booked'; // Past is always booked/busy

  const dayBookings = bookings.get(iso) ?? [];
  
  // Check if slot is booked
  const isBooked = dayBookings.some((entry) => 
    rangesOverlap(slotStart, slotEnd, entry.start, entry.end)
  );

  if (isBooked) return 'booked';

  // If not booked, it's available. Now check Chan.
  // Chan available if:
  // 1. Time >= 13:00 (chanStartLimit)
  // 2. No other booking on this day has withChan === true
  
  const chanStartLimit = toDateAtTime(iso, '13:00', settings.timeZone);
  const isAfterChanStart = slotStart >= chanStartLimit;
  const chanAlreadyBooked = dayBookings.some(b => b.withChan);

  if (isAfterChanStart && !chanAlreadyBooked) {
      return 'available_with_chan';
  }

  return 'available';
}

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
    return aStart < bEnd && bStart < aEnd;
}

function buildSegments(cells: SlotCell[]): SlotSegment[] {
  const segments: SlotSegment[] = [];
  let current: SlotSegment | null = null;

  cells.forEach((cell) => {
    // Check if we can merge
    let canMerge = false;
    
    if (current) {
        if (current.status === cell.status && current.chanAvailable === cell.chanAvailable) {
            // Exact match
            canMerge = true;
        } else if (
            (current.status === 'available' || current.status === 'available_with_chan' || current.status === 'mixed') &&
            (cell.status === 'available' || cell.status === 'available_with_chan')
        ) {
            // Both are available types (maybe different chan status)
            // We merge them into a 'mixed' segment
            canMerge = true;
            current.status = 'mixed'; // Upgrade to mixed
        }
    }

    if (canMerge && current) {
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

function formatTime(date: Date, timeZone: string): string {
  const zoned = toZonedTime(date, timeZone);
  return format(zoned, 'HH:mm');
}

function getDurationMinutes(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 60000;
}