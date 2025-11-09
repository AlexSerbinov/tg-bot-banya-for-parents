import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { Booking, Settings } from '@prisma/client';
import { addMinutes, differenceInMinutes, format, isBefore } from 'date-fns';
import { uk } from 'date-fns/locale';
import { dateToISO, toDateAtTime } from './time';

type SlotStatus = 'available' | 'booked' | 'cleaning' | 'tight' | 'past';

interface GenerateImageArgs {
  days: Date[];
  settings: Settings;
  bookings: Booking[];
}

export interface WeeklyScheduleImageResult {
  buffer: Buffer;
  stats: Record<SlotStatus, number>;
}

const CANVAS_WIDTH = 1080;
const HEADER_HEIGHT = 132;
const LEGEND_HEIGHT = 68;
const LEGEND_BOTTOM_MARGIN = 24;
const LEFT_MARGIN = 36;
const RIGHT_MARGIN = 36;
const ROW_LABEL_WIDTH = 120;
const COLUMN_GAP = 12;
const ROW_HEIGHT = 58;
const ROW_GAP = 12;
const BOTTOM_PADDING = 46;

export function generateWeeklyScheduleImage({
  days,
  settings,
  bookings,
}: GenerateImageArgs): WeeklyScheduleImageResult {
  console.log('🎨 Starting schedule image generation... [UPDATED VERSION v2.0]');

  if (!days.length) {
    throw new Error('Expected at least one day to build schedule image');
  }

  const hourLabels = buildHourLabels(settings.dayOpenTime, settings.dayCloseTime);
  if (!hourLabels.length) {
    throw new Error('Робочі години закороткі для побудови розкладу');
  }

  const gridTop = HEADER_HEIGHT + LEGEND_HEIGHT + LEGEND_BOTTOM_MARGIN;
  const gridHeight =
    hourLabels.length * ROW_HEIGHT + Math.max(0, hourLabels.length - 1) * ROW_GAP;
  const canvasHeight = gridTop + gridHeight + BOTTOM_PADDING;

  const canvas = createCanvas(CANVAS_WIDTH, canvasHeight);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, CANVAS_WIDTH, canvasHeight);
  drawHeader(ctx, days);
  drawLegend(ctx);

  const layout = computeGridLayout(days.length);
  drawDayHeaders(ctx, days, layout, gridTop);
  drawRowLabels(ctx, hourLabels, layout, gridTop);

  const stats: Record<SlotStatus, number> = {
    available: 0,
    booked: 0,
    cleaning: 0,
    tight: 0,
    past: 0,
  };

  const minDurationMinutes = getMinimumDurationMinutes(settings);

  const dayDescriptors = days.map((day) => ({
    iso: dateToISO(day),
    label: format(day, 'EEE', { locale: uk }),
    dateLabel: format(day, 'd MMM', { locale: uk }),
  }));

  const tightRangesByDay = buildTightRangesByDay(
    dayDescriptors,
    bookings,
    settings,
    minDurationMinutes
  );

  const now = new Date();

  dayDescriptors.forEach((day, columnIndex) => {
    hourLabels.forEach((timeLabel, rowIndex) => {
      const dayTightRanges = tightRangesByDay.get(day.iso) ?? [];
      const status = resolveSlotStatus(
        day.iso,
        timeLabel,
        settings,
        bookings,
        now,
        dayTightRanges
      );

      stats[status] += 1;

      const cellX =
        layout.gridX + columnIndex * (layout.columnWidth + layout.columnGap);
      const cellY = gridTop + rowIndex * (ROW_HEIGHT + ROW_GAP);

      drawSlotCell(ctx, cellX, cellY, layout.columnWidth, ROW_HEIGHT, status);
      drawSlotLabel(ctx, cellX, cellY, layout.columnWidth, ROW_HEIGHT, status);
    });
  });

  const buffer = canvas.toBuffer('image/png');
  console.log(`✅ Schedule image generated successfully! Size: ${buffer.length} bytes`);

  return { buffer, stats };
}

type CanvasCtx = SKRSContext2D;

function drawBackground(ctx: CanvasCtx, width: number, height: number) {
  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#1d2434');
  gradient.addColorStop(1, '#141927');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, HEADER_HEIGHT);
}

