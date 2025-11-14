import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { Booking, Settings } from '@prisma/client';
import { addMinutes, differenceInMinutes, format, isBefore } from 'date-fns';
import { uk } from 'date-fns/locale';
import { dateToISO, toDateAtTime } from './time';
import { computeChanWindowsByDay, isWithinStartOfDayChanWindow } from './chan';

type SlotStatus = 'available' | 'booked' | 'cleaning' | 'tight' | 'past';
type VisualSlotStatus = 'available' | 'booked' | 'cleaning' | 'past';

interface GenerateImageArgs {
  days: Date[];
  settings: Settings;
  bookings: Booking[];
  aggregateSlots?: boolean;
  bookedAsUnavailable?: boolean;
}

export interface WeeklyScheduleImageResult {
  buffer: Buffer;
  stats: Record<SlotStatus, number>;
}

interface SlotCell {
  rawStatus: SlotStatus;
  visualStatus: VisualSlotStatus;
  chanAvailable?: boolean;
  rowIndex: number;
  slotStart: Date;
  slotEnd: Date;
}

const CANVAS_WIDTH = 1080;
const HEADER_HEIGHT = 132;
const HEADER_BOTTOM_MARGIN = 16;
const LEGEND_HEIGHT = 68;
const LEGEND_BOTTOM_MARGIN = 32;
const GRID_TOP_PADDING = 24;
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
  aggregateSlots = true,
  bookedAsUnavailable = false,
}: GenerateImageArgs): WeeklyScheduleImageResult {
  console.log('🎨 Starting schedule image generation... [UPDATED VERSION v2.0]');

  if (!days.length) {
    throw new Error('Expected at least one day to build schedule image');
  }

  const hourLabels = buildHourLabels(settings.dayOpenTime, settings.dayCloseTime);
  if (!hourLabels.length) {
    throw new Error('Робочі години закороткі для побудови розкладу');
  }

  const legendTop = HEADER_HEIGHT + HEADER_BOTTOM_MARGIN;
  const gridTop =
    legendTop + LEGEND_HEIGHT + LEGEND_BOTTOM_MARGIN + GRID_TOP_PADDING;
  const gridHeight =
    hourLabels.length * ROW_HEIGHT + Math.max(0, hourLabels.length - 1) * ROW_GAP;
  const canvasHeight = gridTop + gridHeight + BOTTOM_PADDING;

  const canvas = createCanvas(CANVAS_WIDTH, canvasHeight);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, CANVAS_WIDTH, canvasHeight);
  drawHeader(ctx, days, settings);
  drawLegend(ctx, legendTop);

  const layout = computeGridLayout(days.length);
  drawDayHeaders(ctx, days, layout, gridTop);
  drawRowLabels(ctx, hourLabels, layout, gridTop);

  const daySlots: SlotCell[][] = days.map(() => []);

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

  // Розрахунок вікон для ЧАНУ (позначаємо лише startOfDay вікна як «Вільно + Чан»)
  const chanWindowsByDay = computeChanWindowsByDay(
    dayDescriptors,
    bookings,
    settings
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

      const slotStart = toDateAtTime(day.iso, timeLabel, settings.timeZone);
      const slotEnd = addMinutes(slotStart, 60);
      const visualStatus = getVisualStatus(status, { bookedAsUnavailable });
      const chanAvailable =
        status === 'available' &&
        isWithinStartOfDayChanWindow(day.iso, slotStart, slotEnd, chanWindowsByDay);

      stats[status] += 1;

      daySlots[columnIndex].push({
        rawStatus: status,
        visualStatus,
        chanAvailable,
        rowIndex,
        slotStart,
        slotEnd,
      });
    });
  });

  const shouldAggregateSlots = aggregateSlots;

  daySlots.forEach((slots, columnIndex) => {
    const columnX =
      layout.gridX + columnIndex * (layout.columnWidth + layout.columnGap);

    if (!shouldAggregateSlots) {
      slots.forEach((slot) => {
        const cellY = gridTop + slot.rowIndex * (ROW_HEIGHT + ROW_GAP);
        drawSlotCell(ctx, columnX, cellY, layout.columnWidth, ROW_HEIGHT, slot.visualStatus);
        drawSlotLabel(
          ctx,
          columnX,
          cellY,
          layout.columnWidth,
          ROW_HEIGHT,
          slot.visualStatus,
          slot.chanAvailable
        );
      });
      return;
    }

    const segments = buildSegments(slots);
    segments.forEach((segment) => {
      const rowCount = segment.endRow - segment.startRow;
      const cellY = gridTop + segment.startRow * (ROW_HEIGHT + ROW_GAP);
      const segmentHeight =
        rowCount * ROW_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP;
      const rangeLines =
        rowCount > 1
          ? buildSegmentRangeLines(segment.slotStart, segment.slotEnd)
          : undefined;

      drawSlotCell(
        ctx,
        columnX,
        cellY,
        layout.columnWidth,
        segmentHeight,
        segment.visualStatus
      );
      drawSlotLabel(
        ctx,
        columnX,
        cellY,
        layout.columnWidth,
        segmentHeight,
        segment.visualStatus,
        segment.chanAvailable,
        rangeLines
      );
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

function drawHeader(ctx: CanvasCtx, days: Date[], settings: Settings) {
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 48px "Arial"';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Вільні слоти', LEFT_MARGIN, 26);

  const rangeLabel = formatRange(days);
  ctx.font = '600 30px "Arial"';
  ctx.fillStyle = '#93c5fd';
  ctx.fillText(rangeLabel, LEFT_MARGIN, 84);

  const workingHoursLabel = `Робочий день: ${settings.dayOpenTime} – ${settings.dayCloseTime}`;
  ctx.font = '600 22px "Arial"';
  ctx.fillStyle = '#cbd5f5';
  ctx.fillText(workingHoursLabel, LEFT_MARGIN, 118);
}

function drawLegend(ctx: CanvasCtx, top: number) {
  const legendItems: { color: string; label: string }[] = [
    { color: '#22c55e', label: 'Вільно без Чану' },
    { color: '#22c55e', label: 'Вільно з Чаном' },
    { color: '#f87171', label: 'Зайнято' },
    { color: '#94a3b8', label: 'Недоступно' },
    { color: '#475569', label: 'Минуло' },
  ];

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 24px "Arial"';

  let currentX = LEFT_MARGIN;
  const centerY = top + LEGEND_HEIGHT / 2 - 4;

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
  const headersY = gridTop - 48;
  const datesY = gridTop - 20;

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
  status: VisualSlotStatus
) {
  const colors: Record<VisualSlotStatus, string> = {
    available: '#1ea672',
    booked: '#ef4444',
    cleaning: '#94a3b8',
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
  status: VisualSlotStatus,
  chanAvailable?: boolean,
  rangeLines?: string[]
) {
  const labels: Record<VisualSlotStatus, SlotLabelMeta> = {
    available: {
      text: chanAvailable ? ['Вільно', 'з Чаном'] : ['Вільно', 'без Чану'],
      color: '#052e16',
      lineHeight: 20,
    },
    booked: { text: 'Зайнято', color: '#fee2e2' },
    cleaning: { text: 'Недоступно', color: '#0f172a', font: '700 17px "Arial"' },
    past: { text: '', color: '#e2e8f0' },
  };

  const label = labels[status];
  if (!label) {
    return;
  }

  let font = label.font ?? '700 22px "Arial"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = label.color;

  const baseLines = Array.isArray(label.text) ? [...label.text] : [label.text];
  if (!baseLines[0]) {
    return;
  }

  if (status === 'cleaning' && baseLines.length === 1) {
    ctx.font = font;
    const maxWidth = width - 24;
    let iterations = 0;
    let measuredWidth = ctx.measureText(baseLines[0]).width;

    while (measuredWidth > maxWidth && iterations < 15) {
      const currentSize = parseInt(font.match(/(\d+)px/)?.[1] || '17', 10);
      if (currentSize <= 12) break;

      font = font.replace(/\d+px/, `${currentSize - 1}px`);
      ctx.font = font;
      measuredWidth = ctx.measureText(baseLines[0]).width;
      iterations += 1;
    }
  }

  ctx.font = font;
  const baseLineHeight = label.lineHeight ?? 22;
  const rangeLineCount = rangeLines?.length ?? 0;
  const rangeLineHeight = rangeLineCount > 0 ? 18 : 0;
  const totalHeight = baseLineHeight * baseLines.length + rangeLineHeight * rangeLineCount;
  let currentY = y + height / 2 - totalHeight / 2;

  baseLines.forEach((line) => {
    const lineCenter = currentY + baseLineHeight / 2;
    ctx.fillText(line, x + width / 2, lineCenter);
    currentY += baseLineHeight;
  });

  if (rangeLineCount) {
    const rangeFont = '600 18px "Arial"';
    ctx.font = rangeFont;
    rangeLines?.forEach((line) => {
      const lineCenter = currentY + rangeLineHeight / 2;
      ctx.fillText(line, x + width / 2, lineCenter);
      currentY += rangeLineHeight;
    });
  }
}

interface SlotSegment {
  visualStatus: VisualSlotStatus;
  chanAvailable?: boolean;
  startRow: number;
  endRow: number;
  slotStart: Date;
  slotEnd: Date;
}

function buildSegments(cells: SlotCell[]): SlotSegment[] {
  const segments: SlotSegment[] = [];
  let current: SlotSegment | null = null;

  cells.forEach((cell) => {
    if (
      current &&
      current.visualStatus === cell.visualStatus &&
      current.chanAvailable === cell.chanAvailable
    ) {
      current.endRow = cell.rowIndex + 1;
      current.slotEnd = cell.slotEnd;
      return;
    }

    if (current) {
      segments.push(current);
    }

    current = {
      visualStatus: cell.visualStatus,
      chanAvailable: cell.chanAvailable,
      startRow: cell.rowIndex,
      endRow: cell.rowIndex + 1,
      slotStart: cell.slotStart,
      slotEnd: cell.slotEnd,
    };
  });

  if (current) {
    segments.push(current);
  }

  return segments;
}

function buildSegmentRangeLines(start: Date, end: Date): string[] {
  const startLabel = formatCompactTime(start);
  const endLabel = formatCompactTime(end);
  return [startLabel, '–', endLabel];
}

function formatCompactTime(date: Date): string {
  return format(date, 'HH:mm', { locale: uk });
}

function getVisualStatus(
  status: SlotStatus,
  options: { bookedAsUnavailable: boolean }
): VisualSlotStatus {
  if (status === 'available') {
    return 'available';
  }

  if (status === 'past') {
    return 'past';
  }

  if (status === 'booked') {
    return options.bookedAsUnavailable ? 'cleaning' : 'booked';
  }

  return 'cleaning';
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

  // Гарантуємо мінімум 60 хв на прибирання незалежно від налаштувань
  const bufferMin = Math.max(
    60,
    Number.isFinite((settings as any).cleaningBufferMin)
      ? (settings as any).cleaningBufferMin
      : 60
  );
  if (bufferMin > 0) {
    // Прибирання ТІЛЬКИ після попереднього візиту (1 година) - ПРІОРИТЕТ!
    // Будуємо діапазони прибирання [booking.end, booking.end + bufferMin)
    // і перевіряємо накладення зі слот-годиною.
    const touchesBuffer = bookings.some((booking) => {
      const cleanStart = booking.dateEnd;
      const cleanEnd = addMinutes(booking.dateEnd, bufferMin);
      return rangesOverlap(slotStart, slotEnd, cleanStart, cleanEnd);
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