function drawHeader(ctx: CanvasCtx, days: Date[]) {
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 48px "Arial"';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Вільні слоти', LEFT_MARGIN, 26);

  const rangeLabel = formatRange(days);
  ctx.font = '600 30px "Arial"';
  ctx.fillStyle = '#93c5fd';
  ctx.fillText(rangeLabel, LEFT_MARGIN, 84);
}

function drawLegend(ctx: CanvasCtx) {
  const legendItems: { color: string; label: string }[] = [
    { color: '#22c55e', label: 'Вільно' },
    { color: '#f87171', label: 'Зайнято' },
    { color: '#fde047', label: '🧹 Прибирання' },
    { color: '#94a3b8', label: 'Недоступно' },
    { color: '#475569', label: 'Минуло' },
  ];

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 24px "Arial"';

  let currentX = LEFT_MARGIN;
  const centerY = HEADER_HEIGHT + LEGEND_HEIGHT / 2 - 4;

  legendItems.forEach((item) => {
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.roundRect(currentX, centerY - 16, 48, 32, 12);
    ctx.fill();

    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(item.label, currentX + 58, centerY);

    currentX += 58 + ctx.measureText(item.label).width + 40;
  });
}

function computeGridLayout(dayCount: number) {
  const gridX = LEFT_MARGIN + ROW_LABEL_WIDTH;
  const availableWidth = CANVAS_WIDTH - gridX - RIGHT_MARGIN;
  const columnGap = dayCount > 1 ? COLUMN_GAP : 0;
  const columnWidth =
    dayCount > 0
      ? (availableWidth - columnGap * Math.max(0, dayCount - 1)) / dayCount
      : availableWidth;

  return { gridX, columnWidth, columnGap };
}

function drawDayHeaders(
  ctx: CanvasCtx,
  days: Date[],
  layout: { gridX: number; columnWidth: number; columnGap: number },
  gridTop: number
) {
  const headersY = gridTop - 42;
  const datesY = gridTop - 14;

  days.forEach((day, index) => {
    const centerX =
      layout.gridX + index * (layout.columnWidth + layout.columnGap) +
      layout.columnWidth / 2;

    const dayLabel = capitalize(format(day, 'EEE', { locale: uk }));
    const dateLabel = format(day, 'd MMM', { locale: uk });

    ctx.fillStyle = '#f1f5f9';
    ctx.font = '700 26px "Arial"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dayLabel, centerX, headersY);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 22px "Arial"';
    ctx.fillText(dateLabel, centerX, datesY);
  });
}

function drawRowLabels(
  ctx: CanvasCtx,
  hourLabels: string[],
  layout: { gridX: number },
  gridTop: number
) {
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '700 24px "Arial"';
  ctx.fillStyle = '#cbd5f5';

  hourLabels.forEach((time, rowIndex) => {
    const centerY = gridTop + rowIndex * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
    ctx.fillText(time, layout.gridX - 16, centerY);
  });
}

function drawSlotCell(
  ctx: CanvasCtx,
  x: number,
  y: number,
  width: number,
  height: number,
  status: SlotStatus
) {
  const colors: Record<SlotStatus, string> = {
    available: '#1ea672',
    booked: '#ef4444',
    cleaning: '#facc15', // Жовтий - прибирання (тільки після візитів)
    tight: '#94a3b8',    // Сірий - недоступно (мало часу для запису)
    past: '#334155',
  };

  ctx.fillStyle = colors[status];
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 16);
  ctx.fill();

  // Додаємо помітне перекреслення для минулих слотів без тексту
  if (status === 'past') {
    ctx.save();
    ctx.strokeStyle = 'rgba(226,232,240,0.8)'; // Більш помітний колір
    ctx.lineWidth = 4; // Товща лінія
    ctx.setLineDash([8, 6]); // Пунктирна лінія
    ctx.beginPath();
    ctx.moveTo(x + 12, y + height / 2);
    ctx.lineTo(x + width - 12, y + height / 2);
    ctx.stroke();
    ctx.restore();
  }
}

interface SlotLabelMeta {
  text: string | string[];
  color: string;
  font?: string;
  lineHeight?: number;
}

function drawSlotLabel(
  ctx: CanvasCtx,
  x: number,
  y: number,
  width: number,
  height: number,
  status: SlotStatus
) {
  const labels: Record<SlotStatus, SlotLabelMeta> = {
    available: { text: 'Вільно', color: '#052e16' },
    booked: { text: 'Зайнято', color: '#fee2e2' },
    cleaning: {
      text: ['🧹', 'Прибирання'],
      color: '#422006',
      font: '700 20px "Arial"',
      lineHeight: 20,
    },
    tight: { text: 'Недоступно', color: '#0f172a', font: '700 17px "Arial"' }, // Сірий - мало часу для запису
    past: { text: '', color: '#e2e8f0' },
  };

  const label = labels[status];
  let font = label.font ?? '700 22px "Arial"';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = label.color;

  const lines = Array.isArray(label.text) ? label.text : [label.text];
  if (!lines[0]) {
    return; // нічого не пишемо (наприклад, для минулих слотів)
  }
  if (lines.length === 1) {
    // Піджимаємо «Недоступно», якщо не влазить
    if (status === 'tight') {
      let maxWidth = width - 24;
      let iterations = 0;

      while (iterations < 15) { // Збільшив ліміт ітерацій для кращого підбору розміру
        const measuredWidth = ctx.measureText(lines[0]).width;
        if (measuredWidth <= maxWidth) break;

        const currentSize = parseInt(font.match(/(\d+)px/ )?.[1] || '17', 10);
        if (currentSize <= 12) break; // Зменшив мінімальний розмір шрифту до 12px

        font = font.replace(/\d+px/, `${currentSize - 1}px`);
        ctx.font = font;
        iterations++;
      }
    }
    ctx.fillText(lines[0], x + width / 2, y + height / 2 + 2);
    return;
  }

  const lineHeight = label.lineHeight ?? 22;
  const totalHeight = lineHeight * lines.length;
  const startY = y + height / 2 - totalHeight / 2;

  lines.forEach((line, index) => {
    const lineCenter = startY + index * lineHeight + lineHeight / 2;
    ctx.fillText(line, x + width / 2, lineCenter);
  });
}

function resolveSlotStatus(
  dateISO: string,
  timeStr: string,
  settings: Settings,
  bookings: Booking[],
  now: Date,
  tightRanges: TimeRange[]
): SlotStatus {
  const slotStart = toDateAtTime(dateISO, timeStr, settings.timeZone);
  const slotEnd = addMinutes(slotStart, 60);

  if (isBefore(slotEnd, now)) {
    return 'past';
  }

  const overlapsDirectly = bookings.some((booking) =>
    rangesOverlap(slotStart, slotEnd, booking.dateStart, booking.dateEnd)
  );

  if (overlapsDirectly) {
    return 'booked';
  }

  const bufferMin = settings.cleaningBufferMin;
  if (bufferMin > 0) {
    // Прибирання ТІЛЬКИ після попереднього візиту (1 година) - ПРІОРИТЕТ!
    const touchesBuffer = bookings.some((booking) => {
      if (rangesOverlap(slotStart, slotEnd, booking.dateStart, booking.dateEnd)) {
        return false;
      }

      const minutesSinceBookingEnded = differenceInMinutes(
        slotStart,
        booking.dateEnd
      );

      // Тільки після попереднього візиту, не перед наступним!
      return minutesSinceBookingEnded > 0 && minutesSinceBookingEnded <= bufferMin;
    });

    if (touchesBuffer) {
      return 'cleaning';
    }
  }

  // Недоступно - коли мало часу для запису (tight ranges)
  if (isWithinRanges(slotStart, slotEnd, tightRanges)) {
    return 'tight';
  }

  return 'available';
}

interface TimeRange {
  start: Date;
  end: Date;
}

function rangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function isWithinRanges(
  slotStart: Date,
  slotEnd: Date,
  ranges: TimeRange[]
): boolean {
  return ranges.some((range) => rangesOverlap(slotStart, slotEnd, range.start, range.end));
}

function buildHourLabels(openTime: string, closeTime: string): string[] {
  const openMinutes = timeToMinutes(openTime);
  const closeMinutes = timeToMinutes(closeTime);

  if (closeMinutes <= openMinutes) {
    return [];
  }

  const labels: string[] = [];
  for (let minutes = openMinutes; minutes < closeMinutes; minutes += 60) {
    labels.push(minutesToLabel(minutes));
  }
  return labels;
}

function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map((n) => parseInt(n, 10));
  return hours * 60 + minutes;
}

function minutesToLabel(totalMinutes: number): string {
  const hrs = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, '0');
  const mins = (totalMinutes % 60).toString().padStart(2, '0');
  return `${hrs}:${mins}`;
}

function formatRange(days: Date[]): string {
  if (days.length === 1) {
    return format(days[0], 'd MMM', { locale: uk });
  }

  const first = format(days[0], 'd MMM', { locale: uk });
  const last = format(days[days.length - 1], 'd MMM', { locale: uk });
  return `${first} – ${last}`;
}

function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  return value[0].toUpperCase() + value.slice(1);
}

function getMinimumDurationMinutes(settings: Settings): number {
  const durations = settings.allowedDurations
    .split(',')
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n > 0);

  if (!durations.length) {
    return 120;
  }

  return Math.min(...durations) * 60;
}

function buildTightRangesByDay(
  days: Array<{ iso: string }>,
  bookings: Booking[],
  settings: Settings,
  minDurationMinutes: number
): Map<string, TimeRange[]> {
  const rangesByDay = new Map<string, TimeRange[]>();
  const bufferMin = settings.cleaningBufferMin;

  // Нова логіка відповідно до вимог:
  // Мінімальний запис - 2 години
  // Прибирання - 1 година
  // Внутрішні слоти: 4 години (2 год візит + 1 год прибирання до + 1 год прибирання після)
  // Початок/кінець дня: 3 години (можна поприбирати раніше/пізніше)
  const requiredGapMinutesMiddle = 240; // 4 години - всередині дня
  const requiredGapMinutesStart = 180;  // 3 години - на початку дня
  const requiredGapMinutesEnd = 180;    // 3 години - в кінці дня

  days.forEach((day) => {
    const dayOpen = toDateAtTime(day.iso, settings.dayOpenTime, settings.timeZone);
    const dayClose = toDateAtTime(day.iso, settings.dayCloseTime, settings.timeZone);

    const dayBookings = bookings
      .filter((booking) =>
        rangesOverlap(dayOpen, dayClose, booking.dateStart, booking.dateEnd)
      )
      .sort(
        (a, b) => a.dateStart.getTime() - b.dateStart.getTime()
      );

    const tightRanges: TimeRange[] = [];

    // Початок дня - якщо менше 3 годин до першого бронювання
    if (dayBookings.length >= 1) {
      const first = dayBookings[0];
      const startGap = differenceInMinutes(first.dateStart, dayOpen);
      if (startGap > 0 && startGap < requiredGapMinutesStart) {
        // Недоступний час (включаючи можливе прибирання)
        const gapStart = dayOpen;
        const gapEnd = first.dateStart; // До початку бронювання
        if (gapEnd > gapStart) {
          tightRanges.push({ start: gapStart, end: gapEnd });
        }
      }
    }

    // Проміжки між бронюваннями - якщо менше 4 годин
    for (let i = 0; i < dayBookings.length - 1; i += 1) {
      const current = dayBookings[i];
      const next = dayBookings[i + 1];
      const gapMinutes = differenceInMinutes(next.dateStart, current.dateEnd);

      if (gapMinutes <= 0 || gapMinutes >= requiredGapMinutesMiddle) {
        continue;
      }

      // Весь проміжок недоступний (включаючи час прибирання)
      const gapStart = current.dateEnd;
      const gapEnd = next.dateStart;

      if (gapEnd > gapStart) {
        tightRanges.push({ start: gapStart, end: gapEnd });
      }
    }

    // Кінець дня - якщо менше 3 годин після останнього бронювання
    if (dayBookings.length >= 1) {
      const last = dayBookings[dayBookings.length - 1];
      const endGap = differenceInMinutes(dayClose, last.dateEnd);
      if (endGap > 0 && endGap < requiredGapMinutesEnd) {
        // Недоступний час (включаючи можливе прибирання)
        const gapStart = last.dateEnd;
        const gapEnd = dayClose; // До закриття
        if (gapEnd > gapStart) {
          tightRanges.push({ start: gapStart, end: gapEnd });
        }
      }
    }

    if (tightRanges.length) {
      rangesByDay.set(day.iso, tightRanges);
    }
  });

  return rangesByDay;
}
